import type { AgentEvent, AgentEventFactory } from "./agent-events.js";
import type { NativeToolCall } from "./provider-protocol.js";
import type { ToolResult } from "./protocol.js";
import {
  approvalDeniedResult,
  approvalExpiredResult,
  type AuthorizedToolExecutor,
  permissionDeniedResult,
  type ToolPermissionContext,
  workspaceGrantDeniedResult,
  workspaceGrantExpiredResult,
} from "./tool-permissions.js";
import {
  type PreparedToolCall,
  type ToolExecutionContext,
  type ToolRegistry,
} from "./tools.js";

export interface ExecuteAgentToolCallOptions {
  readonly call: NativeToolCall;
  readonly stepNumber: number;
  readonly registry: ToolRegistry;
  readonly eventFactory: AgentEventFactory;
  readonly signal?: AbortSignal;
  readonly authorizedToolExecutor: AuthorizedToolExecutor;
  readonly toolPermissionContext: ToolPermissionContext;
}

export type PreparedAgentToolCall =
  | {
      readonly type: "ready";
      readonly call: NativeToolCall;
      readonly prepared: PreparedToolCall;
      readonly executionContext: ToolExecutionContext;
    }
  | {
      readonly type: "complete";
      readonly call: NativeToolCall;
      readonly result: ToolResult;
      readonly durationMs: number;
    };

export interface ExecutedAgentToolCall {
  readonly call: NativeToolCall;
  readonly prepared: PreparedToolCall;
  readonly result: ToolResult;
  readonly durationMs: number;
}

type AuthorizationResult =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly result: ToolResult };

export async function* executeAgentToolCall(
  options: ExecuteAgentToolCallOptions,
): AsyncGenerator<AgentEvent, ToolResult, void> {
  const prepared = yield* prepareAgentToolCall(options);
  if (prepared.type === "complete") {
    return yield* completeToolCall(
      options,
      prepared.result,
      prepared.durationMs,
    );
  }
  yield options.eventFactory.toolStarted(
    options.stepNumber,
    prepared.call.callId,
    prepared.prepared.name,
    prepared.prepared.input,
  );
  const execution = await executePreparedAgentToolCall(options, prepared);
  return yield* completeToolCall(
    options,
    execution.result,
    execution.durationMs,
  );
}

export async function* prepareAgentToolCall(
  options: ExecuteAgentToolCallOptions,
): AsyncGenerator<AgentEvent, PreparedAgentToolCall, void> {
  const { call, registry, authorizedToolExecutor, toolPermissionContext } =
    options;
  const prepared = prepareToolCall(registry, call);
  if (!isPreparedToolCall(prepared)) {
    return { type: "complete", call, result: prepared, durationMs: 0 };
  }

  const executionContext = createExecutionContext(options);
  const permission = yield* authorizeToolCall(options, prepared);
  const access = permission.allowed
    ? yield* authorizeWorkspaceAccess(options, prepared, executionContext)
    : permission;
  if (!access.allowed) {
    authorizedToolExecutor.recordExecutionResult(
      prepared,
      toolPermissionContext,
      call.callId,
      access.result,
      0,
    );
    return {
      type: "complete",
      call,
      result: access.result,
      durationMs: 0,
    };
  }
  return { type: "ready", call, prepared, executionContext };
}

export async function executePreparedAgentToolCall(
  options: ExecuteAgentToolCallOptions,
  preparedCall: Extract<PreparedAgentToolCall, { type: "ready" }>,
): Promise<ExecutedAgentToolCall> {
  const startedAt = performance.now();
  const result = await options.authorizedToolExecutor.execute(
    preparedCall.prepared,
    preparedCall.executionContext,
  );
  const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
  options.authorizedToolExecutor.recordExecutionResult(
    preparedCall.prepared,
    options.toolPermissionContext,
    preparedCall.call.callId,
    result,
    durationMs,
  );
  return {
    call: preparedCall.call,
    prepared: preparedCall.prepared,
    result,
    durationMs,
  };
}

async function* authorizeToolCall(
  options: ExecuteAgentToolCallOptions,
  prepared: PreparedToolCall,
): AsyncGenerator<AgentEvent, AuthorizationResult, void> {
  const { authorizedToolExecutor, toolPermissionContext, call } = options;
  const decision = authorizedToolExecutor.evaluate(
    prepared,
    toolPermissionContext,
  );
  authorizedToolExecutor.recordPolicyDecision(
    prepared,
    toolPermissionContext,
    call.callId,
    decision,
  );

  if (decision.effect === "allow") return { allowed: true };
  if (decision.effect === "deny") {
    return {
      allowed: false,
      result: permissionDeniedResult(prepared.name, decision.reason),
    };
  }
  if (decision.effect !== "confirm") {
    return {
      allowed: false,
      result: permissionDeniedResult(
        prepared.name,
        "Tool execution was not authorized.",
      ),
    };
  }

  const pending = authorizedToolExecutor.createApproval(prepared, {
    runId: toolPermissionContext.runId,
    step: options.stepNumber,
    toolCallId: call.callId,
    decision,
    conversationId: toolPermissionContext.conversationId ?? "",
  });
  if (pending === undefined) {
    return { allowed: false, result: approvalDeniedResult(prepared.name) };
  }
  try {
    yield options.eventFactory.interactionRequired(pending);
    options.signal?.throwIfAborted();
    const resolution = await pending.wait(options.signal);
    options.signal?.throwIfAborted();
    authorizedToolExecutor.recordResolution(pending, resolution);
    authorizedToolExecutor.applyToolGrant(pending, resolution);
    yield options.eventFactory.interactionResolved(pending, resolution);
    options.signal?.throwIfAborted();

    const approved =
      resolution.status === "responded" &&
      resolution.response.decision === "approve";
    return approved
      ? { allowed: true }
      : {
          allowed: false,
          result: resolution.status === "expired"
            ? approvalExpiredResult(prepared.name)
            : approvalDeniedResult(prepared.name),
        };
  } finally {
    pending.dispose();
  }
}

async function* authorizeWorkspaceAccess(
  options: ExecuteAgentToolCallOptions,
  prepared: PreparedToolCall,
  executionContext: ToolExecutionContext,
): AsyncGenerator<AgentEvent, AuthorizationResult, void> {
  const requirement = await prepared.preflight(executionContext);
  if (requirement === undefined) return { allowed: true };

  const pending = options.authorizedToolExecutor.createWorkspaceGrant(
    prepared,
    requirement,
    {
      context: options.toolPermissionContext,
      step: options.stepNumber,
      toolCallId: options.call.callId,
    },
  );
  if (pending === undefined) {
    return {
      allowed: false,
      result: workspaceGrantDeniedResult(prepared.name),
    };
  }
  try {
    yield options.eventFactory.interactionRequired(pending);
    options.signal?.throwIfAborted();
    const resolution = await pending.wait(options.signal);
    options.signal?.throwIfAborted();
    options.authorizedToolExecutor.recordResolution(pending, resolution);
    yield options.eventFactory.interactionResolved(pending, resolution);
    options.signal?.throwIfAborted();

    if (
      options.authorizedToolExecutor.applyWorkspaceGrant(pending, resolution)
    ) {
      const repeatedRequirement = await prepared.preflight(executionContext);
      if (repeatedRequirement === undefined) return { allowed: true };
    }
    return {
      allowed: false,
      result: resolution.status === "expired"
        ? workspaceGrantExpiredResult(prepared.name)
        : workspaceGrantDeniedResult(prepared.name),
    };
  } finally {
    pending.dispose();
  }
}

async function* completeToolCall(
  options: ExecuteAgentToolCallOptions,
  result: ToolResult,
  durationMs: number,
): AsyncGenerator<AgentEvent, ToolResult, void> {
  options.signal?.throwIfAborted();
  yield options.eventFactory.toolCompleted(
    options.stepNumber,
    options.call.callId,
    result,
    durationMs,
  );
  options.signal?.throwIfAborted();
  return result;
}

function createExecutionContext(
  options: ExecuteAgentToolCallOptions,
): ToolExecutionContext {
  return {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.toolPermissionContext.conversationId === undefined
      ? {}
      : { conversationId: options.toolPermissionContext.conversationId }),
    toolCallId: options.call.callId,
  };
}

function prepareToolCall(
  registry: ToolRegistry,
  call: NativeToolCall,
): PreparedToolCall | ToolResult {
  try {
    return registry.prepare(call.name, JSON.parse(call.arguments));
  } catch {
    return {
      type: "tool_result",
      tool: call.name,
      status: "error",
      error: {
        code: "INVALID_TOOL_INPUT",
        message: "Tool arguments are not valid JSON.",
      },
    };
  }
}

function isPreparedToolCall(
  prepared: PreparedToolCall | ToolResult,
): prepared is PreparedToolCall {
  return !("type" in prepared);
}
