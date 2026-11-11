import { Plus, Trash2, X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";

import {
  hasErrors,
  isDirty,
  validateDraft,
  type DraftErrors,
  type KeyValueDraft,
  type McpServerDraft,
  type McpSettingsAction,
  type McpSettingsState,
  type ProbeStatus,
} from "../mcp-settings-state";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
} from "./ui/dialog";
import {
  dangerButtonClasses,
  inputClasses,
  primaryButtonClasses,
  secondaryButtonClasses,
  smallButtonClasses,
} from "./view-styles";

export interface McpSettingsDialogProps {
  state: McpSettingsState;
  dispatch: (action: McpSettingsAction) => void;
  onRetryLoad: () => void;
  onProbe: (draft: McpServerDraft) => void;
  onSave: () => void;
}

const HEADER = {
  eyebrow: "MCP SERVERS",
  eyebrowClassName: "text-[#276c53]",
  title: "MCP 服务器",
  description: (
    <>
      管理用户级 <code className="font-mono text-[13px]">~/.agents/mcp.json</code>，
      所有项目可用；同名的项目级配置会覆盖它。
    </>
  ),
};

export function McpSettingsDialog({
  state,
  dispatch,
  onRetryLoad,
  onProbe,
  onSave,
}: McpSettingsDialogProps) {
  const open = state.status !== "closed";
  const saving = state.status === "ready" && state.saving;
  return (
    <>
      <Dialog
        open={open}
        onClose={() => dispatch({ type: "request_close" })}
        dismissible={!saving}
      >
        {open && (
          <DialogContent size="lg" closeDisabled={saving} className="h-[85vh]">
            <DialogHeader {...HEADER} />
            {state.status === "loading" && (
              <DialogBody>
                <p className="py-10 text-center text-sm text-[#657068]">正在读取配置…</p>
              </DialogBody>
            )}
            {state.status === "load_error" && (
              <DialogBody>
                <div className="rounded-[12px] border border-[#e1b9b4] bg-[#fdf5f4] p-4">
                  <p className="text-sm font-bold text-[#a33d35]">读取配置失败</p>
                  <p className="mt-1 text-sm leading-6 text-[#7a4a45]" role="alert">
                    {state.error}
                  </p>
                  <p className="mt-2 text-xs leading-5 text-[#657068]">
                    为避免用空配置覆盖原文件，读取失败时不能保存。修好文件后重试。
                  </p>
                  <button
                    type="button"
                    className={`mt-3 ${secondaryButtonClasses}`}
                    onClick={onRetryLoad}
                  >
                    重试
                  </button>
                </div>
              </DialogBody>
            )}
            {state.status === "ready" && (
              <ReadyBody
                state={state}
                dispatch={dispatch}
                onProbe={onProbe}
                onSave={onSave}
              />
            )}
            {state.status === "load_error" && (
              <DialogFooter>
                <button
                  type="button"
                  className={secondaryButtonClasses}
                  onClick={() => dispatch({ type: "close" })}
                >
                  关闭
                </button>
                <button type="button" className={primaryButtonClasses} disabled>
                  保存
                </button>
              </DialogFooter>
            )}
          </DialogContent>
        )}
      </Dialog>

      <Dialog
        open={state.status === "ready" && state.confirmDiscard}
        onClose={() => dispatch({ type: "keep_editing" })}
      >
        {state.status === "ready" && state.confirmDiscard && (
          <DialogContent size="sm">
            <DialogHeader
              title="放弃修改？"
              description="有尚未保存的修改，关闭后会丢失。"
            />
            <DialogFooter>
              <button
                type="button"
                className={secondaryButtonClasses}
                onClick={() => dispatch({ type: "keep_editing" })}
              >
                留下
              </button>
              <button
                type="button"
                className={dangerButtonClasses}
                onClick={() => dispatch({ type: "close" })}
              >
                放弃修改
              </button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}

type ReadyState = Extract<McpSettingsState, { status: "ready" }>;

function ReadyBody({
  state,
  dispatch,
  onProbe,
  onSave,
}: {
  state: ReadyState;
  dispatch: (action: McpSettingsAction) => void;
  onProbe: (draft: McpServerDraft) => void;
  onSave: () => void;
}) {
  const selected = state.drafts.find((draft) => draft.id === state.selectedId);
  const errorsById = new Map(
    state.drafts.map((draft) => [draft.id, validateDraft(draft, state.drafts)]),
  );
  const anyInvalid = Array.from(errorsById.values()).some(hasErrors);
  const dirty = isDirty(state);
  const saveDisabled = state.saving || anyInvalid || !dirty;

  return (
    <>
      <DialogBody bleed className="mt-5 flex min-h-0 border-t border-[rgba(20,32,27,0.1)] max-[600px]:flex-col">
        <ServerListPane
          drafts={state.drafts}
          selectedId={state.selectedId}
          probes={state.probes}
          errorsById={errorsById}
          disabled={state.saving}
          dispatch={dispatch}
        />
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-6 py-5 max-[600px]:px-[18px]">
          {selected === undefined ? (
            <EmptyForm onAdd={() => dispatch({ type: "add" })} />
          ) : (
            <ServerForm
              key={selected.id}
              draft={selected}
              errors={errorsById.get(selected.id) ?? {}}
              probe={state.probes[selected.id] ?? { status: "idle" }}
              disabled={state.saving}
              dispatch={dispatch}
              onProbe={() => onProbe(selected)}
            />
          )}
        </div>
      </DialogBody>
      <DialogFooter
        note={
          state.saveError !== undefined
            ? <span className="text-[#a33d35]" role="alert">{state.saveError}</span>
            : state.savedAt !== undefined
              ? <span className="text-[#276c53]" role="status">已保存</span>
              : anyInvalid
                ? "有字段未填对，修正后才能保存。"
                : dirty
                  ? "有未保存的修改"
                  : undefined
        }
      >
        <button
          type="button"
          className={secondaryButtonClasses}
          disabled={state.saving}
          onClick={() => dispatch({ type: "request_close" })}
        >
          取消
        </button>
        <button
          type="button"
          className={`min-w-[96px] ${primaryButtonClasses}`}
          disabled={saveDisabled}
          onClick={onSave}
        >
          {state.saving ? "正在保存…" : "保存"}
        </button>
      </DialogFooter>
    </>
  );
}

function ServerListPane({
  drafts,
  selectedId,
  probes,
  errorsById,
  disabled,
  dispatch,
}: {
  drafts: readonly McpServerDraft[];
  selectedId: string | undefined;
  probes: Record<string, ProbeStatus>;
  errorsById: Map<string, DraftErrors>;
  disabled: boolean;
  dispatch: (action: McpSettingsAction) => void;
}) {
  return (
    <div className="flex w-[240px] shrink-0 flex-col border-r border-[rgba(20,32,27,0.1)] bg-[#f7f7f2] max-[600px]:w-full max-[600px]:max-h-48 max-[600px]:border-b max-[600px]:border-r-0">
      <div className="flex items-center justify-between px-4 pb-2 pt-4">
        <span className="text-xs font-bold tracking-[0.08em] text-[#6c766f]">
          服务器 · {drafts.length}
        </span>
        <button
          type="button"
          className={`inline-flex items-center gap-1 ${smallButtonClasses}`}
          disabled={disabled}
          onClick={() => dispatch({ type: "add" })}
        >
          <Plus className="size-3.5" aria-hidden="true" />
          新增
        </button>
      </div>
      <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-3" role="listbox" aria-label="服务器列表">
        {drafts.map((draft) => {
          const selected = draft.id === selectedId;
          const invalid = hasErrors(errorsById.get(draft.id) ?? {});
          const nameError = errorsById.get(draft.id)?.name;
          return (
            <li key={draft.id}>
              <button
                type="button"
                role="option"
                aria-selected={selected}
                className={`flex w-full cursor-pointer items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left transition ${
                  selected
                    ? "border-[#7aae99] bg-[#eaf3ed]"
                    : "border-transparent hover:bg-[#eeefe9]"
                }`}
                onClick={() => dispatch({ type: "select", id: draft.id })}
              >
                <ProbeDot probe={probes[draft.id]} />
                <span
                  className={`min-w-0 flex-1 truncate font-mono text-[13px] ${
                    nameError !== undefined && nameError.includes("同名")
                      ? "text-[#a33d35]"
                      : invalid
                        ? "text-[#9a6817]"
                        : "text-[#14201b]"
                  }`}
                >
                  {draft.name.trim() === "" ? "未命名" : draft.name}
                </span>
                <span className="rounded-full border border-[#d5dbd5] bg-white px-1.5 py-0.5 text-[10px] font-bold tracking-[0.04em] text-[#657068]">
                  {draft.type}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ProbeDot({ probe }: { probe: ProbeStatus | undefined }) {
  const status = probe?.status ?? "idle";
  const { className, label } = {
    idle: { className: "bg-[#c9cfc8]", label: "未测试" },
    probing: { className: "bg-[#e0b95a] animate-pulse", label: "正在连接" },
    ok: { className: "bg-[#2f9a6a]", label: "连接成功" },
    failed: { className: "bg-[#d0524a]", label: "连接失败" },
  }[status];
  return (
    <span
      className={`size-2 shrink-0 rounded-full ${className}`}
      role="img"
      aria-label={label}
    />
  );
}

function EmptyForm({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center py-10 text-center">
      <p className="text-sm font-bold">还没有配置任何 MCP 服务器</p>
      <p className="mt-1 max-w-[320px] text-sm leading-6 text-[#657068]">
        添加一个后，模型在所有项目里都能调用它提供的工具。
      </p>
      <button
        type="button"
        className={`mt-4 inline-flex items-center gap-1.5 ${primaryButtonClasses}`}
        onClick={onAdd}
      >
        <Plus className="size-4" aria-hidden="true" />
        新增第一个服务器
      </button>
    </div>
  );
}

function ServerForm({
  draft,
  errors,
  probe,
  disabled,
  dispatch,
  onProbe,
}: {
  draft: McpServerDraft;
  errors: DraftErrors;
  probe: ProbeStatus;
  disabled: boolean;
  dispatch: (action: McpSettingsAction) => void;
  onProbe: () => void;
}) {
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (draft.name === "") nameRef.current?.focus();
  }, [draft.id]);

  const edit = (patch: Partial<Omit<McpServerDraft, "id">>): void =>
    dispatch({ type: "edit", id: draft.id, patch });
  const probing = probe.status === "probing";

  return (
    <fieldset className="space-y-4" disabled={disabled}>
      <legend className="sr-only">服务器配置</legend>
      <Field label="名称" error={errors.name} htmlFor={`${draft.id}-name`}>
        <input
          id={`${draft.id}-name`}
          ref={nameRef}
          className={`${inputClasses} font-mono`}
          placeholder="playwright"
          value={draft.name}
          aria-invalid={errors.name !== undefined}
          onChange={(event) => edit({ name: event.target.value })}
        />
      </Field>

      <Field label="类型">
        <div className="flex gap-2" role="radiogroup" aria-label="类型">
          {(["stdio", "http"] as const).map((type) => (
            <label
              key={type}
              className={`flex flex-1 cursor-pointer items-start gap-2.5 rounded-xl border px-3 py-2.5 transition ${
                draft.type === type
                  ? "border-[#7aae99] bg-[#eaf3ed]"
                  : "border-[#d9dbd3] bg-white hover:bg-[#f7f8f4]"
              }`}
            >
              <input
                type="radio"
                name={`${draft.id}-type`}
                value={type}
                className="mt-0.5 size-4 accent-[#176b4d]"
                checked={draft.type === type}
                onChange={() => edit({ type })}
              />
              <span>
                <span className="block font-mono text-sm font-bold">{type}</span>
                <span className="block text-xs leading-5 text-[#657068]">
                  {type === "stdio" ? "本机起一个子进程" : "远端 Streamable HTTP 端点"}
                </span>
              </span>
            </label>
          ))}
        </div>
      </Field>

      {draft.type === "stdio" ? (
        <>
          <Field label="命令" error={errors.command} htmlFor={`${draft.id}-command`}>
            <input
              id={`${draft.id}-command`}
              className={`${inputClasses} font-mono`}
              placeholder="npx"
              value={draft.command}
              aria-invalid={errors.command !== undefined}
              onChange={(event) => edit({ command: event.target.value })}
            />
          </Field>
          <Field label="参数" hint="一行一个，按顺序传给命令。">
            <ListEditor
              items={draft.args}
              placeholder="-y"
              addLabel="添加参数"
              onChange={(args) => edit({ args })}
            />
          </Field>
          <Field
            label="工作目录"
            hint="相对主目录，留空则为主目录。"
            htmlFor={`${draft.id}-cwd`}
          >
            <input
              id={`${draft.id}-cwd`}
              className={`${inputClasses} font-mono`}
              placeholder="projects/tools"
              value={draft.cwd}
              onChange={(event) => edit({ cwd: event.target.value })}
            />
          </Field>
          <Field label="环境变量" error={errors.env} hint="值可以写 ${VAR}，从 Harness 的 .env 里取，明文不落盘。">
            <KeyValueEditor
              entries={draft.env}
              keyPlaceholder="GITHUB_TOKEN"
              valuePlaceholder="${GITHUB_TOKEN}"
              addLabel="添加环境变量"
              onChange={(env) => edit({ env })}
            />
          </Field>
        </>
      ) : (
        <>
          <Field label="地址" error={errors.url} htmlFor={`${draft.id}-url`}>
            <input
              id={`${draft.id}-url`}
              className={`${inputClasses} font-mono`}
              placeholder="http://127.0.0.1:3845/mcp"
              value={draft.url}
              aria-invalid={errors.url !== undefined}
              onChange={(event) => edit({ url: event.target.value })}
            />
          </Field>
          <Field label="请求头" error={errors.headers} hint="值可以写 ${VAR}，从 Harness 的 .env 里取，明文不落盘。">
            <KeyValueEditor
              entries={draft.headers}
              keyPlaceholder="Authorization"
              valuePlaceholder="Bearer ${DOCS_MCP_TOKEN}"
              addLabel="添加请求头"
              onChange={(headers) => edit({ headers })}
            />
          </Field>
        </>
      )}

      <Field
        label="超时（毫秒）"
        error={errors.timeoutMs}
        hint="单次工具调用的上限，最大 600000。"
        htmlFor={`${draft.id}-timeout`}
      >
        <input
          id={`${draft.id}-timeout`}
          className={`${inputClasses} max-w-[200px] font-mono`}
          inputMode="numeric"
          value={draft.timeoutMs}
          aria-invalid={errors.timeoutMs !== undefined}
          onChange={(event) => edit({ timeoutMs: event.target.value })}
        />
      </Field>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[rgba(20,32,27,0.1)] pt-4">
        <div className="flex min-w-0 items-center gap-3">
          <button
            type="button"
            className={secondaryButtonClasses}
            disabled={probing || hasErrors(errors)}
            onClick={onProbe}
          >
            {probing ? "正在连接…" : "测试连接"}
          </button>
          <ProbeResultText probe={probe} />
        </div>
        <button
          type="button"
          className="inline-flex cursor-pointer items-center gap-1.5 rounded-full px-3 py-2 text-sm font-bold text-[#a33d35] transition hover:bg-[#f7e9e7] disabled:cursor-not-allowed disabled:opacity-45"
          onClick={() => dispatch({ type: "remove", id: draft.id })}
        >
          <Trash2 className="size-4" aria-hidden="true" />
          删除此服务器
        </button>
      </div>
    </fieldset>
  );
}

function ProbeResultText({ probe }: { probe: ProbeStatus }) {
  if (probe.status === "ok") {
    return (
      <span className="text-sm text-[#276c53]" role="status">
        连接成功，{probe.toolCount} 个工具
      </span>
    );
  }
  if (probe.status === "failed") {
    return (
      <span className="min-w-0 break-words text-sm text-[#a33d35]" role="alert">
        {probe.message}
      </span>
    );
  }
  return null;
}

function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="block text-xs font-bold text-[#3c4741]">
        {label}
      </label>
      <div className="mt-1.5">{children}</div>
      {error !== undefined ? (
        <p className="mt-1 text-xs text-[#a33d35]" role="alert">{error}</p>
      ) : hint !== undefined ? (
        <p className="mt-1 text-xs leading-5 text-[#7b847e]">{hint}</p>
      ) : null}
    </div>
  );
}

function ListEditor({
  items,
  placeholder,
  addLabel,
  onChange,
}: {
  items: readonly string[];
  placeholder: string;
  addLabel: string;
  onChange: (items: string[]) => void;
}) {
  return (
    <div className="space-y-1.5">
      {items.map((item, index) => (
        <div key={index} className="flex items-center gap-1.5">
          <input
            className={`${inputClasses} font-mono`}
            placeholder={placeholder}
            value={item}
            aria-label={`第 ${index + 1} 项`}
            onChange={(event) =>
              onChange(items.map((current, i) => (i === index ? event.target.value : current)))}
          />
          <RemoveRowButton onClick={() => onChange(items.filter((_, i) => i !== index))} />
        </div>
      ))}
      <button
        type="button"
        className={`inline-flex items-center gap-1 ${smallButtonClasses}`}
        onClick={() => onChange([...items, ""])}
      >
        <Plus className="size-3.5" aria-hidden="true" />
        {addLabel}
      </button>
    </div>
  );
}

function KeyValueEditor({
  entries,
  keyPlaceholder,
  valuePlaceholder,
  addLabel,
  onChange,
}: {
  entries: readonly KeyValueDraft[];
  keyPlaceholder: string;
  valuePlaceholder: string;
  addLabel: string;
  onChange: (entries: KeyValueDraft[]) => void;
}) {
  const update = (index: number, patch: Partial<KeyValueDraft>): void =>
    onChange(entries.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)));
  return (
    <div className="space-y-1.5">
      {entries.map((entry, index) => (
        <div key={index} className="flex items-center gap-1.5">
          <input
            className={`${inputClasses} basis-2/5 font-mono`}
            placeholder={keyPlaceholder}
            value={entry.key}
            aria-label={`第 ${index + 1} 项的键`}
            onChange={(event) => update(index, { key: event.target.value })}
          />
          <input
            className={`${inputClasses} basis-3/5 font-mono`}
            placeholder={valuePlaceholder}
            value={entry.value}
            aria-label={`第 ${index + 1} 项的值`}
            onChange={(event) => update(index, { value: event.target.value })}
          />
          <RemoveRowButton onClick={() => onChange(entries.filter((_, i) => i !== index))} />
        </div>
      ))}
      <button
        type="button"
        className={`inline-flex items-center gap-1 ${smallButtonClasses}`}
        onClick={() => onChange([...entries, { key: "", value: "" }])}
      >
        <Plus className="size-3.5" aria-hidden="true" />
        {addLabel}
      </button>
    </div>
  );
}

function RemoveRowButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      className="inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-[#657068] transition hover:bg-[#eef0eb] hover:text-[#a33d35]"
      aria-label="删除这一行"
      onClick={onClick}
    >
      <X className="size-4" aria-hidden="true" />
    </button>
  );
}
