import { startAgentServer } from "./server-bootstrap.js";

const server = await startAgentServer();

const shutdown = (): void => {
  void server.close().catch((error: unknown) => {
    console.error("Agent server shutdown failed.", error);
    process.exitCode = 1;
  });
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
