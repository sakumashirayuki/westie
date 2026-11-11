import assert from "node:assert/strict";
import test from "node:test";

import { z } from "zod";

import {
  OpenAICompatibleProvider,
  OpenAICompatibleProviderError,
  type ChatCompletionsChunk,
  type CreateStreamingChatCompletion,
} from "../src/providers/openai-compatible.js";
import { defineTool } from "../src/tools.js";

const TEST_SYSTEM_PROMPT = "Test system prompt.";

const chunk = (
  delta: ChatCompletionsChunk["choices"][number]["delta"],
  finishReason: ChatCompletionsChunk["choices"][number]["finish_reason"] = null,
): ChatCompletionsChunk => ({
  choices: [{ delta, finish_reason: finishReason }],
});

function streamOf(...chunks: ChatCompletionsChunk[]) {
  return (async function* () {
    yield* chunks;
  })();
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of stream) values.push(value);
  return values;
}

test("uses the configured baseURL and does not inject DeepSeek thinking", async () => {
  let request: Parameters<CreateStreamingChatCompletion>[0] | undefined;
  const provider = new OpenAICompatibleProvider({
    apiKey: "test-key",
    model: "compat-model",
    baseURL: "http://127.0.0.1:8317/v1",
    createStreamingChatCompletion: async (body) => {
      request = body;
      return streamOf(chunk({ content: "ok" }, "stop"));
    },
  });

  await collect(provider.stream({
    systemPrompt: TEST_SYSTEM_PROMPT,
    transcript: [{ role: "user", content: "hello" }],
    tools: [],
  }));

  assert.equal("thinking" in (request ?? {}), false);
  assert.equal(request?.model, "compat-model");
});

test("rejects an empty baseURL", () => {
  assert.throws(
    () => new OpenAICompatibleProvider({ apiKey: "k", model: "m", baseURL: "" }),
    /baseURL/,
  );
});

test("streams final text through the generic Chat Completions path", async () => {
  const provider = new OpenAICompatibleProvider({
    apiKey: "test-key",
    model: "generic-model",
    baseURL: "http://127.0.0.1:9000/v1",
    createStreamingChatCompletion: async () =>
      streamOf(
        chunk({ content: "hel" }),
        chunk({ content: "lo" }, "stop"),
      ),
  });

  assert.deepEqual(
    await collect(provider.stream({
      systemPrompt: TEST_SYSTEM_PROMPT,
      transcript: [{ role: "user", content: "hello" }],
      tools: [],
    })),
    [
      { type: "output_text.delta", text: "hel" },
      { type: "output_text.delta", text: "lo" },
      { type: "completed", turn: { type: "final", content: "hello" } },
    ],
  );
});

test("assembles tool calls and maps tool results by call ID", async () => {
  let request: Parameters<CreateStreamingChatCompletion>[0] | undefined;
  const provider = new OpenAICompatibleProvider({
    apiKey: "test-key",
    model: "generic-model",
    baseURL: "http://127.0.0.1:9000/v1",
    createStreamingChatCompletion: async (body) => {
      request = body;
      return streamOf(
        chunk({
          tool_calls: [{
            index: 0,
            id: "call-1",
            type: "function",
            function: { name: "echo", arguments: '{"text":"hi"}' },
          }],
        }, "tool_calls"),
      );
    },
  });
  const tool = defineTool({
    name: "echo",
    description: "Echo text.",
    inputSchema: z.strictObject({ text: z.string() }),
    async execute(input) {
      return { text: input.text };
    },
  });

  const events = await collect(provider.stream({
    systemPrompt: TEST_SYSTEM_PROMPT,
    transcript: [{ role: "user", content: "echo hi" }],
    tools: [tool],
  }));

  const completed = events.at(-1);
  assert.equal(completed?.type, "completed");
  if (completed?.type === "completed") {
    assert.equal(completed.turn.type, "tool_calls");
  }
  assert.equal(request?.tools?.[0]?.type, "function");
});

test("maps standard OpenAI usage fields", async () => {
  const provider = new OpenAICompatibleProvider({
    apiKey: "test-key",
    model: "generic-model",
    baseURL: "http://127.0.0.1:9000/v1",
    createStreamingChatCompletion: async () =>
      streamOf(
        chunk({ content: "done" }, "stop"),
        {
          model: "generic-model",
          choices: [],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 20,
            prompt_tokens_details: { cached_tokens: 30 },
            completion_tokens_details: { reasoning_tokens: 5 },
          },
        },
      ),
  });

  const events = await collect(provider.stream({
    systemPrompt: TEST_SYSTEM_PROMPT,
    transcript: [{ role: "user", content: "hello" }],
    tools: [],
  }));

  assert.deepEqual(events.at(-1), {
    type: "completed",
    turn: { type: "final", content: "done" },
    usage: {
      model: "generic-model",
      inputTokens: 100,
      cachedInputTokens: 30,
      outputTokens: 20,
      reasoningTokens: 5,
    },
  });
});

test("wraps failures as OpenAICompatibleProviderError by default", async () => {
  const provider = new OpenAICompatibleProvider({
    apiKey: "test-key",
    model: "generic-model",
    baseURL: "http://127.0.0.1:9000/v1",
    createStreamingChatCompletion: async () => {
      throw new Error("network down");
    },
  });

  await assert.rejects(
    collect(provider.stream({
      systemPrompt: TEST_SYSTEM_PROMPT,
      transcript: [{ role: "user", content: "hello" }],
      tools: [],
    })),
    OpenAICompatibleProviderError,
  );
});

test("supports custom transient finish reasons", async () => {
  const provider = new OpenAICompatibleProvider({
    apiKey: "test-key",
    model: "generic-model",
    baseURL: "http://127.0.0.1:9000/v1",
    transientFinishReasons: ["custom_overloaded"],
    createStreamingChatCompletion: async () =>
      streamOf(chunk({ content: "par" }, "custom_overloaded")),
  });

  const { ProviderTransientError } = await import("../src/provider-protocol.js");
  await assert.rejects(
    collect(provider.stream({
      systemPrompt: TEST_SYSTEM_PROMPT,
      transcript: [{ role: "user", content: "hello" }],
      tools: [],
    })),
    (error: unknown) =>
      error instanceof ProviderTransientError && error.reason === "overloaded",
  );
});
