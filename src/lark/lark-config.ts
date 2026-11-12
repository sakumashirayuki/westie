export interface LarkConfig {
  /** 飞书自建应用 App ID；与 App Secret 同时填写才启用桥接。 */
  readonly appId?: string;
  /** 飞书自建应用 App Secret。 */
  readonly appSecret?: string;
  /** API 与长连接域名；缺省 `open.feishu.cn`，国际版填 `open.larksuite.com`。 */
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

/**
 * 从进程环境读取飞书配置。未填凭证时返回「桥接关闭」的配置对象，此时不创建
 * 任何 SDK 对象、不建立任何外连，网页与现状一致。
 */
export function loadLarkConfig(environment: NodeJS.ProcessEnv = process.env): LarkConfig {
  const appId = optionalValue(environment.LARK_APP_ID);
  const appSecret = optionalValue(environment.LARK_APP_SECRET);
  const domain = optionalValue(environment.LARK_DOMAIN) ?? "open.feishu.cn";
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