import { createHash } from "node:crypto";

import type {
  InteractionResolution,
  InteractionBroker,
  PendingInteraction,
  ToolApprovalInteraction,
  WorkspaceGrantInteraction,
} from "./application/interaction-broker.js";
import type { WorkspaceGrantStore } from "./application/workspace-grant-store.js";
import type { ToolGrantStore } from "./application/tool-grant-store.js";
import { deriveGrantOptions, type ToolGrantScope } from "./tool-grants.js";
import type { ExecutionMode } from "./domain/conversation.js";
import type { ToolResult } from "./protocol.js";
import type {
  PreparedToolCall,
  Tool,
  ToolExecutionContext,
  WorkspaceGrantRequirement,
} from "./tools.js";

export type ToolPermissionEffect = "allow" | "deny" | "confirm";

/** Harness 内部执行完成检查脚本时使用的工具名；不加入模型可见工具列表。 */
const STOP_HOOK_TOOL_NAME = "stop_hook";

export interface ToolPermissionRule {
  readonly effect: ToolPermissionEffect;
  readonly ruleId: string;
  readonly reason?: string;
}

export type PolicyDecision =
  | { readonly effect: "allow"; readonly ruleId: string }
  | {
      readonly effect: "deny";
      readonly ruleId: string;
      readonly reason: string;
    }
  | {
      readonly effect: "confirm";
      readonly ruleId: string;
      readonly reason: string;
    };

export interface ToolPermissionContext {
  readonly workspaceRoot: string;
  readonly executionMode?: ExecutionMode;
  readonly conversationId?: string;
  readonly runId: string;
}

export interface ToolPermissionPolicy {
  evaluate(
    tool: Pick<PreparedToolCall, "name" | "input">,
    context: ToolPermissionContext,
  ): PolicyDecision;
  isVisible(tool: Tool, context: ToolPermissionContext): boolean;
}

/**
 * 权限策略的一层。像 Express 中间件：自己能拍板就直接返回决定，不能就 `next()`
 * 问后面的层，也可以拿到后面的决定再改写。`composePolicy` 按数组顺序串起来，
 * 所以数组从上到下就是判断顺序。
 */
export type PolicyMiddleware = (
  tool: Pick<PreparedToolCall, "name" | "input">,
  context: ToolPermissionContext,
  next: () => PolicyDecision,
) => PolicyDecision;

/** 链尾：没有任何一层拍板，就是没有规则，默认拒绝。 */
function defaultDeny(
  tool: Pick<PreparedToolCall, "name" | "input">,
): PolicyDecision {
  return {
    effect: "deny",
    ruleId: "default-deny",
    reason: `No permission rule is configured for tool ${tool.name}.`,
  };
}

/**
 * 把一串中间件组合成 `ToolPermissionPolicy`。可见性在这里统一定义：用空参数
 * 评估一次，结果不是 deny 就对模型可见。
 */
export function composePolicy(
  chain: readonly PolicyMiddleware[],
): ToolPermissionPolicy {
  const evaluate = (
    tool: Pick<PreparedToolCall, "name" | "input">,
    context: ToolPermissionContext,
  ): PolicyDecision => {
    const run = (index: number): PolicyDecision =>
      index < chain.length
        ? chain[index]!(tool, context, () => run(index + 1))
        : defaultDeny(tool);
    return run(0);
  };
  return {
    evaluate,
    isVisible: (tool, context) =>
      evaluate({ name: tool.name, input: {} }, context).effect !== "deny",
  };
}

/** `full_access` 会话里一切放行，后面的层都不看。 */
export const fullAccessAllowsEverything: PolicyMiddleware = (
  tool,
  context,
  next,
) =>
  context.executionMode === "full_access"
    ? { effect: "allow", ruleId: `full-access:${tool.name}:allow` }
    : next();

/**
 * 会话级授权：后面的层说 confirm、而这个会话已经对该工具（或命令前缀）点过
 * 「本会话允许」，改成 allow。deny 不能被授权抬成 allow。
 */
export function conversationGrantsUpgradeConfirm(
  grantStore: ToolGrantStore,
): PolicyMiddleware {
  return (tool, context, next) => {
    const decision = next();
    // 完成检查每次执行前都要单独批准：会话授权不适用于 stop_hook。
    if (
      decision.effect !== "confirm" ||
      context.conversationId === undefined ||
      tool.name === STOP_HOOK_TOOL_NAME
    ) {
      return decision;
    }
    const scopeKind = grantStore.matchedScopeKind(
      context.conversationId,
      tool.name,
      tool.input,
    );
    return scopeKind === undefined
      ? decision
      : {
          effect: "allow",
          ruleId: `conversation-grant:${tool.name}:${scopeKind}:allow`,
        };
  };
}

/**
 * MCP 工具没有精确规则时不是 deny 而是 confirm：它们在沙箱外执行、可能有副作用，
 * 但用户既然配置了这个 Server，就应该让模型看得到、由用户逐次放行。
 */
export const mcpToolsNeedConfirmation: PolicyMiddleware = (
  tool,
  _context,
  next,
) => {
  const decision = next();
  return decision.effect === "deny" && tool.name.startsWith("mcp__")
    ? {
        effect: "confirm",
        ruleId: "default:mcp:confirm",
        reason: "MCP tools run outside the workspace sandbox.",
      }
    : decision;
};

/** 按工具名查静态规则表；表里没有的交给后面的层（最终是默认拒绝）。 */
export function fixedRules(
  rules: Readonly<Record<string, ToolPermissionRule>>,
): PolicyMiddleware {
  const table = new Map(Object.entries(rules));
  return (tool, _context, next) => {
    const rule = table.get(tool.name);
    if (rule === undefined) return next();
    if (rule.effect === "allow") {
      return { effect: "allow", ruleId: rule.ruleId };
    }
    return {
      effect: rule.effect,
      ruleId: rule.ruleId,
      reason:
        rule.reason ??
        (rule.effect === "confirm"
          ? "This tool requires user confirmation."
          : "This tool is denied by policy."),
    };
  };
}

/** 只有一张静态规则表的策略；测试里大量直接构造，保留为薄包装。 */
export class FixedToolPermissionPolicy implements ToolPermissionPolicy {
  readonly #policy: ToolPermissionPolicy;

  constructor(rules: Readonly<Record<string, ToolPermissionRule>>) {
    this.#policy = composePolicy([fixedRules(rules)]);
  }

  evaluate(
    tool: Pick<PreparedToolCall, "name" | "input">,
    context: ToolPermissionContext,
  ): PolicyDecision {
    return this.#policy.evaluate(tool, context);
  }

  isVisible(tool: Tool, context: ToolPermissionContext): boolean {
    return this.#policy.isVisible(tool, context);
  }
}

export interface AuthorizedToolExecutorOptions {
  readonly policy: ToolPermissionPolicy;
  readonly interactionBroker?: InteractionBroker;
  readonly interactionTimeoutMs?: number;
  readonly auditSink?: ToolAuditSink;
  readonly workspaceGrantStore?: WorkspaceGrantStore;
  readonly toolGrantStore?: ToolGrantStore;
}

export type ToolAuditEvent =
  | {
      readonly type: "policy.decision";
      readonly timestamp: string;
      readonly runId: string;
      readonly toolCallId: string;
      readonly toolName: string;
      readonly ruleId: string;
      readonly effect: ToolPermissionEffect;
      readonly argumentsDigest: string;
    }
  | {
      readonly type: "interaction.required";
      readonly timestamp: string;
      readonly runId: string;
      readonly interactionId: string;
      readonly kind: "tool_approval";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly ruleId: string;
      readonly argumentsDigest: string;
    }
  | {
      readonly type: "interaction.required";
      readonly timestamp: string;
      readonly runId: string;
      readonly interactionId: string;
      readonly kind: "workspace_grant";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly pathDigest: string;
    }
  | {
      readonly type: "interaction.resolution";
      readonly timestamp: string;
      readonly runId: string;
      readonly interactionId: string;
      readonly kind: "tool_approval" | "workspace_grant";
      readonly toolCallId: string;
      readonly status: "responded" | "expired";
      readonly decision?: "approve" | "deny";
      readonly grantScope?: ToolGrantScope;
    }
  | {
      readonly type: "execution.result";
      readonly timestamp: string;
      readonly runId: string;
      readonly toolCallId: string;
      readonly toolName: string;
      readonly status: "success" | "error";
      readonly errorCode?: string;
      readonly durationMs: number;
    };

export interface ToolAuditSink {
  record(event: ToolAuditEvent): void;
}

export class JsonLineToolAuditSink implements ToolAuditSink {
  record(event: ToolAuditEvent): void {
    process.stderr.write(`${JSON.stringify(event)}\n`);
  }
}

const noOpToolAuditSink: ToolAuditSink = {
  record() {},
};

export class AuthorizedToolExecutor {
  readonly #policy: ToolPermissionPolicy;
  readonly #interactionBroker: InteractionBroker | undefined;
  readonly #interactionTimeoutMs: number | undefined;
  readonly #auditSink: ToolAuditSink;
  readonly #workspaceGrantStore: WorkspaceGrantStore | undefined;
  readonly #toolGrantStore: ToolGrantStore | undefined;

  constructor(options: AuthorizedToolExecutorOptions) {
    this.#policy = options.policy;
    this.#interactionBroker = options.interactionBroker;
    this.#interactionTimeoutMs = options.interactionTimeoutMs;
    this.#auditSink = options.auditSink ?? noOpToolAuditSink;
    this.#workspaceGrantStore = options.workspaceGrantStore;
    this.#toolGrantStore = options.toolGrantStore;
  }

  visibleTools(
    tools: readonly Tool[],
    context: ToolPermissionContext,
  ): readonly Tool[] {
    return tools.filter((tool) => this.#policy.isVisible(tool, context));
  }

  evaluate(
    prepared: PreparedToolCall,
    context: ToolPermissionContext,
  ): PolicyDecision {
    return this.#policy.evaluate(prepared, context);
  }

  recordPolicyDecision(
    prepared: PreparedToolCall,
    context: ToolPermissionContext,
    toolCallId: string,
    decision: PolicyDecision,
  ): void {
    this.#auditSink.record({
      type: "policy.decision",
      timestamp: new Date().toISOString(),
      runId: context.runId,
      toolCallId,
      toolName: prepared.name,
      ruleId: decision.ruleId,
      effect: decision.effect,
      argumentsDigest: digestArguments(prepared.input),
    });
  }

  createApproval(
    prepared: PreparedToolCall,
    request: {
      readonly runId: string;
      readonly step: number;
      readonly toolCallId: string;
      readonly decision: Extract<PolicyDecision, { effect: "confirm" }>;
      readonly conversationId: string;
    },
  ): PendingInteraction | undefined {
    if (this.#interactionBroker === undefined) return undefined;
    const interaction: ToolApprovalInteraction = {
      kind: "tool_approval",
      runId: request.runId,
      step: request.step,
      toolCallId: request.toolCallId,
      toolName: prepared.name,
      ruleId: request.decision.ruleId,
      argumentsDigest: digestArguments(prepared.input),
      argumentsSummary: prepared.argumentsSummary,
      risk: request.decision.reason,
      impact: prepared.impact,
      grantOptions: deriveGrantOptions(prepared.name, prepared.input),
      conversationId: request.conversationId,
    };
    const pending = this.#interactionBroker.create(
      interaction,
      this.#interactionTimeoutMs === undefined
        ? undefined
        : { timeoutMs: this.#interactionTimeoutMs },
    );
    this.#auditSink.record({
      type: "interaction.required",
      timestamp: new Date().toISOString(),
      runId: interaction.runId,
      interactionId: pending.interactionId,
      kind: interaction.kind,
      toolCallId: interaction.toolCallId,
      toolName: interaction.toolName,
      ruleId: interaction.ruleId,
      argumentsDigest: interaction.argumentsDigest,
    });
    return pending;
  }

  createWorkspaceGrant(
    prepared: PreparedToolCall,
    requirement: WorkspaceGrantRequirement,
    request: {
      readonly context: ToolPermissionContext;
      readonly step: number;
      readonly toolCallId: string;
    },
  ): PendingInteraction | undefined {
    if (
      this.#interactionBroker === undefined ||
      this.#workspaceGrantStore === undefined ||
      request.context.conversationId === undefined
    ) {
      return undefined;
    }
    const interaction: WorkspaceGrantInteraction = {
      kind: "workspace_grant",
      reason: requirement.reason,
      runId: request.context.runId,
      step: request.step,
      toolCallId: request.toolCallId,
      toolName: prepared.name,
      conversationId: request.context.conversationId,
      requestedPath: requirement.requestedPath,
      canonicalPath: requirement.canonicalPath,
      access: requirement.access,
      scope: requirement.scope,
    };
    const pending = this.#interactionBroker.create(
      interaction,
      this.#interactionTimeoutMs === undefined
        ? undefined
        : { timeoutMs: this.#interactionTimeoutMs },
    );
    this.#auditSink.record({
      type: "interaction.required",
      timestamp: new Date().toISOString(),
      runId: interaction.runId,
      interactionId: pending.interactionId,
      kind: interaction.kind,
      toolCallId: interaction.toolCallId,
      toolName: interaction.toolName,
      pathDigest: digestArguments(interaction.canonicalPath),
    });
    return pending;
  }

  applyWorkspaceGrant(
    pending: PendingInteraction,
    resolution: InteractionResolution,
  ): boolean {
    const interaction = pending.interaction;
    if (
      interaction.kind !== "workspace_grant" ||
      resolution.status !== "responded" ||
      resolution.response.decision !== "approve" ||
      (interaction.reason === "outside_workspace"
        ? resolution.response.selectedPath !== interaction.canonicalPath
        : resolution.response.selectedPath !== undefined &&
          resolution.response.selectedPath !== interaction.canonicalPath) ||
      this.#workspaceGrantStore === undefined
    ) {
      return false;
    }
    this.#workspaceGrantStore.grantRead({
      conversationId: interaction.conversationId,
      toolCallId: interaction.toolCallId,
      canonicalPath: interaction.canonicalPath,
    });
    return true;
  }

  applyToolGrant(
    pending: PendingInteraction,
    resolution: InteractionResolution,
  ): boolean {
    const interaction = pending.interaction;
    if (
      interaction.kind !== "tool_approval" ||
      resolution.status !== "responded" ||
      resolution.response.decision !== "approve" ||
      !("grant" in resolution.response) ||
      resolution.response.grant === undefined ||
      this.#toolGrantStore === undefined
    ) {
      return false;
    }
    this.#toolGrantStore.grant({
      conversationId: interaction.conversationId,
      toolName: interaction.toolName,
      scope: resolution.response.grant,
    });
    return true;
  }

  recordResolution(
    pending: PendingInteraction,
    resolution: InteractionResolution,
  ): void {
    this.#auditSink.record({
      type: "interaction.resolution",
      timestamp: new Date().toISOString(),
      runId: pending.interaction.runId,
      interactionId: pending.interactionId,
      kind: pending.interaction.kind,
      toolCallId: pending.interaction.toolCallId,
      status: resolution.status,
      ...(resolution.status === "responded"
        ? {
            decision: resolution.response.decision,
            ...(!("grant" in resolution.response) ||
                resolution.response.grant === undefined
              ? {}
              : { grantScope: resolution.response.grant }),
          }
        : {}),
    });
  }

  recordExecutionResult(
    prepared: PreparedToolCall,
    context: ToolPermissionContext,
    toolCallId: string,
    result: ToolResult,
    durationMs: number,
  ): void {
    this.#auditSink.record({
      type: "execution.result",
      timestamp: new Date().toISOString(),
      runId: context.runId,
      toolCallId,
      toolName: prepared.name,
      status: result.status,
      ...(result.status === "error" ? { errorCode: result.error.code } : {}),
      durationMs,
    });
  }

  execute(
    prepared: PreparedToolCall,
    context?: ToolExecutionContext,
  ): Promise<ToolResult> {
    return prepared.execute(context);
  }
}

export const defaultToolPermissionRules = {
  get_current_time: {
    effect: "allow",
    ruleId: "default:get_current_time:allow",
  },
  read: { effect: "allow", ruleId: "default:read:allow" },
  grep: { effect: "allow", ruleId: "default:grep:allow" },
  write: { effect: "allow", ruleId: "default:write:allow" },
  edit: { effect: "allow", ruleId: "default:edit:allow" },
  web_search: {
    effect: "allow",
    ruleId: "default:web_search:allow",
  },
  web_fetch: { effect: "allow", ruleId: "default:web_fetch:allow" },
  glob: { effect: "allow", ruleId: "default:glob:allow" },
  todo: { effect: "allow", ruleId: "default:todo:allow" },
  skill: { effect: "allow", ruleId: "default:skill:allow" },
  // 项目记忆文件工具；写入受系统提示词约束，按 action 拆静态规则不可行。
  memory: { effect: "allow", ruleId: "default:memory:allow" },
  // 子 Run 的每一次工具调用都单独经过同一个执行器，委托本身不扩大能力。
  agent: { effect: "allow", ruleId: "default:agent:allow" },
  // 父任务本地的子任务控制工具（等待与停止），不执行外部动作。
  wait_agent: { effect: "allow", ruleId: "default:wait_agent:allow" },
  stop_agent: { effect: "allow", ruleId: "default:stop_agent:allow" },
  // 项目配置的完成检查脚本；只有单次批准，不能沿用会话授权。
  [STOP_HOOK_TOOL_NAME]: {
    effect: "confirm",
    ruleId: "default:stop_hook:confirm",
    reason:
      "The project's completion check script runs inside the macOS workspace sandbox.",
  },
  bash: {
    effect: "confirm",
    ruleId: "default:bash:confirm",
    reason:
      "Bash can execute arbitrary commands inside the macOS workspace sandbox.",
  },
} as const satisfies Readonly<Record<string, ToolPermissionRule>>;

export interface DefaultToolPermissionPolicyOptions {
  /** 提供时启用「本会话允许」：能把 confirm 抬成 allow，不能动 deny。 */
  readonly toolGrantStore?: ToolGrantStore;
}

/** 生产装配。数组顺序就是判断顺序，从上往下读。 */
export function createDefaultToolPermissionPolicy(
  options: DefaultToolPermissionPolicyOptions = {},
): ToolPermissionPolicy {
  return composePolicy([
    fullAccessAllowsEverything,
    ...(options.toolGrantStore === undefined
      ? []
      : [conversationGrantsUpgradeConfirm(options.toolGrantStore)]),
    mcpToolsNeedConfirmation,
    fixedRules(defaultToolPermissionRules),
  ]);
}

export const allowAllToolPermissionPolicy: ToolPermissionPolicy = {
  evaluate() {
    return { effect: "allow", ruleId: "compatibility:allow-all" };
  },
  isVisible() {
    return true;
  },
};

export function permissionDeniedResult(
  tool: string,
  reason: string,
): ToolResult {
  return {
    type: "tool_result",
    tool,
    status: "error",
    error: { code: "TOOL_PERMISSION_DENIED", message: reason },
  };
}

export function approvalDeniedResult(tool: string): ToolResult {
  return {
    type: "tool_result",
    tool,
    status: "error",
    error: {
      code: "TOOL_APPROVAL_DENIED",
      message: "The user denied this tool call.",
    },
  };
}

export function approvalExpiredResult(tool: string): ToolResult {
  return {
    type: "tool_result",
    tool,
    status: "error",
    error: {
      code: "TOOL_APPROVAL_EXPIRED",
      message: "User confirmation for this tool call expired.",
    },
  };
}

export function workspaceGrantDeniedResult(tool: string): ToolResult {
  return {
    type: "tool_result",
    tool,
    status: "error",
    error: {
      code: "WORKSPACE_GRANT_DENIED",
      message: "The requested file access was not granted.",
    },
  };
}

export function workspaceGrantExpiredResult(tool: string): ToolResult {
  return {
    type: "tool_result",
    tool,
    status: "error",
    error: {
      code: "WORKSPACE_GRANT_EXPIRED",
      message: "The requested file access expired.",
    },
  };
}

function digestArguments(input: unknown): string {
  return createHash("sha256").update(canonicalJson(input)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(",")}}`;
}
