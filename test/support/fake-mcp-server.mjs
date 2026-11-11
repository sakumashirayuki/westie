#!/usr/bin/env node
// 一个 stdio 假 MCP Server，供传输与客户端测试用。实现 JSON-RPC 2.0 分帧，
// 支持 initialize、notifications/initialized、tools/list（分页）、tools/call，
// 以及 notifications/cancelled。工具：echo、fail、slow、image、crash。
//
// 用法：node test/support/fake-mcp-server.mjs [--page-size N] [--protocol-version V]
//
// 没有依赖，直接跑在 Node 22 上。

import readline from "node:readline";

const pageSize = Number(process.argv.includes("--page-size")
  ? process.argv[process.argv.indexOf("--page-size") + 1]
  : 0);
const protocolVersion = process.argv.includes("--protocol-version")
  ? process.argv[process.argv.indexOf("--protocol-version") + 1]
  : "2025-06-18";

// --emit-garbage：启动时先往 stdout 写一行非 JSON；--emit-huge：写一行 5 MiB 的 JSON。
// 两者都用来验证客户端判定连接损坏后仍会回收子进程。--ignore-stdin-close：stdin 关了
// 也不退出，逼客户端走 SIGTERM。
if (process.argv.includes("--emit-garbage")) {
  process.stdout.write("this is not json\n");
}
if (process.argv.includes("--emit-huge")) {
  process.stdout.write(`${JSON.stringify({
    jsonrpc: "2.0",
    method: "notifications/message",
    params: { level: "info", data: "x".repeat(5 * 1024 * 1024) },
  })}\n`);
}
if (process.argv.includes("--ignore-stdin-close")) {
  setInterval(() => {}, 60_000);
}

const TOOLS = [
  {
    name: "echo",
    description: "Echo the input text back.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
  {
    name: "fail",
    description: "Return an isError result.",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string" } },
    },
  },
  {
    name: "slow",
    description: "Delay before returning.",
    inputSchema: {
      type: "object",
      properties: { delayMs: { type: "number" } },
    },
  },
  {
    name: "image",
    description: "Return an image content block.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "crash",
    description: "Exit the process.",
    inputSchema: { type: "object", properties: {} },
  },
];

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

for await (const line of rl) {
  if (line.trim() === "") continue;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    continue;
  }
  if (message.jsonrpc !== "2.0") continue;

  // 通知不需要响应。
  if (message.id === undefined) {
    continue;
  }

  const respond = (result) => {
    process.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      result,
    })}\n`);
  };
  const respondError = (code, text) => {
    process.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      error: { code, message: text },
    })}\n`);
  };

  switch (message.method) {
    case "initialize":
      respond({
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "fake-mcp-server", version: "0.1.0" },
      });
      break;

    case "tools/list":
      if (pageSize > 0) {
        const cursor = typeof message.params?.cursor === "string"
          ? Number(message.params.cursor)
          : 0;
        const batch = TOOLS.slice(cursor, cursor + pageSize);
        const nextCursor = cursor + pageSize < TOOLS.length
          ? String(cursor + pageSize)
          : undefined;
        respond({ tools: batch, nextCursor });
      } else {
        respond({ tools: TOOLS });
      }
      break;

    case "tools/call": {
      const { name, arguments: args = {} } = message.params ?? {};
      switch (name) {
        case "echo":
          respond({
            content: [{ type: "text", text: `echo: ${args.text ?? ""}` }],
          });
          break;
        case "fail":
          respond({
            isError: true,
            content: [{ type: "text", text: `fail: ${args.message ?? "boom"}` }],
          });
          break;
        case "slow": {
          const delay = args.delayMs ?? 100;
          setTimeout(() => {
            respond({ content: [{ type: "text", text: "slow done" }] });
          }, delay);
          break;
        }
        case "image":
          respond({
            content: [
              {
                type: "image",
                mimeType: "image/png",
                data: "U3RhY2s=",
              },
              { type: "text", text: "got an image" },
            ],
          });
          break;
        case "crash":
          // 退出进程，客户端应观察到连接关闭。
          respondError(-32000, "crashing");
          process.exit(1);
          break;
        default:
          respondError(-32602, `Unknown tool: ${name}`);
      }
      break;
    }

    default:
      respondError(-32601, `Method not found: ${message.method}`);
  }
}
