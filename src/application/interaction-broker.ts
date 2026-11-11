import { randomUUID } from "node:crypto";

import type { ToolGrantScope } from "../tool-grants.js";

export interface ToolApprovalInteraction {
  readonly kind: "tool_approval";
  readonly runId: string;
  readonly step: number;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly ruleId: string;
  readonly argumentsDigest: string;
  readonly argumentsSummary: unknown;
  readonly risk: string;
  readonly impact: string;
  readonly grantOptions: readonly ToolGrantScope[];
  readonly conversationId: string;
}

export interface WorkspaceGrantInteraction {
  readonly kind: "workspace_grant";
  readonly reason: "outside_workspace" | "sensitive_workspace_file";
  readonly runId: string;
  readonly step: number;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly conversationId: string;
  readonly requestedPath: string;
  readonly canonicalPath: string;
  readonly access: "read";
  readonly scope: "once";
}

export type Interaction =
  | ToolApprovalInteraction
  | WorkspaceGrantInteraction;

export interface ToolApprovalResponse {
  readonly decision: "approve" | "deny";
  readonly selectedPath?: never;
  readonly grant?: ToolGrantScope;
}

export type InteractionResponse =
  | ToolApprovalResponse
  | {
      readonly decision: "approve";
      readonly selectedPath: string;
    };

export type InteractionResolution =
  | {
      readonly status: "responded";
      readonly response: InteractionResponse;
    }
  | { readonly status: "expired" };

export interface PendingInteraction {
  readonly interactionId: string;
  readonly interaction: Interaction;
  readonly expiresAt: string;
  wait(signal?: AbortSignal): Promise<InteractionResolution>;
  dispose(): void;
}

export type ResolveInteractionResult =
  | { readonly status: "accepted" | "idempotent" }
  | {
      readonly status:
        | "conflict"
        | "gone"
        | "not_found"
        | "invalid_response";
    };

export type InspectInteractionResult =
  | { readonly status: "pending"; readonly interaction: Interaction }
  | { readonly status: "gone" }
  | { readonly status: "not_found" };

export interface InteractionBroker {
  create(
    interaction: Interaction,
    options?: { readonly timeoutMs?: number },
  ): PendingInteraction;
  resolve(
    interactionId: string,
    response: InteractionResponse,
  ): ResolveInteractionResult;
  inspect(interactionId: string): InspectInteractionResult;
}

interface PendingEntry {
  readonly interaction: Interaction;
  readonly expiresAt: string;
  readonly promise: Promise<InteractionResolution>;
  readonly resolvePromise: (resolution: InteractionResolution) => void;
  readonly rejectPromise: (reason?: unknown) => void;
  readonly timeout: NodeJS.Timeout;
  resolution?: InteractionResolution;
  waitingSignal?: AbortSignal;
  abortListener?: () => void;
}

interface TerminalEntry {
  readonly outcome:
    | { readonly status: "responded"; readonly response: InteractionResponse }
    | { readonly status: "gone" };
  readonly cleanupTimer: NodeJS.Timeout;
}

export interface InMemoryInteractionBrokerOptions {
  readonly defaultTimeoutMs?: number;
  readonly terminalRetentionMs?: number;
}

export class InMemoryInteractionBroker implements InteractionBroker {
  readonly #defaultTimeoutMs: number;
  readonly #terminalRetentionMs: number;
  readonly #pending = new Map<string, PendingEntry>();
  readonly #terminal = new Map<string, TerminalEntry>();

  constructor(options: InMemoryInteractionBrokerOptions = {}) {
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? 5 * 60_000;
    this.#terminalRetentionMs = options.terminalRetentionMs ?? 5 * 60_000;
    assertPositiveDuration(this.#defaultTimeoutMs, "defaultTimeoutMs");
    assertPositiveDuration(this.#terminalRetentionMs, "terminalRetentionMs");
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  create(
    interaction: Interaction,
    options: { readonly timeoutMs?: number } = {},
  ): PendingInteraction {
    const timeoutMs = options.timeoutMs ?? this.#defaultTimeoutMs;
    assertPositiveDuration(timeoutMs, "timeoutMs");

    const interactionId = randomUUID();
    const expiresAt = new Date(Date.now() + timeoutMs).toISOString();
    let resolvePromise!: (resolution: InteractionResolution) => void;
    let rejectPromise!: (reason?: unknown) => void;
    const promise = new Promise<InteractionResolution>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const timeout = setTimeout(() => {
      const entry = this.#pending.get(interactionId);
      if (entry === undefined || entry.resolution !== undefined) return;
      const resolution = { status: "expired" } as const;
      entry.resolution = resolution;
      this.#detachAbort(entry);
      this.#rememberTerminal(interactionId, { status: "gone" });
      entry.resolvePromise(resolution);
    }, timeoutMs);

    const entry: PendingEntry = {
      interaction,
      expiresAt,
      promise,
      resolvePromise,
      rejectPromise,
      timeout,
    };
    this.#pending.set(interactionId, entry);

    let disposed = false;
    return {
      interactionId,
      interaction,
      expiresAt,
      wait: (signal) => this.#wait(interactionId, entry, signal),
      dispose: () => {
        if (disposed) return;
        disposed = true;
        this.#dispose(interactionId, entry);
      },
    };
  }

  resolve(
    interactionId: string,
    response: InteractionResponse,
  ): ResolveInteractionResult {
    const entry = this.#pending.get(interactionId);
    if (entry !== undefined) {
      if (!isValidResponse(entry.interaction, response)) {
        return { status: "invalid_response" };
      }
      if (entry.resolution !== undefined) {
        if (entry.resolution.status === "expired") {
          return { status: "gone" };
        }
        return isSameResponse(entry.resolution, response)
          ? { status: "idempotent" }
          : { status: "conflict" };
      }

      const resolution = { status: "responded", response } as const;
      entry.resolution = resolution;
      clearTimeout(entry.timeout);
      this.#detachAbort(entry);
      this.#rememberTerminal(interactionId, resolution);
      entry.resolvePromise(resolution);
      return { status: "accepted" };
    }

    const terminal = this.#terminal.get(interactionId);
    if (terminal === undefined) return { status: "not_found" };
    if (terminal.outcome.status === "gone") return { status: "gone" };
    return isSameDecision(terminal.outcome.response, response)
      ? { status: "idempotent" }
      : { status: "conflict" };
  }

  inspect(interactionId: string): InspectInteractionResult {
    const entry = this.#pending.get(interactionId);
    if (entry !== undefined && entry.resolution === undefined) {
      return { status: "pending", interaction: entry.interaction };
    }
    if (entry !== undefined || this.#terminal.has(interactionId)) {
      return { status: "gone" };
    }
    return { status: "not_found" };
  }

  #wait(
    interactionId: string,
    entry: PendingEntry,
    signal: AbortSignal | undefined,
  ): Promise<InteractionResolution> {
    if (signal === undefined) return entry.promise;
    if (signal.aborted) {
      this.#cancel(interactionId, entry, signal.reason);
      return entry.promise;
    }
    if (entry.waitingSignal !== undefined && entry.waitingSignal !== signal) {
      throw new Error("Pending interaction already has a waiter.");
    }
    if (entry.waitingSignal === undefined) {
      const abortListener = (): void => {
        this.#cancel(interactionId, entry, signal.reason);
      };
      entry.waitingSignal = signal;
      entry.abortListener = abortListener;
      signal.addEventListener("abort", abortListener, { once: true });
    }
    return entry.promise;
  }

  #cancel(
    interactionId: string,
    entry: PendingEntry,
    reason: unknown,
  ): void {
    if (entry.resolution !== undefined) return;
    clearTimeout(entry.timeout);
    this.#detachAbort(entry);
    this.#pending.delete(interactionId);
    this.#rememberTerminal(interactionId, { status: "gone" });
    entry.rejectPromise(reason ?? new DOMException("Aborted", "AbortError"));
  }

  #dispose(interactionId: string, entry: PendingEntry): void {
    clearTimeout(entry.timeout);
    this.#detachAbort(entry);
    if (this.#pending.get(interactionId) === entry) {
      this.#pending.delete(interactionId);
      if (!this.#terminal.has(interactionId)) {
        this.#rememberTerminal(interactionId, { status: "gone" });
      }
    }
  }

  #detachAbort(entry: PendingEntry): void {
    if (entry.waitingSignal !== undefined && entry.abortListener !== undefined) {
      entry.waitingSignal.removeEventListener("abort", entry.abortListener);
    }
    entry.waitingSignal = undefined;
    entry.abortListener = undefined;
  }

  #rememberTerminal(
    interactionId: string,
    outcome: TerminalEntry["outcome"],
  ): void {
    const existing = this.#terminal.get(interactionId);
    if (existing !== undefined) clearTimeout(existing.cleanupTimer);
    const cleanupTimer = setTimeout(() => {
      this.#terminal.delete(interactionId);
    }, this.#terminalRetentionMs);
    cleanupTimer.unref();
    this.#terminal.set(interactionId, { outcome, cleanupTimer });
  }
}

function isSameResponse(
  resolution: InteractionResolution,
  response: InteractionResponse,
): boolean {
  return (
    resolution.status === "responded" &&
    isSameDecision(resolution.response, response)
  );
}

function isSameDecision(
  left: InteractionResponse,
  right: InteractionResponse,
): boolean {
  return (
    left.decision === right.decision &&
    left.selectedPath === right.selectedPath &&
    grantOverride(left) === grantOverride(right)
  );
}

function isValidResponse(
  interaction: Interaction,
  response: InteractionResponse,
): boolean {
  if (interaction.kind === "tool_approval") {
    if (response.selectedPath !== undefined) return false;
    if (response.decision === "deny" && response.grant !== undefined) {
      return false;
    }
    if (response.grant !== undefined) {
      return interaction.grantOptions.some((option) =>
        sameScope(option, response.grant!)
      );
    }
    return true;
  }
  if (response.decision === "deny") {
    return response.selectedPath === undefined;
  }
  if (interaction.reason === "sensitive_workspace_file") {
    return (
      response.selectedPath === undefined ||
      response.selectedPath === interaction.canonicalPath
    );
  }
  return response.selectedPath === interaction.canonicalPath;
}

function sameScope(left: ToolGrantScope, right: ToolGrantScope): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === "tool" || left.value === (right as typeof left).value)
  );
}

function grantOverride(
  response: InteractionResponse,
): string {
  const grant = "grant" in response ? response.grant : undefined;
  if (grant === undefined) return "";
  return grant.kind === "tool" ? "tool" : `command_prefix:${grant.value}`;
}

function assertPositiveDuration(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }
}
