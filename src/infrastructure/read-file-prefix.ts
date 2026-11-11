import type { FileHandle } from "node:fs/promises";

/** 从文件开头读取至多 requestedBytes 字节；文件句柄由调用方关闭。 */
export async function readFilePrefix(
  file: FileHandle,
  requestedBytes: number,
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(requestedBytes);
  let bytesRead = 0;
  while (bytesRead < buffer.length) {
    const chunk = await file.read(
      buffer,
      bytesRead,
      buffer.length - bytesRead,
      bytesRead,
    );
    if (chunk.bytesRead === 0) break;
    bytesRead += chunk.bytesRead;
  }
  return buffer.subarray(0, bytesRead);
}
