import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdtemp,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  compareUtf8,
  MEMORY_INDEX_FILE,
  MEMORY_INDEX_MAX_BYTES,
  MemoryContentTooLargeError,
  MemoryDirectoryUnavailableError,
  MemoryEntryNotRegularError,
  MemoryEncodingError,
  MemoryFileNotFoundError,
  MemoryWriteConflictError,
  memoryDirectoryName,
  ProjectMemoryStore,
} from "../src/infrastructure/memory-store.js";
import { createMemoryRuntime } from "../src/infrastructure/run-memory.js";
import {
  acquireWritePosition,
  MemoryWriteTimeoutError,
} from "../src/infrastructure/memory-write-queue.js";

const projectKey = "git:/repo/app/.git";

async function temporaryRoot(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "harness-memory-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test("directory name is the sha256 of the project key", () => {
  assert.equal(
    memoryDirectoryName(projectKey),
    createHash("sha256").update(projectKey, "utf8").digest("hex"),
  );
  assert.match(memoryDirectoryName(projectKey), /^[0-9a-f]{64}$/);
  assert.notEqual(
    memoryDirectoryName(projectKey),
    memoryDirectoryName("dir:/repo/app"),
  );
});

test("index is limited by lines and bytes and keeps the file untouched", async (t) => {
  const root = await temporaryRoot(t);
  const store = new ProjectMemoryStore(root, projectKey);
  const lines = Array.from({ length: 260 }, (_, index) => `- entry ${index + 1}`);
  await mkdir(store.directory, { recursive: true });
  await writeFile(join(store.directory, MEMORY_INDEX_FILE), lines.join("\n"));

  const index = await store.loadIndex();
  assert.equal(index.nextLine, 201);
  assert.equal(index.content.split("\n").length, 200);
  assert.equal(
    await readFile(join(store.directory, MEMORY_INDEX_FILE), "utf8"),
    lines.join("\n"),
  );

  const byteLimited = new ProjectMemoryStore(
    await temporaryRoot(t),
    "dir:/repo/other",
  );
  await mkdir(byteLimited.directory, { recursive: true });
  const wide = Array.from({ length: 4 }, () => "x".repeat(20 * 1024));
  await writeFile(join(byteLimited.directory, MEMORY_INDEX_FILE), wide.join("\n"));
  const truncated = await byteLimited.loadIndex();
  assert.equal(truncated.nextLine, 2);
  assert.equal(truncated.content, wide[0]);
});

test("an oversized first line truncates the index at line 1", async (t) => {
  const store = new ProjectMemoryStore(await temporaryRoot(t), projectKey);
  await mkdir(store.directory, { recursive: true });
  await writeFile(join(store.directory, MEMORY_INDEX_FILE), "y".repeat(30 * 1024));
  assert.deepEqual(await store.loadIndex(), { content: "", nextLine: 1 });
});

test("missing files and directories are reported without side effects", async (t) => {
  const store = new ProjectMemoryStore(await temporaryRoot(t), projectKey);
  assert.deepEqual(await store.loadIndex(), { content: "", nextLine: null });
  assert.deepEqual(await store.list(), []);
  await assert.rejects(store.read("missing.md"), MemoryFileNotFoundError);
});

test("invalid UTF-8 is reported as an encoding error", async (t) => {
  const store = new ProjectMemoryStore(await temporaryRoot(t), projectKey);
  await mkdir(store.directory, { recursive: true });
  await writeFile(
    join(store.directory, MEMORY_INDEX_FILE),
    Buffer.from([0xff, 0xfe, 0x00]),
  );
  await assert.rejects(store.loadIndex(), MemoryEncodingError);
});

test("write, read and delete round trip with sha256 preconditions", async (t) => {
  const store = new ProjectMemoryStore(await temporaryRoot(t), projectKey);
  const created = await store.write(
    "testing.md",
    "# 集成测试\n执行测试前启动 Redis。\n",
    null,
  );
  assert.equal(created.file, "testing.md");
  assert.match(created.sha256, /^[0-9a-f]{64}$/);

  const read = await store.read("testing.md");
  assert.equal(read.content, "# 集成测试\n执行测试前启动 Redis。\n");
  assert.equal(read.sha256, created.sha256);
  assert.equal(read.nextLine, null);
  // 目录存在时 list 总包含启动索引，即使它尚未创建。
  assert.deepEqual(await store.list(), ["MEMORY.md", "testing.md"]);

  // null 校验值只用于创建新文件。
  await assert.rejects(
    store.write("testing.md", "other", null),
    MemoryWriteConflictError,
  );
  // 校验值与磁盘内容不一致时不覆盖。
  await assert.rejects(
    store.write("testing.md", "other", "0".repeat(64)),
    MemoryWriteConflictError,
  );
  const updated = await store.write("testing.md", "- 需要 Redis\n", created.sha256);
  await assert.rejects(
    store.delete("testing.md", created.sha256),
    MemoryWriteConflictError,
  );
  await store.delete("testing.md", updated.sha256);
  await assert.rejects(store.read("testing.md"), MemoryFileNotFoundError);
});

test("creating an existing file conflicts without changing it", async (t) => {
  const store = new ProjectMemoryStore(await temporaryRoot(t), projectKey);
  await store.write("index.md", "first", null);
  await assert.rejects(store.write("index.md", "second", null), MemoryWriteConflictError);
  assert.equal((await store.read("index.md")).content, "first");
});

test("read paginates by lines and reports the next line", async (t) => {
  const store = new ProjectMemoryStore(await temporaryRoot(t), projectKey);
  const lines = Array.from({ length: 120 }, (_, index) => `line ${index + 1}`);
  await store.write("detail.md", lines.join("\n"), null);

  const first = await store.read("detail.md", { limit: 100 });
  assert.equal(first.nextLine, 101);
  assert.equal(first.content, lines.slice(0, 100).join("\n"));
  const second = await store.read("detail.md", { startLine: 101, limit: 100 });
  assert.equal(second.nextLine, null);
  assert.equal(second.content, lines.slice(100).join("\n"));
  assert.equal((await store.read("detail.md")).content.split("\n").length, 50);
});

test("read stops before exceeding the byte budget", async (t) => {
  const store = new ProjectMemoryStore(await temporaryRoot(t), projectKey);
  const line = "z".repeat(10 * 1024);
  await store.write("big.md", [line, line, line, line].join("\n"), null);
  const page = await store.read("big.md", { limit: 200 });
  assert.equal(page.nextLine, 4);
  assert.equal((await store.read("big.md", { startLine: 4 })).content, line);
});

test("a single line beyond the read budget is rejected", async (t) => {
  const store = new ProjectMemoryStore(await temporaryRoot(t), projectKey);
  await store.write("huge.md", "q".repeat(40 * 1024), null);
  await assert.rejects(store.read("huge.md"), MemoryContentTooLargeError);
});

test("writes beyond 1 MiB are rejected and keep the file", async (t) => {
  const store = new ProjectMemoryStore(await temporaryRoot(t), projectKey);
  const created = await store.write("limit.md", "small", null);
  await assert.rejects(
    store.write("limit.md", "a".repeat(1024 * 1024 + 1), created.sha256),
    MemoryContentTooLargeError,
  );
  assert.equal((await store.read("limit.md")).content, "small");
});

test("a stale read conflicts instead of overwriting another session's write", async (t) => {
  const root = await temporaryRoot(t);
  const first = new ProjectMemoryStore(root, projectKey);
  const second = new ProjectMemoryStore(root, projectKey);
  const created = await first.write(MEMORY_INDEX_FILE, "- original\n", null);
  const readBySecond = await second.read(MEMORY_INDEX_FILE);

  const winner = await first.write(
    MEMORY_INDEX_FILE,
    "- original\n- added by A\n",
    created.sha256,
  );
  await assert.rejects(
    second.write(MEMORY_INDEX_FILE, "- replaced by B\n", readBySecond.sha256),
    MemoryWriteConflictError,
  );
  const current = await second.read(MEMORY_INDEX_FILE);
  assert.equal(current.content, "- original\n- added by A\n");
  assert.equal(current.sha256, winner.sha256);
});

test("write waiting is bounded and changes nothing when it times out", async (t) => {
  const store = new ProjectMemoryStore(await temporaryRoot(t), projectKey, {
    writeWaitMs: 20,
  });
  const created = await store.write("serial.md", "a", null);
  const release = await acquireWritePosition(await realpath(store.directory));
  try {
    await assert.rejects(
      store.write("serial.md", "b", created.sha256),
      MemoryWriteTimeoutError,
    );
    await assert.rejects(
      store.delete("serial.md", created.sha256),
      MemoryWriteTimeoutError,
    );
  } finally {
    release();
  }
  assert.equal((await store.read("serial.md")).content, "a");
  await store.write("serial.md", "b", created.sha256);
  assert.equal((await store.read("serial.md")).content, "b");
});

test("a cancelled write wait leaves the file unchanged", async (t) => {
  const store = new ProjectMemoryStore(await temporaryRoot(t), projectKey);
  const created = await store.write("serial.md", "a", null);
  const release = await acquireWritePosition(await realpath(store.directory));
  const controller = new AbortController();
  try {
    const write = store.write(
      "serial.md",
      "b",
      created.sha256,
      controller.signal,
    );
    controller.abort(new Error("cancelled"));
    await assert.rejects(write, /cancelled/);
  } finally {
    release();
  }
  assert.equal((await store.read("serial.md")).content, "a");
});

test("symbolic links are never read, followed or replaced", async (t) => {
  const root = await temporaryRoot(t);
  const store = new ProjectMemoryStore(root, projectKey);
  await mkdir(store.directory, { recursive: true });
  const outside = join(root, "outside.md");
  await writeFile(outside, "secret");
  const link = join(store.directory, "linked.md");
  await symlink(outside, link);
  await assert.rejects(store.read("linked.md"), MemoryFileNotFoundError);
  await assert.rejects(
    store.delete("linked.md", createHash("sha256").update("secret").digest("hex")),
    MemoryEntryNotRegularError,
  );
  await assert.rejects(
    store.write("linked.md", "replaced", null),
    MemoryEntryNotRegularError,
  );
  // 链接本身没有被替换，目标文件也没有被改写。
  assert.ok((await lstat(link)).isSymbolicLink());
  assert.equal(await readFile(outside, "utf8"), "secret");
  // 不可读取的条目不出现在 list 里，模型不会按结果调用失败。
  assert.deepEqual(await store.list(), ["MEMORY.md"]);
});

test("a directory occupying a memory file name is a conflict, not a create", async (t) => {
  const store = new ProjectMemoryStore(await temporaryRoot(t), projectKey);
  await mkdir(join(store.directory, "folder.md"), { recursive: true });
  await assert.rejects(
    store.write("folder.md", "- x\n", null),
    MemoryEntryNotRegularError,
  );
  await assert.rejects(
    store.write("folder.md", "- x\n", "0".repeat(64)),
    MemoryEntryNotRegularError,
  );
  await assert.rejects(
    store.delete("folder.md", "0".repeat(64)),
    MemoryEntryNotRegularError,
  );
  assert.deepEqual(await store.list(), ["MEMORY.md"]);
});

test("list hides names the memory tool cannot accept", async (t) => {
  const store = new ProjectMemoryStore(await temporaryRoot(t), projectKey);
  await mkdir(store.directory, { recursive: true });
  for (const name of ["ok.md", "my notes.md", ".hidden.md", "ok.txt"]) {
    await writeFile(join(store.directory, name), "- x\n");
  }
  await mkdir(join(store.directory, "nested.md"));
  assert.deepEqual(await store.list(), ["MEMORY.md", "ok.md"]);
});

test("list sorts file names by UTF-8 bytes", async (t) => {
  const store = new ProjectMemoryStore(await temporaryRoot(t), projectKey);
  for (const name of ["b.md", "a.md", "_a.md"]) {
    await store.write(name, name, null);
  }
  assert.deepEqual(await store.list(), ["MEMORY.md", "_a.md", "a.md", "b.md"]);
  assert.deepEqual(["a", "B", "b"].sort(compareUtf8), ["B", "a", "b"]);
});

test("write positions serialize per directory and release in order", async () => {
  const order: string[] = [];
  const firstRelease = await acquireWritePosition("queue-test");
  const second = acquireWritePosition("queue-test").then((release) => {
    order.push("second");
    release();
  });
  const third = acquireWritePosition("queue-test").then((release) => {
    order.push("third");
    release();
  });
  order.push("first");
  firstRelease();
  await Promise.all([second, third]);
  assert.deepEqual(order, ["first", "second", "third"]);
});

test("a directory that cannot be listed is an error, not empty memory", async (t) => {
  const root = await temporaryRoot(t);
  const store = new ProjectMemoryStore(root, "git:/repo/blocked/.git");
  await mkdir(store.directory, { recursive: true });
  await writeFile(join(store.directory, MEMORY_INDEX_FILE), "- blocked\n");
  const { chmod } = await import("node:fs/promises");
  await chmod(store.directory, 0o000);
  if (process.getuid?.() === 0) {
    // root 不受目录权限限制，这条检查只在普通用户下有效。
    await chmod(store.directory, 0o700);
    assert.ok(true);
    return;
  }
  await assert.rejects(store.loadIndex(), (error: NodeJS.ErrnoException) =>
    error.code === "EACCES");
  await assert.rejects(store.list(), (error: NodeJS.ErrnoException) =>
    error.code === "EACCES");
  await assert.rejects(
    store.read(MEMORY_INDEX_FILE),
    (error: NodeJS.ErrnoException) => error.code === "EACCES",
  );
  // 先恢复权限再交给用例清理钩子删除目录。
  await chmod(store.directory, 0o700);
});

test("a memory path occupied by a regular file is unavailable", async (t) => {
  const root = await temporaryRoot(t);
  const store = new ProjectMemoryStore(root, "git:/repo/occupied/.git");
  await writeFile(store.directory, "not a directory");
  await assert.rejects(store.loadIndex(), MemoryDirectoryUnavailableError);
  await assert.rejects(store.list(), MemoryDirectoryUnavailableError);
});

test("loading the index stops reading at the byte budget without touching the tail", async (t) => {
  const root = await temporaryRoot(t);
  const store = new ProjectMemoryStore(root, "git:/repo/large/.git");
  await mkdir(store.directory, { recursive: true });
  const target = join(store.directory, MEMORY_INDEX_FILE);
  const handle = await open(target, "w");
  // 每行约 1 KiB：25 KiB 预算先于 200 行上限触发，第 26 行开始放不下。
  const line = `${"x".repeat(1023)}\n`;
  for (let index = 0; index < 300; index += 1) {
    await handle.write(line);
  }
  // 文件尾部放一个远超预算的单行；读取必须在预算处停下，不读到它。
  await handle.write("y".repeat(256 * 1024));
  await handle.close();

  const index = await store.loadIndex();
  assert.equal(index.nextLine, 26);
  assert.equal(index.content.split("\n").length, 25);
  assert.equal(Buffer.byteLength(index.content, "utf8"), 25 * 1023 + 24);
  assert.ok(Buffer.byteLength(index.content, "utf8") <= MEMORY_INDEX_MAX_BYTES);
  // 文件本身保持完整。
  const stats = await (await open(target, "r")).stat();
  assert.ok(stats.size > 300 * 1024);
});

test("the line limit applies when bytes still fit", async (t) => {
  const root = await temporaryRoot(t);
  const store = new ProjectMemoryStore(root, "git:/repo/many-lines/.git");
  await mkdir(store.directory, { recursive: true });
  await writeFile(
    join(store.directory, MEMORY_INDEX_FILE),
    Array.from({ length: 260 }, (_, index) => `${index}`).join("\n"),
  );
  const index = await store.loadIndex();
  assert.equal(index.nextLine, 201);
  assert.equal(index.content.split("\n").length, 200);
});

test("a line that alone exceeds the budget stops reading without reaching the end", async (t) => {
  const root = await temporaryRoot(t);
  const store = new ProjectMemoryStore(root, "git:/repo/huge-line/.git");
  await mkdir(store.directory, { recursive: true });
  const target = join(store.directory, MEMORY_INDEX_FILE);
  const handle = await open(target, "w");
  await handle.write("- first\n");
  await handle.write("z".repeat(64 * 1024));
  await handle.write("\n- after the huge line\n");
  await handle.close();

  const index = await store.loadIndex();
  assert.equal(index.content, "- first");
  // 第 2 行在预算内的前缀里没有换行，无法确认它已结束；文件保留，行号指向它。
  assert.equal(index.nextLine, 2);
});

test("invalid UTF-8 before the truncation point is still an encoding error", async (t) => {
  const root = await temporaryRoot(t);
  const store = new ProjectMemoryStore(root, "git:/repo/bad-bytes/.git");
  await mkdir(store.directory, { recursive: true });
  await writeFile(
    join(store.directory, MEMORY_INDEX_FILE),
    Buffer.concat([Buffer.from("- ok\n"), Buffer.from([0xff]), Buffer.from("\n")]),
  );
  await assert.rejects(store.loadIndex(), MemoryEncodingError);
});

test("a trailing line without a newline that fits is loaded whole", async (t) => {
  const root = await temporaryRoot(t);
  const store = new ProjectMemoryStore(root, "git:/repo/tail/.git");
  await mkdir(store.directory, { recursive: true });
  const wide = "w".repeat(20 * 1024);
  await writeFile(join(store.directory, MEMORY_INDEX_FILE), `${wide}\n${wide}`);
  const index = await store.loadIndex();
  assert.equal(index.content, wide);
  assert.equal(index.nextLine, 2);

  await writeFile(join(store.directory, MEMORY_INDEX_FILE), `${wide.slice(0, 1024)}`);
  assert.deepEqual(await store.loadIndex(), {
    content: wide.slice(0, 1024),
    nextLine: null,
  });
});

test("CRLF line endings are preserved exactly as stored", async (t) => {
  const root = await temporaryRoot(t);
  const store = new ProjectMemoryStore(root, "git:/repo/crlf/.git");
  await mkdir(store.directory, { recursive: true });
  await writeFile(
    join(store.directory, MEMORY_INDEX_FILE),
    "a\r\nb\r\n",
  );
  assert.deepEqual(await store.loadIndex(), { content: "a\r\nb\r\n", nextLine: null });
});

test("the runtime reports a blocked memory directory as unavailable", async (t) => {
  const root = await temporaryRoot(t);
  const store = new ProjectMemoryStore(root, "git:/repo/runtime-blocked/.git");
  await mkdir(store.directory, { recursive: true });
  const { chmod } = await import("node:fs/promises");
  await chmod(store.directory, 0o000);
  if (process.getuid?.() === 0) {
    await chmod(store.directory, 0o700);
    assert.ok(true);
    return;
  }
  const runtime = createMemoryRuntime({ rootDirectory: root });
  const memory = await runtime.loadMemory({
    conversationId: "conversation",
    turnId: "turn",
    runId: "run",
    workspaceRoot: "/repo",
    executionMode: "workspace_sandbox",
    projectKey: "git:/repo/runtime-blocked/.git",
    projectRoot: "/repo",
    workspaceKind: "main",
  });
  assert.deepEqual(memory.status, { status: "unavailable", reason: "read" });
  assert.equal(memory.store, undefined);
  await chmod(store.directory, 0o700);
});

test("reading a page streams the file instead of loading it whole", async (t) => {
  const root = await temporaryRoot(t);
  const store = new ProjectMemoryStore(root, "git:/repo/stream/.git");
  await mkdir(store.directory, { recursive: true });
  const target = join(store.directory, "big.md");
  // 200 MiB 详情文件，单行 200 字节；只读第一页不应把整个文件读入内存。
  const line = `${"b".repeat(199)}\n`;
  const handle = await open(target, "w");
  for (let index = 0; index < 1_000_000; index += 1) {
    await handle.write(line);
  }
  await handle.close();

  const before = process.memoryUsage().rss;
  const page = await store.read("big.md");
  const delta = process.memoryUsage().rss - before;
  assert.equal(page.nextLine, 51);
  assert.equal(page.content.split("\n").length, 50);
  assert.ok(delta < 64 * 1024 * 1024, `rss grew ${delta} bytes`);
});

test("a page read past the limit carries the whole-file checksum", async (t) => {
  const store = new ProjectMemoryStore(await temporaryRoot(t), "git:/repo/page-sha/.git");
  const lines = Array.from({ length: 120 }, (_, index) => `- fact ${index + 1}`);
  const created = await store.write("notes.md", `${lines.join("\n")}\n`, null);
  const first = await store.read("notes.md", { limit: 100 });
  const second = await store.read("notes.md", {
    startLine: first.nextLine ?? 1,
  });
  assert.equal(first.nextLine, 101);
  assert.equal(second.nextLine, null);
  const written = await store.write(
    "notes.md",
    `${first.content}\n${second.content}`,
    created.sha256,
  );
  const restored = await store.read("notes.md", { limit: 200 });
  assert.equal(restored.nextLine, null);
  assert.equal(restored.content, `${lines.join("\n")}\n`);
  assert.equal(written.sha256, created.sha256);
});

test("write verification hashes the file in chunks", async (t) => {
  const root = await temporaryRoot(t);
  const store = new ProjectMemoryStore(root, "git:/repo/hash/.git");
  await mkdir(store.directory, { recursive: true });
  const target = join(store.directory, "huge.md");
  const line = `${"c".repeat(199)}\n`;
  const handle = await open(target, "w");
  for (let index = 0; index < 200_000; index += 1) {
    await handle.write(line);
  }
  await handle.close();

  const before = process.memoryUsage().rss;
  await assert.rejects(
    store.write("huge.md", "- replaced\n", "0".repeat(64)),
    MemoryWriteConflictError,
  );
  const delta = process.memoryUsage().rss - before;
  assert.ok(delta < 64 * 1024 * 1024, `rss grew ${delta} bytes`);
});
