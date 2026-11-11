import { runAgent } from "./agent-loop.js";
import { createAgentRun } from "./agent-run.js";
import {
  createDefaultTools,
  createProviderFromEnvironment,
} from "./runtime.js";
import { loadWorkspaceInstructions } from "./infrastructure/workspace-instructions.js";
import { assembleSystemPrompt } from "./system-prompt.js";
import {
  discoverWorkspaceSkills,
  reportWorkspaceSkillDiagnostics,
} from "./infrastructure/workspace-skills.js";
import { acquireMcpToolSet } from "./mcp/acquire-tools.js";
import { McpServerPool } from "./mcp/server-pool.js";
import { ContextBuilder } from "./application/context-builder.js";
import { loadAgentModelCapacity } from "./server-config.js";
import { createSkillTool } from "./tools/skill.js";
import { homedir } from "node:os";
import {
  AuthorizedToolExecutor,
  createDefaultToolPermissionPolicy,
} from "./tool-permissions.js";

async function main(): Promise<void> {
  const input = process.argv.slice(2).join(" ").trim();
  if (input === "") {
    throw new Error('Usage: npm start -- "your task"');
  }

  const provider = createProviderFromEnvironment(loadAgentModelCapacity());
  const workspaceRoot = process.cwd();
  // MCP 的 stdio 子进程随连接池活着；离开 main 时（正常或异常）自动 close()。
  await using mcpServerPool = new McpServerPool();
  const [baseTools, workspaceInstructions, workspaceSkills, mcpTools] =
    await Promise.all([
      createDefaultTools(workspaceRoot),
      loadWorkspaceInstructions(workspaceRoot),
      discoverWorkspaceSkills(workspaceRoot, { homeDir: homedir() }),
      acquireMcpToolSet(mcpServerPool, workspaceRoot),
    ]);
  reportWorkspaceSkillDiagnostics(workspaceSkills.diagnostics);
  const tools = [...baseTools, ...mcpTools];
  if (workspaceSkills.skills.length > 0) {
    tools.push(createSkillTool(workspaceSkills));
  }
  const systemPrompt = assembleSystemPrompt({
    workspaceRoot,
    workspaceInstructions,
    workspaceSkillsCatalog: workspaceSkills.catalog,
    hasMcpTools: mcpTools.length > 0,
  });
  const authorizedToolExecutor = new AuthorizedToolExecutor({
    policy: createDefaultToolPermissionPolicy(),
  });
  const run = createAgentRun();
  const answer = await runAgent({
    transcript: [{ role: "user", content: input }],
    systemPrompt,
    provider,
    contextBuilder: new ContextBuilder({
      provider,
      runId: run.runId,
      usageLog: run.usageLog,
    }),
    toolEnvironment: {
      tools,
      executor: authorizedToolExecutor,
      permissionContext: { workspaceRoot },
    },
    run,
  });

  process.stderr.write(`${JSON.stringify({
    event: "run.usage",
    usage: run.usageLog.totals,
  })}\n`);

  console.log(answer);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
