import OpenAI from "openai";
import { zodResponsesFunction } from "openai/helpers/zod";
import { z } from "zod";
import type {
  ResponseCreateParamsStreaming,
  ResponseFunctionToolCall,
  ResponseInput,
  ResponseStreamEvent,
} from "openai/resources/responses/responses";

import {
  ProviderOutputError,
  ProviderTruncatedOutputError,
  validateProviderUsage,
  type LlmProvider,
  type ProviderRequest,
  type ProviderStreamEvent,
  type ProviderUsage,
} from "../provider-protocol.js";
import type { TranscriptMessage } from "../transcript.js";
import { validateTranscriptBatches } from "../transcript.js";
import { classifyProviderError } from "./provider-errors.js";
import { StreamAttempt } from "./stream-attempt.js";
import {
  serializeStopHookResultForModel,
  serializeSubAgentResultForModel,
  serializeToolResultForModel,
} from "./tool-result-boundary.js";

const REQUEST_TIMEOUT_MS = 60_000;
const STREAM_MAX_RETRIES = 0;
/** 流开始后连续这么久收不到数据就中止本次请求。推理模型思考期间可能长时间不发 delta。 */
const STREAM_IDLE_TIMEOUT_MS = 180_000;

export interface ProviderRequestOptions {
  readonly timeout: number;
  readonly maxRetries: number;
  readonly signal?: AbortSignal;
}

export type CreateStreamingResponse = (
  body: ResponseCreateParamsStreaming,
  options: ProviderRequestOptions,
) => Promise<AsyncIterable<ResponseStreamEvent>>;

export interface OpenAIProviderOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly contextWindowTokens?: number;
  readonly maxOutputTokens?: number;
  readonly createStreamingResponse?: CreateStreamingResponse;
}

export class OpenAIProviderError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OpenAIProviderError";
  }
}

export class OpenAIProvider implements LlmProvider {
  readonly model: string;
  readonly contextWindowTokens?: number;
  readonly maxOutputTokens?: number;
  readonly #createStreamingResponse: CreateStreamingResponse;

  constructor(options: OpenAIProviderOptions) {
    if (options.apiKey.trim() === "") {
      throw new Error("OpenAI apiKey must not be empty.");
    }
    if (options.model.trim() === "") {
      throw new Error("OpenAI model must not be empty.");
    }
    validateOptionalPositiveInteger(
      options.contextWindowTokens,
      "OpenAI contextWindowTokens",
    );
    validateOptionalPositiveInteger(
      options.maxOutputTokens,
      "OpenAI maxOutputTokens",
    );

    this.model = options.model;
    this.contextWindowTokens = options.contextWindowTokens;
    this.maxOutputTokens = options.maxOutputTokens;
    if (options.createStreamingResponse !== undefined) {
      this.#createStreamingResponse = options.createStreamingResponse;
    } else {
      const client = new OpenAI({ apiKey: options.apiKey });
      this.#createStreamingResponse = async (body, requestOptions) =>
        client.responses.create(body, requestOptions);
    }
  }

  async *stream(
    request: ProviderRequest,
  ): AsyncIterable<ProviderStreamEvent> {
    let text = "";
    const toolCalls = new Map<number, ResponseFunctionToolCall>();
    const toolArgumentIndexes = new Set<number>();
    let completed = false;
    let usage: ProviderUsage | undefined;

    using attempt = new StreamAttempt(
      request.signal,
      STREAM_IDLE_TIMEOUT_MS,
      "OpenAI",
    );
    const input = createInput(request.transcript);
    try {
      const stream = await this.#createStreamingResponse(
        {
          model: this.model,
          instructions: request.systemPrompt,
          input,
          ...(request.tools.length === 0
            ? {}
            : {
                tools: request.tools.map((tool) =>
                  tool.looseInputSchema === true
                    ? {
                        type: "function",
                        name: tool.name,
                        description: tool.description,
                        parameters: z.toJSONSchema(tool.inputSchema),
                        strict: false,
                      }
                    : zodResponsesFunction({
                        name: tool.name,
                        description: tool.description,
                        parameters: tool.inputSchema,
                      })
                ),
                parallel_tool_calls: true,
              }),
          ...(request.maxOutputTokens === undefined &&
              this.maxOutputTokens === undefined
            ? {}
            : {
                max_output_tokens:
                  request.maxOutputTokens ?? this.maxOutputTokens,
              }),
          store: false,
          stream: true,
        },
        {
          timeout: REQUEST_TIMEOUT_MS,
          maxRetries: STREAM_MAX_RETRIES,
          signal: attempt.signal,
        },
      );

      for await (const event of stream) {
        attempt.touch();
        request.signal?.throwIfAborted();
        switch (event.type) {
          case "response.output_text.delta":
            if (event.delta !== "") {
              text += event.delta;
              yield { type: "output_text.delta", text: event.delta };
            }
            break;
          case "response.function_call_arguments.delta":
            if (event.delta !== "") {
              toolArgumentIndexes.add(event.output_index);
              yield {
                type: "tool_arguments.delta",
                callIndex: event.output_index,
                text: event.delta,
              };
            }
            break;
          case "response.output_item.done":
            if (event.item.type === "function_call") {
              if (toolCalls.has(event.output_index)) {
                throw new ProviderOutputError(
                  "OpenAI returned duplicate tool call output indexes.",
                );
              }
              toolCalls.set(event.output_index, event.item);
            }
            break;
          case "response.refusal.delta":
          case "response.refusal.done":
            throw new ProviderOutputError("OpenAI refused the request.");
          case "response.failed":
            throw classifyProviderError(undefined, event) ?? new OpenAIProviderError(
              `OpenAI response failed: ${event.response.error?.message ?? "unknown error"}`,
            );
          case "response.incomplete": {
            const reason = event.response.incomplete_details?.reason;
            if (reason === "max_output_tokens") {
              throw new ProviderTruncatedOutputError(
                "OpenAI stopped at the output token limit.",
              );
            }
            throw new OpenAIProviderError(
              `OpenAI response was incomplete: ${reason ?? "unknown reason"}.`,
            );
          }
          case "error":
            throw classifyProviderError(undefined, event) ?? new OpenAIProviderError(
              `OpenAI stream failed: ${event.message}`,
            );
          case "response.completed":
            completed = true;
            usage = validateProviderUsage(mapOpenAIUsage(event.response));
            break;
        }
      }
      request.signal?.throwIfAborted();
      attempt.throwIfIdleTimedOut();
    } catch (error) {
      if (request.signal?.aborted) {
        throw request.signal.reason ?? error;
      }
      const transient = attempt.idleTimeout ?? classifyProviderError(error);
      if (transient !== undefined) throw transient;
      if (
        error instanceof OpenAIProviderError ||
        error instanceof ProviderOutputError ||
        error instanceof ProviderTruncatedOutputError
      ) {
        throw error;
      }
      throw new OpenAIProviderError("OpenAI request failed.", { cause: error });
    }

    if (!completed) {
      throw new OpenAIProviderError(
        "OpenAI stream ended without a completed response.",
      );
    }
    if (toolCalls.size > 0) {
      if (text !== "") {
        throw new ProviderOutputError(
          "OpenAI returned both output text and a tool call.",
        );
      }
      const orderedToolCalls = [...toolCalls.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, call]) => call);
      const callIds = new Set<string>();
      for (const call of orderedToolCalls) {
        if (
          call.call_id.trim() === "" ||
          call.name.trim() === "" ||
          callIds.has(call.call_id)
        ) {
          throw new ProviderOutputError("OpenAI returned an invalid tool call.");
        }
        callIds.add(call.call_id);
      }
      for (const index of toolArgumentIndexes) {
        if (!toolCalls.has(index)) {
          throw new ProviderOutputError(
            "OpenAI returned tool arguments without a completed tool call.",
          );
        }
      }
      yield {
        type: "completed",
        turn: {
          type: "tool_calls",
          calls: orderedToolCalls.map((call) => ({
            callId: call.call_id,
            name: call.name,
            arguments: call.arguments,
          })) as [
            { callId: string; name: string; arguments: string },
            ...{ callId: string; name: string; arguments: string }[],
          ],
        },
        ...(usage === undefined ? {} : { usage }),
      };
      return;
    }
    if (toolArgumentIndexes.size > 0) {
      throw new ProviderOutputError(
        "OpenAI returned tool arguments without a completed tool call.",
      );
    }
    if (text.trim() === "") {
      throw new ProviderOutputError("OpenAI returned an empty final answer.");
    }
    yield {
      type: "completed",
      turn: { type: "final", content: text },
      ...(usage === undefined ? {} : { usage }),
    };
  }
}

function mapOpenAIUsage(response: {
  readonly model?: string;
  readonly usage?: unknown;
}): ProviderUsage | undefined {
  if (response.model === undefined || response.usage === undefined) {
    return undefined;
  }
  const usage = response.usage as {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
    readonly input_tokens_details?: { readonly cached_tokens?: number };
    readonly output_tokens_details?: { readonly reasoning_tokens?: number };
  };
  if (
    usage.input_tokens === undefined ||
    usage.output_tokens === undefined
  ) {
    return undefined;
  }
  return {
    model: response.model,
    inputTokens: usage.input_tokens,
    cachedInputTokens: usage.input_tokens_details?.cached_tokens ?? 0,
    outputTokens: usage.output_tokens,
    reasoningTokens: usage.output_tokens_details?.reasoning_tokens ?? 0,
  };
}

function validateOptionalPositiveInteger(
  value: number | undefined,
  name: string,
): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new Error(`${name} must be a positive integer.`);
  }
}

function createInput(transcript: readonly TranscriptMessage[]): ResponseInput {
  validateTranscriptBatches(transcript);
  const input: ResponseInput = [];
  for (const message of transcript) {
    if (message.role === "user") {
      let content = message.content;
      if ("source" in message) {
        if (message.source === "sub_agent") {
          content = serializeSubAgentResultForModel(message);
        } else {
          content = serializeStopHookResultForModel(message);
        }
      }
      input.push({ role: "user", content });
      continue;
    }
    if (message.role === "tool") {
      input.push(
        ...message.results.map(({ toolCallId, result }) => ({
          type: "function_call_output" as const,
          call_id: toolCallId,
          output: serializeToolResultForModel(result),
        })),
      );
      continue;
    }
    if (message.content !== null) {
      input.push({ role: "assistant", content: message.content });
      continue;
    }
    input.push(
      ...message.toolCalls.map((toolCall) => ({
        type: "function_call" as const,
        call_id: toolCall.callId,
        name: toolCall.name,
        arguments: toolCall.arguments,
      })),
    );
  }
  return input;
}
