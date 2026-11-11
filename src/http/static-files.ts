import { readFile, realpath, stat } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";

export async function serveStaticFile(
  response: ServerResponse,
  pathname: string,
  staticDirectory: string,
): Promise<boolean> {
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return false;
  }

  if (decodedPath.includes("\0")) return false;

  const root = resolve(staticDirectory);
  const requestedPath = resolve(
    root,
    `.${decodedPath === "/" ? "/index.html" : decodedPath}`,
  );
  if (!isWithinDirectory(root, requestedPath)) return false;

  try {
    const [realRoot, realFile] = await Promise.all([
      realpath(root),
      realpath(requestedPath),
    ]);
    if (!isWithinDirectory(realRoot, realFile)) return false;
    if (!(await stat(realFile)).isFile()) return false;

    const body = await readFile(realFile);
    response.writeHead(200, {
      "Content-Type": contentTypeFor(realFile),
      "Content-Length": body.byteLength,
    });
    response.end(body);
    return true;
  } catch {
    return false;
  }
}

export function serveSpaEntry(
  response: ServerResponse,
  staticDirectory: string,
): Promise<boolean> {
  return serveStaticFile(response, "/", staticDirectory);
}

function isWithinDirectory(directory: string, candidate: string): boolean {
  const pathFromDirectory = relative(directory, candidate);
  return pathFromDirectory === "" || (
    pathFromDirectory !== ".." &&
    !pathFromDirectory.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromDirectory)
  );
}

function contentTypeFor(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".txt":
      return "text/plain; charset=utf-8";
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
    case ".json":
    case ".map":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".avif":
      return "image/avif";
    case ".gif":
      return "image/gif";
    case ".ico":
      return "image/x-icon";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    case ".wasm":
      return "application/wasm";
    default:
      return "application/octet-stream";
  }
}
