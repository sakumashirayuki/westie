import { SHELL_METACHARACTERS } from "./protocol.js";

// 会话级权限授权的最小作用域模型。纯函数与类型，bash 工具本身不参与判定。
export type ToolGrantScope =
  | { readonly kind: "tool" }
  | { readonly kind: "command_prefix"; readonly value: string };

// 首词在这些名单内时只提供「允许一次」，不提供命令前缀，避免一次把整个
// shell 授出去。
const WRAPPER_FIRST_WORDS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "sudo",
  "doas",
  "env",
  "eval",
  "exec",
  "xargs",
  "nohup",
  "ssh",
]);

const BARE_WORD = /^[A-Za-z0-9._@:/+-]+$/;

// 候选前缀按「更具体的在前」排序；tool 作用域始终兜底。
export function deriveGrantOptions(
  toolName: string,
  input: unknown,
): readonly ToolGrantScope[] {
  // 完成检查每次执行前都要单独批准；审批卡片只有“允许一次”，不提供会话级授权。
  if (toolName === "stop_hook") return [];
  if (toolName !== "bash" || !isRecord(input) || typeof input.command !== "string") {
    return [{ kind: "tool" }];
  }
  // 前缀候选只从简单命令派生。含元字符的命令永不命中前缀授权，为它提供
  // 前缀选项会让审批卡片显示的作用域与实际执行的命令不一致。
  if (!isSimpleCommand(input.command)) return [{ kind: "tool" }];
  const tokens = tokenize(input.command);
  if (tokens === undefined) return [{ kind: "tool" }];
  const [first = "", second] = tokens;
  if (
    !BARE_WORD.test(first) ||
    WRAPPER_FIRST_WORDS.has(first)
  ) {
    return [{ kind: "tool" }];
  }
  const options: ToolGrantScope[] = [];
  if (
    tokens.length >= 2 &&
    second !== undefined &&
    BARE_WORD.test(second) &&
    !second.startsWith("-")
  ) {
    options.push({ kind: "command_prefix", value: `${first} ${second}` });
  }
  options.push({ kind: "command_prefix", value: first });
  options.push({ kind: "tool" });
  return options;
}

export function matchesGrant(
  scope: ToolGrantScope,
  toolName: string,
  input: unknown,
): boolean {
  if (toolName !== "bash" || !isRecord(input) || typeof input.command !== "string") {
    return scope.kind === "tool";
  }
  if (scope.kind === "tool") return true;
  return matchesCommandPrefix(scope.value, input.command);
}

function matchesCommandPrefix(prefix: string, command: string): boolean {
  if (!isSimpleCommand(command)) return false;
  const tokens = tokenize(command);
  if (tokens === undefined || tokens.length === 0) return false;
  const prefixTokens = tokenize(prefix);
  if (prefixTokens === undefined || prefixTokens.length === 0) return false;
  if (prefixTokens.length > tokens.length) return false;
  return prefixTokens.every((token, index) => token === tokens[index]);
}

// 简单命令：不含能引入另一个被执行程序的元字符。
function isSimpleCommand(command: string): boolean {
  if (command === "") return false;
  return !SHELL_METACHARACTERS.some((meta) => command.includes(meta));
}

function tokenize(command: string): readonly string[] | undefined {
  if (command === "") return undefined;
  const tokens = command.trim().split(/\s+/);
  if (tokens.some((token) => token === "")) return undefined;
  return tokens;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
