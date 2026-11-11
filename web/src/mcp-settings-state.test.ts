import { describe, expect, it } from "vitest";

import {
  firstInvalidId,
  initialMcpSettingsState,
  isDirty,
  mcpSettingsReducer,
  toSaveRequest,
  validateDraft,
  type McpSettingsState,
} from "./mcp-settings-state";
import type { McpServerEntry } from "./run-client";

const servers: McpServerEntry[] = [
  {
    name: "github",
    config: {
      type: "stdio",
      command: "npx",
      args: ["-y", "server-github"],
      env: { TOKEN: "${GITHUB_TOKEN}" },
      timeoutMs: 60_000,
    },
  },
  {
    name: "docs",
    config: { type: "http", url: "https://docs.example/mcp", timeoutMs: 30_000 },
  },
];

function ready(): Extract<McpSettingsState, { status: "ready" }> {
  const state = mcpSettingsReducer(
    mcpSettingsReducer(initialMcpSettingsState, { type: "open" }),
    { type: "loaded", servers },
  );
  if (state.status !== "ready") throw new Error("expected ready");
  return state;
}

describe("mcpSettingsReducer", () => {
  it("loads servers into drafts and selects the first one", () => {
    const state = ready();
    expect(state.drafts.map((d) => d.name)).toEqual(["github", "docs"]);
    expect(state.selectedId).toBe(state.drafts[0]!.id);
    expect(state.drafts[0]!.env).toEqual([{ key: "TOKEN", value: "${GITHUB_TOKEN}" }]);
    expect(isDirty(state)).toBe(false);
  });

  it("adds an empty draft, selects it and marks the state dirty", () => {
    const state = mcpSettingsReducer(ready(), { type: "add" });
    if (state.status !== "ready") throw new Error();
    expect(state.drafts).toHaveLength(3);
    expect(state.selectedId).toBe(state.drafts[2]!.id);
    expect(isDirty(state)).toBe(true);
  });

  it("removing the selected draft selects its neighbour", () => {
    const base = ready();
    const state = mcpSettingsReducer(base, { type: "remove", id: base.drafts[0]!.id });
    if (state.status !== "ready") throw new Error();
    expect(state.drafts.map((d) => d.name)).toEqual(["docs"]);
    expect(state.selectedId).toBe(state.drafts[0]!.id);
  });

  it("editing marks dirty and undoing the edit clears it", () => {
    const base = ready();
    const id = base.drafts[0]!.id;
    const edited = mcpSettingsReducer(base, { type: "edit", id, patch: { command: "bunx" } });
    expect(isDirty(edited)).toBe(true);
    const reverted = mcpSettingsReducer(edited, { type: "edit", id, patch: { command: "npx" } });
    expect(isDirty(reverted)).toBe(false);
  });

  it("request_close asks for confirmation only when dirty", () => {
    const clean = mcpSettingsReducer(ready(), { type: "request_close" });
    expect(clean.status).toBe("closed");

    const dirty = mcpSettingsReducer(ready(), { type: "add" });
    const asked = mcpSettingsReducer(dirty, { type: "request_close" });
    expect(asked.status === "ready" && asked.confirmDiscard).toBe(true);
    const kept = mcpSettingsReducer(asked, { type: "keep_editing" });
    expect(kept.status === "ready" && kept.confirmDiscard).toBe(false);
  });

  it("save_succeeded resets the baseline and keeps the selection by name", () => {
    const base = ready();
    const selectDocs = mcpSettingsReducer(base, { type: "select", id: base.drafts[1]!.id });
    const saving = mcpSettingsReducer(selectDocs, { type: "save_started" });
    const saved = mcpSettingsReducer(saving, { type: "save_succeeded", servers, at: 1_000 });
    if (saved.status !== "ready") throw new Error();
    expect(saved.saving).toBe(false);
    expect(saved.savedAt).toBe(1_000);
    expect(saved.drafts.find((d) => d.id === saved.selectedId)?.name).toBe("docs");
    expect(isDirty(saved)).toBe(false);
  });

  it("load_failed replaces the dialog body and ignores edits", () => {
    const failed = mcpSettingsReducer(
      mcpSettingsReducer(initialMcpSettingsState, { type: "open" }),
      { type: "load_failed", error: "not json" },
    );
    expect(failed).toEqual({ status: "load_error", error: "not json" });
    expect(mcpSettingsReducer(failed, { type: "add" })).toEqual(failed);
  });
});

describe("validateDraft", () => {
  it("rejects a missing or malformed name and duplicate names", () => {
    const base = ready();
    const blank = { ...base.drafts[0]!, id: "x", name: "" };
    expect(validateDraft(blank, base.drafts).name).toBe("请填写名称。");
    const bad = { ...blank, name: "Bad Name" };
    expect(validateDraft(bad, base.drafts).name).toMatch(/小写字母/);
    const duplicate = { ...blank, name: "docs" };
    expect(validateDraft(duplicate, base.drafts).name).toBe("已有同名服务器。");
  });

  it("requires command for stdio, url for http and a sane timeout", () => {
    const base = ready();
    const stdio = { ...base.drafts[0]!, command: " ", timeoutMs: "0" };
    const errors = validateDraft(stdio, base.drafts);
    expect(errors.command).toBeDefined();
    expect(errors.timeoutMs).toBeDefined();
    const http = { ...base.drafts[1]!, url: "" };
    expect(validateDraft(http, base.drafts).url).toBeDefined();
  });

  it("firstInvalidId points at the first broken draft", () => {
    const base = ready();
    expect(firstInvalidId(base.drafts)).toBeUndefined();
    const withBlank = mcpSettingsReducer(base, { type: "add" });
    if (withBlank.status !== "ready") throw new Error();
    expect(firstInvalidId(withBlank.drafts)).toBe(withBlank.drafts[2]!.id);
  });
});

describe("toSaveRequest", () => {
  it("drops empty args and key-less env entries and coerces timeout", () => {
    const base = ready();
    const id = base.drafts[0]!.id;
    const edited = mcpSettingsReducer(base, {
      type: "edit",
      id,
      patch: {
        args: ["-y", " ", "server-github"],
        env: [{ key: "TOKEN", value: "${GITHUB_TOKEN}" }, { key: "", value: "" }],
        timeoutMs: "1200",
      },
    });
    if (edited.status !== "ready") throw new Error();
    const request = toSaveRequest(edited.drafts);
    expect(request.github).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "server-github"],
      env: { TOKEN: "${GITHUB_TOKEN}" },
      timeoutMs: 1200,
    });
    expect(request.docs).toEqual({
      type: "http",
      url: "https://docs.example/mcp",
      timeoutMs: 30_000,
    });
  });
});

describe("saved notice", () => {
  function saveAt(
    state: McpSettingsState,
    at: number,
  ): McpSettingsState {
    return mcpSettingsReducer(
      mcpSettingsReducer(state, { type: "save_started" }),
      { type: "save_succeeded", servers, at },
    );
  }

  it("a stale timer from an earlier save does not clear a newer notice", () => {
    const first = saveAt(ready(), 1_000);
    const second = saveAt(first, 2_500);
    // 第一次保存的计时器到期：不应清掉第二次保存的提示。
    const afterStale = mcpSettingsReducer(second, { type: "notice_expired", at: 1_000 });
    expect(afterStale.status === "ready" && afterStale.savedAt).toBe(2_500);
    const afterFresh = mcpSettingsReducer(afterStale, { type: "notice_expired", at: 2_500 });
    expect(afterFresh.status === "ready" && afterFresh.savedAt).toBeUndefined();
  });

  it("retry from a load error goes back to loading", () => {
    const failed = mcpSettingsReducer(
      mcpSettingsReducer(initialMcpSettingsState, { type: "open" }),
      { type: "load_failed", error: "bad" },
    );
    expect(mcpSettingsReducer(failed, { type: "open" })).toEqual({ status: "loading" });
  });
});
