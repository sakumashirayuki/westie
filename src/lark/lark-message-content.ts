/**
 * 飞书出站消息的 content 构造与尺寸约束。
 *
 * 飞书 text 消息按纯文本渲染，Agent 回答里的 Markdown 语法会原样露出。post 富文本
 * 消息的 md 标签由飞书原生渲染器按 CommonMark 0.31 + GFM 渲染（标题、加粗、表格、
 * 代码块、删除线等），结构与官方文档及 SDK 内置 markdownToPost 的输出一致：
 *
 * content = JSON.stringify({
 *   zh_cn: { title: "", content: [[{ tag: "md", text: markdown }]] },
 * })
 *
 * 尺寸上，post 消息请求体上限 30 KiB（超限飞书返回 230001）。SDK 发请求时会对 data
 * 再做一次 JSON.stringify，md 原文中的特殊字符经历双层转义，本模块按真实线上字节数
 * 做切片预算，保证每片连同包装与标识字段都在上限内。
 */

/** post / 卡片消息请求体上限（字节）。 */
export const POST_MESSAGE_REQUEST_LIMIT_BYTES = 30 * 1024;

/** chat_id 与派生 uuid 的保守占位长度，用于计算与具体标识无关的固定开销。 */
const MAX_CHAT_ID_PLACEHOLDER = "o".repeat(64);
const MAX_UUID_PLACEHOLDER = "u".repeat(128);

/**
 * 除 md 原文外的固定请求体字节数：外层字段、post 包装与双层转义，按最长占位标识
 * 实测得到；真实标识更短时，余量自动变大。
 */
const POST_REQUEST_FIXED_OVERHEAD_BYTES = measurePostRequestBytes("", {
  chatId: MAX_CHAT_ID_PLACEHOLDER,
  uuid: MAX_UUID_PLACEHOLDER,
});

/** 单片 md 原文可用的线上字节预算。 */
export const MAX_POST_MARKDOWN_CHUNK_BYTES =
  POST_MESSAGE_REQUEST_LIMIT_BYTES - POST_REQUEST_FIXED_OVERHEAD_BYTES;

/**
 * 构造 post 消息的 content 字符串：单段 md 元素承载整段 Markdown 原文。
 * 调用方保证 markdown 非空（终态回答为空时上游已替换为固定文案）。
 */
export function buildPostContent(markdown: string): string {
  return JSON.stringify({
    zh_cn: {
      title: "",
      content: [[{ tag: "md", text: markdown }]],
    },
  });
}

/**
 * 完整请求体的线上字节数：与 LarkClient 发送的 data 对象保持同一形态，
 * content 先序列化一次，整个 data 再随 HTTP 请求序列化一次。
 */
export function measurePostRequestBytes(
  markdown: string,
  ids: { readonly chatId: string; readonly uuid: string },
): number {
  return Buffer.byteLength(
    JSON.stringify({
      receive_id: ids.chatId,
      msg_type: "post",
      content: buildPostContent(markdown),
      uuid: ids.uuid,
    }),
    "utf8",
  );
}

/**
 * 单个字符进入双层 JSON 后的线上字节成本：
 * - 双引号与反斜杠经两次转义各占 4 字节；
 * - 换行等控制字符内层转义为两字符、外层再转义反斜杠，占 3 字节；
 * - 其余字符（含不转义的中文）保持 UTF-8 原字节数。
 */
function wireByteCost(char: string): number {
  if (char === '"' || char === "\\") return 4;
  if (char === "\n" || char === "\r" || char === "\t" || char === "\b" || char === "\f") {
    return 3;
  }
  return Buffer.byteLength(char, "utf8");
}

/** 与 findChunkEnd 同一套按 UTF-16 码元累加的线上字节口径。 */
function markdownWireBytes(text: string): number {
  let total = 0;
  for (let index = 0; index < text.length; index += 1) {
    total += wireByteCost(text[index]);
  }
  return total;
}

/**
 * 按 post 请求体预算切片 Markdown：优先在换行、其次空格处断开，不切断多字节字符。
 * 预算作用于线上字节数，引号、反斜杠较多的片段会自动切得更短。
 */
export function chunkMarkdownForPost(
  markdown: string,
  maxBytes: number = MAX_POST_MARKDOWN_CHUNK_BYTES,
): readonly string[] {
  if (markdownWireBytes(markdown) <= maxBytes) return [markdown];
  const result: string[] = [];
  let start = 0;
  while (start < markdown.length) {
    const end = findChunkEnd(markdown, start, maxBytes);
    result.push(markdown.slice(start, end));
    start = end;
  }
  return result;
}

/** 在 start 之后找片边界：累计线上字节不超预算，再尽量回退到最后一个换行 / 空格。 */
function findChunkEnd(text: string, start: number, maxBytes: number): number {
  let budget = maxBytes;
  let end = start;
  while (end < text.length) {
    // emoji 等辅助平面字符占两个 UTF-16 码元（代理对），必须整体计入或整体
    // 留下，否则切片两端会出现孤立代理，飞书侧渲染成乱码。
    const span = text.codePointAt(end)! > 0xffff ? 2 : 1;
    let cost = wireByteCost(text[end]!);
    if (span === 2) cost += wireByteCost(text[end + 1]!);
    if (budget - cost < 0) break;
    budget -= cost;
    end += span;
  }
  // 预算连第一个码点都装不下时仍要保证切片前进；遇到代理对一次推进两个码元。
  if (end <= start) {
    return start + (text.codePointAt(start)! > 0xffff ? 2 : 1);
  }
  const slice = text.slice(start, end);
  const lastBreak = Math.max(slice.lastIndexOf("\n"), slice.lastIndexOf(" "));
  if (lastBreak >= 0) return start + lastBreak + 1;
  return end;
}
