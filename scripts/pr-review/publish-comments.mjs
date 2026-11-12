export const REVIEW_MARKER_PREFIX = "<!-- pr-auto-review";
export const DEFAULT_BOT_LOGIN = "github-actions[bot]";
export const DEFAULT_MAX_INLINE_COMMENTS = 20;

export function buildMarker(headSha, baseSha) {
  return `${REVIEW_MARKER_PREFIX} head=${headSha} base=${baseSha} -->`;
}

export function findDiffFile(diffBundle, path) {
  return diffBundle.files.find((file) => file.path === path) ?? null;
}

export function isLineInDiff(fileEntry, line) {
  return fileEntry.hunks.some(
    (hunk) => hunk.addedLines.includes(line) || hunk.contextLines.includes(line),
  );
}

function formatFinding(finding) {
  return [
    `**${finding.severity} · ${finding.title}**`,
    `位置：${finding.path}${finding.line ? `:${finding.line}` : ""}`,
    `证据：${finding.evidence}`,
    `修复方向：${finding.suggestion}`,
  ].join("\n\n");
}

export function buildReviewBody({ result, summaryOnlyFindings, inlineOverflowCount, headSha, baseSha }) {
  const counts = { P0: 0, P1: 0, P2: 0, suggestion: 0 };
  for (const finding of result.findings) counts[finding.severity] += 1;

  const sections = [
    "## PR 自动审查",
    result.summary,
    `统计：P0 ${counts.P0}，P1 ${counts.P1}，P2 ${counts.P2}，非阻塞建议 ${counts.suggestion}`,
  ];

  if (inlineOverflowCount > 0) {
    sections.push(`行内评论达到上限，另有 ${inlineOverflowCount} 条 finding 转为下方汇总条目。`);
  }

  if (summaryOnlyFindings.length > 0) {
    sections.push("### 仅汇总条目（行号无法映射、文件已截断或超过行内评论上限）");
    sections.push(summaryOnlyFindings.map(formatFinding).join("\n\n---\n\n"));
  }

  if (result.coverageGaps.length > 0) {
    sections.push("### 覆盖缺口");
    sections.push(result.coverageGaps.map((gap) => `- ${gap}`).join("\n"));
  }

  sections.push(buildMarker(headSha, baseSha));
  return sections.join("\n\n");
}

function buildHeaders(token) {
  return {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "content-type": "application/json",
    "user-agent": "pr-auto-review-action",
  };
}

async function githubRequest({ apiBase, token, path, method = "GET", body, fetchImpl = fetch }) {
  const response = await fetchImpl(`${apiBase}/repos${path}`, {
    method,
    headers: buildHeaders(token),
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GitHub API ${method} ${path} 失败：${response.status} ${text.slice(0, 500)}`);
  }
  return text ? JSON.parse(text) : null;
}

const COMMENT_PAGE_SIZE = 100;
const MAX_COMMENT_PAGES = 10;

// GitHub 不允许删除已提交的 review：REST DELETE 与 GraphQL deletePullRequestReview
// 都只接受 pending 态，对 COMMENT review 返回 422（测试 PR 实测确认）。
// 因此每个 PR 保留一条持久 bot review，复审时 PUT 更新 body；行内评论属于可独立
// 删除的 pull request review comment，按 bot login 过滤后逐条删除再重建。
export function findLatestBotReview(reviews, botLogin = DEFAULT_BOT_LOGIN) {
  const matched = reviews.filter(
    (review) =>
      review.user?.login === botLogin &&
      typeof review.body === "string" &&
      review.body.includes(REVIEW_MARKER_PREFIX),
  );
  return matched.at(-1) ?? null;
}

// 先拉全所有页收集待删 id，再统一删除。边翻页边删除会让 offset 分页前移，
// 后续 page 请求返回偏移后的集合，跳过部分条目。
export async function listBotReviewCommentIds({
  apiBase,
  token,
  owner,
  repo,
  prNumber,
  botLogin = DEFAULT_BOT_LOGIN,
  fetchImpl,
}) {
  const ids = [];
  for (let page = 1; page <= MAX_COMMENT_PAGES; page += 1) {
    const batch = await githubRequest({
      apiBase,
      token,
      path: `/${owner}/${repo}/pulls/${prNumber}/comments?per_page=${COMMENT_PAGE_SIZE}&page=${page}`,
      fetchImpl,
    });
    for (const comment of batch) {
      if (comment.user?.login === botLogin) ids.push(comment.id);
    }
    if (batch.length < COMMENT_PAGE_SIZE) break;
  }
  return ids;
}

export async function deleteBotReviewComments(params) {
  const ids = await listBotReviewCommentIds(params);
  let deleted = 0;
  for (const id of ids) {
    await githubRequest({
      apiBase: params.apiBase,
      token: params.token,
      method: "DELETE",
      path: `/${params.owner}/${params.repo}/pulls/comments/${id}`,
      fetchImpl: params.fetchImpl,
    });
    deleted += 1;
  }
  return deleted;
}

export function splitFindings(result, diffBundle, maxInline = DEFAULT_MAX_INLINE_COMMENTS) {
  const inlineComments = [];
  const summaryOnlyFindings = [];

  for (const finding of result.findings) {
    const fileEntry = findDiffFile(diffBundle, finding.path);
    const canPlaceInline =
      finding.line !== undefined &&
      fileEntry !== null &&
      !fileEntry.truncated &&
      isLineInDiff(fileEntry, finding.line);

    if (canPlaceInline && inlineComments.length < maxInline) {
      inlineComments.push({
        path: finding.path,
        line: finding.line,
        side: "RIGHT",
        body: formatFinding(finding),
      });
    } else {
      summaryOnlyFindings.push(finding);
    }
  }

  return { inlineComments, summaryOnlyFindings };
}

export async function publishReview({
  apiBase = "https://api.github.com",
  token,
  owner,
  repo,
  prNumber,
  headSha,
  baseSha,
  result,
  diffBundle,
  botLogin = DEFAULT_BOT_LOGIN,
  maxInline = DEFAULT_MAX_INLINE_COMMENTS,
  fetchImpl,
}) {
  const { inlineComments, summaryOnlyFindings } = splitFindings(result, diffBundle, maxInline);
  const mappableCount = result.findings.filter((finding) => {
    const fileEntry = findDiffFile(diffBundle, finding.path);
    return finding.line !== undefined && fileEntry !== null && !fileEntry.truncated && isLineInDiff(fileEntry, finding.line);
  }).length;
  const inlineOverflowCount = Math.max(0, mappableCount - inlineComments.length);
  const body = buildReviewBody({ result, summaryOnlyFindings, inlineOverflowCount, headSha, baseSha });

  const reviews = await githubRequest({
    apiBase,
    token,
    path: `/${owner}/${repo}/pulls/${prNumber}/reviews`,
    fetchImpl,
  });
  const existingReview = findLatestBotReview(reviews, botLogin);

  if (!existingReview) {
    const review = await githubRequest({
      apiBase,
      token,
      method: "POST",
      path: `/${owner}/${repo}/pulls/${prNumber}/reviews`,
      body: {
        commit_id: headSha,
        event: "COMMENT",
        body,
        comments: inlineComments,
      },
      fetchImpl,
    });
    return {
      reviewId: review?.id ?? null,
      refreshed: false,
      inlineCount: inlineComments.length,
      summaryOnlyCount: summaryOnlyFindings.length,
      deletedComments: 0,
    };
  }

  // 复审：已提交 review 无法删除，保留同一条 review 并 PUT 刷新 body。
  // 先快照 bot 自身的旧行内评论 id，再 PUT body、POST 新评论，全部成功后才删除旧评论。
  // 任一步提前失败时旧审查结果仍然完整，下一轮运行会重新收集 id 并自愈清理。
  const staleCommentIds = await listBotReviewCommentIds({
    apiBase,
    token,
    owner,
    repo,
    prNumber,
    botLogin,
    fetchImpl,
  });
  await githubRequest({
    apiBase,
    token,
    method: "PUT",
    path: `/${owner}/${repo}/pulls/${prNumber}/reviews/${existingReview.id}`,
    body: { body },
    fetchImpl,
  });
  for (const comment of inlineComments) {
    await githubRequest({
      apiBase,
      token,
      method: "POST",
      path: `/${owner}/${repo}/pulls/${prNumber}/comments`,
      body: {
        commit_id: headSha,
        path: comment.path,
        line: comment.line,
        side: comment.side,
        body: comment.body,
      },
      fetchImpl,
    });
  }
  let deletedComments = 0;
  for (const id of staleCommentIds) {
    await githubRequest({
      apiBase,
      token,
      method: "DELETE",
      path: `/${owner}/${repo}/pulls/comments/${id}`,
      fetchImpl,
    });
    deletedComments += 1;
  }

  return {
    reviewId: existingReview.id,
    refreshed: true,
    inlineCount: inlineComments.length,
    summaryOnlyCount: summaryOnlyFindings.length,
    deletedComments,
  };
}
