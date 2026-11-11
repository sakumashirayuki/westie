import type { ConversationTurnState } from "../conversation-state";
import type {
  InteractionRequestMap,
  InteractionResponder,
  WorkspaceGrantSelector,
} from "../interaction-ui";
import { RunResult } from "./RunResult";
import { RunTrace } from "./RunTrace";
import { SteeringMessages } from "./SteeringMessages";
import { SubAgentList } from "./SubAgentList";
import { latestTodo, TodoList } from "./TodoList";
import { statusLabels, surfaceClasses } from "./view-styles";

export function ConversationTurn({
  turn,
  number,
  interactionRequests,
  onRespond,
  onSelectFile,
  onOpenSubAgent,
  onStopSubAgent,
}: {
  turn: ConversationTurnState;
  number: number;
  interactionRequests: InteractionRequestMap;
  onRespond: InteractionResponder;
  onSelectFile: WorkspaceGrantSelector;
  onOpenSubAgent?: (toolCallId: string) => void;
  onStopSubAgent?: (toolCallId: string) => void;
}) {
  const todo = latestTodo(turn.run.steps);
  return (
    <article className={`${surfaceClasses} overflow-hidden rounded-[18px]`}>
      <div className="border-b border-[rgba(20,32,27,0.09)] px-[22px] py-[17px]">
        <div className="mb-2 flex items-center justify-between">
          <span className="font-mono text-xs font-bold tracking-[0.08em] text-[#657068]">
            TURN {number}
          </span>
          <span className="text-xs text-[#69736d]">
            {statusLabels[turn.run.status]}
          </span>
        </div>
        <p className="leading-[1.65] whitespace-pre-wrap">{turn.userMessage}</p>
        <SteeringMessages messages={turn.run.steeringMessages} />
        {todo !== undefined && <TodoList list={todo} />}
      </div>
      <div className="px-[22px] py-[19px]">
        <RunResult run={turn.run} />
        {turn.run.waitingForSubAgents && (
          <p className="mt-3 text-sm text-[#a5650d]" role="status">等待子任务完成…</p>
        )}
        {Object.keys(turn.subAgentRuns).length > 0 && (
            <SubAgentList turn={turn} onOpen={onOpenSubAgent} onStop={onStopSubAgent} />
          )}
        {turn.run.steps.length > 0 && (
          <RunTrace
            steps={turn.run.steps}
            canRespond={turn.run.status === "running"}
            interactionRequests={interactionRequests}
            onRespond={onRespond}
            onSelectFile={onSelectFile}
            onOpenSubAgent={onOpenSubAgent}
            onStopSubAgent={onStopSubAgent}
          />
        )}
      </div>
    </article>
  );
}
