import type {
  LlmProvider,
  ProviderTurn,
  ProviderUsage,
} from "../provider-protocol.js";
export interface GenerateSummaryRequest {
  readonly provider: LlmProvider;
  readonly systemPrompt: string;
  readonly source: string;
  readonly maxOutputTokens: number;
  /** 摘要文本允许的字节数，由 ContextBudget 按窗口推导。 */
  readonly maxSummaryBytes: number;
  readonly signal?: AbortSignal;
}

export async function generateProviderSummary(
  request: GenerateSummaryRequest,
): Promise<{ summary: string; usage?: ProviderUsage }> {
  let completedTurn: ProviderTurn | undefined;
  let usage: ProviderUsage | undefined;
  let sawToolArguments = false;
  for await (const event of request.provider.stream({
    systemPrompt: request.systemPrompt,
    transcript: [{ role: "user", content: request.source }],
    tools: [],
    maxOutputTokens: request.maxOutputTokens,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  })) {
    request.signal?.throwIfAborted();
    if (completedTurn !== undefined) {
      throw new Error("Summary provider emitted events after completion.");
    }
    if (event.type === "completed") {
      completedTurn = event.turn;
      usage = event.usage;
    } else if (event.type === "tool_arguments.delta") {
      sawToolArguments = true;
    } else if (event.type === "retrying") {
      sawToolArguments = false;
    }
  }
  request.signal?.throwIfAborted();
  if (
    completedTurn === undefined ||
    completedTurn.type !== "final" ||
    sawToolArguments
  ) {
    throw new Error("Summary provider returned an invalid response.");
  }
  const summary = completedTurn.content.trim();
  if (
    summary === "" ||
    Buffer.byteLength(summary, "utf8") > request.maxSummaryBytes
  ) {
    throw new Error("Summary provider returned an empty or oversized summary.");
  }
  return { summary, ...(usage === undefined ? {} : { usage }) };
}
