import type { LlmProvider } from "./provider-protocol.js";
import type { WorkspaceRuntime } from "./application/workspace-runtime.js";
import type { WorkspaceGrantStore } from "./application/workspace-grant-store.js";
import type { ExecutionMode } from "./domain/conversation.js";
import { DeepSeekProvider } from "./providers/deepseek.js";
import { OpenAICompatibleProvider } from "./providers/openai-compatible.js";
import { OpenAIProvider } from "./providers/openai.js";
import { RetryingProvider } from "./providers/retrying-provider.js";
import { MacOsSeatbeltSandboxRunner } from "./sandbox/macos-seatbelt-sandbox-runner.js";
import type { SandboxRunner } from "./sandbox/sandbox-runner.js";
import type { Tool } from "./tools.js";
import { createBashTool } from "./tools/bash.js";
import { createEditTool } from "./tools/edit.js";
import { createGlobTool } from "./tools/glob.js";
import { createGrepTool } from "./tools/grep.js";
import { getCurrentTimeTool } from "./tools/get-current-time.js";
import { createReadTool } from "./tools/read.js";
import { todoTool } from "./tools/todo.js";
import { createWebFetchTool } from "./tools/web-fetch.js";
import { createWriteTool } from "./tools/write.js";
import { createWebSearchTool } from "./tools/web-search.js";

export type SandboxRunnerFactory = (
  workspaceRoot: string,
  executionMode: ExecutionMode,
) => Promise<SandboxRunner>;

export interface DefaultWorkspaceRuntimeOptions {
  readonly sandboxRunnerFactory?: SandboxRunnerFactory;
  readonly workspaceGrantStore?: WorkspaceGrantStore;
  readonly webSearchApiKey?: string;
}

export async function createDefaultWorkspaceRuntime(
  workspaceRoot: string,
  executionMode: ExecutionMode,
  options: DefaultWorkspaceRuntimeOptions = {},
): Promise<WorkspaceRuntime> {
  const sandboxRunnerFactory =
    options.sandboxRunnerFactory ?? ((root, mode) =>
      mode === "full_access"
        ? MacOsSeatbeltSandboxRunner.createFullAccess(root)
        : MacOsSeatbeltSandboxRunner.create(root));
  const [readTool, writeTool, editTool, sandboxRunner] = await Promise.all([
    createReadTool(workspaceRoot, options.workspaceGrantStore, executionMode),
    createWriteTool(workspaceRoot, executionMode),
    createEditTool(workspaceRoot, executionMode),
    sandboxRunnerFactory(workspaceRoot, executionMode),
  ]);
  const [grepTool, globTool] = await Promise.all([
    createGrepTool(workspaceRoot, sandboxRunner, executionMode),
    createGlobTool(workspaceRoot, sandboxRunner, executionMode),
  ]);

  return {
    workspaceRoot,
    executionMode,
    sandboxRunner,
    tools: [
      getCurrentTimeTool,
      readTool,
      grepTool,
      globTool,
      writeTool,
      editTool,
      createWebSearchTool({
        apiKey: options.webSearchApiKey ??
          requireEnvironmentVariable("TAVILY_API_KEY"),
      }),
      createWebFetchTool({ executionMode }),
      todoTool,
      createBashTool(workspaceRoot, sandboxRunner, executionMode),
    ],
  };
}

export async function createDefaultTools(
  workspaceRoot: string,
  options: {
    readonly sandboxRunner?: SandboxRunner;
    readonly workspaceGrantStore?: WorkspaceGrantStore;
    readonly webSearchApiKey?: string;
  } = {},
): Promise<readonly Tool[]> {
  const runtime = await createDefaultWorkspaceRuntime(
    workspaceRoot,
    "workspace_sandbox",
    {
      ...(options.sandboxRunner === undefined
        ? {}
        : { sandboxRunnerFactory: async () => options.sandboxRunner! }),
      ...(options.workspaceGrantStore === undefined
        ? {}
        : { workspaceGrantStore: options.workspaceGrantStore }),
      ...(options.webSearchApiKey === undefined
        ? {}
        : { webSearchApiKey: options.webSearchApiKey }),
    },
  );
  return runtime.tools;
}

export interface ProviderCapacity {
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
}

export function createProviderFromEnvironment(
  capacity?: ProviderCapacity,
): LlmProvider {
  const providerName = process.env.LLM_PROVIDER?.trim().toLowerCase() || "openai";

  let inner: LlmProvider;
  switch (providerName) {
    case "openai":
      inner = new OpenAIProvider({
        apiKey: requireEnvironmentVariable("OPENAI_API_KEY"),
        model: requireEnvironmentVariable("OPENAI_MODEL"),
        ...capacity,
      });
      break;
    case "deepseek":
      inner = new DeepSeekProvider({
        apiKey: requireEnvironmentVariable("DEEPSEEK_API_KEY"),
        model: requireEnvironmentVariable("DEEPSEEK_MODEL"),
        baseURL: optionalEnvironmentVariable("DEEPSEEK_BASE_URL"),
        ...capacity,
      });
      break;
    case "openai-compatible":
      inner = new OpenAICompatibleProvider({
        apiKey: requireEnvironmentVariable("OPENAI_COMPATIBLE_API_KEY"),
        model: requireEnvironmentVariable("OPENAI_COMPATIBLE_MODEL"),
        baseURL: requireEnvironmentVariable("OPENAI_COMPATIBLE_BASE_URL"),
        ...capacity,
      });
      break;
    default:
      throw new Error(
        `Unsupported LLM_PROVIDER: ${providerName}. Expected openai, deepseek, or openai-compatible.`,
      );
  }
  return new RetryingProvider(inner);
}

function requireEnvironmentVariable(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnvironmentVariable(name: string): string | undefined {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") {
    return undefined;
  }
  return value;
}
