// 在 staging 目录准备桌面 runtime：固定版本独立 Node、后端生产依赖、
// 编译产物、原生 helper、页面和桌面入口。只复制明确列出的产物，
// 不包含仓库 .env、.data、测试产物和日志。开发与打包共用这一份脚本。
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

// 后端 Node 版本固定在此处，并通过官方发布清单校验下载文件的 SHA256。
const NODE_VERSION = "22.23.1";
const NODE_DIST_BASE = `https://nodejs.org/dist/v${NODE_VERSION}`;

const DESKTOP_ENV_TEMPLATE = `# westie 配置模板。首次启动会复制为用户目录下的 .env，填写后重启应用生效。
# HOST、PORT、AGENT_DATABASE_PATH、CORS_ALLOW_ORIGIN 由桌面宿主固定，这里不需要填写。

LLM_PROVIDER=deepseek
DEEPSEEK_API_KEY=your-deepseek-api-key
DEEPSEEK_MODEL=deepseek-v4-flash

TAVILY_API_KEY=your-tavily-api-key

AGENT_MODEL_CONTEXT_TOKENS=1048576
AGENT_MODEL_MAX_OUTPUT_TOKENS=32768

# 飞书单聊绑定桥接：同时填写 LARK_APP_ID 与 LARK_APP_SECRET 才会开启。
# 凭证来自飞书开放平台自建应用的「凭证与基础信息」页；同一凭证只能被一个
# Westie 进程使用。国际版域名用 https://open.larksuite.com，裸域名会自动补 https://。
# LARK_APP_ID=cli_xxx
# LARK_APP_SECRET=
# LARK_DOMAIN=https://open.feishu.cn
# LARK_ALLOWED_OPEN_IDS=

# 通过 nvm 等安装的命令需要把 bin 目录加到 PATH，MCP 也可以写绝对命令路径。
# PATH=/Users/you/.nvm/versions/node/v22.23.1/bin:$PATH
`;

const root = resolve(import.meta.dirname, "..");
const staging = join(root, ".desktop-runtime");
const runtime = join(staging, "dev-runtime");

const arch = { arm64: "arm64", x64: "x64" }[process.arch];
if (arch === undefined) {
  throw new Error(`Unsupported CPU architecture: ${process.arch}`);
}

requireBuildArtifacts();

rmSync(staging, { recursive: true, force: true });
mkdirSync(join(runtime, "bin"), { recursive: true });
mkdirSync(join(runtime, "desktop"), { recursive: true });

cpSync(join(root, "package.json"), join(runtime, "package.json"));
cpSync(join(root, "package-lock.json"), join(runtime, "package-lock.json"));
writeFileSync(join(runtime, ".env.example"), DESKTOP_ENV_TEMPLATE, { mode: 0o600 });

await downloadNode(arch);
installProductionDependencies();

cpSync(join(root, "dist/src"), join(runtime, "dist/src"), { recursive: true });
cpSync(join(root, "dist/native"), join(runtime, "dist/native"), { recursive: true });
cpSync(join(root, "web/dist"), join(runtime, "web/dist"), { recursive: true });
cpSync(join(root, "desktop/backend-entry.mjs"), join(runtime, "desktop", "backend-entry.mjs"));

console.log(`Desktop runtime prepared at ${runtime} (node v${NODE_VERSION}, ${arch}).`);

function requireBuildArtifacts() {
  for (const artifact of ["dist/src/server-bootstrap.js", "dist/native/process-containment-helper", "web/dist/index.html"]) {
    if (!existsSync(join(root, artifact))) {
      throw new Error(`Missing ${artifact}. Run \`npm run build\` first.`);
    }
  }
}

async function downloadNode(targetArch) {
  const tarball = `node-v${NODE_VERSION}-darwin-${targetArch}.tar.gz`;
  const cacheDirectory = join(root, ".desktop-cache", "node");
  const archive = join(cacheDirectory, tarball);
  const checksumPath = `${archive}.sha256`;
  let cached = false;
  if (existsSync(archive) && existsSync(checksumPath)) {
    const expected = readFileSync(checksumPath, "utf8").trim();
    const actual = createHash("sha256").update(readFileSync(archive)).digest("hex");
    cached = actual === expected;
  }

  if (cached) {
    console.log(`Using cached Node: ${tarball}`);
  } else {
    console.log(`Downloading Node: ${tarball}`);
    await cacheNodeArchive(tarball, archive, checksumPath);
  }

  execFileSync("/usr/bin/tar", ["-xzf", archive, "-C", staging], { stdio: "inherit" });
  const extracted = join(staging, `node-v${NODE_VERSION}-darwin-${targetArch}`, "bin", "node");
  cpSync(extracted, join(runtime, "bin", "node"));
  chmodSync(join(runtime, "bin", "node"), 0o755);
}

async function cacheNodeArchive(tarball, archive, checksumPath) {
  const response = await fetch(`${NODE_DIST_BASE}/SHASUMS256.txt`);
  if (!response.ok) {
    throw new Error(`Could not download SHASUMS256.txt (HTTP ${response.status}).`);
  }
  const expected = (await response.text())
    .split("\n")
    .find((line) => line.trim().endsWith(` ${tarball}`))
    ?.split(/\s+/)[0];
  if (expected === undefined) {
    throw new Error(`SHASUMS256.txt does not list ${tarball}.`);
  }

  const download = await fetch(`${NODE_DIST_BASE}/${tarball}`);
  if (!download.ok) {
    throw new Error(`Could not download ${tarball} (HTTP ${download.status}).`);
  }
  const contents = Buffer.from(await download.arrayBuffer());
  const actual = createHash("sha256").update(contents).digest("hex");
  if (actual !== expected) {
    throw new Error(`${tarball} checksum mismatch: ${actual} != ${expected}.`);
  }

  mkdirSync(join(root, ".desktop-cache", "node"), { recursive: true });
  writeFileSync(archive, contents);
  writeFileSync(checksumPath, `${expected}\n`);
}

// 在 staging 内按仓库锁文件安装生产依赖。
function installProductionDependencies() {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith("npm_")) delete environment[key];
  }
  execFileSync(
    "npm",
    ["ci", "--omit=dev", "--no-audit", "--no-fund", "--prefix", runtime],
    { cwd: runtime, stdio: "inherit", env: environment },
  );
}
