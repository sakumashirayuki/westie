import { randomBytes } from "node:crypto";

export interface IssuedBindingCode {
  readonly code: string;
  readonly expiresAt: string;
  readonly conversationId: string;
}

/** 已消费的绑定码快照，用于绑定失败时把码放回存储。 */
export interface ConsumedBindingCode {
  readonly code: string;
  readonly conversationId: string;
  /** 过期时间的 epoch 毫秒，放回时沿用原有效期。 */
  readonly expiresAt: number;
}

const BINDING_CODE_TTL_MS = 10 * 60 * 1000;
/** 同一 chat_id 在窗口内校验失败达到该次数后进入枚举熔断。 */
export const MAX_BINDING_FAILURES_PER_WINDOW = 10;
export const BINDING_FAILURE_WINDOW_MS = 10 * 60 * 1000;

/** 编码字符集：大写字母去掉易混的 O/I（剩 24）+ 数字 2–9（8 个），共 32 个。 */
const CODE_ALPHABET =
  "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/**
 * 绑定码存储（内存）：签发一次性绑定码的校验、消费与过期清理，以及按 chat_id
 * 计数的失败枚举熔断。只存回调，不接触会话；绑定的最终裁决在路由层依赖数据库。
 *
 * 进程重启后所有绑定码失效，用户重新生成即可；绑定关系本身持久化在 SQLite，
 * 不依赖这里的任何状态。
 */
export class LarkBindingTokenStore {
  #codes = new Map<string, { conversationId: string; expiresAt: number }>();
  #codeByConversation = new Map<string, string>();
  #failures = new Map<string, number[]>();

  constructor(private readonly now: () => number = Date.now) {}

  /** 为一个会话签发新绑定码；同一会话的旧码立即失效。 */
  issue(conversationId: string): IssuedBindingCode {
    this.#sweep();
    // 码形如 `WST-XXXXXX`：前缀帮助路由识别，也方便用户辨认；核对时经
    // normalize 去掉空白并大写。
    const code = `WST-${this.#newPayload()}`;
    const expiresAt = this.now() + BINDING_CODE_TTL_MS;
    const previous = this.#codeByConversation.get(conversationId);
    if (previous !== undefined) this.#codes.delete(previous);
    this.#codes.set(code, { conversationId, expiresAt });
    this.#codeByConversation.set(conversationId, code);
    return { code, expiresAt: new Date(expiresAt).toISOString(), conversationId };
  }

  /**
   * 校验绑定码。trim、大写化与去空格由调用方先完成，这里只做精确匹配。
   * 返回 `{status: "valid", entry}`（含放回存储所需的完整快照）或
   * `{status: "invalid"}`（含过期）。校验失败不消费码，允许改正后重试；
   * 校验成功会一次性删码，后续绑定若失败需调用 `restore` 把码放回。
   */
  consume(
    code: string,
    chatId: string,
  ):
    | { readonly status: "valid"; readonly entry: ConsumedBindingCode }
    | { readonly status: "invalid" } {
    const entry = this.#codes.get(code);
    if (entry === undefined || entry.expiresAt <= this.now()) {
      this.#codes.delete(code);
      if (entry !== undefined) this.#codeByConversation.delete(entry.conversationId);
      this.#recordFailure(chatId);
      return { status: "invalid" };
    }
    // 校验成功即一次性消费。
    this.#codes.delete(code);
    this.#codeByConversation.delete(entry.conversationId);
    return {
      status: "valid",
      entry: {
        code,
        conversationId: entry.conversationId,
        expiresAt: entry.expiresAt,
      },
    };
  }

  /**
   * 把消费后绑定失败的码放回，允许用户用原码重试。已过期、同会话已签发新码
   * 或同码已存在时不放回，保证新码优先且不复活过期码。
   */
  restore(entry: ConsumedBindingCode): void {
    if (entry.expiresAt <= this.now()) return;
    if (this.#codes.has(entry.code)) return;
    if (this.#codeByConversation.has(entry.conversationId)) return;
    this.#codes.set(entry.code, {
      conversationId: entry.conversationId,
      expiresAt: entry.expiresAt,
    });
    this.#codeByConversation.set(entry.conversationId, entry.code);
  }

  /**
   * 该 chat_id 是否已处于枚举熔断（最近窗口内失败达到上限）。熔断期间调用方
   * 只回复简短失败提示，不再查码。
   */
  isBlocked(chatId: string): boolean {
    this.#pruneFailures(chatId);
    return (this.#failures.get(chatId)?.length ?? 0) >= MAX_BINDING_FAILURES_PER_WINDOW;
  }

  #newPayload(): string {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      let code = "";
      const bytes = randomBytes(6);
      for (let index = 0; index < 6; index += 1) {
        code += CODE_ALPHABET[bytes[index] % CODE_ALPHABET.length];
      }
      if (!this.#codes.has(`WST-${code}`)) return code;
    }
    // 32^6 组合下几乎不可达；防御性抛错避免死循环。
    throw new Error("Could not allocate a unique Lark binding code.");
  }

  #recordFailure(chatId: string): void {
    const now = this.now();
    const failures = this.#failures.get(chatId) ?? [];
    failures.push(now);
    this.#failures.set(
      chatId,
      failures.filter((time) => time > now - BINDING_FAILURE_WINDOW_MS),
    );
  }

  #pruneFailures(chatId: string): void {
    const now = this.now();
    const failures = this.#failures.get(chatId);
    if (failures === undefined) return;
    const pruned = failures.filter((time) => time > now - BINDING_FAILURE_WINDOW_MS);
    if (pruned.length === 0) this.#failures.delete(chatId);
    else this.#failures.set(chatId, pruned);
  }

  #sweep(): void {
    const now = this.now();
    for (const [code, entry] of [...this.#codes]) {
      if (entry.expiresAt <= now) {
        this.#codes.delete(code);
        if (this.#codeByConversation.get(entry.conversationId) === code) {
          this.#codeByConversation.delete(entry.conversationId);
        }
      }
    }
  }
}