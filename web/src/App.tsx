import { useEffect, useState } from "react";
import {
  Navigate,
  Route,
  Routes,
  useNavigate,
  useParams,
} from "react-router-dom";

import { ProjectOpenDialog } from "./components/ProjectOpenDialog";
import { ConversationComposer } from "./components/ConversationComposer";
import { ConversationSidebarPanel } from "./components/ConversationSidebarPanel";
import { ConversationTurn } from "./components/ConversationTurn";
import { FeishuBindingDialog } from "./components/FeishuBindingDialog";
import { ScrollToBottomArea } from "./components/ScrollToBottomArea";
import { McpSettingsDialog } from "./components/McpSettingsDialog";
import { PendingInteractionDock } from "./components/PendingInteractionDock";
import { SubAgentDrawer } from "./components/SubAgentDrawer";
import { UsageSummary } from "./components/UsageSummary";
import { WorkspacePanel } from "./components/WorkspacePanel";
import { surfaceClasses } from "./components/view-styles";
import { subAgentDescription } from "./conversation-state";
import { useConversationList } from "./hooks/useConversationList";
import { useConversationLoader } from "./hooks/useConversationLoader";
import { useConversationRun } from "./hooks/useConversationRun";
import { useRunActivity } from "./hooks/useRunActivity";
import { useMcpSettings } from "./hooks/useMcpSettings";
import { useProjectOpen } from "./hooks/useProjectOpen";
import { useLarkBinding } from "./hooks/useLarkBinding";
import { conversationDisplayName } from "./components/conversation-display-name";
import { buildOpenRequest } from "./project-open-state";
import { ArchivedPage } from "./components/ArchivedPage";
import type {
  ConversationDetail,
  ConversationSummary,
} from "./run-client";
import { getLarkCapability } from "./run-client";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<ConversationPage />} />
      <Route
        path="/conversations/:conversationId"
        element={<ConversationPage />}
      />
      <Route path="/archived" element={<ArchivedPage />} />
      <Route
        path="/archived/:conversationId"
        element={<ArchivedPage />}
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function ConversationPage() {
  const { conversationId } = useParams();
  const navigate = useNavigate();
  const catalog = useConversationList();
  const run = useConversationRun(catalog.refresh);
  const loader = useConversationLoader({ conversationId, run, catalog });
  const runActivity = useRunActivity();
  const mcp = useMcpSettings();
  // 删除确认弹窗开合由侧栏容器持有，这里同步一份用于禁用项目打开等操作。
  const [deletionOpen, setDeletionOpen] = useState(false);
  // 飞书绑定弹窗；目标会话来自列表行菜单，以 key 触发重读该会话的绑定状态。
  const [larkTarget, setLarkTarget] =
    useState<ConversationSummary | null>(null);
  const [larkCapabilityEnabled, setLarkCapabilityEnabled] = useState(false);
  const lark = useLarkBinding(larkTarget?.id);
  // 进入页面时读取一次飞书能力，决定行菜单是否显示「绑定飞书单聊」入口。
  // 放在 useEffect 中，避免重渲染重复请求；卸载后不再落地状态。
  useEffect(() => {
    let cancelled = false;
    getLarkCapability().then(
      (capability) => {
        if (!cancelled) setLarkCapabilityEnabled(capability.enabled);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, []);
  const projectOpen = useProjectOpen({
    isBlocked: () => deletionOpen,
    onOpened: (conversation) => switchTo(conversation),
  });
  /** 打开的子 Run 抽屉；同一时间只开一个。 */
  const [openSubAgent, setOpenSubAgent] =
    useState<{ turnId: string; toolCallId: string } | null>(null);
  const openSubAgentTurn = openSubAgent === null
    ? undefined
    : run.state.turns.find((turn) => turn.id === openSubAgent.turnId);
  const openSubAgentRun = openSubAgent === null
    ? undefined
    : openSubAgentTurn?.subAgentRuns[openSubAgent.toolCallId];

  /** 打开新项目或删掉当前会话后，把页面切到给定会话（null 即首页）。 */
  function switchTo(detail: ConversationDetail | null): void {
    loader.show(detail);
    run.setInput("");
    if (detail === null) {
      run.reset();
      navigate("/", { replace: true });
      return;
    }
    catalog.upsert(detail);
    run.hydrate(detail);
    navigate(`/conversations/${encodeURIComponent(detail.id)}`);
  }

  function selectConversation(id: string): void {
    // 运行中允许切换会话：离开只断当前订阅，Run 继续跑。
    if (deletionOpen || id === conversationId) {
      return;
    }
    navigate(`/conversations/${encodeURIComponent(id)}`);
  }

  const { conversation } = loader;
  // 切换、新建会话都不受当前 Run 限制；打开项目与删除彼此独占。
  const projectDialogOpen = projectOpen.state.status !== "closed";
  const busy = projectDialogOpen || deletionOpen;

  return (
    <main className="h-dvh min-w-80 overflow-hidden bg-[radial-gradient(circle_at_15%_10%,rgba(255,255,255,0.85),transparent_28rem),linear-gradient(145deg,#f7f5ee_0%,#eeece3_100%)] font-sans text-[#14201b] antialiased max-[760px]:h-auto max-[760px]:min-h-dvh max-[760px]:overflow-visible">
      <div className="flex h-full w-full flex-col p-4 max-[760px]:h-auto max-[600px]:p-2.5 max-[600px]:pb-6">
        <div className="mx-auto grid min-h-0 w-full max-w-[1320px] flex-1 grid-cols-[270px_minmax(0,1fr)] items-stretch gap-[18px] min-[1120px]:grid-cols-[300px_minmax(0,1fr)] max-[760px]:grid-cols-1">
          <ConversationSidebarPanel
            catalog={catalog}
            selectedId={conversationId}
            onSelect={selectConversation}
            isOperationBlocked={() => projectDialogOpen}
            onDeletionDialogChange={setDeletionOpen}
            runActivities={runActivity.activities}
            isRunActive={(id) => runActivity.activities.has(id)}
            newConversationDisabled={projectDialogOpen}
            onBindLark={larkCapabilityEnabled
              ? (conversation) => {
                  // 先设置弹窗目标会话使其挂载，再读取该会话的绑定状态。
                  setLarkTarget(conversation);
                  lark.open(conversation.id);
                }
              : undefined}
            onNewConversation={() => void projectOpen.inspectDirectory()}
            activeNav={mcp.state.status === "closed" ? undefined : "mcp"}
            onOpenMcpSettings={mcp.open}
            onShowArchived={() => navigate("/archived")}
            projectActions={{
              newConversationDisabled: projectDialogOpen,
              onNewConversationInProject: (project) => {
                projectOpen.openProject(project);
              },
            }}
            onDeleted={(deletedId) => {
              if (deletedId === conversationId) switchTo(null);
            }}
            onArchived={(archivedId) => {
              // 若归档的正是当前选中的会话，按产品方案切到该会话的只读详情。
              if (archivedId === conversationId) {
                navigate(`/archived/${encodeURIComponent(archivedId)}`, {
                  replace: true,
                });
              }
            }}
            onMissing={(missingId) => {
              if (missingId === conversationId) switchTo(null);
            }}
          />
          <div className="flex min-h-0 min-w-0 flex-col">
            <ScrollToBottomArea>
              {loader.error !== undefined && (
                <div
                  className={`${surfaceClasses} mb-[18px] rounded-[18px] border-[#e1b9b4] p-[18px] text-sm text-[#a33d35] max-[600px]:rounded-[14px]`}
                  role="alert"
                >
                  {loader.error}
                </div>
              )}
              {loader.loading && (
                <div
                  className={`${surfaceClasses} mb-[18px] rounded-[18px] p-[18px] text-sm text-[#69736d] max-[600px]:rounded-[14px]`}
                >
                  正在恢复会话…
                </div>
              )}

              <WorkspacePanel
                conversation={conversation}
                openingDisabled={busy}
                opening={projectOpen.state.status === "submitting"}
                onOpenProject={() => void projectOpen.inspectDirectory()}
              />

              {run.state.usage.calls > 0 && (
                <UsageSummary
                  usage={run.state.usage}
                  scope="conversation"
                  className={`${surfaceClasses} mb-[18px] rounded-[18px] px-[18px] py-3 max-[600px]:rounded-[14px]`}
                />
              )}

              {run.state.turns.length > 0 && (
                <section
                  className="mb-[18px] space-y-[18px]"
                  aria-label="对话记录"
                >
                  {run.state.turns.map((turn, index) => (
                    <ConversationTurn
                      key={turn.id}
                      turn={turn}
                      number={index + 1}
                      interactionRequests={run.interactionRequests}
                      onRespond={run.respond}
                      onSelectFile={run.selectFile}
                        onOpenSubAgent={(toolCallId) =>
                        setOpenSubAgent({ turnId: turn.id, toolCallId })}
                        onStopSubAgent={(toolCallId) => run.stopSubAgent(toolCallId)}
                    />
                  ))}
                </section>
              )}
            </ScrollToBottomArea>

            <ProjectOpenDialog
              state={projectOpen.state}
              onCancel={() => projectOpen.dispatch({ type: "close" })}
              onInspect={() => void projectOpen.inspectDirectory()}
              onModeChange={(executionMode) =>
                projectOpen.dispatch({ type: "select_mode", executionMode })}
              onFullAccessConfirmationChange={(confirmed) =>
                projectOpen.dispatch({ type: "confirm_full_access", confirmed })}
              onChoiceChange={(choice) =>
                projectOpen.dispatch({ type: "select_choice", choice })}
              onBaseBranchChange={(base) =>
                projectOpen.dispatch({ type: "select_base_branch", ...base })}
              onBranchChange={(branch) =>
                projectOpen.dispatch({ type: "select_new_branch", branch })}
              onSelectCreateMode={(createMode) =>
                projectOpen.dispatch({ type: "select_create_mode", createMode })}
              onSubmit={() => void projectOpen.submit(buildOpenRequest)}
            />

            <McpSettingsDialog
              state={mcp.state}
              dispatch={mcp.dispatch}
              onRetryLoad={mcp.open}
              onProbe={(draft) => void mcp.probe(draft)}
              onSave={() => void mcp.save()}
            />

            {openSubAgent !== null &&
              openSubAgentTurn !== undefined &&
              openSubAgentRun !== undefined && (
                <SubAgentDrawer
                  description={subAgentDescription(
                    openSubAgentTurn,
                    openSubAgent.toolCallId,
                  )}
                  run={openSubAgentRun}
                  canRespond={openSubAgentTurn.run.status === "running"}
                  interactionRequests={run.interactionRequests}
                  onRespond={run.respond}
                  onSelectFile={run.selectFile}
                  onClose={() => setOpenSubAgent(null)}
                  onStop={() => run.stopSubAgent(openSubAgent.toolCallId)}
                />
              )}
            {run.subAgentStopError !== undefined && (
              <p className="mb-2.5 rounded-[9px] border border-[#e1b9b4] bg-[#fff5f3] px-3 py-2 text-xs text-[#a33d35]" role="alert">
                {run.subAgentStopError}
              </p>
            )}

            <PendingInteractionDock
              interactions={run.pendingInteractions}
              interactionRequests={run.interactionRequests}
              onRespond={run.respond}
              onSelectFile={run.selectFile}
            />

            {larkTarget !== null && larkCapabilityEnabled && (
              <FeishuBindingDialog
                open={lark.state.status !== "loading"}
                conversationName={conversationDisplayName(larkTarget)}
                lark={lark}
                onClose={() => {
                  lark.close();
                  setLarkTarget(null);
                }}
              />
            )}

            <ConversationComposer
              input={run.input}
              status={run.status}
              hasConversation={conversation !== null}
              hasTurns={run.state.turns.length > 0}
              projectSelecting={
                projectOpen.state.status === "submitting" || deletionOpen
              }
              canSteer={run.canSteer}
              hasPendingInteraction={run.pendingInteractions.length > 0}
              onInputChange={run.setInput}
              onSubmit={() => {
                if (conversation !== null) {
                  run.start(
                    conversation.id,
                    projectOpen.state.status === "submitting",
                  );
                }
              }}
              onSteer={() => void run.steer()}
              onStop={run.stop}
              isStopping={run.isStopping}
            />
          </div>
        </div>
      </div>
    </main>
  );
}
