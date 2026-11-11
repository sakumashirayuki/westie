// 评测入口：与 server-main 共用同一份装配，只把目录选择器换成固定目录，
// 让建会话不弹原生对话框，评测可以无人值守。业务代码不知道评测的存在。
//
//   node --env-file=.env scripts/eval-server.mjs /abs/path/to/eval-repo
import { isAbsolute } from "node:path";
import { startAgentServer } from "../dist/src/server-bootstrap.js";

const workspaceRoot = process.argv[2];
if (workspaceRoot === undefined || !isAbsolute(workspaceRoot)) {
  console.error("usage: eval-server.mjs <absolute workspace path>");
  process.exit(2);
}

const server = await startAgentServer({
  hostDirectoryPicker: {
    async pickDirectory(signal) {
      signal?.throwIfAborted();
      return { status: "selected", path: workspaceRoot };
    },
  },
});
const shutdown = () => {
  void server.close().catch((error) => {
    console.error("Eval server shutdown failed.", error);
    process.exitCode = 1;
  });
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
console.log(`Eval server: every new conversation binds ${workspaceRoot}.`);
