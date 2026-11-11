import { createServer, type ViteDevServer } from "vite";
import { describe, expect, it } from "vitest";
import { createServer as createHttpServer, type Server } from "node:http";
import viteConfig from "./vite.config";

describe("Vite development proxy", () => {
  it("preserves Host and Origin for /v1 requests", async () => {
    let upstream: Server | undefined;
    let vite: ViteDevServer | undefined;

    try {
      const upstreamRequest = new Promise<{ host?: string; origin?: string }>(
        (resolve) => {
          upstream = createHttpServer((request, response) => {
            resolve({ host: request.headers.host, origin: request.headers.origin });
            response.writeHead(200);
            response.end("ok");
          });
        },
      );
      await new Promise<void>((resolve) => upstream?.listen(0, "127.0.0.1", resolve));
      const upstreamAddress = upstream.address();
      if (!upstreamAddress || typeof upstreamAddress === "string") {
        throw new Error("Failed to start upstream server");
      }

      const proxy = viteConfig.server?.proxy?.["/v1"];
      if (!proxy || typeof proxy === "string") {
        throw new Error("Expected /v1 proxy object configuration");
      }
      vite = await createServer({
        configFile: false,
        server: {
          host: "127.0.0.1",
          port: 0,
          proxy: {
            "/v1": { ...proxy, target: `http://127.0.0.1:${upstreamAddress.port}` },
          },
        },
      });
      await vite.listen();
      const viteAddress = vite.httpServer?.address();
      if (!viteAddress || typeof viteAddress === "string") {
        throw new Error("Failed to start Vite server");
      }

      const host = `127.0.0.1:${viteAddress.port}`;
      const origin = `http://${host}`;
      const response = await fetch(`http://${host}/v1/test`, {
        headers: { Host: host, Origin: origin },
      });
      expect(response.status).toBe(200);
      await response.text();
      await expect(upstreamRequest).resolves.toEqual({ host, origin });
    } finally {
      await vite?.close();
      await new Promise<void>((resolve) => upstream?.close(() => resolve()));
    }
  });
});
