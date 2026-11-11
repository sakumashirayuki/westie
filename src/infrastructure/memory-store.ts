/**
 * 项目记忆的 Markdown 存储。
 *
 * 记忆根目录由启动配置给出；每个项目在根目录下占一个以 `sha256(projectKey)`
 * 命名的子目录，目录里是普通 UTF-8 Markdown 文件，`MEMORY.md` 是启动索引，其他
 * `.md` 是详情。文件是唯一权威数据：存储层只做有界读取、写前校验和进程内串行化，
 * 不负责解释内容。
 */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { join } from "node:path";

import { acquireWritePosition, DEFAULT_WRITE_WAIT_MS } from "./memory-write-queue.js";

/** 启动索引加载上限：行数与 UTF-8 字节数。 */
export const MEMORY_INDEX_MAX_LINES = 200;
export const MEMORY_INDEX_MAX_BYTES = 25 * 1024;
/** 单次读取的默认与最大行数。 */
export const MEMORY_READ_DEFAULT_LINES = 50;
export const MEMORY_READ_MAX_LINES = 200;
/** 单次读取返回内容（按 JSON 转义后估计）的字节上限。 */
export const MEMORY_READ_MAX_BYTES = 32 * 1024;
/** 工具单次写入内容的字节上限；人工写入不受限。 */
export const MEMORY_WRITE_MAX_BYTES = 1024 * 1024;
/** `list` 的文件数上限；超过时返回错误而不是静默省略。 */
export const MEMORY_LIST_MAX_FILES = 500;
/**
 * 读取启动索引时每次探测的块大小。索引只保留预算内的完整行；一旦下一行放不下，
 * 只再读取该行在预算内的前缀来判断它是否已结束，不会读入整个文件。
 */
const INDEX_PROBE_CHUNK_BYTES = 4 * 1024;

export const MEMORY_INDEX_FILE = "MEMORY.md";

/** 启动索引与状态事件使用的快照。 */
export interface MemoryIndex {
  /** 已加载的索引原文；没有 `MEMORY.md` 时为空字符串。 */
  readonly content: string;
  /** 截断时未加载的第一行行号（1 起算）；完整加载时为 null。 */
  readonly nextLine: number | null;
}

export type MemoryWriteConflictReason = "changed" | "exists" | "missing";

/** 写前校验失败：文件已被修改、已被创建或已不存在。 */
export class MemoryWriteConflictError extends Error {
  constructor(readonly reason: MemoryWriteConflictReason) {
    super(
      reason === "changed"
        ? "Project memory changed since it was read. Read it again and retry."
        : reason === "exists"
          ? "Project memory file already exists. Read it before writing."
          : "Project memory file does not exist. List the memory files and retry.",
    );
    this.name = "MemoryWriteConflictError";
  }
}

/** 目录中没有该文件，或该名字不是普通文件。 */
export class MemoryFileNotFoundError extends Error {
  constructor() {
    super("Project memory file does not exist.");
    this.name = "MemoryFileNotFoundError";
  }
}

/** 记忆目录存在但不可用：路径不是目录，或解析真实路径失败。 */
export class MemoryDirectoryUnavailableError extends Error {
  constructor() {
    super("Project memory directory is unavailable.");
    this.name = "MemoryDirectoryUnavailableError";
  }
}

/** 记忆文件名被目录、符号链接或其他非普通条目占用。 */
export class MemoryEntryNotRegularError extends Error {
  constructor() {
    super("A memory entry with this name exists and is not a regular file.");
    this.name = "MemoryEntryNotRegularError";
  }
}

/** 记忆文件内容不是合法 UTF-8。 */
export class MemoryEncodingError extends Error {
  constructor() {
    super("Project memory file is not valid UTF-8.");
    this.name = "MemoryEncodingError";
  }
}

/** 单个文件超出可返回或可写入的上限。 */
export class MemoryContentTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryContentTooLargeError";
  }
}

export interface MemoryReadResult {
  readonly file: string;
  readonly content: string;
  /**
   * 已读内容的 SHA-256。`nextLine` 为 null（读到文件末尾）时它是完整文件校验值，
   * 可用于写回或删除；分页未读完时不得用于写前校验。
   */
  readonly sha256: string;
  /** 还有内容未返回时的下一行行号；读到末尾为 null。 */
  readonly nextLine: number | null;
}

/** `sha256(UTF8(projectKey))`，仅作为记忆目录名。 */
export function memoryDirectoryName(projectKey: string): string {
  return createHash("sha256").update(projectKey, "utf8").digest("hex");
}

/** 文件名按 UTF-8 字节序排序，与区域设置无关。 */
export function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

/**
 * 绑定单个项目记忆目录的存储。读取直接访问磁盘当前文件；写入和删除按目录串行，
 * 取得写入位置后重新校验磁盘内容，冲突时放弃写入。
 */
export class ProjectMemoryStore {
  readonly #rootDirectory: string;
  readonly #directory: string;
  readonly #writeWaitMs: number;

  constructor(
    rootDirectory: string,
    projectKey: string,
    options: { readonly writeWaitMs?: number } = {},
  ) {
    this.#rootDirectory = rootDirectory;
    this.#directory = join(rootDirectory, memoryDirectoryName(projectKey));
    this.#writeWaitMs = options.writeWaitMs ?? DEFAULT_WRITE_WAIT_MS;
  }

  get directory(): string {
    return this.#directory;
  }

  /**
   * 读取启动索引。文件不存在时是空索引；目录不可访问、内容不是合法 UTF-8 时抛错。
   *
   * 读取是有界的：只解码并保留预算内的完整行。下一行放不下时，只再读取该行在
   * 预算内的前缀判断它是否已结束，然后停止读文件；截断点之后的字节不会被读取，
   * 也不参与 UTF-8 校验。行数是否超限由已读内容判定，因此超限时同样不会读到
   * 文件末尾。
   */
  async loadIndex(signal?: AbortSignal): Promise<MemoryIndex> {
    const directory = await this.#existingDirectory();
    if (directory === null) return { content: "", nextLine: null };
    // 索引名被目录或符号链接占用时是存储状态问题，不是「没有索引」。
    const target = await regularFileEntry(directory, MEMORY_INDEX_FILE);
    if (target === null) return { content: "", nextLine: null };
    const handle = await open(target, "r");
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) {
        throw new MemoryEntryNotRegularError();
      }
      return await readIndexWithinBudget(handle, stats.size, signal);
    } finally {
      await handle.close();
    }
  }

  /**
   * 列出可以读取的 `.md` 记忆文件；目录不存在时返回空数组。
   *
   * 只返回名字符合 `memory` 工具规则、且确实是普通文件的条目，保证工具按结果
   * 调用 `read` 不会遇到 `INVALID_TOOL_INPUT` 或 `FILE_NOT_FOUND`。目录存在时
   * 结果总包含启动索引 `MEMORY.md`，即使它尚未创建。
   */
  async list(signal?: AbortSignal): Promise<readonly string[]> {
    const directory = await this.#existingDirectory();
    if (directory === null) return [];
    signal?.throwIfAborted();
    const names = await memoryFileNames(directory, signal);
    if (names.length > MEMORY_LIST_MAX_FILES) {
      throw new MemoryContentTooLargeError(
        `Project memory has more than ${MEMORY_LIST_MAX_FILES} files.`,
      );
    }
    return names;
  }

  /**
   * 从 `startLine` 起读取至多 `limit` 行。返回内容按 JSON 转义后的字节数不超过
   * 32 KiB，放不下时提前结束并给出下一行；单行放不下时直接报错。
   *
   * 文件按块流式读取，分页只保留选中的行：内容与行号不依赖文件大小。`sha256`
   * 覆盖本次实际读到的字节，`nextLine` 为 null 时即完整文件校验值，可用于写回或
   * 删除。要修改一个需要分页读的大文件，先把各页读到 `nextLine` 为 null 再写回。
   */
  async read(
    file: string,
    options: {
      readonly startLine?: number;
      readonly limit?: number;
    } = {},
    signal?: AbortSignal,
  ): Promise<MemoryReadResult> {
    const startLine = options.startLine ?? 1;
    const limit = Math.min(
      options.limit ?? MEMORY_READ_DEFAULT_LINES,
      MEMORY_READ_MAX_LINES,
    );
    const directory = await this.#existingDirectory();
    if (directory === null) throw new MemoryFileNotFoundError();
    // 名字被非普通文件占用时按「文件不存在」处理，与工具的 FILE_NOT_FOUND 一致。
    const target = await regularFileEntry(directory, file).catch((error) => {
      if (error instanceof MemoryEntryNotRegularError) return null;
      throw error;
    });
    if (target === null) throw new MemoryFileNotFoundError();

    const handle = await open(target, "r");
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) throw new MemoryFileNotFoundError();
      return await readPageWithinBudget(handle, stats.size, {
        file,
        startLine,
        limit,
      }, signal);
    } finally {
      await handle.close();
    }
  }

  /**
   * 整体替换文件内容。`expectedSha256` 为 null 表示新建文件，文件已存在即冲突；
   * 否则必须与磁盘当前内容一致。写入使用同目录临时文件加 rename。
   */
  async write(
    file: string,
    content: string,
    expectedSha256: string | null,
    signal?: AbortSignal,
  ): Promise<{ readonly file: string; readonly sha256: string }> {
    const bytes = Buffer.from(content, "utf8");
    if (bytes.byteLength > MEMORY_WRITE_MAX_BYTES) {
      throw new MemoryContentTooLargeError(
        `Memory files are limited to ${MEMORY_WRITE_MAX_BYTES} bytes.`,
      );
    }
    return this.#withWriteTurn(signal, async (directory) => {
      await assertDirectoryAccessible(directory);
      const target = await regularFileEntry(directory, file);
      if (expectedSha256 === null) {
        if (target !== null) throw new MemoryWriteConflictError("exists");
      } else {
        if (target === null) throw new MemoryWriteConflictError("missing");
        if (await hashFile(target, signal) !== expectedSha256) {
          throw new MemoryWriteConflictError("changed");
        }
      }
      // 临时文件名与目标名无关，避免长文件名加后缀后超出文件系统上限。
      const temporary = join(directory, `.${randomUUID()}.tmp`);
      try {
        await writeFileDurably(temporary, bytes);
        await rename(temporary, join(directory, file));
      } catch (error) {
        await unlink(temporary).catch(() => {});
        throw error;
      }
      return { file, sha256: sha256(bytes) };
    });
  }

  /** 校验后删除文件；磁盘内容与 `expectedSha256` 不一致时返回冲突。 */
  async delete(
    file: string,
    expectedSha256: string,
    signal?: AbortSignal,
  ): Promise<{ readonly file: string; readonly deleted: true }> {
    return this.#withWriteTurn(signal, async (directory) => {
      await assertDirectoryAccessible(directory);
      const target = await regularFileEntry(directory, file);
      if (target === null) throw new MemoryWriteConflictError("missing");
      if (await hashFile(target, signal) !== expectedSha256) {
        throw new MemoryWriteConflictError("changed");
      }
      await unlink(target);
      return { file, deleted: true };
    });
  }

  /** 取得目录的写入位置后执行；等待超时或取消时抛错且不改动文件。 */
  async #withWriteTurn<T>(
    signal: AbortSignal | undefined,
    operation: (directory: string) => Promise<T>,
  ): Promise<T> {
    const directory = await this.#ensureDirectory();
    const release = await acquireWritePosition(directory, {
      waitMs: this.#writeWaitMs,
      ...(signal === undefined ? {} : { signal }),
    });
    try {
      return await operation(directory);
    } finally {
      release();
    }
  }

  /** 记忆目录已存在时返回其 realpath；只有目录确实不存在才返回 null。 */
  async #existingDirectory(): Promise<string | null> {
    let stats;
    try {
      stats = await lstat(this.#directory);
    } catch (error) {
      if (isMissingPath(error)) return null;
      throw error;
    }
    if (!stats.isDirectory()) {
      throw new MemoryDirectoryUnavailableError();
    }
    const directory = await realpath(this.#directory);
    const resolved = await lstat(directory);
    if (!resolved.isDirectory()) {
      throw new MemoryDirectoryUnavailableError();
    }
    return directory;
  }

  /** 懒创建记忆目录（用户私有权限）并返回其真实路径。 */
  async #ensureDirectory(): Promise<string> {
    await mkdir(this.#rootDirectory, { recursive: true, mode: 0o700 });
    try {
      await mkdir(this.#directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const directory = await realpath(this.#directory);
    const stats = await lstat(directory);
    if (!stats.isDirectory()) {
      throw new MemoryDirectoryUnavailableError();
    }
    return directory;
  }
}

/**
 * 增量解码 UTF-8。块边界上被截断的多字节字符会留到下一块，不产生替换字符；
 * 非法编码统一替换为 U+FFFD，由调用方检查已读范围后抛出 `MemoryEncodingError`。
 */
function decodeChunk(decoder: StringDecoder, buffer: Buffer): string {
  return assertDecoded(decoder.write(buffer));
}

/** 结束解码；块边界上残留的不完整字节在这里暴露为非法编码。 */
function decodeTail(decoder: StringDecoder): string {
  return assertDecoded(decoder.end());
}

/** 已读范围内出现 U+FFFD 说明有非法字节；截断点之后的内容不参与校验。 */
function assertDecoded(text: string): string {
  if (text.indexOf("\uFFFD") !== -1) throw new MemoryEncodingError();
  return text;
}

async function readChunk(
  handle: FileHandle,
  fileSize: number,
  offset: number,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  signal?.throwIfAborted();
  const buffer = Buffer.allocUnsafe(Math.min(maxBytes, fileSize - offset));
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
  return buffer.subarray(0, bytesRead);
}

async function readIndexWithinBudget(
  handle: FileHandle,
  fileSize: number,
  signal: AbortSignal | undefined,
): Promise<MemoryIndex> {
  const kept: string[] = [];
  let keptBytes = 0;
  let current = "";
  let currentBytes = 0;
  let offset = 0;
  const decoder = new StringDecoder("utf8");

  /** 已读到文件末尾且剩余缓冲为空：最后一行以 LF 结束，拼回时补一个换行。 */
  const endsWithNewline = (): boolean =>
    current === "" && offset >= fileSize && kept.length > 0;

  /**
   * 返回结果。`content` 与文件原文逐字节一致：最后一个完整行以换行结束时补回
   * 那个换行；行号只在本轮没有读到文件末尾时给出。
   */
  const result = (nextLine: number | null): MemoryIndex => {
    const text = kept.join("\n");
    return {
      content: endsWithNewline() ? text.concat("\n") : text,
      nextLine,
    };
  };
  const truncated = (): MemoryIndex => result(kept.length + 1);

  while (offset < fileSize) {
    const buffer = await readChunk(handle, fileSize, offset, INDEX_PROBE_CHUNK_BYTES, signal);
    if (buffer.length === 0) break;
    offset += buffer.length;
    current += decodeChunk(decoder, buffer);
    let newline = current.indexOf("\n");
    while (newline >= 0) {
      const head = current.slice(0, newline);
      current = current.slice(newline + 1);
      currentBytes = 0;
      const lineBytes = Buffer.byteLength(head, "utf8") +
        (kept.length === 0 ? 0 : 1);
      if (
        kept.length >= MEMORY_INDEX_MAX_LINES ||
        keptBytes + lineBytes > MEMORY_INDEX_MAX_BYTES
      ) {
        return truncated();
      }
      kept.push(head);
      keptBytes += lineBytes;
      newline = current.indexOf("\n");
    }
    if (kept.length >= MEMORY_INDEX_MAX_LINES) {
      // 行数已满，下一行必然放不下。
      return truncated();
    }
    currentBytes = Buffer.byteLength(current, "utf8");
    if (
      keptBytes + (kept.length === 0 ? 0 : 1) + currentBytes >
        MEMORY_INDEX_MAX_BYTES
    ) {
      // 当前行已超出剩余预算，补读前缀后停下。
      break;
    }
  }

  const remainder = current + decodeTail(decoder);
  if (offset >= fileSize) {
    if (remainder === "") return result(null);
    const lineBytes = Buffer.byteLength(remainder, "utf8") +
      (kept.length === 0 ? 0 : 1);
    if (
      kept.length < MEMORY_INDEX_MAX_LINES &&
      keptBytes + lineBytes <= MEMORY_INDEX_MAX_BYTES
    ) {
      kept.push(remainder);
      return result(null);
    }
    return truncated();
  }

  let probe = remainder;
  let probeBytes = Buffer.byteLength(probe, "utf8");
  while (offset < fileSize) {
    signal?.throwIfAborted();
    if (probe.includes("\n")) return truncated();
    const remainingBudget = MEMORY_INDEX_MAX_BYTES -
      (keptBytes + (kept.length === 0 ? 0 : 1));
    if (probeBytes >= Math.max(remainingBudget, 1)) return truncated();
    const maxBytes = Math.min(
      INDEX_PROBE_CHUNK_BYTES,
      Math.max(remainingBudget - probeBytes, 1),
    );
    const buffer = await readChunk(handle, fileSize, offset, maxBytes, signal);
    if (buffer.length === 0) break;
    offset += buffer.length;
    probe += decodeChunk(decoder, buffer);
    probeBytes = Buffer.byteLength(probe, "utf8");
  }
  return truncated();
}

/**
 * 记忆目录必须可以直接列出：目录不可访问时读写都应报错，不能当成空目录或
 * 「文件不存在」。`#ensureDirectory` 返回的目录已经过校验，这里只补充可读性检查。
 */
async function assertDirectoryAccessible(directory: string): Promise<void> {
  await readdir(directory);
}

/** 只有「路径不存在」类错误才表示没有记忆目录；权限等错误向上抛出。 */
function isMissingPath(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** 严格解码 UTF-8；非法字节抛 `MemoryEncodingError`。 */
export function decodeUtf8(buffer: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new MemoryEncodingError();
  }
}

/** UTF-8 字节数限长的单层 `.md` 文件名规则；工具 schema 与目录列举共用。 */
const MEMORY_FILE_NAME_MAX_BYTES = 200;
const MEMORY_FILE_NAME_PATTERN = /^[\p{L}\p{N}._-]+\.md$/u;

/** 记忆文件名是否可被 `memory` 工具接受。 */
export function isValidMemoryFileName(name: string): boolean {
  if (Buffer.byteLength(name, "utf8") > MEMORY_FILE_NAME_MAX_BYTES) return false;
  if (!MEMORY_FILE_NAME_PATTERN.test(name)) return false;
  return !name.startsWith(".") && name !== "." && name !== "..";
}

/**
 * 目录内普通文件的路径。名字被目录、符号链接、FIFO 等非普通条目占用时抛
 * `MemoryEntryNotRegularError`，不能被当作「不存在」再改名覆盖。
 */
async function regularFileEntry(
  directory: string,
  file: string,
): Promise<string | null> {
  const path = join(directory, file);
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    // 只有文件确实不存在才算「没有这个文件」；目录不可访问等错误向上抛出。
    if (isMissingPath(error)) return null;
    throw error;
  }
  if (!stats.isFile()) throw new MemoryEntryNotRegularError();
  return path;
}

/**
 * 按行流式读取一页内容。只保留选中的行，逐块更新文件哈希：内容与行号不依赖文件
 * 大小，`sha256` 覆盖本次实际读到的字节，`nextLine` 为 null 时即完整文件校验值。
 */
async function readPageWithinBudget(
  handle: FileHandle,
  fileSize: number,
  request: {
    readonly file: string;
    readonly startLine: number;
    readonly limit: number;
  },
  signal: AbortSignal | undefined,
): Promise<MemoryReadResult> {
  const { file, startLine, limit } = request;
  const hash = createHash("sha256");
  const decoder = new StringDecoder("utf8");
  const selected: string[] = [];
  let usedBytes = 0;
  let current = "";
  let offset = 0;
  let lineNumber = 1;
  let nextLine: number | null = null;

  /** 处理一行；返回 false 表示本页已满，应停止读取。 */
  const acceptLine = (value: string, numberOfLine: number): boolean => {
    if (numberOfLine < startLine) return true;
    if (selected.length >= limit) {
      nextLine = numberOfLine;
      return false;
    }
    const cost = Buffer.byteLength(JSON.stringify(value), "utf8") +
      (selected.length === 0 ? 0 : 1);
    if (cost > MEMORY_READ_MAX_BYTES) {
      throw new MemoryContentTooLargeError(
        `Line ${numberOfLine} of ${file} exceeds the ${MEMORY_READ_MAX_BYTES} byte read budget. Split it into shorter lines.`,
      );
    }
    if (usedBytes + cost > MEMORY_READ_MAX_BYTES) {
      nextLine = numberOfLine;
      return false;
    }
    selected.push(value);
    usedBytes += cost;
    return true;
  };

  while (offset < fileSize) {
    const buffer = await readChunk(handle, fileSize, offset, INDEX_PROBE_CHUNK_BYTES * 16, signal);
    if (buffer.length === 0) break;
    hash.update(buffer);
    offset += buffer.length;
    current += decodeChunk(decoder, buffer);

    let newline = current.indexOf("\n");
    while (newline >= 0) {
      const value = current.slice(0, newline);
      current = current.slice(newline + 1);
      if (!acceptLine(value, lineNumber)) break;
      lineNumber += 1;
      newline = current.indexOf("\n");
    }
    if (nextLine !== null) break;
  }

  // 读到了文件末尾且缓冲里没有残留内容：最后一行以换行结束，拼回时补回那个换行。
  let endsWithNewline = false;
  if (nextLine === null && offset >= fileSize) {
    current += decodeTail(decoder);
    if (current !== "") {
      // 最后一行没有结尾换行。
      acceptLine(current, lineNumber);
    } else {
      endsWithNewline = true;
    }
  }
  const content = endsWithNewline
    ? selected.join("\n").concat("\n")
    : selected.join("\n");
  return {
    file,
    content,
    sha256: hash.digest("hex"),
    nextLine,
  };
}

/**
 * 流式计算文件 SHA-256，内存占用与文件大小无关。写入和删除的写前校验用它比较
 * 磁盘当前内容，人工放大的文件不会再一次性读入内存。
 */
async function hashFile(
  path: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  const hash = createHash("sha256");
  try {
    for await (const chunk of createReadStream(path, { signal })) {
      hash.update(chunk);
    }
  } catch (error) {
    signal?.throwIfAborted();
    throw error;
  }
  return hash.digest("hex");
}

/** 列出目录中可读的记忆文件名：符合文件名规则且是普通文件，`MEMORY.md` 总在内。 */
async function memoryFileNames(
  directory: string,
  signal: AbortSignal | undefined,
): Promise<readonly string[]> {
  const names: string[] = [];
  for (const name of await readdir(directory)) {
    signal?.throwIfAborted();
    if (!isValidMemoryFileName(name)) continue;
    const path = join(directory, name);
    try {
      if (!(await lstat(path)).isFile()) continue;
    } catch {
      // 列举期间被删除的条目跳过即可，不必让整次 list 失败。
      continue;
    }
    names.push(name);
  }
  if (!names.includes(MEMORY_INDEX_FILE)) names.push(MEMORY_INDEX_FILE);
  return names.sort(compareUtf8);
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

async function writeFileDurably(path: string, bytes: Buffer): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle?.close();
  }
}
