import OpenAI from "openai";
import type {
  ChatCompletionChunk,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions/completions";
import { z } from "zod";

import {
  ProviderOutputError,
  ProviderTransientError,
  ProviderTruncatedOutputError,
  validateProviderUsage,
  type LlmProvider,
  type ProviderRequest,
  type ProviderStreamEvent,
  type ProviderTurn,
  type ProviderUsage,
} from "../provider-protocol.js";
import {
  type TranscriptMessage,
  validateTranscriptBatches,
} from "../transcript.js";
import type { Tool } from "../tools.js";
import { classifyProviderError } from "./provider-errors.js";
import { StreamAttempt } from "./stream-attempt.js";
import {
  serializeStopHookResultForModel,
  serializeSubAgentResultForModel,
  serializeToolResultForModel,
} from "./tool-result-boundary.js";

const REQUEST_TIMEOUT_MS = 60_000;
const STREAM_MAX_RETRIES = 0;
/** 流开始后连续这么久收不到数据就中止本次请求，交给 RetryingProvider 重试。 */
const STREAM_IDLE_TIMEOUT_MS = 180_000;

export interface ProviderRequestOptions {
  readonly timeout: number;
  readonly maxRetries: number;
  readonly signal?: AbortSignal;
}

/**
 * 兼容 OpenAI Chat Completions 协议的流式响应分片。
 * finish_reason 放宽为 string，以容纳各厂商的自定义原因（如 DeepSeek 的
 * insufficient_system_resource）。
 */
export interface ChatCompletionsChunk {
  readonly model?: string;
  readonly usage?: ChatCompletionsUsage | null;
  readonly choices: readonly (
    Pick<ChatCompletionChunk["choices"][number], "delta"> & {
      readonly finish_reason: string | null;
    }
  )[];
}

export interface ChatCompletionsUsage {
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
  readonly prompt_cache_hit_tokens?: number;
  readonly prompt_tokens_details?: { readonly cached_tokens?: number };
  readonly completion_tokens_details?: { readonly reasoning_tokens?: number };
}

/**
 * Chat Completions 请求体。在标准参数之外允许额外字段，以承载各厂商的
 * 专属扩展（如 DeepSeek 的 thinking、本地兼容网关的自定义参数）。
 */
export type ChatCompletionsRequestBody = ChatCompletionCreateParamsStreaming &
  Record<string, unknown>;

export type CreateStreamingChatCompletion = (
  body: ChatCompletionsRequestBody,
  options: ProviderRequestOptions,
) => Promise<AsyncIterable<ChatCompletionsChunk>>;

export type CreateProviderError = (
  message: string,
  options?: ErrorOptions,
) => Error;

export interface OpenAICompatibleProviderOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly baseURL: string;
  readonly contextWindowTokens?: number;
  readonly maxOutputTokens?: number;
  readonly createStreamingChatCompletion?: CreateStreamingChatCompletion;
  /** 合并到 Chat Completions 请求体的额外字段，用于厂商专属参数（如 DeepSeek 的 thinking）。 */
  readonly extraRequestBody?: Readonly<Record<string, unknown>>;
  /** 被视为瞬时过载、需要重试的 finish_reason 集合。 */
  readonly transientFinishReasons?: readonly string[];
  /** 非协议错误的包装类型，默认使用 OpenAICompatibleProviderError。 */
  readonly createProviderError?: CreateProviderError;
}

export class OpenAICompatibleProviderError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OpenAICompatibleProviderError";
  }
}

export class OpenAICompatibleProvider implements LlmProvider {
  readonly model: string;
  readonly contextWindowTokens?: number;
  readonly maxOutputTokens?: number;
  readonly #createStreamingChatCompletion: CreateStreamingChatCompletion;
  readonly #extraRequestBody: Readonly<Record<string, unknown>>;
  readonly #transientFinishReasons: ReadonlySet<string>;
  readonly #createProviderError: CreateProviderError;

  constructor(options: OpenAICompatibleProviderOptions) {
    if (options.apiKey.trim() === "") {
      throw new Error("OpenAI-compatible apiKey must not be empty.");
    }
    if (options.model.trim() === "") {
      throw new Error("OpenAI-compatible model must not be empty.");
    }
    if (options.baseURL.trim() === "") {
      throw new Error("OpenAI-compatible baseURL must not be empty.");
    }
    validateOptionalPositiveInteger(
      options.contextWindowTokens,
      "OpenAI-compatible contextWindowTokens",
    );
    validateOptionalPositiveInteger(
      options.maxOutputTokens,
      "OpenAI-compatible maxOutputTokens",
    );

    this.model = options.model;
    this.contextWindowTokens = options.contextWindowTokens;
    this.maxOutputTokens = options.maxOutputTokens;
    this.#extraRequestBody = options.extraRequestBody ?? {};
    this.#transientFinishReasons = new Set(options.transientFinishReasons ?? []);
    this.#createProviderError =
      options.createProviderError ??
      ((message, errorOptions) =>
        new OpenAICompatibleProviderError(message, errorOptions));

    if (options.createStreamingChatCompletion !== undefined) {
      this.#createStreamingChatCompletion =
        options.createStreamingChatCompletion;
    } else {
      const client = new OpenAI({
        apiKey: options.apiKey,
        baseURL: options.baseURL,
      });
      this.#createStreamingChatCompletion = async (body, requestOptions) =>
        client.chat.completions.create(body, requestOptions);
    }
  }

  async *stream(
    request: ProviderRequest,
  ): AsyncIterable<ProviderStreamEvent> {
    let text = "";
    const toolCalls = new Map<number, AccumulatedToolCall>();
    let finishReason: string | null = null;
    let usage: ProviderUsage | undefined;
    let model: string | undefined;

    using attempt = new StreamAttempt(
      request.signal,
      STREAM_IDLE_TIMEOUT_MS,
      "OpenAICompatible",
    );
    const messages = createMessages(request.systemPrompt, request.transcript);
    try {
      const stream = await this.#createStreamingChatCompletion(
        {
          model: this.model,
          messages,
          ...(request.tools.length === 0
            ? {}
            : {
                tools: createTools(request.tools),
                tool_choice: "auto" as const,
                parallel_tool_calls: true,
              }),
          ...(request.maxOutputTokens === undefined &&
              this.maxOutputTokens === undefined
            ? {}
            : {
                max_tokens: request.maxOutputTokens ?? this.maxOutputTokens,
              }),
          stream: true,
          stream_options: { include_usage: true },
          ...this.#extraRequestBody,
        },
        {
          timeout: REQUEST_TIMEOUT_MS,
          maxRetries: STREAM_MAX_RETRIES,
          signal: attempt.signal,
        },
      );

      for await (const chunk of stream) {
        attempt.touch();
        request.signal?.throwIfAborted();
        if (chunk.usage != null) {
          usage = validateProviderUsage(
            mapUsage(chunk.usage, chunk.model ?? model ?? this.model),
          );
        }
        if (chunk.model !== undefined && chunk.model !== "") {
          model = chunk.model;
        }
        const choice = chunk.choices[0];
        if (choice === undefined) continue;

        const content = choice.delta.content;
        if (content) {
          text += content;
          yield { type: "output_text.delta", text: content };
        }
        for (const toolCallDelta of choice.delta.tool_calls ?? []) {
          const index = toolCallDelta.index;
          if (!Number.isSafeInteger(index) || index < 0) {
            throw new ProviderOutputError(
              "Model returned an invalid tool call index.",
            );
          }
          const toolCall = toolCalls.get(index) ?? { name: "", arguments: "" };
          toolCalls.set(index, toolCall);
          const argumentDelta = appendToolCallDelta(toolCall, toolCallDelta);
          if (argumentDelta) {
            yield {
              type: "tool_arguments.delta",
              callIndex: index,
              text: argumentDelta,
            };
          }
        }
        if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
          if (this.#transientFinishReasons.has(choice.finish_reason)) {
            throw new ProviderTransientError(
              "overloaded",
              `Model reported ${choice.finish_reason}.`,
            );
          }
          finishReason = choice.finish_reason;
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
        error instanceof ProviderOutputError ||
        error instanceof ProviderTruncatedOutputError
      ) {
        throw error;
      }
      throw this.#createProviderError("OpenAI-compatible request failed.", {
        cause: error,
      });
    }

    yield {
      type: "completed",
      turn: completeTurn(text, toolCalls, finishReason),
      ...(usage === undefined ? {} : { usage }),
    };
  }
}

function mapUsage(
  usage: ChatCompletionsUsage,
  model: string,
): ProviderUsage {
  return {
    model,
    inputTokens: usage.prompt_tokens,
    cachedInputTokens:
      usage.prompt_cache_hit_tokens ??
      usage.prompt_tokens_details?.cached_tokens ??
      0,
    outputTokens: usage.completion_tokens,
    reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? 0,
  };
}

interface AccumulatedToolCall {
  callId?: string;
  name: string;
  arguments: string;
}

function appendToolCallDelta(
  toolCall: AccumulatedToolCall,
  delta: ChatCompletionChunk.Choice.Delta.ToolCall,
): string {
  if (delta.id !== undefined) {
    if (toolCall.callId !== undefined && toolCall.callId !== delta.id) {
      throw new ProviderOutputError(
        "Model returned conflicting tool call IDs.",
      );
    }
    toolCall.callId = delta.id;
  }
  toolCall.name += delta.function?.name ?? "";
  const argumentDelta = delta.function?.arguments ?? "";
  toolCall.arguments += argumentDelta;
  return argumentDelta;
}

function completeTurn(
  text: string,
  toolCalls: ReadonlyMap<number, AccumulatedToolCall>,
  finishReason: string | null,
): ProviderTurn {
  if (finishReason === "length") {
    throw new ProviderTruncatedOutputError(
      "Model stopped at the output token limit.",
    );
  }
  if (toolCalls.size > 0) {
    if (finishReason !== "tool_calls") {
      throw new ProviderOutputError(
        "Model returned a tool call without a tool_calls finish reason.",
      );
    }
    const orderedToolCalls = [...toolCalls.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, call]) => call);
    const callIds = new Set<string>();
    for (const toolCall of orderedToolCalls) {
      const callId = toolCall.callId;
      if (
        callId === undefined ||
        callId.trim() === "" ||
        toolCall.name.trim() === "" ||
        callIds.has(callId)
      ) {
        throw new ProviderOutputError("Model returned an invalid tool call.");
      }
      callIds.add(callId);
    }
    return {
      type: "tool_calls",
      calls: orderedToolCalls.map((toolCall) => ({
        callId: toolCall.callId!,
        name: toolCall.name,
        arguments: toolCall.arguments,
      })) as [
        { callId: string; name: string; arguments: string },
        ...{ callId: string; name: string; arguments: string }[],
      ],
    };
  }
  if (finishReason === "tool_calls") {
    throw new ProviderOutputError(
      "Model returned a tool_calls finish reason without tool calls.",
    );
  }
  if (finishReason !== "stop") {
    throw new ProviderOutputError(
      `Model returned an invalid finish reason: ${finishReason ?? "missing"}.`,
    );
  }
  if (text.trim() === "") {
    throw new ProviderOutputError("Model returned an empty final answer.");
  }
  return { type: "final", content: text };
}

function validateOptionalPositiveInteger(
  value: number | undefined,
  name: string,
): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new Error(`${name} must be a positive integer.`);
  }
}

function createMessages(
  systemPrompt: string,
  transcript: readonly TranscriptMessage[],
): ChatCompletionMessageParam[] {
  validateTranscriptBatches(transcript);
  return [
    { role: "system", content: systemPrompt },
    ...transcript.flatMap((message): ChatCompletionMessageParam[] => {
      if (message.role === "user") {
        let content = message.content;
        if ("source" in message) {
          if (message.source === "sub_agent") {
            content = serializeSubAgentResultForModel(message);
          } else {
            content = serializeStopHookResultForModel(message);
          }
        }
        return [{ role: "user", content }];
      }
      if (message.role === "tool") {
        return message.results.map(({ toolCallId, result }) => ({
          role: "tool",
          tool_call_id: toolCallId,
          content: serializeToolResultForModel(result),
        }));
      }
      if (message.content !== null) {
        return [{ role: "assistant", content: message.content }];
      }
      return [{
        role: "assistant",
        content: null,
        tool_calls: message.toolCalls.map((toolCall) => ({
          id: toolCall.callId,
          type: "function",
          function: {
            name: toolCall.name,
            arguments: toolCall.arguments,
          },
        })),
      }];
    }),
  ];
}

function createTools(tools: readonly Tool[]): ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: z.toJSONSchema(tool.inputSchema),
      strict: false,
    },
  }));
}
