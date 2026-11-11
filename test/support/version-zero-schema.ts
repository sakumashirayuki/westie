/** SQLite schema before versioned migrations. */
export const VERSION_ZERO_SCHEMA = `
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
        workspace_root TEXT NOT NULL,
        execution_mode TEXT NOT NULL
          CHECK (execution_mode IN ('workspace_sandbox', 'full_access')),
        active_run_id TEXT NULL
          REFERENCES runs(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL
          REFERENCES conversations(id) ON DELETE CASCADE,
        position INTEGER NOT NULL CHECK (position >= 0),
        user_message TEXT NOT NULL,
        opening_seq INTEGER NOT NULL CHECK (opening_seq >= 0),
        status TEXT NOT NULL
          CHECK (
            status IN ('running', 'completed', 'failed', 'cancelled')
          ),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (conversation_id, position),
        UNIQUE (conversation_id, opening_seq)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL
          REFERENCES turns(id) ON DELETE CASCADE,
        attempt INTEGER NOT NULL CHECK (attempt >= 1),
        status TEXT NOT NULL
          CHECK (
            status IN ('running', 'completed', 'failed', 'cancelled')
          ),
        final_answer TEXT NULL,
        message_count INTEGER NULL
          CHECK (message_count IS NULL OR message_count >= 0),
        transcript_bytes INTEGER NULL
          CHECK (transcript_bytes IS NULL OR transcript_bytes >= 0),
        error_code TEXT NULL,
        error_message TEXT NULL,
        internal_error TEXT NULL,
        system_prompt TEXT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (turn_id, attempt),
        CHECK (
          (status = 'completed' AND final_answer IS NOT NULL)
          OR (status <> 'completed' AND final_answer IS NULL)
        ),
        CHECK ((status = 'running') = (message_count IS NULL)),
        CHECK ((message_count IS NULL) = (transcript_bytes IS NULL))
      ) STRICT;

      CREATE TABLE IF NOT EXISTS transcript_messages (
        conversation_id TEXT NOT NULL
          REFERENCES conversations(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL CHECK (seq >= 0),
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        role TEXT NOT NULL
          CHECK (role IN ('user', 'assistant', 'tool')),
        message_json TEXT NOT NULL
          CHECK (json_valid(message_json))
          CHECK (json_type(message_json) IS 'object')
          CHECK (json_type(message_json, '$.role') IS 'text')
          CHECK (json_extract(message_json, '$.role') = role),
        PRIMARY KEY (conversation_id, seq)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS conversation_context_compactions (
        conversation_id TEXT NOT NULL
          REFERENCES conversations(id) ON DELETE CASCADE,
        position INTEGER NOT NULL CHECK (position >= 0),
        covered_through_seq INTEGER NOT NULL CHECK (covered_through_seq >= 0),
        summary_text TEXT NOT NULL CHECK (length(trim(summary_text)) > 0),
        created_at TEXT NOT NULL,
        PRIMARY KEY (conversation_id, position),
        UNIQUE (conversation_id, covered_through_seq)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS sub_agent_runs (
        id TEXT PRIMARY KEY,
        parent_run_id TEXT NOT NULL
          REFERENCES runs(id) ON DELETE CASCADE,
        tool_call_id TEXT NOT NULL,
        description TEXT NOT NULL CHECK (length(trim(description)) > 0),
        status TEXT NOT NULL
          CHECK (status IN ('completed', 'failed', 'cancelled')),
        stop_reason TEXT NULL
          CHECK (stop_reason IN ('final', 'step_limit')),
        final_answer TEXT NULL,
        error_code TEXT NULL,
        error_message TEXT NULL,
        internal_error TEXT NULL,
        system_prompt TEXT NOT NULL,
        message_count INTEGER NOT NULL CHECK (message_count >= 0),
        transcript_bytes INTEGER NOT NULL CHECK (transcript_bytes >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (parent_run_id, tool_call_id),
        CHECK ((status = 'completed') = (stop_reason IS NOT NULL)),
        CHECK (
          (status = 'completed' AND final_answer IS NOT NULL)
          OR (status <> 'completed' AND final_answer IS NULL)
        )
      ) STRICT;

      CREATE TABLE IF NOT EXISTS sub_agent_transcript_messages (
        sub_agent_run_id TEXT NOT NULL
          REFERENCES sub_agent_runs(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL CHECK (seq >= 0),
        role TEXT NOT NULL
          CHECK (role IN ('user', 'assistant', 'tool')),
        message_json TEXT NOT NULL
          CHECK (json_valid(message_json))
          CHECK (json_type(message_json) IS 'object')
          CHECK (json_type(message_json, '$.role') IS 'text')
          CHECK (json_extract(message_json, '$.role') = role),
        PRIMARY KEY (sub_agent_run_id, seq)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS run_model_calls (
        run_id TEXT NOT NULL
          REFERENCES runs(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL CHECK (seq >= 0),
        kind TEXT NOT NULL
          CHECK (
            kind IN ('step', 'context_compaction', 'history_summary', 'sub_agent')
          ),
        step INTEGER NULL CHECK (step IS NULL OR step >= 1),
        sub_agent_run_id TEXT NULL
          REFERENCES sub_agent_runs(id) ON DELETE CASCADE,
        model TEXT NOT NULL CHECK (length(trim(model)) > 0),
        input_tokens INTEGER NULL,
        cached_input_tokens INTEGER NULL,
        output_tokens INTEGER NULL,
        reasoning_tokens INTEGER NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (run_id, seq),
        CHECK ((kind = 'step') = (step IS NOT NULL)),
        CHECK ((kind = 'sub_agent') = (sub_agent_run_id IS NOT NULL)),
        CHECK (
          (input_tokens IS NULL AND cached_input_tokens IS NULL
            AND output_tokens IS NULL AND reasoning_tokens IS NULL)
          OR
          (input_tokens IS NOT NULL AND cached_input_tokens IS NOT NULL
            AND output_tokens IS NOT NULL AND reasoning_tokens IS NOT NULL)
        ),
        CHECK (input_tokens IS NULL OR input_tokens >= 0),
        CHECK (output_tokens IS NULL OR output_tokens >= 0),
        CHECK (
          cached_input_tokens IS NULL
          OR (cached_input_tokens >= 0 AND cached_input_tokens <= input_tokens)
        ),
        CHECK (
          reasoning_tokens IS NULL
          OR (reasoning_tokens >= 0 AND reasoning_tokens <= output_tokens)
        )
      ) STRICT;

      CREATE INDEX IF NOT EXISTS conversations_updated_at_id_idx
        ON conversations(updated_at DESC, id DESC);
    `;
