import { readFile, writeFile } from "node:fs/promises";

import { z } from "zod";

import { defineTool, ToolExecutionError } from "../tools.js";
import type { ExecutionMode } from "../domain/conversation.js";
import {
  createWorkspacePathResolver,
  decodeTextContent,
  rethrowFileNotFound,
} from "./path.js";

export async function createEditTool(
  workspaceRoot: string,
  executionMode: ExecutionMode = "workspace_sandbox",
) {
  const paths = await createWorkspacePathResolver(
    workspaceRoot,
    undefined,
    executionMode,
  );

  return defineTool({
    name: "edit",
    description: executionMode === "full_access"
      ? "Replace an exact text match in any UTF-8 host file available to the current user. The match must be unique unless replaceAll is true."
      : "Replace an exact text match in a UTF-8 workspace file. The match must be unique unless replaceAll is true.",
    impact: executionMode === "full_access"
      ? "Modifies matching text in one file anywhere the host user can access."
      : "Modifies matching text in one existing workspace file.",
    inputSchema: z.strictObject({
      path: z.string().min(1),
      oldText: z.string().min(1),
      newText: z.string(),
      replaceAll: z.boolean().optional(),
    }),
    async execute(input, context) {
      context.signal?.throwIfAborted();
      const resolvedPath = await paths.resolveExisting(input.path);
      let contentBuffer: Buffer;
      try {
        contentBuffer = await readFile(resolvedPath);
      } catch (error) {
        return rethrowFileNotFound(error, input.path);
      }
      context.signal?.throwIfAborted();
      const content = decodeTextContent(contentBuffer, input.path);

      const matches = countMatches(content, input.oldText);
      if (matches === 0 || (!input.replaceAll && matches !== 1)) {
        throw new ToolExecutionError(
          "EDIT_CONFLICT",
          matches === 0
            ? `Text to replace was not found in ${input.path}.`
            : `Text to replace matched ${matches} times in ${input.path}; set replaceAll to replace every match.`,
        );
      }

      const updatedContent = input.replaceAll
        ? content.replaceAll(input.oldText, input.newText)
        : content.replace(input.oldText, input.newText);
      try {
        await writeFile(resolvedPath, updatedContent, "utf8");
      } catch (error) {
        return rethrowFileNotFound(error, input.path);
      }
      context.signal?.throwIfAborted();

      return {
        path: input.path,
        replacements: input.replaceAll ? matches : 1,
        bytesWritten: Buffer.byteLength(updatedContent, "utf8"),
      };
    },
  });
}

function countMatches(content: string, search: string): number {
  let count = 0;
  let offset = 0;
  while ((offset = content.indexOf(search, offset)) !== -1) {
    count += 1;
    offset += search.length;
  }
  return count;
}
