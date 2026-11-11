import { matchesGrant, type ToolGrantScope } from "../tool-grants.js";

// 一条待写入的会话级授权，判定所需的最小信息。
export interface NewToolGrant {
  readonly conversationId: string;
  readonly toolName: string;
  readonly scope: ToolGrantScope;
}

export interface ToolGrantStore {
  isGranted(
    conversationId: string,
    toolName: string,
    input: unknown,
  ): boolean;
  matchedScopeKind(
    conversationId: string,
    toolName: string,
    input: unknown,
  ): ToolGrantScope["kind"] | undefined;
  grant(grant: NewToolGrant): void;
  clear(conversationId: string): void;
}

// 内存态授权，与 InteractionBroker、InMemoryWorkspaceGrantStore 同层；
// 按 conversationId 建，会话删除或进程重启即消失。
export class InMemoryToolGrantStore implements ToolGrantStore {
  readonly #scopes = new Map<string, Set<string>>();

  isGranted(
    conversationId: string,
    toolName: string,
    input: unknown,
  ): boolean {
    return this.matchedScopeKind(conversationId, toolName, input) !== undefined;
  }

  matchedScopeKind(
    conversationId: string,
    toolName: string,
    input: unknown,
  ): ToolGrantScope["kind"] | undefined {
    const scopes = this.#scopes.get(conversationId);
    if (scopes === undefined) return undefined;
    let matchedKind: ToolGrantScope["kind"] | undefined;
    for (const key of scopes) {
      const { toolName: grantedTool, scope } = decodeScopeKey(key);
      if (
        grantedTool === toolName &&
        matchesGrant(scope, toolName, input)
      ) {
        if (scope.kind === "tool") return "tool";
        matchedKind = "command_prefix";
      }
    }
    return matchedKind;
  }

  grant(grant: NewToolGrant): void {
    const sets = this.#scopes.get(grant.conversationId);
    const key = encodeScopeKey(grant.toolName, grant.scope);
    if (sets === undefined) {
      this.#scopes.set(grant.conversationId, new Set([key]));
    } else {
      sets.add(key);
    }
  }

  clear(conversationId: string): void {
    this.#scopes.delete(conversationId);
  }
}

function encodeScopeKey(toolName: string, scope: ToolGrantScope): string {
  return JSON.stringify([
    toolName,
    scope.kind,
    scope.kind === "command_prefix" ? scope.value : "",
  ]);
}

function decodeScopeKey(
  key: string,
): { toolName: string; scope: ToolGrantScope } {
  const [toolName, kind, value] = JSON.parse(key) as unknown[];
  if (typeof toolName !== "string") throw new Error("Invalid grant key.");
  if (kind === "tool") return { toolName, scope: { kind: "tool" } };
  if (kind === "command_prefix" && typeof value === "string") {
    return { toolName, scope: { kind: "command_prefix", value } };
  }
  throw new Error("Invalid grant key.");
}
