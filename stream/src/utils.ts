import { IncomingMessage, ServerResponse } from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import esbuild from "esbuild";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function handleTs(req: IncomingMessage, res: ServerResponse, dirname: string): Promise<void> {
  const filePath = path.join(`${__dirname}/${dirname}`, "main.ts");
  fs.readFile(filePath, "utf-8", async (err, src) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("文件未找到: " + err.message);
      return;
    }
    try {
      const { code } = await esbuild.transform(src, { loader: "ts" });
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
      res.end(code);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("TS 转译失败: " + (e as Error).message);
    }
  });
}

export function handleIndex(req: IncomingMessage, res: ServerResponse, dirname?: string): void {
  const filePath = path.join(`${__dirname}/${dirname}`, "index.html");
  fs.readFile(filePath, "utf-8", (err, html) => {
    if (err) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("读取首页文件失败: " + err.message);
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  });
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const writeSSE = (res: ServerResponse, data: unknown, id?: number, event?: string): void => {
  // id 字段是 SSE 协议内置的续传机制：
  // 浏览器断线重连时会自动在请求头带上 Last-Event-ID: <最后收到的 id>
  if (id !== undefined) {
    res.write(`id: ${id}\n`);
  }
  if (event) {
    res.write(`event: ${event}\n`);
  }
  const lines = String(data).split("\n");
  for (const line of lines) {
    res.write(`data: ${line}\n`);
  }
  res.write("\n");
};

export function setSSEHeaders(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();
}
