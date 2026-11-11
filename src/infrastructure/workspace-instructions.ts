import { constants } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import { readFilePrefix } from "./read-file-prefix.js";

const MAX_WORKSPACE_INSTRUCTIONS_BYTES = 64 * 1024;

export async function loadWorkspaceInstructions(
  canonicalWorkspaceRoot: string,
): Promise<string | undefined> {
  const instructionsPath = join(canonicalWorkspaceRoot, "AGENTS.md");

  try {
    await lstat(instructionsPath);
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw error;
  }

  const resolvedWorkspaceRoot = await realpath(canonicalWorkspaceRoot);
  let resolvedInstructionsPath: string;
  try {
    resolvedInstructionsPath = await realpath(instructionsPath);
  } catch (error) {
    if (isMissingPathError(error)) {
      throw new Error(
        `Workspace instructions must resolve to a regular file: ${instructionsPath}`,
      );
    }
    throw error;
  }
  if (!isWithin(resolvedWorkspaceRoot, resolvedInstructionsPath)) {
    throw new Error(
      `Workspace instructions must remain inside the workspace: ${instructionsPath}`,
    );
  }

  let file: FileHandle;
  try {
    file = await open(
      resolvedInstructionsPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    if (isMissingPathError(error) || isSymbolicLinkError(error)) {
      throw new Error(
        `Workspace instructions must resolve to a regular file: ${instructionsPath}`,
      );
    }
    throw error;
  }

  try {
    const fileStats = await file.stat();
    if (!fileStats.isFile()) {
      throw new Error(
        `Workspace instructions must be a regular file: ${instructionsPath}`,
      );
    }
    if (fileStats.size > MAX_WORKSPACE_INSTRUCTIONS_BYTES) {
      throwInstructionsTooLarge(instructionsPath);
    }

    const content = await readFilePrefix(file, MAX_WORKSPACE_INSTRUCTIONS_BYTES + 1);
    if (content.byteLength > MAX_WORKSPACE_INSTRUCTIONS_BYTES) {
      throwInstructionsTooLarge(instructionsPath);
    }
    if (content.byteLength === 0) return undefined;

    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(content);
    } catch {
      throw new Error(
        `Workspace instructions must be valid UTF-8: ${instructionsPath}`,
      );
    }
  } finally {
    await file.close();
  }
}

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" ||
    (!pathFromRoot.startsWith(`..${sep}`) &&
      pathFromRoot !== ".." &&
      !isAbsolute(pathFromRoot));
}

function throwInstructionsTooLarge(instructionsPath: string): never {
  throw new Error(
    `Workspace instructions exceed ${MAX_WORKSPACE_INSTRUCTIONS_BYTES} bytes: ${instructionsPath}`,
  );
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function isSymbolicLinkError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ELOOP"
  );
}
