import { lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { WorkspaceGrantStore } from "../application/workspace-grant-store.js";
import type { ExecutionMode } from "../domain/conversation.js";
import { isSensitiveWorkspacePath } from "../security/sensitive-path-policy.js";
import {
  ToolExecutionError,
  type ToolExecutionContext,
  type WorkspaceGrantRequirement,
} from "../tools.js";

export interface WorkspacePathResolver {
  readonly root: string;
  resolveExisting(inputPath: string): Promise<string>;
  preflightReadable(
    inputPath: string,
    context?: ToolExecutionContext,
  ): Promise<WorkspaceGrantRequirement | undefined>;
  resolveReadable(
    inputPath: string,
    context?: ToolExecutionContext,
  ): Promise<string>;
  resolveWritable(inputPath: string): Promise<string>;
}

export async function createWorkspacePathResolver(
  workspaceRoot: string,
  workspaceGrantStore?: WorkspaceGrantStore,
  executionMode: ExecutionMode = "workspace_sandbox",
): Promise<WorkspacePathResolver> {
  const lexicalRoot = resolve(workspaceRoot);
  const root = await realpath(lexicalRoot);

  if (executionMode === "full_access") {
    return createFullAccessPathResolver(lexicalRoot, root);
  }

  return {
    root,
    async resolveExisting(inputPath) {
      const candidate = resolveCandidate(lexicalRoot, root, inputPath);
      const resolvedPath = await realpathOrFileNotFound(candidate, inputPath);
      assertInsideWorkspace(root, resolvedPath, inputPath);
      assertNotSensitiveWorkspacePath(
        lexicalRoot,
        root,
        candidate,
        resolvedPath,
      );
      return resolvedPath;
    },
    async preflightReadable(inputPath, context = {}) {
      const candidate = resolveAnyCandidate(lexicalRoot, inputPath);
      const resolvedPath = await resolveAnyExisting(
        lexicalRoot,
        inputPath,
      );
      const reason = readGrantReason(
        lexicalRoot,
        root,
        candidate,
        resolvedPath,
      );
      if (reason === undefined) return undefined;
      await assertRegularFile(resolvedPath, inputPath);
      const grant = toReadGrant(context, resolvedPath);
      if (
        workspaceGrantStore !== undefined &&
        grant !== undefined &&
        workspaceGrantStore.hasRead(grant)
      ) {
        return undefined;
      }
      return {
        kind: "workspace_grant",
        reason,
        requestedPath: resolvedPath,
        canonicalPath: resolvedPath,
        access: "read",
        scope: "once",
      };
    },
    async resolveReadable(inputPath, context = {}) {
      const candidate = resolveAnyCandidate(lexicalRoot, inputPath);
      const resolvedPath = await resolveAnyExisting(
        lexicalRoot,
        inputPath,
      );
      const reason = readGrantReason(
        lexicalRoot,
        root,
        candidate,
        resolvedPath,
      );
      if (reason === undefined) return resolvedPath;
      await assertRegularFile(resolvedPath, inputPath);
      const grant = toReadGrant(context, resolvedPath);
      if (
        workspaceGrantStore === undefined ||
        grant === undefined ||
        !workspaceGrantStore.consumeRead(grant)
      ) {
        throw reason === "sensitive_workspace_file"
          ? sensitiveFileError()
          : outsideWorkspaceError(inputPath);
      }
      return resolvedPath;
    },
    async resolveWritable(inputPath) {
      const candidate = resolveCandidate(lexicalRoot, root, inputPath);
      assertNotSensitiveWorkspacePath(lexicalRoot, root, candidate);

      try {
        await lstat(candidate);
      } catch (error) {
        if (!isMissingPathError(error)) throw error;

        const parent = await realpathOrFileNotFound(
          resolve(candidate, ".."),
          inputPath,
        );
        assertInsideWorkspace(root, parent, inputPath);
        return candidate;
      }

      const resolvedPath = await realpathOrFileNotFound(candidate, inputPath);
      assertInsideWorkspace(root, resolvedPath, inputPath);
      assertNotSensitiveWorkspacePath(
        lexicalRoot,
        root,
        candidate,
        resolvedPath,
      );
      return resolvedPath;
    },
  };
}

function createFullAccessPathResolver(
  lexicalRoot: string,
  root: string,
): WorkspacePathResolver {
  const candidateFor = (inputPath: string): string =>
    isAbsolute(inputPath)
      ? resolve(inputPath)
      : resolve(lexicalRoot, inputPath);

  return {
    root,
    async resolveExisting(inputPath) {
      return realpathOrFileNotFound(candidateFor(inputPath), inputPath);
    },
    async preflightReadable() {
      return undefined;
    },
    async resolveReadable(inputPath) {
      return realpathOrFileNotFound(candidateFor(inputPath), inputPath);
    },
    async resolveWritable(inputPath) {
      const candidate = candidateFor(inputPath);
      try {
        await lstat(candidate);
        return realpathOrFileNotFound(candidate, inputPath);
      } catch (error) {
        if (!isMissingPathError(error)) throw error;
        await realpathOrFileNotFound(resolve(candidate, ".."), inputPath);
        return candidate;
      }
    },
  };
}

async function resolveAnyExisting(
  lexicalRoot: string,
  inputPath: string,
): Promise<string> {
  const candidate = isAbsolute(inputPath)
    ? resolve(inputPath)
    : resolve(lexicalRoot, inputPath);
  return realpathOrFileNotFound(candidate, inputPath);
}

function resolveAnyCandidate(lexicalRoot: string, inputPath: string): string {
  return isAbsolute(inputPath)
    ? resolve(inputPath)
    : resolve(lexicalRoot, inputPath);
}

async function assertRegularFile(
  resolvedPath: string,
  inputPath: string,
): Promise<void> {
  const fileStats = await stat(resolvedPath);
  if (!fileStats.isFile()) {
    throw new ToolExecutionError(
      "FILE_NOT_FOUND",
      `File not found: ${inputPath}`,
    );
  }
}

function toReadGrant(
  context: ToolExecutionContext,
  canonicalPath: string,
):
  | {
      conversationId: string;
      toolCallId: string;
      canonicalPath: string;
    }
  | undefined {
  if (
    context.conversationId === undefined ||
    context.toolCallId === undefined
  ) {
    return undefined;
  }
  return {
    conversationId: context.conversationId,
    toolCallId: context.toolCallId,
    canonicalPath,
  };
}

export function decodeTextContent(content: Buffer, inputPath: string): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    throw new ToolExecutionError(
      "FILE_NOT_TEXT",
      `File is not UTF-8 text: ${inputPath}`,
    );
  }

  if (text.includes("\0")) {
    throw new ToolExecutionError(
      "FILE_NOT_TEXT",
      `File is not UTF-8 text: ${inputPath}`,
    );
  }
  return text;
}

export function rethrowFileNotFound(error: unknown, inputPath: string): never {
  if (isMissingPathError(error)) {
    throw new ToolExecutionError(
      "FILE_NOT_FOUND",
      `File not found: ${inputPath}`,
    );
  }
  throw error;
}

function resolveCandidate(
  lexicalRoot: string,
  realRoot: string,
  inputPath: string,
): string {
  const candidate = isAbsolute(inputPath)
    ? resolve(inputPath)
    : resolve(lexicalRoot, inputPath);
  if (
    !isInsideWorkspace(lexicalRoot, candidate) &&
    !isInsideWorkspace(realRoot, candidate)
  ) {
    throw outsideWorkspaceError(inputPath);
  }
  return candidate;
}

function assertInsideWorkspace(
  root: string,
  candidate: string,
  inputPath: string,
): void {
  if (!isInsideWorkspace(root, candidate)) {
    throw outsideWorkspaceError(inputPath);
  }
}

function isInsideWorkspace(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return !(
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  );
}

function outsideWorkspaceError(inputPath: string): ToolExecutionError {
  return new ToolExecutionError(
    "PATH_OUTSIDE_WORKSPACE",
    `Path is outside the workspace: ${inputPath}`,
  );
}

function sensitiveFileError(): ToolExecutionError {
  return new ToolExecutionError(
    "SENSITIVE_FILE_ACCESS_DENIED",
    "Sensitive workspace file access was not authorized.",
  );
}

function readGrantReason(
  lexicalRoot: string,
  realRoot: string,
  lexicalPath: string,
  canonicalPath: string,
): WorkspaceGrantRequirement["reason"] | undefined {
  if (!isInsideWorkspace(realRoot, canonicalPath)) {
    return "outside_workspace";
  }
  return isSensitiveWorkspacePath(lexicalRoot, lexicalPath) ||
      isSensitiveWorkspacePath(realRoot, canonicalPath)
    ? "sensitive_workspace_file"
    : undefined;
}

function assertNotSensitiveWorkspacePath(
  lexicalRoot: string,
  realRoot: string,
  lexicalPath: string,
  canonicalPath?: string,
): void {
  if (
    isSensitiveWorkspacePath(lexicalRoot, lexicalPath) ||
    (canonicalPath !== undefined &&
      isSensitiveWorkspacePath(realRoot, canonicalPath))
  ) {
    throw sensitiveFileError();
  }
}

async function realpathOrFileNotFound(
  candidate: string,
  inputPath: string,
): Promise<string> {
  try {
    return await realpath(candidate);
  } catch (error) {
    return rethrowFileNotFound(error, inputPath);
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}
