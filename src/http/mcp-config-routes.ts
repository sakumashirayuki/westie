import type { IncomingMessage, ServerResponse } from "node:http";

import { z } from "zod";

import {
  expandVariables,
  type McpServerDraft,
  type WorkspaceMcpServerConfig,
} from "../infrastructure/workspace-mcp-config.js";
import {
  userMcpConfigStore,
  type UserMcpConfigStore,
} from "../infrastructure/mcp-config-store.js";
import type { McpProbeResult } from "../mcp/probe.js";
import {
  isTrustedHostActionOrigin,
} from "./origin-policy.js";
import {
  writeHttpError,
  writeJson,
} from "./http-response.js";
import { parseJsonRequest } from "./request-json.js";

const serverNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const serverConfigSchema = z.strictObject({
  type: z.enum(["stdio", "http"]),
  command: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().min(1).optional(),
  url: z.string().min(1).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.number().int().positive().max(600_000).optional(),
});

const saveRequestSchema = z.strictObject({
  servers: z.record(z.string(), serverConfigSchema),
});

const probeRequestSchema = z.strictObject({
  name: z.string(),
  config: serverConfigSchema,
});

export interface McpConfigRoutesOptions {
  readonly homeDir: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly store?: UserMcpConfigStore;
  readonly probe?: (config: WorkspaceMcpServerConfig) => Promise<McpProbeResult>;
  readonly allowedOrigin?: string;
  readonly fullAccessAvailable?: boolean;
}

/**
 * 用户级 `~/.agents/mcp.json` 的管理端点。全部要求受信任的宿主动作 Origin；
 * 写回（PUT）还会要求服务绑定 loopback。读/写复用同一个校验与 `${VAR}` 展开。
 */
export class McpConfigRoutes {
  readonly #options: McpConfigRoutesOptions;

  constructor(options: McpConfigRoutesOptions) {
    this.#options = options;
  }

  async getConfig(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    // 方法校验与 Allow 头由挂载处的 defineRoute 负责。
    if (!this.#trusted(request, response)) return;

    const store = this.#store();
    const config = await store.read(this.#options.homeDir);
    writeJson(response, 200, {
      servers: config.servers,
      diagnostics: config.diagnostics.map(({ code, server, path, message }) => ({
        code,
        ...(server === undefined ? {} : { server }),
        path,
        message,
      })),
    });
  }

  async saveConfig(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    // 方法校验与 Allow 头由挂载处的 defineRoute 负责。
    if (!this.#trusted(request, response)) return;
    if (this.#options.fullAccessAvailable !== true) {
      writeHttpError(response, {
        status: 403,
        code: "MCP_CONFIG_REQUIRES_LOOPBACK",
        message: "MCP config can be edited only on a loopback-bound server.",
      });
      return;
    }

    const parsed = await parseJsonRequest(request, saveRequestSchema, {
      code: "INVALID_MCP_CONFIG",
      message: "Request body does not match the MCP config schema.",
    });
    if (!parsed.ok) {
      writeHttpError(response, parsed.error);
      return;
    }

    const build = this.#buildDrafts(parsed.data.servers);
    if (!build.ok) {
      writeHttpError(response, {
        status: 422,
        code: "INVALID_MCP_CONFIG",
        message: build.message,
      });
      return;
    }

    const store = this.#store();
    await store.write(this.#options.homeDir, build.servers);
    const config = await store.read(this.#options.homeDir);
    writeJson(response, 200, {
      servers: config.servers,
      diagnostics: config.diagnostics.map(({ code, server, path, message }) => ({
        code,
        ...(server === undefined ? {} : { server }),
        path,
        message,
      })),
    });
  }

  async probeServer(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    // 方法校验与 Allow 头由挂载处的 defineRoute 负责。
    if (!this.#trusted(request, response)) return;

    const parsed = await parseJsonRequest(request, probeRequestSchema, {
      code: "INVALID_MCP_SERVER",
      message: "Request body does not match the MCP server schema.",
    });
    if (!parsed.ok) {
      writeHttpError(response, parsed.error);
      return;
    }

    const draft = this.#buildDraft(parsed.data.name, parsed.data.config);
    if (!draft.ok) {
      writeHttpError(response, {
        status: 422,
        code: "INVALID_MCP_SERVER",
        message: draft.message,
      });
      return;
    }

    const probe = this.#options.probe ?? (() =>
      Promise.resolve({
        ok: false as const,
        message: "MCP probing is unavailable.",
      }));
    // 探测用展开后的值；落盘的 server.config 保留 ${VAR} 原串。
    writeJson(response, 200, await probe(draft.probeConfig));
  }

  #trusted(request: IncomingMessage, response: ServerResponse): boolean {
    if (isTrustedHostActionOrigin(request, this.#options.allowedOrigin)) {
      return true;
    }
    writeHttpError(response, {
      status: 403,
      code: "UNTRUSTED_ORIGIN",
      message: "This origin cannot manage MCP config.",
    });
    return false;
  }

  #store(): UserMcpConfigStore {
    return this.#options.store ?? userMcpConfigStore;
  }

  #buildDrafts(
    rawServers: Record<string, z.infer<typeof serverConfigSchema>>,
  ):
    | { readonly ok: true; readonly servers: McpServerDraft[] }
    | { readonly ok: false; readonly message: string } {
    const errors: string[] = [];
    const servers: McpServerDraft[] = [];
    for (const [name, raw] of Object.entries(rawServers)) {
      const built = this.#buildDraft(name, raw);
      if (built.ok) servers.push(built.server);
      else errors.push(`${name}: ${built.message}`);
    }
    if (errors.length > 0) {
      return { ok: false, message: errors.join("; ") };
    }
    return { ok: true, servers };
  }

  #buildDraft(
    name: string,
    raw: z.infer<typeof serverConfigSchema>,
  ):
    | {
        readonly ok: true;
        /** 落盘形态，`${VAR}` 原串。 */
        readonly server: McpServerDraft;
        /** 探测形态，`${VAR}` 已展开。 */
        readonly probeConfig: WorkspaceMcpServerConfig;
      }
    | { readonly ok: false; readonly message: string } {
    if (!serverNamePattern.test(name) || name.length > 32) {
      return {
        ok: false,
        message:
          "server name must be 1-32 lowercase letters, digits, or single hyphens",
      };
    }
    const env = this.#options.env ?? process.env;

    let expandedEnv: Record<string, string> | undefined;
    if (raw.env !== undefined) {
      const result = expandVariables(raw.env, env);
      if (result === undefined) {
        return { ok: false, message: "env references an undefined variable" };
      }
      expandedEnv = result;
    }
    let expandedHeaders: Record<string, string> | undefined;
    if (raw.headers !== undefined) {
      const result = expandVariables(raw.headers, env);
      if (result === undefined) {
        return { ok: false, message: "headers reference an undefined variable" };
      }
      expandedHeaders = result;
    }

    if (raw.type === "stdio") {
      if (raw.command === undefined || raw.command === "") {
        return { ok: false, message: "stdio server requires a command" };
      }
      const base = {
        type: "stdio" as const,
        command: raw.command,
        ...(raw.args === undefined ? {} : { args: raw.args }),
        ...(raw.cwd === undefined ? {} : { cwd: raw.cwd }),
        timeoutMs: raw.timeoutMs ?? 60_000,
      };
      return {
        ok: true,
        server: {
          name,
          config: { ...base, ...(raw.env === undefined ? {} : { env: raw.env }) },
        },
        probeConfig: {
          ...base,
          ...(expandedEnv === undefined ? {} : { env: expandedEnv }),
        },
      };
    }

    if (raw.url === undefined || raw.url === "") {
      return { ok: false, message: "http server requires a url" };
    }
    const base = {
      type: "http" as const,
      url: raw.url,
      timeoutMs: raw.timeoutMs ?? 60_000,
    };
    return {
      ok: true,
      server: {
        name,
        config: {
          ...base,
          ...(raw.headers === undefined ? {} : { headers: raw.headers }),
        },
      },
      probeConfig: {
        ...base,
        ...(expandedHeaders === undefined ? {} : { headers: expandedHeaders }),
      },
    };
  }
}
