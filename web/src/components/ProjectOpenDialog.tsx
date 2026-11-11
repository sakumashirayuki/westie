import type { ProjectContext, ProjectOpenState } from "../project-open-state";
import {
  branchLabel,
  canSubmitProjectOpen,
  workspaceKindLabel,
  type WorkspaceChoice,
} from "../project-groups";
import type {
  ExecutionMode,
  ProjectBranches,
  ProjectRemoteBranch,
  ProjectWorktrees,
} from "../run-client";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
} from "./ui/dialog";
import {
  inputClasses,
  secondaryButtonClasses,
  smallButtonClasses,
} from "./view-styles";

/**
 * 新建会话页面：选择项目工作目录、执行模式并提交。
 *
 * 页面只呈现服务端返回的目录、分支与 worktree 信息；`selected_directory` 使用
 * 选择器里刚确认的精确路径，新建 worktree 的目录由服务端生成。
 */
export function ProjectOpenDialog({
  state,
  onCancel,
  onInspect,
  onModeChange,
  onFullAccessConfirmationChange,
  onChoiceChange,
  onBaseBranchChange,
  onBranchChange,
  onSelectCreateMode,
  onSubmit,
}: {
  state: ProjectOpenState;
  onCancel: () => void;
  onInspect: () => void;
  onModeChange: (mode: ExecutionMode) => void;
  onFullAccessConfirmationChange: (confirmed: boolean) => void;
  onChoiceChange: (choice: ProjectOpenState["choice"]) => void;
  onBaseBranchChange: (base: {
    baseRefKind: "local" | "remote";
    baseBranch: string;
    baseRemote: string | null;
  }) => void;
  onBranchChange: (branch: string) => void;
  onSelectCreateMode: (createMode: "new" | "existing") => void;
  onSubmit: () => void;
}) {
  const open = state.status !== "closed";
  const submitting = state.status === "submitting";
  const fullAccess = state.executionMode === "full_access";
  const selection = state.project?.selection ?? null;
  const projectType = state.project?.projectType ?? "unknown";
  const isGit = projectType === "git";
  const branches: ProjectBranches =
    state.status === "ready" ? state.branches ?? emptyBranches() : emptyBranches();
  const worktrees: ProjectWorktrees | null =
    state.status === "ready" ? state.worktrees : null;
  const choices = workspaceChoices(state, worktrees, branches, projectType);
  const submitDisabled = submitting || !canSubmitProjectOpen(
    state.choice,
    state.executionMode,
    state.fullAccessConfirmed,
  );

  return (
    <Dialog open={open} onClose={onCancel} dismissible={!submitting}>
      {open && (
        <DialogContent size="lg" closeDisabled={submitting}>
          <DialogHeader
            eyebrow="NEW CONVERSATION"
            title="新建会话"
            description="选择工作目录和执行模式。执行模式在会话创建后不可更改。"
          />
          <DialogBody>
            <section aria-label="项目" className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-bold">项目</h3>
                <button
                  type="button"
                  className={smallButtonClasses}
                  disabled={submitting}
                  onClick={onInspect}
                >
                  选择其他目录
                </button>
              </div>
              {state.project === null ? (
                <p className="text-sm leading-6 text-[#657068]">
                  先通过 macOS 系统目录选择器选择一个项目目录。也可以从侧栏项目的
                  ＋ 直接进入。
                </p>
              ) : (
                <div className="rounded-xl border border-[#d9dbd3] bg-white p-3">
                  <p className="text-sm font-bold">{state.project.name}</p>
                  <p className="mt-1 break-all font-mono text-xs text-[#657068]">
                    主工作目录：{state.project.root}
                  </p>
                  {selection !== null && (
                    <p className="mt-1 break-all font-mono text-xs text-[#657068]">
                      所选路径：{selection.selectedPath}
                    </p>
                  )}
                  {selection?.unavailableReason !== undefined && (
                    <p className="mt-1 text-xs text-[#a33d35]" role="alert">
                      Git 信息暂时不可用：{selection.unavailableReason}
                      。本次只能使用所选目录创建会话。
                    </p>
                  )}
                  {state.status === "ready" && state.loadError !== null && (
                    <p className="mt-1 text-xs text-[#a33d35]" role="alert">
                      {state.loadError}
                    </p>
                  )}
                </div>
              )}
            </section>

            {state.project !== null && (
              <fieldset className="mt-4 space-y-3" disabled={submitting}>
                <legend className="text-sm font-bold">工作目录</legend>
                {choices.map((choice) => (
                  <label
                    key={choice.kind}
                    className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50 ${
                      state.choice.kind === choice.kind
                        ? "border-[#7aae99] bg-[#eaf3ed]"
                        : "border-[#d9dbd3] bg-white hover:bg-[#f7f8f4]"
                    }`}
                  >
                    <input
                      type="radio"
                      name="workspace-kind"
                      className="mt-1 size-4 accent-[#176b4d]"
                      checked={state.choice.kind === choice.kind}
                      disabled={choice.disabled}
                      onChange={() =>
                        onChoiceChange(
                          selectWorkspaceChoice(
                            choice.kind,
                            worktrees,
                            branches,
                          ),
                        )}
                    />
                    <span className="min-w-0">
                      <strong className="text-sm">{choice.title}</strong>
                      <span className="mt-1 block break-all text-xs leading-5 text-[#657068]">
                        {choice.description}
                      </span>
                    </span>
                  </label>
                ))}

                {state.choice.kind === "existing_worktree" && worktrees !== null &&
                  (
                    <select
                      className={inputClasses}
                      value={state.choice.path}
                      onChange={(event) =>
                        onChoiceChange({
                          kind: "existing_worktree",
                          path: event.currentTarget.value,
                        })}
                    >
                      {worktrees.worktrees.map((entry) => (
                        <option
                          key={entry.path}
                          value={entry.path}
                          disabled={!entry.available}
                        >
                          {entry.kind === "main"
                            ? "主目录"
                            : workspaceKindLabel("worktree")}
                          {" · "}
                          {entry.branch ?? branchLabel({ status: "detached", commit: null })}
                          {" · "}
                          {entry.path}
                          {entry.available ? "" : "（不可用）"}
                        </option>
                      ))}
                    </select>
                  )}

                {state.choice.kind === "new_worktree" && (
                  <div className="space-y-2 rounded-xl border border-[#d9dbd3] bg-white p-3">
                    <div>
                      <span className="block text-xs font-bold text-[#657068]">
                        分支方式
                      </span>
                      <div className="mt-1 flex gap-2">
                        {(["new", "existing"] as const).map((mode) => (
                          <label
                            key={mode}
                            className="flex flex-1 cursor-pointer items-center gap-2 rounded-lg border border-[#d9dbd3] px-3 py-2 text-xs font-bold has-[:checked]:border-[#7aae99] has-[:checked]:bg-[#eaf3ed]"
                          >
                            <input
                              type="radio"
                              name="worktree-branch-mode"
                              className="size-4 accent-[#176b4d]"
                              checked={state.choice.kind === "new_worktree" &&
                                state.choice.createMode === mode}
                              onChange={() => onSelectCreateMode(mode)}
                            />
                            {mode === "new" ? "创建新分支" : "检出已有分支"}
                          </label>
                        ))}
                      </div>
                    </div>
                    {state.choice.createMode === "existing"
                      ? (
                        <ExistingBranchPicker
                          branches={branches}
                          worktrees={worktrees}
                          selected={state.choice.branch}
                          ready={state.status === "ready"}
                          onSelect={onBranchChange}
                        />
                      )
                      : (
                        <>
                    <label className="block text-xs font-bold text-[#657068]">
                      起始分支
                      <select
                        className={`${inputClasses} mt-1`}
                        value={baseSelectValue(state.choice, branches)}
                        onChange={(event) =>
                          onBaseBranchChange(
                            parseBaseSelectValue(
                              event.currentTarget.value,
                              branches,
                            ),
                          )}
                      >
                        <option value="">
                          {baseSelectOptions(branches).length === 0
                            ? "没有可用的分支"
                            : "请选择起始分支"}
                        </option>
                        {branches.branches.length > 0 && (
                          <optgroup label="本地分支">
                            {branches.branches.map((branch) => (
                              <option
                                key={`local:${branch}`}
                                value={localBaseValue(branch)}
                              >
                                {branch}
                              </option>
                            ))}
                          </optgroup>
                        )}
                        {remoteBranchGroups(branches).map((group) => (
                          <optgroup key={group.remote} label={`远端 ${group.remote}`}>
                            {group.branches.map((entry) => (
                              <option
                                key={`remote:${entry.remote}:${entry.name}`}
                                value={remoteBaseValue(entry.remote, entry.name)}
                                disabled={entry.hasLocalBranch}
                              >
                                {entry.remote}/{entry.name}
                                {entry.hasLocalBranch
                                  ? "（已被同名本地分支占用）"
                                  : ""}
                              </option>
                            ))}
                          </optgroup>
                        ))}
                      </select>
                    </label>
                    {branches.remotes.length > 0 && (
                      <div className="space-y-2">
                        <label className="block text-xs font-bold text-[#657068]">
                          其他远端分支的远端
                          <select
                            className={`${inputClasses} mt-1`}
                            value={manualBaseRemote(state.choice, branches)}
                            onChange={(event) => {
                              const remote = event.currentTarget.value;
                              // 换远端时保留已填写的分支名，由创建前的 fetch 校验。
                              const branch = manualBaseBranch(state.choice);
                              onBaseBranchChange(
                                remote === ""
                                  ? { baseRefKind: "local", baseBranch: "", baseRemote: null }
                                  : { baseRefKind: "remote", baseBranch: branch, baseRemote: remote },
                              );
                            }}
                          >
                            <option value="">
                              {branches.remotes.length === 1
                                ? branches.remotes[0]
                                : "使用下拉里已有的远端分支"}
                            </option>
                            {branches.remotes.map((remote) => (
                              <option key={remote} value={remote}>
                                {remote}
                              </option>
                            ))}
                          </select>
                        </label>
                        {manualBaseRemote(state.choice, branches) !== "" && (
                          <label className="block text-xs font-bold text-[#657068]">
                            其他远端分支
                            <input
                              className={`${inputClasses} mt-1`}
                              list={manualBaseListId}
                              value={manualBaseBranch(state.choice)}
                              placeholder="feat/remote-only"
                              onChange={(event) => {
                                const remote = manualBaseRemote(state.choice, branches);
                                if (remote === "") return;
                                const branch = event.currentTarget.value.trim();
                                // 清空分支名时保留所选远端，避免重新输入时落回默认远端。
                                onBaseBranchChange({
                                  baseRefKind: "remote",
                                  baseBranch: branch,
                                  baseRemote: remote,
                                });
                              }}
                            />
                            <datalist id={manualBaseListId}>
                              {branches.remoteBranches
                                .filter((entry) =>
                                  entry.remote ===
                                    manualBaseRemote(state.choice, branches) &&
                                  !entry.hasLocalBranch
                                )
                                .map((entry) => (
                                  <option key={entry.name} value={entry.name} />
                                ))}
                            </datalist>
                            <span className="mt-1 block font-normal leading-5 text-[#657068]">
                              下拉里只有本机已经 fetch 过的远端分支。远端上的新分支
                              在这里填写分支名，创建前会从
                              {" "}
                              {manualBaseRemote(state.choice, branches)}
                              /&lt;分支名&gt; 拉取并校验；远端没有该分支时不会创建
                              目录或分支。
                            </span>
                          </label>
                        )}
                      </div>
                    )}
                    {state.choice.baseRefKind === "remote" && (
                      <p className="text-xs leading-5 text-[#657068]">
                        起点是远端分支 {state.choice.baseRemote}/
                        {state.choice.baseBranch}：创建前会先执行 git fetch
                        拉取该分支的最新提交。
                      </p>
                    )}
                    {branches.recommendationSource !== null &&
                      branches.recommendedBranch !== null && (
                        <p className="text-xs text-[#657068]">
                          推荐 {branches.recommendedBranch}（来自
                          {" "}
                          {branches.recommendationSource}
                          ）
                        </p>
                      )}
                    <label className="block text-xs font-bold text-[#657068]">
                      新分支
                      <input
                        className={`${inputClasses} mt-1`}
                        value={state.newBranch}
                        placeholder="feat/example"
                        onChange={(event) =>
                          onBranchChange(event.currentTarget.value)}
                      />
                    </label>
                        </>
                      )}
                    <p className="text-xs leading-5 text-[#657068]">
                      目录由服务端生成（~/.westie/worktrees 下），创建前会展示完整路径。
                      起始分支的未提交文件、依赖和本地配置不会复制到新目录。
                      创建 worktree 是宿主 Git 操作：会执行该项目已有的 Git 配置
                      （hook、filter 等），与会话的 Sandbox 授权相互独立。
                    </p>
                  </div>
                )}
              </fieldset>
            )}

            <fieldset className="mt-4 space-y-3" disabled={submitting}>
              <legend className="text-sm font-bold">执行模式</legend>
              <ModeOption
                mode="workspace_sandbox"
                selectedMode={state.executionMode}
                title="Workspace Sandbox"
                description="在所选工作目录及受限系统路径内工作；Bash 禁止网络并逐次确认。"
                onChange={onModeChange}
              />
              <ModeOption
                mode="full_access"
                selectedMode={state.executionMode}
                title="Full Access"
                description="可访问宿主用户可访问的任意文件与网络，Bash 不再逐次确认。"
                warning
                onChange={onModeChange}
              />
            </fieldset>

            {fullAccess && (
              <div className="mt-3 rounded-[10px] border border-[#e7c98d] bg-[#fff9eb] p-4">
                <p className="text-sm leading-[1.55] text-[#725b31]">
                  Full Access 不是访问沙箱。命令超时、输出限制、资源限制与进程清理仍然生效。
                </p>
                <label className="mt-3 flex cursor-pointer items-start gap-2.5 text-sm font-bold text-[#75500f] has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50">
                  <input
                    type="checkbox"
                    className="mt-0.5 size-4 accent-[#9a6817]"
                    checked={state.fullAccessConfirmed}
                    disabled={submitting}
                    onChange={(event) =>
                      onFullAccessConfirmationChange(event.currentTarget.checked)}
                  />
                  我了解 Agent 将拥有完全文件与网络访问权限
                </label>
              </div>
            )}

            {state.status === "error" && (
              <p className="mt-3 text-sm text-[#a33d35]" role="alert">
                {state.error}
              </p>
            )}
            {!isGit && state.project !== null && (
              <p className="mt-3 text-xs text-[#657068]">
                该目录不是 Git 仓库：只能使用该目录创建会话，不提供 worktree 选项。
              </p>
            )}
          </DialogBody>
          <DialogFooter>
            <button
              type="button"
              className={secondaryButtonClasses}
              disabled={submitting}
              onClick={onCancel}
            >
              取消
            </button>
            <button
              type="button"
              className={`min-w-[112px] cursor-pointer rounded-full px-4 py-2.5 text-sm font-bold text-white transition disabled:cursor-not-allowed disabled:opacity-45 ${
                fullAccess
                  ? "bg-[#9a6817] hover:bg-[#7f5310]"
                  : "bg-[#176b4d] hover:bg-[#0d593d]"
              }`}
              disabled={submitDisabled || state.project === null}
              onClick={onSubmit}
            >
              {submitting ? "正在创建…" : "创建会话"}
            </button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}

interface WorkspaceChoiceView {
  readonly kind: ProjectOpenState["choice"]["kind"];
  readonly title: string;
  readonly description: string;
  readonly disabled: boolean;
}

/**
 * 选中某个工作目录选项时构造对应的 choice：已有 worktree 默认选第一个可用
 * 目录；新建 worktree 默认走创建新分支并预选推荐起点；其余选项只需标记类型。
 */
function selectWorkspaceChoice(
  kind: WorkspaceChoice["kind"],
  worktrees: ProjectWorktrees | null,
  branches: ProjectBranches,
): WorkspaceChoice {
  switch (kind) {
    case "existing_worktree":
      return {
        kind,
        path: worktrees?.worktrees.find((entry) => entry.available)?.path ?? "",
      };
    case "new_worktree":
      return {
        kind,
        createMode: "new",
        baseRefKind: "local",
        baseBranch: branches.recommendedBranch ?? "",
        baseRemote: null,
        branch: "",
      };
    case "main":
    case "selected_directory":
    case "directory":
      return { kind };
  }
}

/** 按识别结果列出可用的工作目录选项。 */
function workspaceChoices(
  state: ProjectOpenState,
  worktrees: ProjectWorktrees | null,
  branches: ProjectBranches,
  projectType: ProjectContext["projectType"],
): WorkspaceChoiceView[] {
  // 普通目录或 Git 暂时不可用：只能使用该目录本身，不提供 Git 选项。
  if (projectType === "directory") {
    return [
      {
        kind: "directory",
        title: "所选目录",
        description: state.project?.root ?? "",
        disabled: false,
      },
    ];
  }
  if (projectType === "unknown") {
    return [
      {
        kind: "selected_directory",
        title: "所选目录",
        description: state.selectedPath ?? state.project?.root ?? "",
        disabled: false,
      },
    ];
  }
  const selection = state.project?.selection ?? null;
  return [
    {
      kind: "main",
      title: "主目录",
      description: selection?.mainWorkspace ?? state.project?.root ?? "",
      disabled: false,
    },
    {
      kind: "existing_worktree",
      title: "已有 worktree",
      description: worktreesAvailableText(worktrees),
      disabled: worktrees === null ||
        !worktrees.worktrees.some((entry) => entry.available),
    },
    {
      kind: "new_worktree",
      title: "新建 worktree",
      description: canCreateWorktree(branches)
        ? "从本地或远端分支创建独立工作目录。"
        : "没有可用的分支，也没有已配置的远端：先创建本地分支或配置远端。",
      // 已配置的远端本身就是一个入口：可以选远端并手填尚未 fetch 的分支。
      disabled: !canCreateWorktree(branches),
    },
    // 选择器选中的是 checkout 内部子目录时，保留这个精确路径。
    ...(selection !== null &&
        selection.selectionKind !== "main" &&
        selection.selectionKind !== "worktree"
      ? [{
          kind: "selected_directory" as const,
          title: "刚才选中的目录",
          description: selection.selectedPath,
          disabled: false,
        }]
      : []),
  ];
}

function worktreesAvailableText(worktrees: ProjectWorktrees | null): string {
  if (worktrees === null) return "正在读取 worktree 列表…";
  const available = worktrees.worktrees.filter((entry) => entry.available);
  if (available.length === 0) {
    return "没有可用的 worktree，请选择主目录或新建 worktree。";
  }
  return `${available.length} 个可用的工作目录`;
}

function emptyBranches(): ProjectBranches {
  return {
    branches: [],
    remotes: [],
    remoteBranches: [],
    recommendedBranch: null,
    recommendationSource: null,
  };
}

/**
 * 「检出已有分支」模式的分支选择。只列出本地分支，已被某个 worktree（含主目录）
 * 检出的分支禁用并标注所在目录，因为 Git 不允许同一分支同时被两个工作目录检出。
 */
function ExistingBranchPicker({
  branches,
  worktrees,
  selected,
  ready,
  onSelect,
}: {
  branches: ProjectBranches;
  worktrees: ProjectWorktrees | null;
  selected: string;
  ready: boolean;
  onSelect: (branch: string) => void;
}) {
  const occupied = new Map<string, string>();
  for (const entry of worktrees?.worktrees ?? []) {
    if (entry.branch !== null) occupied.set(entry.branch, entry.path);
  }
  const selectable = branches.branches.filter((branch) => !occupied.has(branch));
  const value = selectable.includes(selected) ? selected : "";
  let placeholder = "请选择要检出的分支";
  if (!ready) {
    placeholder = "正在读取分支列表…";
  } else if (branches.branches.length === 0) {
    placeholder = "没有本地分支";
  }
  return (
    <label className="block text-xs font-bold text-[#657068]">
      已有分支
      <select
        className={`${inputClasses} mt-1`}
        value={value}
        disabled={branches.branches.length === 0}
        onChange={(event) => onSelect(event.currentTarget.value)}
      >
        <option value="">
          {placeholder}
        </option>
        {branches.branches.map((branch) => {
          const path = occupied.get(branch);
          return (
            <option key={branch} value={branch} disabled={path !== undefined}>
              {branch}
              {path !== undefined ? `（已在 ${shortenPath(path)} 检出）` : ""}
            </option>
          );
        })}
      </select>
      <span className="mt-1 block font-normal leading-5 text-[#657068]">
        直接在新工作目录检出该分支，不创建新分支；分支上的已提交内容原样保留，
        未提交文件不会从其他目录复制过来。
      </span>
    </label>
  );
}

/** 路径展示时把 macOS 用户目录缩写为 ~，避免占用分支的提示过长。 */
function shortenPath(path: string): string {
  const match = /^(\/Users\/[^/]+)\//.exec(path);
  if (match !== null) return `~/${path.slice(match[1].length + 1)}`;
  return path;
}

function ModeOption({
  mode,
  selectedMode,
  title,
  description,
  warning = false,
  onChange,
}: {
  mode: ExecutionMode;
  selectedMode: ExecutionMode;
  title: string;
  description: string;
  warning?: boolean;
  onChange: (mode: ExecutionMode) => void;
}) {
  const selected = mode === selectedMode;
  return (
    <label
      className={`flex cursor-pointer items-start gap-3 rounded-xl border p-4 transition has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50 ${
        selected
          ? warning
            ? "border-[#d3b575] bg-[#fff9eb]"
            : "border-[#7aae99] bg-[#eaf3ed]"
          : "border-[#d9dbd3] bg-white hover:bg-[#f7f8f4]"
      }`}
    >
      <input
        type="radio"
        name="execution-mode"
        value={mode}
        className={`mt-1 size-4 ${warning ? "accent-[#9a6817]" : "accent-[#176b4d]"}`}
        checked={selected}
        onChange={() => onChange(mode)}
      />
      <span>
        <strong className={warning ? "text-[#75500f]" : "text-[#204f3d]"}>
          {title}
        </strong>
        <span className={`mt-1 block text-sm leading-[1.55] ${
          warning ? "text-[#725b31]" : "text-[#657068]"
        }`}>
          {description}
        </span>
      </span>
    </label>
  );
}

/** 「其他远端分支」手填框的 datalist id：`<datalist>` 的 id 唯一即可。 */
const manualBaseListId = "new-worktree-base-remote-options";

/** 起始分支下拉的取值：`local:<分支名>` 或 `remote:<远端>:<分支名>`。 */
const LOCAL_BASE_PREFIX = "local:";
const REMOTE_BASE_PREFIX = "remote:";

function localBaseValue(branch: string): string {
  return `${LOCAL_BASE_PREFIX}${branch}`;
}

function remoteBaseValue(remote: string, branch: string): string {
  return `${REMOTE_BASE_PREFIX}${remote}:${branch}`;
}

/** 下拉当前选中项；起点尚未选择时为空串，显示占位项。 */
function baseSelectValue(
  choice: Extract<ProjectOpenState["choice"], { kind: "new_worktree" }>,
  branches: ProjectBranches,
): string {
  if (choice.baseBranch === "") return "";
  if (choice.baseRefKind === "remote") {
    if (choice.baseRemote === null) return "";
    return remoteBaseValue(choice.baseRemote, choice.baseBranch);
  }
  // 起点是上次选择的本地分支，但列表刷新后该分支已消失：不假装选中。
  if (!branches.branches.includes(choice.baseBranch)) return "";
  return localBaseValue(choice.baseBranch);
}

/** 把下拉取值还原成起点；无法解析时退回空起点，由提交校验拦住。 */
function parseBaseSelectValue(
  value: string,
  branches: ProjectBranches,
): {
  baseRefKind: "local" | "remote";
  baseBranch: string;
  baseRemote: string | null;
} {
  if (value.startsWith(LOCAL_BASE_PREFIX)) {
    return {
      baseRefKind: "local",
      baseBranch: value.slice(LOCAL_BASE_PREFIX.length),
      baseRemote: null,
    };
  }
  const rest = value.slice(REMOTE_BASE_PREFIX.length);
  const separator = rest.indexOf(":");
  const remote = rest.slice(0, separator);
  const branch = rest.slice(separator + 1);
  const known = branches.remoteBranches.some((entry) =>
    entry.remote === remote && entry.name === branch
  );
  if (!value.startsWith(REMOTE_BASE_PREFIX) || separator < 0 || !known) {
    return { baseRefKind: "local", baseBranch: "", baseRemote: null };
  }
  return { baseRefKind: "remote", baseBranch: branch, baseRemote: remote };
}

/**
 * 能否新建 worktree：存在可选分支，或存在已配置的远端（可手填远端分支）。
 * 远端分支下拉只列出本机已 fetch 的 ref，配置了远端就能通过手填入口使用。
 */
function canCreateWorktree(branches: ProjectBranches): boolean {
  return baseSelectOptions(branches).length > 0 || branches.remotes.length > 0;
}

/** 可选本地分支数 + 可用远端分支数；被本地分支占用的远端分支不可选。 */
function baseSelectOptions(branches: ProjectBranches): readonly string[] {
  return [
    ...branches.branches,
    ...branches.remoteBranches
      .filter((entry) => !entry.hasLocalBranch)
      .map((entry) => `${entry.remote}/${entry.name}`),
  ];
}

/** 按远端分组的可选远端分支，保持服务端返回的顺序。 */
function remoteBranchGroups(
  branches: ProjectBranches,
): readonly {
  readonly remote: string;
  readonly branches: readonly ProjectRemoteBranch[];
}[] {
  const groups: { remote: string; branches: ProjectRemoteBranch[] }[] = [];
  for (const entry of branches.remoteBranches) {
    const group = groups.find((item) => item.remote === entry.remote);
    if (group === undefined) {
      groups.push({ remote: entry.remote, branches: [entry] });
      continue;
    }
    group.branches.push(entry);
  }
  return groups;
}

/**
 * 「其他远端分支」当前选中的远端：取起点本身所在的远端；起点不是远端分支时
 * 取默认远端（`origin`，否则第一个已配置的远端）。远端列表来自
 * `git remote`，与该远端是否已有本地分支引用无关。
 */
function manualBaseRemote(
  choice: ProjectOpenState["choice"],
  branches: ProjectBranches,
): string {
  if (choice.kind === "new_worktree" && choice.baseRefKind === "remote") {
    if (choice.baseRemote !== null) return choice.baseRemote;
  }
  return defaultBaseRemote(branches);
}

function defaultBaseRemote(branches: ProjectBranches): string {
  if (branches.remotes.length === 0) return "";
  return branches.remotes.includes("origin") ? "origin" : branches.remotes[0];
}

/** 手填框的当前值；起点不是远端分支时留空。 */
function manualBaseBranch(choice: ProjectOpenState["choice"]): string {
  if (choice.kind !== "new_worktree") return "";
  if (choice.baseRefKind !== "remote") return "";
  return choice.baseBranch;
}
