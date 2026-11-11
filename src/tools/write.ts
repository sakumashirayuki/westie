import { writeFile } from "node:fs/promises";

import { z } from "zod";

import { defineTool } from "../tools.js";
import type { ExecutionMode } from "../domain/conversation.js";
import {
  createWorkspacePathResolver,
  rethrowFileNotFound,
} from "./path.js";

export async function createWriteTool(
  workspaceRoot: string,
  executionMode: ExecutionMode = "workspace_sandbox",
) {
  const paths = await createWorkspacePathResolver(
    workspaceRoot,
    undefined,
    executionMode,
  );

  return defineTool({
    name: "write",
    description: executionMode === "full_access"
      ? "Create or completely overwrite any UTF-8 host file available to the current user."
      : "Create or completely overwrite a UTF-8 workspace file.",
    impact: executionMode === "full_access"
      ? "Creates or completely overwrites one file anywhere the host user can access."
      : "Creates or completely overwrites one file inside the workspace.",
    inputSchema: z.strictObject({
      path: z.string().min(1),
      content: z.string(),
    }),
    async execute(input, context) {
      context.signal?.throwIfAborted();
      const resolvedPath = await paths.resolveWritable(input.path);
      try {
        await writeFile(resolvedPath, input.content, "utf8");
      } catch (error) {
        return rethrowFileNotFound(error, input.path);
      }
      context.signal?.throwIfAborted();

      return {
        path: input.path,
        bytesWritten: Buffer.byteLength(input.content, "utf8"),
      };
    },
  });
}
