import type { ToolGrantScope } from "./events";
import type { ToolApprovalDecision } from "./run-client";

export interface InteractionRequestState {
  status: "submitting" | "submitted" | "error";
  action?: "respond" | "select_file";
  error?: string;
}

export type InteractionRequestMap = Record<
  string,
  InteractionRequestState
>;

export type InteractionResponder = (
  interactionId: string,
  decision: ToolApprovalDecision,
  grant?: ToolGrantScope,
) => void;

export type WorkspaceGrantSelector = (interactionId: string) => void;

/** 作用域按钮的文案。tool 作用域覆盖该工具的全部调用。 */
export function grantScopeLabel(
  scope: ToolGrantScope,
  toolName: string,
): string {
  return scope.kind === "tool"
    ? `本会话内允许所有 ${toolName}`
    : `本会话内允许 ${scope.value}`;
}
