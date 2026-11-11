import type {
  InteractionRequestMap,
  InteractionResponder,
  WorkspaceGrantSelector,
} from "../interaction-ui";
import type { PendingInteraction } from "../pending-interactions";
import { ToolApprovalCard } from "./ToolApprovalCard";
import { WorkspaceGrantCard } from "./WorkspaceGrantCard";

const cardLayoutClasses = "rounded-[12px] p-4";

export function PendingInteractionDock({
  interactions,
  interactionRequests,
  onRespond,
  onSelectFile,
}: {
  interactions: PendingInteraction[];
  interactionRequests: InteractionRequestMap;
  onRespond: InteractionResponder;
  onSelectFile: WorkspaceGrantSelector;
}) {
  if (interactions.length === 0) return null;

  return (
    <section
      className="mb-2.5 space-y-2.5"
      aria-label="待处理的确认"
      aria-live="polite"
    >
      {interactions.map((interaction) => (
        <div key={interaction.interactionId}>
          <p className="mb-1 flex flex-wrap items-center gap-2 px-1 text-[11px] text-[#7b847e]">
            <span className="font-mono font-bold tracking-[0.08em] text-[#a5650d]">
              STEP {interaction.step}
            </span>
            {interaction.source !== undefined && (
              <span className="text-[#276c53]">
                agent · {interaction.source.description} →
              </span>
            )}
            <span>
              {interaction.kind === "tool_approval"
                ? interaction.tool.name
                : interaction.grant.toolName}
            </span>
            <span>
              {interaction.source === undefined
                ? "· 运行已暂停，等待你的决定"
                : "· 子 Run 已暂停，等待你的决定"}
            </span>
          </p>
          {interaction.kind === "tool_approval" ? (
            <ToolApprovalCard
              tool={interaction.tool}
              canRespond
              request={interactionRequests[interaction.interactionId]}
              onRespond={onRespond}
              layoutClassName={cardLayoutClasses}
              showArguments
            />
          ) : (
            <WorkspaceGrantCard
              grant={interaction.grant}
              canRespond
              request={interactionRequests[interaction.interactionId]}
              onRespond={onRespond}
              onSelectFile={onSelectFile}
              layoutClassName={cardLayoutClasses}
            />
          )}
        </div>
      ))}
    </section>
  );
}
