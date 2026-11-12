import { spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";

export const DIFF_LIMITS = {
  totalBytes: 60_000,
  perFileBytes: 20_000,
  maxFiles: 50,
};

// git diff 保留 3 行上下文，hunk 内的上下文行同样属于 GitHub 行内评论可落点的右侧行。
export const DIFF_CONTEXT_LINES = 3;

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_GIT_HEADER = /^diff --git a\/(.+) b\/(.+)$/;

export function createExecGit(cwd = process.cwd()) {
  return function execGit(args) {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
    }
    return result.stdout;
  };
}

export function parseDiff(diffText, limits = DIFF_LIMITS) {
  const files = [];
  const gaps = [];
  let current = null;
  let currentHunk = null;

  const flush = () => {
    if (!current) return;
    if (current.binary) {
      gaps.push(`${current.path}: 二进制文件未审查`);
    } else {
      files.push(current);
    }
  };

  for (const line of diffText.split("\n")) {
    const gitMatch = line.match(DIFF_GIT_HEADER);
    if (gitMatch) {
      flush();
      current = { path: gitMatch[2], hunks: [], diffLines: [], binary: false, truncated: false };
      currentHunk = null;
      continue;
    }
    if (!current) continue;
    if (line.startsWith("Binary files ")) {
      current.binary = true;
      continue;
    }
    const hunkMatch = line.match(HUNK_HEADER);
    if (hunkMatch) {
      currentHunk = {
        newStart: Number(hunkMatch[3]),
        newCount: Number(hunkMatch[4] ?? "1"),
        addedLines: [],
        contextLines: [],
        cursor: Number(hunkMatch[3]),
      };
      current.hunks.push(currentHunk);
      current.diffLines.push(line);
      continue;
    }
    if (currentHunk && (line.startsWith("+") || line.startsWith(" "))) {
      if (line.startsWith("+")) {
        currentHunk.addedLines.push(currentHunk.cursor);
      } else {
        currentHunk.contextLines.push(currentHunk.cursor);
      }
      currentHunk.cursor += 1;
      current.diffLines.push(line);
    } else if (line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ")) {
      current.diffLines.push(line);
    }
  }
  flush();

  return applyLimits(files, gaps, limits);
}

function applyLimits(files, gaps, limits) {
  const kept = [];
  let usedBytes = 0;

  if (files.length > limits.maxFiles) {
    const skipped = files.splice(limits.maxFiles);
    gaps.push(`审查文件数超过 ${limits.maxFiles} 个，跳过 ${skipped.length} 个文件：${skipped.map((f) => f.path).join(", ")}`);
  }

  for (const file of files) {
    let text = file.diffLines.join("\n");
    const fileBytes = Buffer.byteLength(text);
    if (fileBytes > limits.perFileBytes) {
      text = truncateLines(file.diffLines, limits.perFileBytes);
      file.truncated = true;
      gaps.push(`${file.path}: 单文件 diff 超过 ${limits.perFileBytes} 字节，已按行截断，该文件不发行内评论`);
    }
    const chunkBytes = Buffer.byteLength(text);
    if (usedBytes + chunkBytes > limits.totalBytes) {
      gaps.push(`${file.path} 及之后的文件：diff 总量超过 ${limits.totalBytes} 字节，未送审`);
      break;
    }
    file.diffText = text;
    usedBytes += chunkBytes;
    kept.push(file);
  }

  return { files: kept, coverageGaps: gaps, totalBytes: usedBytes };
}

function truncateLines(lines, maxBytes) {
  const keptLines = [];
  let usedBytes = 0;
  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line) + (keptLines.length > 0 ? 1 : 0);
    if (usedBytes + lineBytes > maxBytes) break;
    keptLines.push(line);
    usedBytes += lineBytes;
  }
  // 单行本身超限时至少保留第一行，避免产出空 diff；truncated 标记仍由调用方设置。
  if (keptLines.length === 0 && lines.length > 0) {
    keptLines.push(lines[0]);
  }
  return keptLines.join("\n");
}

export function collectDiff({ event, execGit, limits = DIFF_LIMITS }) {
  const pullRequest = event?.pull_request;
  if (!pullRequest?.number || !pullRequest?.base?.sha || !pullRequest?.head?.sha) {
    throw new Error("事件缺少 pull_request.number/base.sha/head.sha，无法确定审查对象");
  }

  const baseSha = pullRequest.base.sha;
  const headSha = pullRequest.head.sha;
  const mergeBase = execGit(["merge-base", baseSha, headSha]).trim();
  const diffText = execGit(["diff", `--unified=${DIFF_CONTEXT_LINES}`, `${mergeBase}...${headSha}`]);

  if (!diffText.trim()) {
    throw new Error("merge-base 到 head 的 diff 为空，没有可审查内容");
  }

  const parsed = parseDiff(diffText, limits);
  return {
    prNumber: pullRequest.number,
    baseSha,
    headSha,
    mergeBase,
    files: parsed.files,
    coverageGaps: parsed.coverageGaps,
    totalBytes: parsed.totalBytes,
  };
}
