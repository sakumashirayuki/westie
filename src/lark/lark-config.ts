export interface LarkConfig {
  /** 飞书自建应用 App ID；与 App Secret 同时填写才启用桥接。 */
  readonly appId?: string;
  /** 飞书自建应用 App Secret。 */
  readonly appSecret?: string;
  /** API 与长连接的完整 origin，带 https 协议；缺省国内版，国际版填 https://open.larksuite.com。 */
  readonly domain: string;
  /** 逗号分隔的 open_id 白名单；空表示不限制（绑定码是唯一授权入口）。 */
  readonly allowedOpenIds: ReadonlySet<string>;
}

export interface LarkBridgeEnabledConfig extends LarkConfig {
  readonly appId: string;
  readonly appSecret: string;
}

/** 是否给定了 App ID 与 App Secret（两者同时填写才启用桥接）。 */
export function isLarkConfigEnabled(config: LarkConfig): config is LarkBridgeEnabledConfig {
  return config.appId !== undefined && config.appSecret !== undefined;
}

/** 缺省国内版 origin；SDK 要求带协议，裸域名会在 URL 解析时抛 Invalid URL。 */
const DEFAULT_LARK_DOMAIN = "https://open.feishu.cn";

/**
 * 归一化 LARK_DOMAIN：缺省回退国内版；填写裸域名时补 `https://`，已带协议的
 * 原样保留。飞书 SDK 的 `formatDomain` 只识别内置枚举，自定义域名走默认分支
 * 原样透传，因此这里必须保证输出是合法完整 URL。
 */
export function normalizeLarkDomain(value: string | undefined): string {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed === "") return DEFAULT_LARK_DOMAIN;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

/**
 * 从进程环境读取飞书配置。未填凭证时返回「桥接关闭」的配置对象，此时不创建
 * 任何 SDK 对象、不建立任何外连，网页与现状一致。
 */
export function loadLarkConfig(environment: NodeJS.ProcessEnv = process.env): LarkConfig {
  const appId = optionalValue(environment.LARK_APP_ID);
  const appSecret = optionalValue(environment.LARK_APP_SECRET);
  const domain = normalizeLarkDomain(optionalValue(environment.LARK_DOMAIN));
  const allowedOpenIds = new Set(
    optionalValue(environment.LARK_ALLOWED_OPEN_IDS)
      ?.split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0) ?? [],
  );
  return { appId, appSecret, domain, allowedOpenIds };
}

function optionalValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}