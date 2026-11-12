import { readFileSync } from "node:fs";
import { collectDiff, createExecGit, DIFF_LIMITS } from "./collect-diff.mjs";
import { runReview } from "./review-client.mjs";
import { publishReview } from "./publish-comments.mjs";

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`缺少必需环境变量 ${name}`);
  return value;
}

function parsePositiveInt(rawValue, fallback) {
  if (rawValue === undefined || rawValue === "") return fallback;
  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`环境变量必须是正整数：${rawValue}`);
  }
  return parsed;
}

function parseBooleanFlag(rawValue, defaultValue) {
  if (rawValue === undefined || rawValue === "") return defaultValue;
  if (rawValue === "true") return true;
  if (rawValue === "false") return false;
  throw new Error(`布尔环境变量只支持 true/false，收到：${rawValue}`);
}

function shouldFailOnSeverity(setting, findings) {
  if (setting === "never" || setting === "") return false;
  if (setting !== "P0" && setting !== "P1") {
    throw new Error(`PR_REVIEW_FAIL_ON_SEVERITY 只支持 never/P0/P1，收到：${setting}`);
  }
  const order = { P0: 0, P1: 1 };
  const threshold = order[setting];
  return findings.some((finding) => finding.severity !== "suggestion" && order[finding.severity] <= threshold);
}

async function main() {
  const token = requiredEnv("GITHUB_TOKEN");
  const apiKey = requiredEnv("DEEPSEEK_API_KEY");
  const eventPath = requiredEnv("GITHUB_EVENT_PATH");
  const model = process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";
  const baseUrl = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
  const apiBase = process.env.GITHUB_API_URL || "https://api.github.com";
  const maxFindings = parsePositiveInt(process.env.PR_REVIEW_MAX_FINDINGS, 20);
  const maxTokens = parsePositiveInt(process.env.PR_REVIEW_MAX_TOKENS, 8000);
  const disableThinking = parseBooleanFlag(process.env.PR_REVIEW_DISABLE_THINKING, true);
  const failOnSeverity = process.env.PR_REVIEW_FAIL_ON_SEVERITY || "never";
  const botLogin = process.env.PR_REVIEW_BOT_LOGIN || "github-actions[bot]";

  const event = JSON.parse(readFileSync(eventPath, "utf8"));
  const repository = event.repository;
  if (!repository?.owner?.login || !repository?.name) {
    throw new Error("事件缺少 repository.owner.login/repository.name");
  }

  const execGit = createExecGit(process.cwd());
  const diffBundle = collectDiff({ event, execGit, limits: DIFF_LIMITS });
  console.log(
    `PR #${diffBundle.prNumber} 收集到 ${diffBundle.files.length} 个文件，diff ${diffBundle.totalBytes} 字节，缺口 ${diffBundle.coverageGaps.length} 项`,
  );

  const result = await runReview({
    event,
    diffBundle,
    baseUrl,
    apiKey,
    model,
    maxFindings,
    maxTokens,
    disableThinking,
  });
  console.log(`模型 ${model} @ ${new URL(baseUrl).host} 返回 ${result.findings.length} 条 finding：${result.summary}`);

  const publishResult = await publishReview({
    apiBase,
    token,
    owner: repository.owner.login,
    repo: repository.name,
    prNumber: diffBundle.prNumber,
    headSha: diffBundle.headSha,
    baseSha: diffBundle.baseSha,
    result,
    diffBundle,
    botLogin,
    maxInline: maxFindings,
  });
  const action = publishResult.refreshed ? "已刷新" : "已创建";
  console.log(
    `review ${publishResult.reviewId} ${action}：行内评论 ${publishResult.inlineCount} 条，汇总条目 ${publishResult.summaryOnlyCount} 条，清理旧行内评论 ${publishResult.deletedComments} 条`,
  );

  if (shouldFailOnSeverity(failOnSeverity, result.findings)) {
    console.error(`发现达到 ${failOnSeverity} 级别的缺陷，按 PR_REVIEW_FAIL_ON_SEVERITY 配置以非零码退出`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`PR 自动审查失败：${error.message}`);
  process.exit(1);
});
