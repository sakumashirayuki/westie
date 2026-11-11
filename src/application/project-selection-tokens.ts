/**
 * 新建会话时由目录选择器签发的短期选择令牌。
 *
 * 令牌把「用户刚刚在系统选择器里确认过哪个目录」这件事带回服务端：后续读取
 * 分支、worktree 和创建会话都只使用令牌绑定的 canonical 路径，客户端无法用
 * 任意路径换取宿主文件访问。令牌只保存在内存里，重启或过期后需要重新选择。
 */
import { randomBytes } from "node:crypto";

import type { GitCheckoutState } from "./git-project-service.js";

export interface ProjectSelection {
  /** 选择器返回并 realpath 后的精确路径。 */
  readonly selectedPath: string;
  readonly checkout: GitCheckoutState | null;
}

interface StoredSelection extends ProjectSelection {
  readonly expiresAt: number;
}

export class SelectionTokenStore {
  readonly #selections = new Map<string, StoredSelection>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  issue(selection: ProjectSelection): string {
    this.#sweep();
    const token = randomBytes(24).toString("base64url");
    this.#selections.set(token, {
      ...selection,
      expiresAt: this.now() + this.ttlMs,
    });
    return token;
  }

  /** 读取令牌绑定的选择；不存在或已过期时返回 undefined。 */
  get(token: string): ProjectSelection | undefined {
    const stored = this.#selections.get(token);
    if (stored === undefined) return undefined;
    if (stored.expiresAt <= this.now()) {
      this.#selections.delete(token);
      return undefined;
    }
    return { selectedPath: stored.selectedPath, checkout: stored.checkout };
  }

  /** 创建会话成功后消费令牌，避免同一选择被重复使用。 */
  consume(token: string): void {
    this.#selections.delete(token);
  }

  #sweep(): void {
    const now = this.now();
    for (const [token, stored] of this.#selections) {
      if (stored.expiresAt <= now) this.#selections.delete(token);
    }
  }
}
