import type {
  LlmProvider,
  ProviderRequest,
  ProviderStreamEvent,
  ProviderTurn,
} from "../../src/provider-protocol.js";

export function finalTurn(
  content: string,
): Extract<ProviderTurn, { type: "final" }> {
  return { type: "final", content };
}

export function toolCallTurn(
  name: string,
  input: unknown,
  callId = `provider-call-${name}`,
): Extract<ProviderTurn, { type: "tool_calls" }> {
  return {
    type: "tool_calls",
    calls: [{ callId, name, arguments: JSON.stringify(input) }],
  };
}

export async function* streamTurn(
  turn: ProviderTurn,
): AsyncIterable<ProviderStreamEvent> {
  if (turn.type === "final") {
    yield { type: "output_text.delta", text: turn.content };
  } else {
    yield {
      type: "tool_arguments.delta",
      callIndex: 0,
      text: turn.calls[0].arguments,
    };
  }
  yield { type: "completed", turn };
}

export function providerFromTurnFactory(
  factory: (request: ProviderRequest) => ProviderTurn | Promise<ProviderTurn>,
  capacity: {
    readonly contextWindowTokens?: number;
    readonly maxOutputTokens?: number;
  } = {},
): LlmProvider {
  return {
    ...capacity,
    model: "test-model",
    async *stream(request) {
      yield* streamTurn(await factory(request));
    },
  };
}

export function providerReturning(content: string): LlmProvider {
  return providerFromTurnFactory(() => finalTurn(content));
}
