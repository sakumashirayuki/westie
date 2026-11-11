import { z } from "zod";

import {
  MAX_MCP_TEXT_BYTES,
  MAX_MCP_TOOL_DESCRIPTION_BYTES,
  MAX_MCP_TOOL_SCHEMA_BYTES,
} from "../mcp/constants.js";
import type {
  McpCallResult,
  McpContentBlock,
  McpRemoteTool,
} from "../mcp/types.js";
import type {
  JsonValue,
} from "../protocol.js";
import type { WorkspaceMcpDiagnostic } from "../infrastructure/workspace-mcp-config.js";
import type { McpToolSource } from "../mcp/server-pool.js";
import { defineTool, ToolExecutionError, type Tool } from "../tools.js";

const TOOL_NAME_PATTERN = /[^A-Za-z0-9_-]/g;

export interface McpToolContext {
  readonly server: string;
  readonly remoteTool: McpRemoteTool;
  /** 只用到 callTool 的最小接口，避免工具适配与具体 client 耦合。 */
  readonly callTool: (
    name: string,
    args: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
  ) => Promise<McpCallResult>;
  readonly timeoutMs: number;
}

/**
 * 把一个远端 MCP 工具包成 `Tool`。命名 `mcp__<server>__<tool>`，inputSchema 用
 * `z.fromJSONSchema` 转成 zod；转不成时返回 undefined 由调用方跳过并诊断。
 */
export function createMcpTool(context: McpToolContext): Tool | undefined {
  const built = buildMcpTool(context);
  return typeof built === "string" ? undefined : built;
}

export interface McpToolSet {
  readonly tools: readonly Tool[];
  readonly diagnostics: readonly WorkspaceMcpDiagnostic[];
}

/**
 * 把一批远端工具包成 Tool。转换失败、名字过长、同一 Server 内清洗后撞名的工具
 * 跳过并产生 MCP_TOOL_SKIPPED 诊断，绝不让两个同名 Tool 进入 ToolRegistry。
 */
export function createMcpTools(
  sources: readonly McpToolSource[],
): McpToolSet {
  const tools: Tool[] = [];
  const diagnostics: WorkspaceMcpDiagnostic[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    const built = buildMcpTool({
      server: source.server,
      remoteTool: source.tool,
      callTool: source.client.callTool.bind(source.client),
      timeoutMs: source.timeoutMs,
    });
    const reason = typeof built === "string"
      ? built
      : seen.has(built.name)
      ? `its name collides with another tool on the same server after sanitization (${built.name})`
      : undefined;
    if (typeof built === "string" || reason !== undefined) {
      diagnostics.push({
        code: "MCP_TOOL_SKIPPED",
        server: source.server,
        path: ".agents/mcp.json",
        message: `Skipped MCP tool "${source.tool.name}": ${reason}.`,
      });
      continue;
    }
    seen.add(built.name);
    tools.push(built);
  }
  return { tools, diagnostics };
}

/** 返回 Tool，或一句跳过原因。 */
function buildMcpTool(context: McpToolContext): Tool | string {
  const { server, remoteTool, callTool, timeoutMs } = context;

  if (
    Buffer.byteLength(JSON.stringify(remoteTool.inputSchema), "utf8") >
      MAX_MCP_TOOL_SCHEMA_BYTES
  ) {
    return `its input schema exceeds ${MAX_MCP_TOOL_SCHEMA_BYTES} bytes`;
  }

  let inputSchema: z.ZodObject;
  try {
    const converted = z.fromJSONSchema(remoteTool.inputSchema);
    if (!(converted instanceof z.ZodObject)) {
      return "its input schema is not an object schema";
    }
    inputSchema = converted;
  } catch (error) {
    return `its input schema could not be converted (${errorMessage(error)})`;
  }

  const name = mcpToolName(server, remoteTool.name);
  if (name.length > 64) {
    return `its qualified name ${name} exceeds 64 characters`;
  }

  const description = truncateBytes(
    remoteTool.description ?? "",
    MAX_MCP_TOOL_DESCRIPTION_BYTES,
  );
  const impact = composeImpact(server, remoteTool);

  return defineTool({
    name,
    description,
    impact,
    inputSchema,
    looseInputSchema: true,
    summarizeInput(input) {
      return toJsonValue(input);
    },
    async execute(input, context) {
      let result: McpCallResult;
      try {
        result = await callTool(
          remoteTool.name,
          input as Record<string, unknown>,
          timeoutMs,
          context.signal,
        );
      } catch (error) {
        // Run 被取消时原样上抛，ToolRegistry 会按取消处理；其余一切传输层问题
        // （超时、断连、Server 崩溃、协议错误）都是 Server 不可用。
        if (context.signal?.aborted) throw error;
        if (error instanceof ToolExecutionError) throw error;
        throw new ToolExecutionError(
          "MCP_SERVER_UNAVAILABLE",
          `MCP server ${server} failed to answer "${remoteTool.name}": ${errorMessage(error)}`,
        );
      }
      return mapOutput(server, remoteTool.name, result);
    },
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function mcpToolName(server: string, tool: string): string {
  const sanitized = tool.replace(TOOL_NAME_PATTERN, "_");
  return `mcp__${server}__${sanitized}`;
}

export function truncateBytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let result = "";
  for (const char of value) {
    if (Buffer.byteLength(result + char, "utf8") > maxBytes) break;
    result += char;
  }
  return result;
}

function composeImpact(server: string, tool: McpRemoteTool): string {
  const readOnly = tool.readOnlyHint === undefined
    ? "unknown"
    : tool.readOnlyHint
    ? "read-only"
    : "not read-only";
  const destructive = tool.destructiveHint === undefined
    ? "unknown"
    : tool.destructiveHint
    ? "destructive"
    : "not destructive";
  return `Calls "${tool.name}" on MCP server ${server} (${readOnly}, destructive: ${destructive}); runs outside the workspace sandbox.`;
}

function mapOutput(
  server: string,
  tool: string,
  result: McpCallResult,
): JsonValue {
  const content = mapContent(server, result.content);
  const output: Record<string, unknown> = {
    server,
    tool,
    content,
  };
  if (result.structuredContent !== undefined) {
    output.structuredContent = toJsonValue(result.structuredContent);
  }
  if (result.isError === true) {
    throw new ToolExecutionError("MCP_TOOL_ERROR", textSummary(result.content));
  }
  return output as JsonValue;
}

function mapContent(
  server: string,
  content: readonly McpContentBlock[],
): JsonValue[] {
  const blocks: JsonValue[] = [];
  let textBytes = 0;
  let truncated = false;

  for (const block of content) {
    if (truncated) continue;
    if (block.type === "text") {
      const bytes = Buffer.byteLength(block.text, "utf8");
      if (textBytes + bytes > MAX_MCP_TEXT_BYTES) {
        const remaining = MAX_MCP_TEXT_BYTES - textBytes;
        if (remaining > 0) {
          blocks.push({ type: "text", text: truncateBytes(block.text, remaining) });
        }
        const omitted = totalTextBytes(content.slice(content.indexOf(block)));
        blocks.push({
          type: "text",
          text: `[truncated: ${omitted} more bytes from MCP server ${server}]`,
        });
        truncated = true;
        continue;
      }
      textBytes += bytes;
      blocks.push({ type: "text", text: block.text });
      continue;
    }
    if (block.type === "image" || block.type === "audio") {
      blocks.push({
        type: block.type,
        mimeType: block.mimeType,
        bytes: block.bytes,
        omitted: true,
      });
      continue;
    }
    if (block.type === "resource") {
      blocks.push({
        type: "resource",
        uri: block.uri,
        ...(block.mimeType === undefined ? {} : { mimeType: block.mimeType }),
        ...(block.text === undefined ? {} : { text: block.text }),
      });
      continue;
    }
  }
  return blocks;
}

function totalTextBytes(blocks: readonly McpContentBlock[]): number {
  return blocks.reduce(
    (total, block) =>
      total + (block.type === "text"
        ? Buffer.byteLength(block.text, "utf8")
        : 0),
    0,
  );
}

function textSummary(content: readonly McpContentBlock[]): string {
  const text = content
    .filter((block): block is Extract<McpContentBlock, { type: "text" }> =>
      block.type === "text"
    )
    .map((block) => block.text)
    .join("\n")
    .trim();
  return text === "" ? "MCP tool returned an error." : text;
}

function toJsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        toJsonValue(v),
      ]),
    );
  }
  return String(value);
}
