import { createAgentRun, type AgentRun } from "../../src/agent-run.js";
import type { AgentContextBuilder, AgentToolEnvironment, RunAgentOptions } from "../../src/agent-loop.js";
import { allowAllToolPermissionPolicy, AuthorizedToolExecutor } from "../../src/tool-permissions.js";

export const testContextBuilder: AgentContextBuilder = {
  async buildContext(request) {
    return { transcript: request.currentTranscript };
  },
};

export function testRun(runId = "test-run"): AgentRun {
  return createAgentRun({ runId });
}

export function testToolEnvironment(overrides: Partial<AgentToolEnvironment> = {}): AgentToolEnvironment {
  return {
    tools: [],
    executor: new AuthorizedToolExecutor({ policy: allowAllToolPermissionPolicy }),
    permissionContext: { workspaceRoot: "/workspace" },
    ...overrides,
  };
}

export function testRunOptions(
  overrides: Pick<RunAgentOptions, "provider"> & Partial<RunAgentOptions>,
): RunAgentOptions {
  return {
    transcript: [{ role: "user", content: "test" }],
    systemPrompt: "Test system prompt.",
    contextBuilder: testContextBuilder,
    run: testRun(),
    toolEnvironment: testToolEnvironment(),
    ...overrides,
  };
}
