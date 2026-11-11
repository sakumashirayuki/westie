import { realpath, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";

import { z } from "zod";

import type { InteractionBroker } from "../application/interaction-broker.js";
import type { HostFilePicker } from "../infrastructure/host-file-picker.js";
import { watchClientDisconnect } from "./client-disconnect.js";
import {
  writeHttpError,
  writeJson,
  writeRetryableSelectionError,
} from "./http-response.js";
import { parseJsonRequest } from "./request-json.js";

const interactionResponseSchema = z.strictObject({
  response: z.strictObject({
    decision: z.enum(["approve", "deny"]),
  }),
});

export interface InteractionRoutesOptions {
  readonly interactionBroker: InteractionBroker;
  readonly hostFilePicker?: HostFilePicker;
}

export class InteractionRoutes {
  constructor(private readonly options: InteractionRoutesOptions) {}

  async respondToInteraction(
    request: IncomingMessage,
    response: ServerResponse,
    interactionId: string,
  ): Promise<void> {
    // 方法校验与 Allow 头由挂载处的 defineRoute 负责。
    const parsed = await parseJsonRequest(
      request,
      interactionResponseSchema,
      {
        code: "INVALID_INTERACTION_RESPONSE",
        message:
          "Request body does not match the interaction response schema.",
      },
    );
    if (!parsed.ok) {
      writeHttpError(response, parsed.error);
      return;
    }

    const result = this.options.interactionBroker.resolve(
      interactionId,
      parsed.data.response,
    );
    switch (result.status) {
      case "accepted":
      case "idempotent":
        writeJson(response, 200, {
          interactionId,
          status: result.status,
        });
        return;
      case "conflict":
        writeHttpError(response, {
          status: 409,
          code: "INTERACTION_RESPONSE_CONFLICT",
          message: "Interaction was already resolved with another response.",
        });
        return;
      case "gone":
        writeHttpError(response, {
          status: 410,
          code: "INTERACTION_GONE",
          message: "Interaction expired or its run has ended.",
        });
        return;
      case "not_found":
        writeHttpError(response, {
          status: 404,
          code: "INTERACTION_NOT_FOUND",
          message: "Interaction was not found.",
        });
        return;
      case "invalid_response":
        writeHttpError(response, {
          status: 422,
          code: "INVALID_INTERACTION_RESPONSE",
          message: "This interaction cannot be approved by this endpoint.",
        });
    }
  }

  async selectFileForInteraction(
    request: IncomingMessage,
    response: ServerResponse,
    interactionId: string,
  ): Promise<void> {
    // 方法校验与 Allow 头由挂载处的 defineRoute 负责。
    if (this.options.hostFilePicker === undefined) {
      writeHttpError(response, {
        status: 501,
        code: "HOST_FILE_PICKER_UNAVAILABLE",
        message: "The host file picker is unavailable.",
      });
      return;
    }

    const inspected = this.options.interactionBroker.inspect(interactionId);
    if (inspected.status === "not_found") {
      writeHttpError(response, {
        status: 404,
        code: "INTERACTION_NOT_FOUND",
        message: "Interaction was not found.",
      });
      return;
    }
    if (inspected.status === "gone") {
      writeHttpError(response, {
        status: 410,
        code: "INTERACTION_GONE",
        message: "Interaction expired or its run has ended.",
      });
      return;
    }
    if (inspected.interaction.kind !== "workspace_grant") {
      writeHttpError(response, {
        status: 409,
        code: "INTERACTION_KIND_MISMATCH",
        message: "This interaction does not request file access.",
      });
      return;
    }

    const watcher = watchClientDisconnect(request, response);
    try {
      const selection = await this.options.hostFilePicker.pickFile(
        watcher.signal,
      );
      if (selection.status === "cancelled") {
        writeRetryableSelectionError(
          response,
          "HOST_FILE_PICKER_CANCELLED",
          "File selection was cancelled.",
        );
        return;
      }

      let selectedPath: string;
      try {
        selectedPath = await realpath(selection.path);
        const selectedStats = await stat(selectedPath);
        if (!selectedStats.isFile()) {
          writeRetryableSelectionError(
            response,
            "WORKSPACE_GRANT_SELECTION_INVALID",
            "Selected path is not a regular file.",
          );
          return;
        }
      } catch {
        writeRetryableSelectionError(
          response,
          "WORKSPACE_GRANT_SELECTION_INVALID",
          "Selected file is unavailable.",
        );
        return;
      }

      if (selectedPath !== inspected.interaction.canonicalPath) {
        writeRetryableSelectionError(
          response,
          "WORKSPACE_GRANT_SELECTION_MISMATCH",
          "Selected file does not match the requested file.",
        );
        return;
      }

      const result = this.options.interactionBroker.resolve(interactionId, {
        decision: "approve",
        selectedPath,
      });
      if (result.status === "accepted" || result.status === "idempotent") {
        writeJson(response, 200, {
          interactionId,
          status: result.status,
        });
        return;
      }
      if (result.status === "gone") {
        writeHttpError(response, {
          status: 410,
          code: "INTERACTION_GONE",
          message: "Interaction expired or its run has ended.",
        });
        return;
      }
      writeHttpError(response, {
        status: 409,
        code: "INTERACTION_RESPONSE_CONFLICT",
        message: "Interaction could not be resolved.",
      });
    } catch {
      if (watcher.signal.aborted) return;
      writeHttpError(response, {
        status: 500,
        code: "HOST_FILE_PICKER_FAILED",
        message: "Could not open the host file picker.",
      });
    } finally {
      watcher.release();
    }
  }
}
