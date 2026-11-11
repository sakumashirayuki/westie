import type { LlmProvider, ProviderRequest, ProviderStreamEvent } from "../provider-protocol.js";
import {
  OpenAICompatibleProvider,
  OpenAICompatibleProviderError,
  type ChatCompletionsChunk,
  type CreateStreamingChatCompletion,
} from "./openai-compatible.js";

export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

/** DeepSeek 会返回的自定义 finish_reason，表示服务端资源不足，建议稍后重试。 */
const DEEPSEEK_TRANSIENT_FINISH_REASONS = ["insufficient_system_resource"] as const;

export type { CreateStreamingChatCompletion };

/** 与 openai-compatible 的分片结构一致，保留 DeepSeek 命名以兼容历史代码。 */
export type DeepSeekChatCompletionChunk = ChatCompletionsChunk;

export interface DeepSeekProviderOptions {
  readonly apiKey: string;
  readonly model: string;
  /** 默认指向 DeepSeek 官方端点；可覆盖为任意兼容 Chat Completions 的端点。 */
  readonly baseURL?: string;
  readonly contextWindowTokens?: number;
  readonly maxOutputTokens?: number;
  readonly createStreamingChatCompletion?: CreateStreamingChatCompletion;
}

export class DeepSeekProviderError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DeepSeekProviderError";
  }
}

export class DeepSeekProvider implements LlmProvider {
  readonly model: string;
  readonly contextWindowTokens?: number;
  readonly maxOutputTokens?: number;
  readonly #inner: OpenAICompatibleProvider;

  constructor(options: DeepSeekProviderOptions) {
    if (options.apiKey.trim() === "") {
      throw new Error("DeepSeek apiKey must not be empty.");
    }
    if (options.model.trim() === "") {
      throw new Error("DeepSeek model must not be empty.");
    }

    this.model = options.model;
    this.contextWindowTokens = options.contextWindowTokens;
    this.maxOutputTokens = options.maxOutputTokens;
    this.#inner = new OpenAICompatibleProvider({
      apiKey: options.apiKey,
      model: options.model,
      baseURL: options.baseURL ?? DEEPSEEK_BASE_URL,
      contextWindowTokens: options.contextWindowTokens,
      maxOutputTokens: options.maxOutputTokens,
      createStreamingChatCompletion: options.createStreamingChatCompletion,
      // DeepSeek 原生支持 thinking 模式，这里显式关闭以获得确定性输出。
      extraRequestBody: { thinking: { type: "disabled" } },
      transientFinishReasons: [...DEEPSEEK_TRANSIENT_FINISH_REASONS],
      createProviderError: (message, errorOptions) =>
        new DeepSeekProviderError(message, errorOptions),
    });
  }

  stream(request: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
    return this.#inner.stream(request);
  }
}

export { OpenAICompatibleProviderError };
