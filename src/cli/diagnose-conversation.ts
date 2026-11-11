import { basename, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";

import { parseTranscriptMessage } from "../transcript.js";

const DEFAULT_DATABASE_PATH = ".data/agent-harness.sqlite";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface DiagnoseConversationOptions {
  readonly includeContent?: boolean;
}

export interface ConversationDiagnostic {
  readonly diagnosticVersion: 7;
  readonly conversation: Record<string, unknown>;
}

export function exportConversationDiagnostic(
  databasePath: string,
  conversationId: string,
  options: DiagnoseConversationOptions = {},
): ConversationDiagnostic {
  assertUuid(conversationId);

  const database = new DatabaseSync(databasePath, {
    readOnly: true,
    enableDoubleQuotedStringLiterals: false,
    allowExtension: false,
    allowBareNamedParameters: false,
    allowUnknownNamedParameters: false,
  });
  try {
    database.exec("PRAGMA query_only = ON");
    const conversation = database.prepare(`
      SELECT
        id,
        revision,
        workspace_root,
        execution_mode,
        active_run_id,
        created_at,
        updated_at
      FROM conversations
      WHERE id = $conversationId
    `).get({ "$conversationId": conversationId });
    if (conversation === undefined) {
      throw new Error(`Conversation ${conversationId} was not found.`);
    }

    const turns = database.prepare(`
      SELECT
        id,
        position,
        user_message,
        opening_seq,
        status,
        created_at,
        updated_at
      FROM turns
      WHERE conversation_id = $conversationId
      ORDER BY position ASC
    `).all({ "$conversationId": conversationId });
    const runs = database.prepare(`
      SELECT
        runs.id,
        runs.turn_id,
        runs.attempt,
        runs.status,
        runs.final_answer,
        runs.message_count,
        runs.transcript_bytes,
        runs.error_code,
        runs.error_message,
        runs.internal_error,
        runs.system_prompt,
        runs.created_at,
        runs.updated_at
      FROM runs
      INNER JOIN turns ON turns.id = runs.turn_id
      WHERE turns.conversation_id = $conversationId
      ORDER BY turns.position ASC, runs.attempt ASC
    `).all({ "$conversationId": conversationId });
    const messages = database.prepare(`
      SELECT
        transcript_messages.seq,
        transcript_messages.run_id,
        transcript_messages.role,
        transcript_messages.message_json
      FROM transcript_messages
      WHERE transcript_messages.conversation_id = $conversationId
      ORDER BY transcript_messages.seq ASC
    `).all({ "$conversationId": conversationId });
    const compactions = database.prepare(`
      SELECT
        conversation_context_compactions.position,
        conversation_context_compactions.covered_through_seq,
        conversation_context_compactions.summary_text,
        conversation_context_compactions.created_at
      FROM conversation_context_compactions
      WHERE conversation_context_compactions.conversation_id = $conversationId
      ORDER BY conversation_context_compactions.position ASC
    `).all({ "$conversationId": conversationId });
    const modelCalls = database.prepare(`
      SELECT
        run_model_calls.run_id,
        run_model_calls.seq,
        run_model_calls.kind,
        run_model_calls.step,
        run_model_calls.sub_agent_run_id,
        run_model_calls.model,
        run_model_calls.input_tokens,
        run_model_calls.cached_input_tokens,
        run_model_calls.output_tokens,
        run_model_calls.reasoning_tokens,
        run_model_calls.created_at
      FROM run_model_calls
      INNER JOIN runs ON runs.id = run_model_calls.run_id
      INNER JOIN turns ON turns.id = runs.turn_id
      WHERE turns.conversation_id = $conversationId
      ORDER BY turns.position ASC, runs.attempt ASC, run_model_calls.seq ASC
    `).all({ "$conversationId": conversationId });

    const subAgentRuns = database.prepare(`
      SELECT
        sub_agent_runs.id,
        sub_agent_runs.parent_run_id,
        sub_agent_runs.tool_call_id,
        sub_agent_runs.description,
        sub_agent_runs.status,
        sub_agent_runs.final_answer,
        sub_agent_runs.error_code,
        sub_agent_runs.error_message,
        sub_agent_runs.internal_error,
        sub_agent_runs.system_prompt,
        sub_agent_runs.message_count,
        sub_agent_runs.transcript_bytes,
        sub_agent_runs.created_at,
        sub_agent_runs.updated_at
      FROM sub_agent_runs
      INNER JOIN runs ON runs.id = sub_agent_runs.parent_run_id
      INNER JOIN turns ON turns.id = runs.turn_id
      WHERE turns.conversation_id = $conversationId
      ORDER BY sub_agent_runs.created_at ASC, sub_agent_runs.id ASC
    `).all({ "$conversationId": conversationId });
    const subAgentMessages = database.prepare(`
      SELECT
        sub_agent_transcript_messages.sub_agent_run_id,
        sub_agent_transcript_messages.seq,
        sub_agent_transcript_messages.role,
        sub_agent_transcript_messages.message_json
      FROM sub_agent_transcript_messages
      INNER JOIN sub_agent_runs
        ON sub_agent_runs.id = sub_agent_transcript_messages.sub_agent_run_id
      INNER JOIN runs ON runs.id = sub_agent_runs.parent_run_id
      INNER JOIN turns ON turns.id = runs.turn_id
      WHERE turns.conversation_id = $conversationId
      ORDER BY sub_agent_transcript_messages.sub_agent_run_id ASC,
        sub_agent_transcript_messages.seq ASC
    `).all({ "$conversationId": conversationId });

    const runsByTurn = groupBy(runs, "turn_id");
    const modelCallsByRun = groupBy(modelCalls, "run_id");
    const subAgentRunsByRun = groupBy(subAgentRuns, "parent_run_id");
    const subAgentMessagesByRun = groupBy(subAgentMessages, "sub_agent_run_id");
    const workspaceRoot = expectString(
      conversation.workspace_root,
      "workspace_root",
    );

    return {
      diagnosticVersion: 7,
      conversation: {
        id: expectString(conversation.id, "conversation.id"),
        revision: expectInteger(conversation.revision, "conversation.revision"),
        executionMode: expectString(
          conversation.execution_mode,
          "conversation.execution_mode",
        ),
        activeRunId: nullableString(
          conversation.active_run_id,
          "conversation.active_run_id",
        ),
        workspace: {
          name: basename(workspaceRoot) || workspaceRoot,
          ...(options.includeContent ? { canonicalPath: workspaceRoot } : {}),
        },
        createdAt: expectString(conversation.created_at, "conversation.created_at"),
        updatedAt: expectString(conversation.updated_at, "conversation.updated_at"),
        turns: turns.map((turn) => {
          const userMessage = expectString(turn.user_message, "turn.user_message");
          return {
            id: expectString(turn.id, "turn.id"),
            position: expectInteger(turn.position, "turn.position"),
            status: expectString(turn.status, "turn.status"),
            openingSeq: expectInteger(turn.opening_seq, "turn.opening_seq"),
            userMessageBytes: Buffer.byteLength(userMessage),
            ...(options.includeContent ? { userMessage } : {}),
            createdAt: expectString(turn.created_at, "turn.created_at"),
            updatedAt: expectString(turn.updated_at, "turn.updated_at"),
            runs: (runsByTurn.get(expectString(turn.id, "turn.id")) ?? []).map(
              (run) => mapRun(
                run,
                modelCallsByRun,
                subAgentRunsByRun,
                subAgentMessagesByRun,
                options.includeContent === true,
              ),
            ),
          };
        }),
        transcript: messages.map((message) => {
          const role = expectString(message.role, "transcript.role");
          const messageJson = expectString(
            message.message_json,
            "transcript.message_json",
          );
          const parsedMessage = parseTranscriptMessage(messageJson);
          if (parsedMessage.role !== role) {
            throw invalidField("transcript.message_json role");
          }
          return {
            seq: expectInteger(message.seq, "transcript.seq"),
            runId: expectString(message.run_id, "transcript.run_id"),
            role,
            messageBytes: Buffer.byteLength(messageJson),
            ...(options.includeContent ? { message: parsedMessage } : {}),
          };
        }),
        contextCompactions: compactions.map((compaction) => {
          const summary = expectString(
            compaction.summary_text,
            "context_compaction.summary_text",
          );
          return {
            position: expectInteger(
              compaction.position,
              "context_compaction.position",
            ),
            coveredThroughSeq: expectInteger(
              compaction.covered_through_seq,
              "context_compaction.covered_through_seq",
            ),
            summaryBytes: Buffer.byteLength(summary, "utf8"),
            ...(options.includeContent ? { summary } : {}),
            createdAt: expectString(
              compaction.created_at,
              "context_compaction.created_at",
            ),
          };
        }),
        usage: usageTotals(modelCalls),
      },
    };
  } finally {
    database.close();
  }
}

export function resolveDatabasePath(
  environment: NodeJS.ProcessEnv,
  cwd: string,
): string {
  const configured = environment.AGENT_DATABASE_PATH?.trim() ||
    DEFAULT_DATABASE_PATH;
  return isAbsolute(configured) ? configured : resolve(cwd, configured);
}

export function runDiagnoseConversationCli(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  stdout: Pick<NodeJS.WriteStream, "write"> = process.stdout,
  stderr: Pick<NodeJS.WriteStream, "write"> = process.stderr,
): number {
  const includeContent = args.includes("--include-content");
  const positional = args.filter((argument) => argument !== "--include-content");
  const unknownOption = positional.find((argument) => argument.startsWith("-"));
  if (positional.length !== 1 || unknownOption !== undefined) {
    stderr.write(
      "Usage: npm run diagnose:conversation -- <conversation-id> [--include-content]\n",
    );
    return 2;
  }

  try {
    assertUuid(positional[0]);
    if (includeContent) {
      stderr.write(
        "Warning: --include-content exports workspace paths, system prompts, messages, tool inputs/results, context summaries, and internal errors. Treat the JSON as sensitive.\n",
      );
    }
    const diagnostic = exportConversationDiagnostic(
      resolveDatabasePath(environment, cwd),
      positional[0],
      { includeContent },
    );
    stdout.write(`${JSON.stringify(diagnostic, null, 2)}\n`);
    return 0;
  } catch (error) {
    stderr.write(`Failed to diagnose conversation: ${errorMessage(error)}\n`);
    return 1;
  }
}

type RowGroups = ReadonlyMap<string, readonly Record<string, SQLOutputValue>[]>;

function mapRun(
  run: Record<string, SQLOutputValue>,
  modelCallsByRun: RowGroups,
  subAgentRunsByRun: RowGroups,
  subAgentMessagesByRun: RowGroups,
  includeContent: boolean,
): Record<string, unknown> {
  const id = expectString(run.id, "run.id");
  const finalAnswer = nullableString(run.final_answer, "run.final_answer");
  const internalError = nullableString(run.internal_error, "run.internal_error");
  const systemPrompt = nullableString(run.system_prompt, "run.system_prompt");
  return {
    id,
    attempt: expectInteger(run.attempt, "run.attempt"),
    status: expectString(run.status, "run.status"),
    errorCode: nullableString(run.error_code, "run.error_code"),
    errorMessage: nullableString(run.error_message, "run.error_message"),
    messageCount: nullableInteger(run.message_count, "run.message_count"),
    transcriptBytes: nullableInteger(run.transcript_bytes, "run.transcript_bytes"),
    systemPromptBytes: systemPrompt === null
      ? null
      : Buffer.byteLength(systemPrompt, "utf8"),
    ...(includeContent ? { finalAnswer, internalError, systemPrompt } : {}),
    createdAt: expectString(run.created_at, "run.created_at"),
    updatedAt: expectString(run.updated_at, "run.updated_at"),
    modelCalls: (modelCallsByRun.get(id) ?? []).map((call) => ({
      seq: expectInteger(call.seq, "model_call.seq"),
      kind: expectString(call.kind, "model_call.kind"),
      step: nullableInteger(call.step, "model_call.step"),
      subAgentRunId: nullableString(
        call.sub_agent_run_id,
        "model_call.sub_agent_run_id",
      ),
      model: expectString(call.model, "model_call.model"),
      inputTokens: nullableInteger(call.input_tokens, "model_call.input_tokens"),
      cachedInputTokens: nullableInteger(
        call.cached_input_tokens,
        "model_call.cached_input_tokens",
      ),
      outputTokens: nullableInteger(call.output_tokens, "model_call.output_tokens"),
      reasoningTokens: nullableInteger(
        call.reasoning_tokens,
        "model_call.reasoning_tokens",
      ),
      createdAt: expectString(call.created_at, "model_call.created_at"),
    })),
    usage: usageTotals(modelCallsByRun.get(id) ?? []),
    subAgentRuns: (subAgentRunsByRun.get(id) ?? []).map((subAgentRun) =>
      mapSubAgentRun(
        subAgentRun,
        modelCallsByRun.get(id) ?? [],
        subAgentMessagesByRun,
        includeContent,
      )
    ),
  };
}

function mapSubAgentRun(
  run: Record<string, SQLOutputValue>,
  parentModelCalls: readonly Record<string, SQLOutputValue>[],
  subAgentMessagesByRun: RowGroups,
  includeContent: boolean,
): Record<string, unknown> {
  const id = expectString(run.id, "sub_agent_run.id");
  const finalAnswer = nullableString(run.final_answer, "sub_agent_run.final_answer");
  const internalError = nullableString(
    run.internal_error,
    "sub_agent_run.internal_error",
  );
  const systemPrompt = expectString(run.system_prompt, "sub_agent_run.system_prompt");
  return {
    id,
    toolCallId: expectString(run.tool_call_id, "sub_agent_run.tool_call_id"),
    description: expectString(run.description, "sub_agent_run.description"),
    status: expectString(run.status, "sub_agent_run.status"),
    errorCode: nullableString(run.error_code, "sub_agent_run.error_code"),
    errorMessage: nullableString(run.error_message, "sub_agent_run.error_message"),
    messageCount: expectInteger(run.message_count, "sub_agent_run.message_count"),
    transcriptBytes: expectInteger(
      run.transcript_bytes,
      "sub_agent_run.transcript_bytes",
    ),
    systemPromptBytes: Buffer.byteLength(systemPrompt, "utf8"),
    ...(includeContent ? { finalAnswer, internalError, systemPrompt } : {}),
    createdAt: expectString(run.created_at, "sub_agent_run.created_at"),
    updatedAt: expectString(run.updated_at, "sub_agent_run.updated_at"),
    usage: usageTotals(
      parentModelCalls.filter((call) => call.sub_agent_run_id === id),
    ),
    transcript: (subAgentMessagesByRun.get(id) ?? []).map((message) => {
      const role = expectString(message.role, "sub_agent_transcript.role");
      const messageJson = expectString(
        message.message_json,
        "sub_agent_transcript.message_json",
      );
      const parsedMessage = parseTranscriptMessage(messageJson);
      if (parsedMessage.role !== role) {
        throw invalidField("sub_agent_transcript.message_json role");
      }
      return {
        seq: expectInteger(message.seq, "sub_agent_transcript.seq"),
        role,
        messageBytes: Buffer.byteLength(messageJson),
        ...(includeContent ? { message: parsedMessage } : {}),
      };
    }),
  };
}

function usageTotals(
  rows: readonly Record<string, SQLOutputValue>[],
): Record<string, number> {
  let calls = 0;
  let unmeasuredCalls = 0;
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  for (const row of rows) {
    calls += 1;
    if (row.input_tokens === null) {
      unmeasuredCalls += 1;
      continue;
    }
    inputTokens += expectInteger(row.input_tokens, "input_tokens");
    cachedInputTokens += expectInteger(
      row.cached_input_tokens,
      "cached_input_tokens",
    );
    outputTokens += expectInteger(row.output_tokens, "output_tokens");
    reasoningTokens += expectInteger(row.reasoning_tokens, "reasoning_tokens");
  }
  return {
    calls,
    unmeasuredCalls,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningTokens,
  };
}

function groupBy(
  rows: readonly Record<string, SQLOutputValue>[],
  key: string,
): Map<string, readonly Record<string, SQLOutputValue>[]> {
  const result = new Map<string, Record<string, SQLOutputValue>[]>();
  for (const row of rows) {
    const value = expectString(row[key], key);
    const group = result.get(value);
    if (group === undefined) result.set(value, [row]);
    else group.push(row);
  }
  return result;
}

function assertUuid(value: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new Error(`Invalid conversation ID: expected a UUID, received ${value}.`);
  }
}

function expectString(value: SQLOutputValue | undefined, field: string): string {
  if (typeof value !== "string") throw invalidField(field);
  return value;
}

function nullableString(
  value: SQLOutputValue | undefined,
  field: string,
): string | null {
  if (value === null) return null;
  return expectString(value, field);
}

function expectInteger(value: SQLOutputValue | undefined, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw invalidField(field);
  }
  return value;
}

function nullableInteger(
  value: SQLOutputValue | undefined,
  field: string,
): number | null {
  if (value === null) return null;
  return expectInteger(value, field);
}

function invalidField(field: string): Error {
  return new Error(`SQLite database has an invalid ${field} value.`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = runDiagnoseConversationCli(process.argv.slice(2));
}
