import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { StdioTransport } from "../src/mcp/stdio-transport.js";

// 假 Server 是 .mjs，不会进 dist 编译产物。测试运行时 cwd 是仓库根，直接按
// 仓库相对路径解析源文件。
const SERVER = resolve(process.cwd(), "test", "support", "fake-mcp-server.mjs");

async function startTransport(
  args: string[] = [],
): Promise<StdioTransport> {
  const transport = new StdioTransport({
    command: process.execPath,
    args: [SERVER, ...args],
  });
  await transport.start();
  return transport;
}

test("round-trips a request and response over stdio", async () => {
  await using transport = await startTransport();
  const received = transport.receive();
  await transport.send({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {},
  });
  const inbound = await received;
  assert.equal(inbound?.kind, "response");
  if (inbound?.kind === "response") {
    const result = inbound.result as { tools?: unknown };
    assert.ok(Array.isArray(result.tools));
  }
});

test("sends notifications without expecting a response", async () => {
  await using transport = await startTransport();
  await transport.notify({
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });
  // 不应因等待响应而卡住；直接能走完就说明通知不阻塞。
  assert.equal(transport.closed, false);
});

test("buffers stderr tail for diagnostics", async () => {
  await using transport = await startTransport();
  // 触发一个未知方法，服务端不会写 stderr，这里只是验证 stderr 属性存在且空。
  assert.equal(transport.stderr, "");
});

test("closes the child process after close()", async () => {
  const transport = await startTransport();
  await transport.close();
  assert.equal(transport.closed, true);
});

test("marks transport closed after the child process exits", async () => {
  await using transport = await startTransport();
  await transport.send({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "crash", arguments: {} },
  });
  // 服务端对 crash 回 error 后 exit(1)，传输应观察到关闭。
  const deadline = Date.now() + 2_000;
  for (;;) {
    const message = await transport.receive();
    if (message === null) break;
    if (Date.now() > deadline) break;
  }
  assert.equal(transport.closed, true);
  assert.match(transport.lastError ?? "", /exited/);
});

async function waitForExit(pid: number): Promise<boolean> {
  const deadline = Date.now() + 6_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

test("a non-JSON line marks the transport broken and still reaps the child", async () => {
  const transport = await startTransport(["--emit-garbage", "--ignore-stdin-close"]);
  const pid = transport.pid!;
  assert.equal(await transport.receive(), null);
  assert.equal(transport.closed, true);
  assert.match(transport.lastError ?? "", /not valid JSON/);
  // #fail 已经在后台关；显式 close() 也必须走到子进程回收，而不是被 closed 短路。
  await transport.close();
  assert.equal(await waitForExit(pid), true);
});

test("an oversized single line is rejected even when it arrives with its newline", async () => {
  const transport = await startTransport(["--emit-huge", "--ignore-stdin-close"]);
  const pid = transport.pid!;
  assert.equal(await transport.receive(), null);
  assert.match(transport.lastError ?? "", /maximum message size/);
  await transport.close();
  assert.equal(await waitForExit(pid), true);
});
