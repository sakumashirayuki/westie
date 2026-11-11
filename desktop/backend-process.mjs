// 桌面后端进程的被控启动器：只负责路径与环境准备、spawn、日志、ready/exit
// 协调和退出等待。Electron 应用、窗口与配置入口在 main.mjs。
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseEnv } from "node:util";

export const START_TIMEOUT_MS = 30_000;
export const EXIT_TIMEOUT_MS = 20_000;
export const LOG_LIMIT_BYTES = 10 * 1024 * 1024;

const FALLBACK_PATH =
  "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
// 桌面宿主固定 HOST 与 PORT：端口由 startAgentServer({ port: 0 }) 指定，PORT 只
// 满足现有配置校验。数据库、CORS 由宿主写入或不写入，用户配置中的这四项一律忽略。
const FIXED_HOST = "127.0.0.1";
const FIXED_PORT = "3000";
const IGNORED_CONFIGURED_KEYS = [
  "HOST",
  "PORT",
  "AGENT_DATABASE_PATH",
  "CORS_ALLOW_ORIGIN",
];

/** runtime 根目录：开发模式来自 staging，安装版来自 Resources。 */
export function resolveRuntimeRoot({ isPackaged, resourcesPath }) {
  // 开发模式：resourcesPath 指向仓库内的 .desktop-runtime 目录。
  return isPackaged
    ? join(resourcesPath, "runtime")
    : join(resourcesPath, "dev-runtime");
}

/**
 * 构造后端子进程环境。优先级为继承环境 → 用户 .env → 桌面宿主固定值；
 * 用户配置与继承环境中的 HOST、PORT、AGENT_DATABASE_PATH、CORS_ALLOW_ORIGIN
 * 一律忽略。返回值供只读检查，不打印。
 */
export function buildBackendEnvironment({
  inheritedEnvironment = process.env,
  userConfigText = "",
  databasePath,
}) {
  const environment = { ...inheritedEnvironment };
  for (const key of IGNORED_CONFIGURED_KEYS) delete environment[key];

  const userConfig = parseEnv(userConfigText);
  for (const [key, value] of Object.entries(userConfig)) {
    if (IGNORED_CONFIGURED_KEYS.includes(key)) continue;
    environment[key] = value;
  }

  environment.HOST = FIXED_HOST;
  environment.PORT = FIXED_PORT;
  environment.AGENT_DATABASE_PATH = databasePath;
  delete environment.CORS_ALLOW_ORIGIN;
  environment.PATH = buildPath(environment.PATH, userConfig.PATH);
  return environment;
}

function buildPath(inheritedPath, configuredPath) {
  const entries = [
    ...(configuredPath ?? inheritedPath ?? "").split(":"),
    ...FALLBACK_PATH.split(":"),
  ].filter((entry) => entry.length > 0);
  return [...new Set(entries)].join(":");
}

/** 只接受本次后端自己上报的 loopback URL。 */
export function parseReadyUrl(value) {
  if (typeof value !== "string") return undefined;
  let url;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") return undefined;
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
  return url.origin;
}

/**
 * 启动后端并等待 ready。成功时返回 { url, stop, exited }：
 * stop() 幂等，发送 shutdown 后最多等待 EXIT_TIMEOUT_MS，超时强制终止并报告
 * 异常退出；exited 在子进程退出后以 { code, signal } 结束。任何启动失败都带
 * 日志路径抛出，由调用方展示原生错误对话框。
 */
export async function startBackend({
  runtimeRoot,
  environment,
  logPath,
  startTimeoutMs = START_TIMEOUT_MS,
  exitTimeoutMs = EXIT_TIMEOUT_MS,
}) {
  mkdirSync(dirname(logPath), { recursive: true });
  // 每次启动截断旧日志；达到上限后停止写入，但继续排空子进程输出。
  const logFd = openSync(logPath, "w");
  let written = 0;
  const writeLog = (chunk) => {
    if (written >= LOG_LIMIT_BYTES) return;
    const buffer = Buffer.from(chunk);
    const slice = buffer.length > LOG_LIMIT_BYTES - written
      ? buffer.subarray(0, LOG_LIMIT_BYTES - written)
      : buffer;
    try {
      writeSync(logFd, slice);
    } catch {
      // 日志写入失败不影响后端运行。
    }
    written += slice.length;
  };

  const child = spawn(
    join(runtimeRoot, "bin", "node"),
    [join(runtimeRoot, "desktop", "backend-entry.mjs")],
    {
      cwd: runtimeRoot,
      env: environment,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  child.stdout.on("data", writeLog);
  child.stderr.on("data", writeLog);

  let exitResult;
  const exited = new Promise((resolve) => {
    let settled = false;
    const closeLog = () => {
      try {
        closeSync(logFd);
      } catch {
        // 已经关闭过。
      }
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(exitResult);
    };
    child.once("exit", (code, signal) => {
      exitResult = { code, signal };
      finish();
    });
    child.once("error", (error) => {
      // 只有 spawn 失败时没有 pid，通常也没有 exit 事件；必须落定
      // exited，否则启动失败处理会无限等待。IPC/kill 错误仍走原有 exit 路径。
      if (child.pid !== undefined) return;
      exitResult ??= { code: null, signal: null, error };
      finish();
    });
    // 等标准输出和标准错误排空后再关闭日志文件。
    child.once("close", closeLog);
  });

  let readyUrl;
  try {
    readyUrl = await waitForReady(child, exited, startTimeoutMs);
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null && !exitResult?.error) {
      child.kill("SIGKILL");
    }
    await exited;
    throw new Error(`Backend failed to start: ${reasonMessage(error)} See ${logPath}.`);
  }

  const stop = createStop({
    child,
    exited,
    getExitResult: () => exitResult,
    exitTimeoutMs,
    logPath,
  });
  return {
    url: readyUrl,
    exited,
    stop,
    // 只用于测试模拟父进程退出；应用代码统一走 stop()。
    disconnect: () => child.disconnect(),
  };
}

function waitForReady(child, exited, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      settle(reject, new Error(`no ready message within ${timeoutMs}ms`));
    }, timeoutMs);

    child.on("message", (message) => {
      if (settled || message?.type !== "ready") return;
      const url = parseReadyUrl(message.url);
      if (url === undefined) {
        settle(reject, new Error("the ready message carried an invalid URL"));
        return;
      }
      settle(resolve, url);
    });
    child.once("error", (error) => settle(reject, error));
    void exited.then(({ code, signal }) => {
      settle(
        reject,
        new Error(
          signal === null
            ? `the process exited before ready (exit ${code})`
            : `the process exited before ready (signal ${signal})`,
        ),
      );
    });
  });
}

function createStop({ child, exited, getExitResult, exitTimeoutMs, logPath }) {
  // 只以 exit 事件结果判断是否退出：child.exitCode / signalCode 在早期可能读到
  // undefined，不能当成“已退出”，否则等待会提前落定、shutdown 消息发得太早。
  const hasExited = () => getExitResult() !== undefined;
  const waitForExit = (timeoutMs) => new Promise((resolve) => {
    const timer = setTimeout(() => resolve(hasExited()), timeoutMs);
    void exited.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  let stopping;
  return function stop() {
    stopping ??= (async () => {
      if (!hasExited()) {
        try {
          child.send({ type: "shutdown" });
        } catch (error) {
          throw new Error(
            `Could not ask the backend to shut down: ${reasonMessage(error)} See ${logPath}.`,
          );
        }
        // 超时不再等待业务清理：强制终止，已有 Run 恢复逻辑在下次启动补救。
        if (!await waitForExit(exitTimeoutMs)) {
          child.kill("SIGKILL");
          await exited;
          throw new Error(
            `Backend did not exit within ${exitTimeoutMs}ms after shutdown and was killed. See ${logPath}.`,
          );
        }
      }
      const result = getExitResult();
      if (result !== undefined && result.signal === null && result.code !== 0) {
        throw new Error(
          `Backend exited abnormally (exit ${result.code}). See ${logPath}.`,
        );
      }
    })();
    return stopping;
  };
}

function reasonMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
