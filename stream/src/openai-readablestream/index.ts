import http from "http";
import type { IncomingMessage, ServerResponse } from "http";
import { handleIndex, handleTs, setSSEHeaders, sleep } from "../utils";

const PORT = 3000;

const SAMPLE_TEXT =
  "这是一个模拟流式响应的 demo。" +
  "每个字符会被当作一个 token，按一定间隔逐个发送给客户端，" +
  "用来模拟大模型 API（比如 OpenAI / Anthropic / MiniMax）返回 SSE 流的过程。";

interface ToolCall {
  index: number;
  id?: string;
  type?: "function";
  function: { name?: string; arguments: string };
}

interface Delta {
  index?: number;
  role?: "assistant";
  content?: string | null;
  tool_calls?: ToolCall[];
}

interface ChunkData {
  id: string;
  created: number;
  model: string;
  delta: Delta;
}

interface ChatCompletionChunk {
  id: string;
  created: number;
  model: string;
  object: "chat.completion.chunk";
  choices: [{ index: 0; delta: Delta; finish_reason: string | null }];
}

function randomId(prefix: string): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let s = "";
  for (let i = 0; i < 24; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return `${prefix}-${s}`;
}

function sendChunk(res: http.ServerResponse, data: ChunkData, finishReason: string | null = null): void {
  if (data.delta.index !== undefined) res.write(`id: ${data.delta.index}\n`);
  const chunk: ChatCompletionChunk = {
    id: data.id,
    created: data.created,
    model: data.model,
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: data.delta, finish_reason: finishReason }],
  };
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

let requestCount = 0;
const FAIL_UNTIL = 2;

async function handleOpenAIChatCompletions(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  let body = "";
  req.on("data", (chunk: Buffer) => (body += chunk));

  await new Promise<void>((resolve) => req.on("end", resolve));

  let parsed: { model?: string; tools?: unknown[] } = {};
  try {
    parsed = body ? JSON.parse(body) : {};
  } catch {
    // 请求体非 JSON 时忽略，走默认分支
  }

  const model = parsed.model ?? "gpt-4o-mini";
  const hasTools = Array.isArray(parsed.tools) && parsed.tools.length > 0;
  const id = randomId("chatcmpl");
  const created = Math.floor(Date.now() / 1000);
  let closed = false;

  setSSEHeaders(res);
  requestCount++;
  const thisRequest = requestCount;
  const shouldFail = thisRequest <= FAIL_UNTIL;

  // 读取浏览器自动携带的 Last-Event-ID，得到续传起点
  const lastId = req.headers["last-event-id"] as string | undefined;
  const offset = lastId !== undefined ? parseInt(lastId, 10) + 1 : 0;

  console.log(`[请求 #${thisRequest}] Last-Event-ID=${lastId ?? "无"} offset=${offset} shouldFail=${shouldFail}`);

  req.on("close", () => {
    console.log(`[请求 #${thisRequest}] 客户端关闭连接`);
    closed = true;
  });

  try {
    if (hasTools) {
      // ---- 分支 A：模拟一次 tool_calls 流式输出 ----
      sendChunk(res, {
        id,
        created,
        model,
        delta: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              index: 0,
              id: randomId("call"),
              type: "function",
              function: { name: "get_weather", arguments: "" },
            },
          ],
        },
      });
      await sleep(150);

      const argsJson = JSON.stringify({ location: "上海", unit: "celsius" });
      const argChunks = argsJson.match(/.{1,4}/g) ?? [];
      for (const piece of argChunks) {
        if (closed) break;
        sendChunk(res, {
          id,
          created,
          model,
          delta: { tool_calls: [{ index: 0, function: { arguments: piece } }] },
        });
        await sleep(80);
      }

      if (!closed) {
        sendChunk(res, { id, created, model, delta: {} }, "tool_calls");
      }
    } else {
      // ---- 分支 B：普通文本流式输出 ----
      sendChunk(res, { id, created, model, delta: { role: "assistant", content: "" } });
      await sleep(100);

      const chars = Array.from(SAMPLE_TEXT);
      const remaining = chars.length - offset;
      const breakAt = offset + Math.floor(remaining / 3);

      for (let i = offset; i < chars.length; i++) {
        if (closed) break;
        if (shouldFail && i === breakAt) {
          console.log(`[请求 #${thisRequest}] 模拟故障，在位置 ${i} 强制断开`);
          res.destroy();
          return;
        }
        sendChunk(res, { id, created, model, delta: { index: i, content: chars[i] } });
        await sleep(50);
      }

      if (!closed) {
        sendChunk(res, { id, created, model, delta: {} }, "stop");
      }
    }

    if (!closed) {
      // res.write("event: done\ndata: [DONE]\n\n");
      res.write("data: [DONE]\n\n");
      res.end();
    }
  } catch (err) {
    if (!closed) {
      res.write(`data: ${JSON.stringify({ error: { message: String(err) } })}\n\n`);
      res.end();
    }
  }
}

const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
    handleOpenAIChatCompletions(req, res);
  } else if (url.pathname === "/" && req.method === "GET") {
    handleIndex(req, res, "openai-readablestream");
  } else if (url.pathname === "/main.ts" && req.method === "GET") {
    handleTs(req, res, "openai-readablestream");
  } else {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  }
});

server.listen(PORT, () => {
  console.log(`服务已启动: http://localhost:${PORT}`);
});
