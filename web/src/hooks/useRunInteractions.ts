import { useState } from "react";

import { workspaceGrantErrorMessage } from "../error-messages";
import type { AgentEvent, ToolGrantScope } from "../events";
import type { InteractionRequestMap } from "../interaction-ui";
import {
  HttpRunError,
  respondToInteraction,
  selectWorkspaceFile,
  type ToolApprovalDecision,
} from "../run-client";

export function useRunInteractions(isActive: () => boolean) {
  const [interactionRequests, setInteractionRequests] =
    useState<InteractionRequestMap>({});

  function reset(): void {
    setInteractionRequests({});
  }

  function handleEvent(event: AgentEvent): void {
    const resolved = event.type === "interaction.resolved" ? event : undefined;
    if (resolved !== undefined) {
      setInteractionRequests((current) => {
        const next = { ...current };
        delete next[resolved.interactionId];
        return next;
      });
    }
  }

  async function respond(
    interactionId: string,
    decision: ToolApprovalDecision,
    grant?: ToolGrantScope,
  ): Promise<void> {
    if (!isActive()) return;
    setInteractionRequests((current) => ({
      ...current,
      [interactionId]: { status: "submitting", action: "respond" },
    }));
    try {
      await respondToInteraction(interactionId, decision, {
        ...(grant === undefined ? {} : { grant }),
      });
      markInteractionSubmitted(interactionId, "respond");
    } catch (error) {
      markInteractionFailed(
        interactionId,
        "respond",
        error instanceof HttpRunError
          ? error.message
          : "提交确认结果失败，请重试。",
      );
    }
  }

  async function selectFile(interactionId: string): Promise<void> {
    if (!isActive()) return;
    setInteractionRequests((current) => ({
      ...current,
      [interactionId]: { status: "submitting", action: "select_file" },
    }));
    try {
      await selectWorkspaceFile(interactionId);
      markInteractionSubmitted(interactionId, "select_file");
    } catch (error) {
      markInteractionFailed(
        interactionId,
        "select_file",
        workspaceGrantErrorMessage(error),
      );
    }
  }

  function markInteractionSubmitted(
    interactionId: string,
    action: "respond" | "select_file",
  ): void {
    setInteractionRequests((current) =>
      current[interactionId]?.status === "submitting"
        ? {
            ...current,
            [interactionId]: { status: "submitted", action },
          }
        : current
    );
  }

  function markInteractionFailed(
    interactionId: string,
    action: "respond" | "select_file",
    error: string,
  ): void {
    setInteractionRequests((current) =>
      current[interactionId]?.status === "submitting"
        ? {
            ...current,
            [interactionId]: { status: "error", action, error },
          }
        : current
    );
  }

  return { interactionRequests, reset, handleEvent, respond, selectFile };
}
