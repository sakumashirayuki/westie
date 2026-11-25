import { closeSync, openSync, writeSync } from "node:fs";
import {
  mkdir,
  open,
  rm,
} from "node:fs/promises";
import path from "node:path";

export const SERVICE_LOG_LIMIT_BYTES = 10 * 1024 * 1024;

export interface ServiceArtifactsLayout {
  readonly root: string;
  readonly canaryDirectory: string;
  readonly allowedCanaryPath: string;
  readonly deniedCanaryPath: string;
  readonly homeDirectory: string;
  readonly tmpDirectory: string;
  readonly logPath: string;
}

/**
 * 每个 service 独占的 artifacts 目录：canary、临时 HOME/TMPDIR 与合并日志。
 * 日志按 append 写入，达到 10 MiB 后停止写盘但继续供调用方排空管道，并把
 * `truncated` 置为 true。
 */
export class ServiceArtifacts {
  readonly layout: ServiceArtifactsLayout;
  #fd: number | undefined;
  #totalBytes = 0;
  #truncated = false;

  private constructor(layout: ServiceArtifactsLayout) {
    this.layout = layout;
  }

  static async create(root: string): Promise<ServiceArtifacts> {
    const canaryDirectory = path.join(root, "canary");
    const homeDirectory = path.join(root, "home");
    const tmpDirectory = path.join(root, "tmp");
    const logPath = path.join(root, "service.log");
    await mkdir(canaryDirectory, { recursive: true });
    await mkdir(homeDirectory, { recursive: true });
    await mkdir(tmpDirectory, { recursive: true });
    await open(logPath, "wx").then((handle) => handle.close());

    const artifacts = new ServiceArtifacts({
      root,
      canaryDirectory,
      allowedCanaryPath: path.join(canaryDirectory, "allowed.canary"),
      deniedCanaryPath: path.join(canaryDirectory, "denied.canary"),
      homeDirectory,
      tmpDirectory,
      logPath,
    });
    artifacts.#fd = openSync(logPath, "a");
    return artifacts;
  }

  get truncated(): boolean {
    return this.#truncated;
  }

  get byteLength(): number {
    return this.#totalBytes;
  }

  append(chunk: Buffer): void {
    if (this.#truncated || this.#fd === undefined) return;
    const remaining = SERVICE_LOG_LIMIT_BYTES - this.#totalBytes;
    if (remaining <= 0) {
      this.#truncated = true;
      return;
    }
    const slice = chunk.subarray(0, remaining);
    writeSync(this.#fd, slice);
    this.#totalBytes += slice.byteLength;
    if (slice.byteLength < chunk.byteLength) this.#truncated = true;
  }

  async readTail(maxBytes: number): Promise<string> {
    const handle = await open(this.layout.logPath, "r");
    try {
      const stats = await handle.stat();
      const size = stats.size;
      const length = Math.min(size, maxBytes);
      if (length <= 0) return "";
      const start = size - length;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, start);
      return decodeUtf8Tail(buffer, maxBytes);
    } finally {
      await handle.close();
    }
  }

  async captureFinalTail(maxBytes: number): Promise<string> {
    try {
      return await this.readTail(maxBytes);
    } catch {
      return "";
    }
  }

  async remove(): Promise<void> {
    if (this.#fd !== undefined) {
      try {
        closeSync(this.#fd);
      } catch {
        // 已关闭或写入失败都不影响目录清理。
      }
      this.#fd = undefined;
    }
    await rm(this.layout.root, { recursive: true, force: true });
  }
}

/**
 * 解码尾部字节：丢弃切片开头和末尾的残缺 UTF-8 序列，局部的非法字节替换为
 * U+FFFD（不丢弃其后的有效日志），再把结果裁剪到 maxBytes 字节以内。
 */
function decodeUtf8Tail(buffer: Buffer, maxBytes: number): string {
  let start = 0;
  while (start < buffer.byteLength && (buffer[start]! & 0xc0) === 0x80) {
    start += 1;
  }
  let end = buffer.byteLength;
  const trailingIncomplete = trailingIncompleteBytes(buffer, end);
  if (trailingIncomplete > 0) end -= trailingIncomplete;
  const decoded = buffer.subarray(start, end).toString("utf8");
  return tailOfUtf8(decoded, maxBytes);
}

/** 返回末尾残缺 UTF-8 序列占用的字节数；完整或只有非法单字节时返回 0。 */
function trailingIncompleteBytes(buffer: Buffer, end: number): number {
  if (end <= 0) return 0;
  const last = buffer[end - 1]!;
  if ((last & 0x80) === 0) return 0;
  let lead = end - 1;
  while (lead >= 0 && (buffer[lead]! & 0xc0) === 0x80) lead -= 1;
  if (lead < 0) return end;
  const byte = buffer[lead]!;
  let needed = 0;
  if ((byte & 0xe0) === 0xc0) needed = 1;
  else if ((byte & 0xf0) === 0xe0) needed = 2;
  else if ((byte & 0xf8) === 0xf0) needed = 3;
  else return 0;
  return end - 1 - lead < needed ? end - lead : 0;
}

/** 按字节预算从末尾裁剪字符串，且不切断完整字符。 */
function tailOfUtf8(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= maxBytes) return value;
  let start = buffer.byteLength - maxBytes;
  while (start < buffer.byteLength && (buffer[start]! & 0xc0) === 0x80) {
    start += 1;
  }
  return buffer.subarray(start).toString("utf8");
}
