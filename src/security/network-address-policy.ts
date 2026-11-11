import { isIP } from "node:net";

// 地址检查策略：workspace_sandbox 下 web_fetch 只允许公开地址。这里的判断
// 作用于 dns.lookup({ all: true }) 的解析结果，与 fetch 实际连接用的解析结果
// 是两次查询，存在 DNS rebinding 窗口（见 docs/runtime-boundaries.md）。

const LINK_LOCAL_PREFIX = "169.254.";

export function isBlockedAddress(ip: string): boolean {
  if (ip === "") return true;

  // IPv4 映射的 IPv6 地址（::ffff:a.b.c.d）按被映射的 IPv4 判断。
  const mappedIpv4 = ipv4MappedToIpv4(ip);
  if (mappedIpv4 !== undefined) return isBlockedAddress(mappedIpv4);

  const family = isIP(ip);
  if (family === 4) return isBlockedIpv4(ip);
  if (family === 6) return isBlockedIpv6(ip.toLowerCase());

  // 无法识别的地址一律拒绝，fail closed。
  return true;
}

export function isBlockedHostname(host: string): boolean {
  const lower = host.toLowerCase();
  if (lower === "" || lower === "0.0.0.0" || lower === "::" ||
    lower.startsWith("0.")) {
    return true;
  }
  if (lower === "localhost" || lower.endsWith(".localhost")) return true;
  if (lower.endsWith(".local")) return true;
  // 文字形式的 IP 直接按地址判断。
  const family = isIP(lower);
  if (family === 4 || family === 6) return isBlockedAddress(lower);
  return false;
}

function isBlockedIpv4(ip: string): boolean {
  if (ip === "0.0.0.0") return true;
  const [a, b] = ip.split(".").map((part) => Number(part)) as [number, number];
  // 回环 127.0.0.0/8。
  if (a === 127) return true;
  // 私网 RFC 1918：10/8、172.16/12、192.168/16。
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  // 链路本地 169.254/16。
  if (ip.startsWith(LINK_LOCAL_PREFIX)) return true;
  return false;
}

function isBlockedIpv6(ip: string): boolean {
  // 未指定 ::
  if (ip === "::") return true;
  // 回环 ::1
  if (ip === "::1") return true;
  // 链路本地 fe80::/10
  if (ip.startsWith("fe8") || ip.startsWith("fe9") || ip.startsWith("fea") ||
    ip.startsWith("feb")) {
    return true;
  }
  // IPv6 ULA fc00::/7
  if (ip.startsWith("fc") || ip.startsWith("fd")) return true;
  return false;
}

function ipv4MappedToIpv4(ip: string): string | undefined {
  const lower = ip.toLowerCase();
  if (!lower.startsWith("::ffff:")) return undefined;
  const rest = lower.slice("::ffff:".length);
  if (rest.includes(".")) {
    const parts = rest.split(".");
    return parts.length === 4 ? rest : undefined;
  }
  if (/^[0-9a-f]{8}$/.test(rest)) {
    return [
      parseInt(rest.slice(0, 2), 16).toString(),
      parseInt(rest.slice(2, 4), 16).toString(),
      parseInt(rest.slice(4, 6), 16).toString(),
      parseInt(rest.slice(6, 8), 16).toString(),
    ].join(".");
  }
  return undefined;
}
