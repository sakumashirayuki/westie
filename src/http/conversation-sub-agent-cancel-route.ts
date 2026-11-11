import type { IncomingMessage, ServerResponse } from "node:http";
import type { ConversationService } from "../application/conversation-service.js";
import type { RunRegistry } from "../application/run-registry.js";
import { getAccessibleRunConversation } from "./conversation-run-access.js";
import { writeHttpError, writeJson } from "./http-response.js";

export interface ConversationSubAgentCancelRouteOptions {
  readonly conversationService: ConversationService;
  readonly registry: RunRegistry;
  readonly allowedOrigin?: string;
  readonly fullAccessAvailable?: boolean;
}

export class ConversationSubAgentCancelRoute {
  constructor(private readonly options: ConversationSubAgentCancelRouteOptions) {}

  /** 方法校验、Origin 校验与 Allow 头由挂载处的 defineRoute 负责。 */
  async handle(request: IncomingMessage, response: ServerResponse, conversationId: string, parentRunId: string, childRunId: string): Promise<void> {
    const conversation = await getAccessibleRunConversation(request, response, conversationId, this.options);
    if (conversation === undefined) return;
    const active = this.options.registry.getByConversation(conversationId, parentRunId);
    if (active !== undefined) {
      const result = this.options.registry.cancelChild(parentRunId, childRunId);
      if (result !== "not_found") {
        writeJson(response, result.status === "stopping" ? 202 : 200, result);
        return;
      }
    }
    const parent = conversation.turns.flatMap((turn) => turn.runs).find((run) => run.id === parentRunId);
    const child = parent?.subAgentRuns.find((run) => run.id === childRunId);
    if (child === undefined) {
      writeHttpError(response, { status: 404, code: "SUB_AGENT_NOT_FOUND", message: "The sub agent was not found in this run." });
      return;
    }
    const result = { runId: child.id, status: child.status };
    writeJson(response, 200, result);
  }
}
