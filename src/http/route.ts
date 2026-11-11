import type { IncomingMessage, ServerResponse } from "node:http";

import {
  writeHttpError,
  writeMethodNotAllowed,
} from "./http-response.js";
import {
  evaluateFullAccessRequest,
  isTrustedHostActionOrigin,
} from "./origin-policy.js";

/**
 * 路由守卫：把方法校验、Origin 校验和 `Allow` 头的生成收在一处。
 *
 * 每个端点用 `defineRoute` 声明自己支持的方法和 Origin 要求，处理函数里只留业务
 * 逻辑。`Allow` 头由 `methods` 生成，不会与实际支持的方法脱节；`OPTIONS` 预检由
 * `AgentController` 统一响应，不进入这里。
 *
 * 请求体解析不属于 `defineRoute`：需要读 `executionMode` 才能判定 Origin 的端点
 * （工作区选择）与只按 Origin 判定、之后才解析 JSON 的端点（改名）次序不同，
 * 硬塞进一个钩子会把“不可信 Origin 不接触请求体”这条既有语义搞乱。
 */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RouteRequest {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
}

/**
 * `trusted`：只接受本机 loopback 同源或 `CORS_ALLOW_ORIGIN` 明确允许的 Origin。
 * `public`：不校验 Origin，用于不带浏览器 Origin 也应直接服务的只读端点。
 */
export type OriginRequirement = "trusted" | "public";

export interface RouteDefinition {
  /** 该端点支持的方法。顺序只影响 `Allow` 头的呈现。 */
  readonly methods: readonly HttpMethod[];
  readonly origin: OriginRequirement;
  /** Origin 不可信时的错误文案，说明该 Origin 不能执行什么操作。 */
  readonly denyMessage: string;
  readonly handle: (context: RouteRequest) => void | Promise<void>;
}

export interface RouteContext {
  readonly allowedOrigin?: string;
}

/**
 * 判定请求 Origin。返回 `allowed` 或 `untrusted_origin`；
 * `requires_loopback` 只在 `executionMode` 语境下出现，由调用方自行处理。
 */
export function checkTrustedOrigin(
  request: IncomingMessage,
  allowedOrigin: string | undefined,
): "allowed" | "untrusted_origin" {
  return isTrustedHostActionOrigin(request, allowedOrigin)
    ? "allowed"
    : "untrusted_origin";
}

export type RouteHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => Promise<void>;

/** 组合出一条可直接挂到路径上的处理函数。 */
export function defineRoute(
  definition: RouteDefinition,
  context: RouteContext,
): RouteHandler {
  const allow = [...definition.methods, "OPTIONS"].join(", ");
  return async (request, response) => {
    if (!definition.methods.includes(request.method as HttpMethod)) {
      writeMethodNotAllowed(response, allow);
      return;
    }
    if (
      definition.origin === "trusted" &&
      checkTrustedOrigin(request, context.allowedOrigin) !== "allowed"
    ) {
      writeHttpError(response, {
        status: 403,
        code: "UNTRUSTED_ORIGIN",
        message: definition.denyMessage,
      });
      return;
    }
    await definition.handle({ request, response });
  };
}

/**
 * 带路径参数的端点：`defineRoute` 只管方法与 Origin，`AgentController` 在守卫
 * 通过后把正则捕获到的参数交给业务 `handle`。
 */
export type ParamRouteHandler<TPath extends readonly string[]> = (
  request: IncomingMessage,
  response: ServerResponse,
  ...params: TPath
) => void | Promise<void>;
