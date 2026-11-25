import { closeSync, openSync, writeSync } from "node:fs";
import {
  mkdir,
  open,
  rm,
} from "node:fs/promises";
import path from "node:path";

export const SERVICE_LOG_LIMIT_BYTES = 10 * 1024 * 1024;

export interface ServiceArtifactsLayout {
  readonly root: string;
  readonly canaryDirectory: string;
  readonly allowedCanaryPath: string;
  readonly deniedCanaryPath: string;
  readonly homeDirectory: string;
  readonly tmpDirectory: string;
  readonly logPath: string;
}

/**
 * 每个 service 独占的 artifacts 目录：canary、临时 HOME/TMPDIR 与合并日志。
 * 日志按 append 写入，达到 10 MiB 后停止写盘但继续供调用方排空管道，并把
 * `truncated` 置为 true。
 */
export class ServiceArtifacts {
  readonly layout: ServiceArtifactsLayout;
  #fd: number | undefined;
  #totalBytes = 0;
  #truncated = false;

  private constructor(layout: ServiceArtifactsLayout) {
    this.layout = layout;
  }

  static async create(root: string): Promise<ServiceArtifacts> {
    const canaryDirectory = path.join(root, "canary");
    const homeDirectory = path.join(root, "home");
    const tmpDirectory = path.join(root, "tmp");
    const logPath = path.join(root, "service.log");
    await mkdir(canaryDirectory, { recursive: true });
    await mkdir(homeDirectory, { recursive: true });
    await mkdir(tmpDirectory, { recursive: true });
    await open(logPath, "wx").then((handle) => handle.close());

    const artifacts = new ServiceArtifacts({
      root,
      canaryDirectory,
      allowedCanaryPath: path.join(canaryDirectory, "allowed.canary"),
      deniedCanaryPath: path.join(canaryDirectory, "denied.canary"),
      homeDirectory,
      tmpDirectory,
      logPath,
    });
    artifacts.#fd = openSync(logPath, "a");
    return artifacts;
  }

  get truncated(): boolean {
    return this.#truncated;
  }

  get byteLength(): number {
    return this.#totalBytes;
  }

  append(chunk: Buffer): void {
    if (this.#truncated || this.#fd === undefined) return;
    const remaining = SERVICE_LOG_LIMIT_BYTES - this.#totalBytes;
    if (remaining <= 0) {
      this.#truncated = true;
      return;
    }
    const slice = chunk.subarray(0, remaining);
    writeSync(this.#fd, slice);
    this.#totalBytes += slice.byteLength;
    if (slice.byteLength < chunk.byteLength) this.#truncated = true;
  }

  async readTail(maxBytes: number): Promise<string> {
    const handle = await open(this.layout.logPath, "r");
    try {
      const stats = await handle.stat();
      const size = stats.size;
      const length = Math.min(size, maxBytes);
      if (length <= 0) return "";
      const start = size - length;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, start);
      return buffer.toString("utf8");
    } finally {
      await handle.close();
    }
  }

  async captureFinalTail(maxBytes: number): Promise<string> {
    try {
      return await this.readTail(maxBytes);
    } catch {
      return "";
    }
  }

  async remove(): Promise<void> {
    if (this.#fd !== undefined) {
      try {
        closeSync(this.#fd);
      } catch {
        // 已关闭或写入失败都不影响目录清理。
      }
      this.#fd = undefined;
    }
    await rm(this.layout.root, { recursive: true, force: true });
  }
}
