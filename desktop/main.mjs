// Electron 主进程：应用身份、单实例、窗口、用户配置入口和错误提示。
// 后端启停与日志在 backend-process.mjs；主进程不运行 Agent，也不打开数据库。
import { app, BrowserWindow, dialog, Menu, shell } from "electron";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildBackendEnvironment,
  resolveRuntimeRoot,
  startBackend,
} from "./backend-process.mjs";

const APP_NAME = "westie";
const ENV_TEMPLATE = `# westie 配置。填写后重启应用生效。
# HOST、PORT、AGENT_DATABASE_PATH、CORS_ALLOW_ORIGIN 由桌面宿主固定，这里不需要填写。

LLM_PROVIDER=deepseek
DEEPSEEK_API_KEY=
DEEPSEEK_MODEL=deepseek-v4-flash
TAVILY_API_KEY=

AGENT_MODEL_CONTEXT_TOKENS=1048576
AGENT_MODEL_MAX_OUTPUT_TOKENS=32768

# 飞书单聊绑定桥接：同时填写 LARK_APP_ID 与 LARK_APP_SECRET 才会开启。
# 凭证来自飞书开放平台自建应用的「凭证与基础信息」页；同一凭证只能被一个
# Westie 进程使用。
# LARK_APP_ID=cli_xxx
# LARK_APP_SECRET=
# 可选：逗号分隔的 open_id 白名单；留空表示不限制。
# LARK_ALLOWED_OPEN_IDS=

# 通过 nvm 等安装的命令需要把 bin 目录加到 PATH。
# PATH=/Users/you/.nvm/versions/node/v22.23.1/bin:$PATH
`;

app.setName(APP_NAME);

const userDataDirectory = app.getPath("userData");
const configPath = join(userDataDirectory, ".env");
const logPath = join(userDataDirectory, "logs", "backend.log");

/** @type {{ url: string, stop: () => Promise<void>, exited: Promise<{code: number | null, signal: string | null}> } | undefined} */
let backend;
/** @type {BrowserWindow | undefined} */
let mainWindow;
let quitting = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow === undefined) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", (event) => {
    if (backend === undefined) return;
    event.preventDefault();
    void shutdownAndExit();
  });
  // 首期关闭最后一个窗口即退出应用与后端，不保留后台常驻。
  void app.whenReady().then(start);
}

async function start() {
  if (!app.isPackaged && process.platform === "darwin") {
    app.dock.setIcon(join(app.getAppPath(), "build", "icon.png"));
  }
  try {
    ensureUserConfig();
    installMenu();
    const runtimeRoot = resolveRuntimeRoot({
      isPackaged: app.isPackaged,
      resourcesPath: app.isPackaged
        ? process.resourcesPath
        : join(app.getAppPath(), ".desktop-runtime"),
    });
    backend = await startBackend({
      runtimeRoot,
      environment: buildBackendEnvironment({
        inheritedEnvironment: process.env,
        userConfigText: readFileSync(configPath, "utf8"),
        databasePath: join(userDataDirectory, "agent-harness.sqlite"),
      }),
      logPath,
    });
  } catch (error) {
    await showStartupFailure(error);
    return;
  }
  createWindow(backend.url);
  void backend.exited.then(({ code, signal }) => {
    if (quitting) return;
    quitting = true;
    mainWindow?.destroy();
    dialog.showErrorBox(
      "westie 后端已退出",
      `后端进程意外结束（${signal ?? `exit ${code}`}）。日志：${logPath}`,
    );
    app.exit(1);
  });
}

function ensureUserConfig() {
  if (existsSync(configPath)) {
    chmodSync(configPath, 0o600);
    return;
  }
  writeFileSync(join(userDataDirectory, ".env.example"), ENV_TEMPLATE, { mode: 0o600 });
  writeFileSync(configPath, ENV_TEMPLATE, { mode: 0o600 });
  dialog.showMessageBoxSync({
    type: "info",
    message: "首次启动需要先填写配置",
    detail: `已生成配置模板：${configPath}\n填写模型与 API Key 后重启应用。`,
    buttons: ["打开配置目录", "退出"],
    defaultId: 0,
  });
  shell.showItemInFolder(configPath);
  throw new StartupCancelled("First launch needs configuration.");
}

function installMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: "appMenu" },
    {
      label: "配置",
      submenu: [
        {
          label: "打开配置目录",
          click: () => shell.showItemInFolder(configPath),
        },
        {
          label: "打开后端日志",
          click: () => shell.openPath(logPath),
        },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
  ]));
}

function createWindow(backendUrl) {
  const allowedOrigin = new URL(backendUrl).origin;
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: "westie",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin === allowedOrigin) return;
    event.preventDefault();
    openExternal(url);
  });
  mainWindow.on("closed", () => {
    mainWindow = undefined;
  });
  void mainWindow.loadURL(backendUrl);
}

function openExternal(candidate) {
  let url;
  try {
    url = new URL(candidate);
  } catch {
    return;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return;
  void shell.openExternal(url.href);
}

async function shutdownAndExit() {
  if (quitting) return;
  quitting = true;
  try {
    await backend?.stop();
  } catch (error) {
    dialog.showErrorBox(
      "westie 退出时出错",
      `${error instanceof Error ? error.message : String(error)}\n日志：${logPath}`,
    );
    app.exit(1);
    return;
  }
  backend = undefined;
  app.quit();
}

async function showStartupFailure(error) {
  if (error instanceof StartupCancelled) {
    quitting = true;
    app.quit();
    return;
  }
  quitting = true;
  dialog.showErrorBox(
    "westie 启动失败",
    `${error instanceof Error ? error.message : String(error)}\n日志：${logPath}\n配置：${configPath}`,
  );
  app.exit(1);
}

class StartupCancelled extends Error {}
