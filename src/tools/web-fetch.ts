import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

import { z } from "zod";

import type { ExecutionMode } from "../domain/conversation.js";
import {
  isBlockedAddress,
  isBlockedHostname,
} from "../security/network-address-policy.js";
import type { JsonValue } from "../protocol.js";
import { defineTool, ToolExecutionError, type Tool } from "../tools.js";
import { decodeEntities, htmlToText } from "./html-to-text.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;
const MAX_FETCH_BODY_BYTES = 2 * 1024 * 1024;
const MAX_FETCH_TEXT_BYTES = 48 * 1024;
const MAX_LINE_LIMIT = 1_000;

const USER_AGENT = "my-agent-harness/0.1";

export interface LookupAddress {
  readonly address: string;
  readonly family: number;
}

export type Lookup = (
  hostname: string,
  options: { readonly all: true },
) => Promise<LookupAddress[]>;

export interface WebFetchToolOptions {
  readonly executionMode: ExecutionMode;
  readonly fetch?: typeof globalThis.fetch;
  readonly lookup?: Lookup;
  readonly timeoutMs?: number;
}

export function createWebFetchTool(options: WebFetchToolOptions): Tool {
  const executionMode = options.executionMode;
  const fetchRequest = options.fetch ?? globalThis.fetch;
  const lookup = options.lookup ??
    ((hostname: string, opts: { readonly all: true }) =>
      dnsLookup(hostname, opts));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return defineTool({
    name: "web_fetch",
    description:
      "Fetch a public http(s) URL and return its readable text. HTML is converted to text with headings, lists and links preserved; offset/limit page through long pages like read.",
    impact: executionMode === "workspace_sandbox"
      ? "Fetches a public http(s) URL from the Harness main process; public addresses only."
      : "Fetches an http(s) URL from the Harness main process without address checks.",
    maxOutputBytes: 96 * 1024,
    inputSchema: z.strictObject({
      url: z.string().url(),
      offset: z.int().positive().optional(),
      limit: z.int().positive().max(MAX_LINE_LIMIT).optional(),
    }),
    summarizeInput({ url }) {
      return { url };
    },
    async execute({ url, offset, limit }, context) {
      const timeoutController = new AbortController();
      const timeout = setTimeout(
        () => timeoutController.abort(
          new DOMException("Fetch timed out.", "TimeoutError"),
        ),
        timeoutMs,
      );
      const signal = context.signal === undefined
        ? timeoutController.signal
        : AbortSignal.any([context.signal, timeoutController.signal]);
      try {
        return await fetchWithRedirects({
          url,
          fetchRequest,
          lookup,
          executionMode,
          signal,
          offset,
          limit,
        });
      } finally {
        clearTimeout(timeout);
      }
    },
  });
}

interface FetchResult {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  title?: string;
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
}

async function fetchWithRedirects(args: {
  url: string;
  fetchRequest: typeof globalThis.fetch;
  lookup: Lookup;
  executionMode: ExecutionMode;
  signal: AbortSignal;
  offset?: number;
  limit?: number;
}): Promise<JsonValue> {
  let currentUrl = args.url;
  for (let jump = 0; jump <= MAX_REDIRECTS; jump += 1) {
    await checkUrl(currentUrl, args.executionMode, args.lookup);

    const response = await doFetch(args.fetchRequest, currentUrl, args.signal);
    const status = response.status;

    if (status >= 300 && status < 400) {
      const location = response.headers.get("location");
      // 消费并丢弃响应体，避免连接泄漏。
      await response.body?.cancel();
      if (location === null) {
        throw new ToolExecutionError(
          "FETCH_FAILED",
          `Redirect without a Location header (HTTP ${status}).`,
        );
      }
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }

    const contentType = response.headers.get("content-type") ?? "";

    if (!response.ok) {
      await response.body?.cancel();
      throw new ToolExecutionError(
        "FETCH_FAILED",
        `Fetch failed with HTTP ${status}.`,
      );
    }

    const body = await readBody(response);
    const converted = convertBody(body, contentType, currentUrl);
    return paginate(
      converted.text,
      currentUrl,
      status,
      contentType,
      converted.title,
      args.offset,
      args.limit,
    ) as unknown as JsonValue;
  }

  throw new ToolExecutionError(
    "FETCH_FAILED",
    "Too many redirects.",
  );
}

async function checkUrl(
  url: string,
  executionMode: ExecutionMode,
  lookup: Lookup,
): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ToolExecutionError(
      "FETCH_BLOCKED_ADDRESS",
      `Unsupported protocol: ${parsed.protocol}`,
    );
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new ToolExecutionError(
      "FETCH_BLOCKED_ADDRESS",
      "URL with userinfo is not allowed.",
    );
  }
  if (executionMode !== "workspace_sandbox") return;

  // URL 把 IPv6 文字地址包在方括号里（"[::1]"），先去掉再判断。
  const host = stripIpv6Brackets(parsed.hostname);
  if (isBlockedHostname(host)) {
    throw new ToolExecutionError(
      "FETCH_BLOCKED_ADDRESS",
      `Address is not a public address: ${host}`,
    );
  }
  // 文字 IP 已在 isBlockedHostname 判过；其余一律解析，包括不含 "." 的单段
  // 主机名，它们可能经 search domain 或 /etc/hosts 指向内网。
  if (isIP(host) !== 0) return;
  const results = await lookup(host, { all: true });
  for (const record of results) {
    if (isBlockedAddress(record.address)) {
      throw new ToolExecutionError(
        "FETCH_BLOCKED_ADDRESS",
        `Address resolves to a blocked address: ${record.address}`,
      );
    }
  }
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

async function doFetch(
  fetchRequest: typeof globalThis.fetch,
  url: string,
  signal: AbortSignal,
): Promise<Response> {
  return fetchRequest(url, {
    redirect: "manual",
    method: "GET",
    headers: {
      "User-Agent": USER_AGENT,
      Accept:
        "text/html,application/xhtml+xml,text/plain,application/json,application/xml,application/*+json,application/*+xml;q=0.9,*/*;q=0.1",
    },
    signal,
  });
}

async function readBody(response: Response): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    return Buffer.from(await response.text());
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_FETCH_BODY_BYTES) {
      await reader.cancel();
      throw new ToolExecutionError(
        "FETCH_FAILED",
        "Response body exceeds the maximum fetch size.",
      );
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

interface ConvertedBody {
  readonly text: string;
  readonly title?: string;
}

function convertBody(
  body: Buffer,
  contentType: string,
  finalUrl: string,
): ConvertedBody {
  const mime = contentType.split(";")[0]!.trim().toLowerCase();

  if (mime === "text/html" || mime === "application/xhtml+xml") {
    return convertHtml(decodestrict(body), finalUrl);
  }

  if (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/xml" ||
    (mime.startsWith("application/") && mime.endsWith("+json")) ||
    (mime.startsWith("application/") && mime.endsWith("+xml"))
  ) {
    return { text: decodestrict(body) };
  }

  if (mime === "" && looksLikeHtml(body)) {
    return convertHtml(decodestrict(body), finalUrl);
  }

  throw new ToolExecutionError(
    "FETCH_UNSUPPORTED_CONTENT",
    `Unsupported content type: ${contentType || "(none)"}`,
  );
}

function decodestrict(body: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new ToolExecutionError(
      "FETCH_UNSUPPORTED_CONTENT",
      "Content is not UTF-8 text.",
    );
  }
}

function looksLikeHtml(body: Buffer): boolean {
  const sample = body.subarray(0, 512).toString("latin1").trimStart();
  return sample.toLowerCase().startsWith("<!doctype html") ||
    sample.toLowerCase().startsWith("<html");
}

function convertHtml(html: string, finalUrl: string): ConvertedBody {
  const title = extractTitle(html);
  return {
    text: htmlToText(html, finalUrl),
    ...(title === undefined ? {} : { title }),
  };
}

function extractTitle(html: string): string | undefined {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (match === null) return undefined;
  const title = decodeEntities(match[1]!).replace(/\s+/g, " ").trim();
  return title === "" ? undefined : title;
}

function paginate(
  text: string,
  finalUrl: string,
  status: number,
  contentType: string,
  title: string | undefined,
  offsetArg: number | undefined,
  limitArg: number | undefined,
): FetchResult {
  const lines = text.split(/\r?\n/);
  const startLine = offsetArg ?? 1;
  let selected: string[];

  if (limitArg !== undefined) {
    selected = lines.slice(startLine - 1, startLine - 1 + limitArg);
  } else {
    // 默认取到 content 达到 MAX_FETCH_TEXT_BYTES 为止。
    selected = [];
    let bytes = 0;
    for (let i = startLine - 1; i < lines.length; i += 1) {
      const lineBytes = Buffer.byteLength(lines[i]!, "utf8");
      const addition = lineBytes + (selected.length === 0 ? 0 : 1);
      if (selected.length > 0 && bytes + addition > MAX_FETCH_TEXT_BYTES) break;
      selected.push(lines[i]!);
      bytes += addition;
    }
  }

  const endLine = selected.length === 0
    ? startLine - 1
    : startLine + selected.length - 1;

  return {
    url: finalUrl,
    finalUrl,
    status,
    contentType,
    ...(title === undefined ? {} : { title }),
    content: selected.join("\n"),
    startLine,
    endLine,
    totalLines: lines.length,
  };
}
