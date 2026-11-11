// 后端桌面宿主入口：在打包进应用的独立 Node 中运行，通过父进程 IPC 通道
// 报告监听地址并接收唯一一条 shutdown 消息。所有业务清理都走 close()，
// 与 Web 入口 server-main.ts 共用同一份装配。环境变量与 cwd 由主进程准备。
//
// 独立 Node 不提供 process.parentPort（那是 Electron utilityProcess 的 API），
// 这里用 child_process IPC 的 process.on("message") / process.send()；
// process.on("disconnect") 对应当前端主进程退出。
import { startAgentServer } from "../dist/src/server-bootstrap.js";

let server;
try {
  server = await startAgentServer({ port: 0 });
} catch (error) {
  console.error("Agent server failed to start.", error);
  process.exit(1);
}

console.log(`Agent SSE server listening on ${server.url}`);
if (typeof process.send !== "function") {
  // 不经桌面主进程直接运行（例如排障）时仍提供服务，但没有 ready 和 shutdown 协调。
  console.warn("No parent IPC channel; ready and shutdown messages are disabled.");
} else {
  process.send({ type: "ready", url: server.url });
  process.on("message", (message) => {
    if (message?.type === "shutdown") shutdown("ipc shutdown");
  });
  process.on("disconnect", () => shutdown("parent disconnected"));
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

// 关闭只发起一次：重复的 shutdown 消息、父通道断开和信号都复用它，
// 由 server.close() 的幂等性保证只清理一次。
let shuttingDown = false;
function shutdown(source) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Shutting down backend (${source}).`);
  server.close().then(
    () => {
      if (typeof process.disconnect === "function" && process.connected) {
        process.disconnect();
      }
      process.exit(0);
    },
    (error) => {
      console.error("Agent server shutdown failed.", error);
      process.exit(1);
    },
  );
}
