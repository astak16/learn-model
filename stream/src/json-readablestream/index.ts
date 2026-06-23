import http from "http";
import { handleIndex, handleTs, setSSEHeaders, sleep, writeSSE } from "../utils";

const PORT = 3000;

const SAMPLE_TEXT: string =
  "这是一个模拟流式响应的 demo。" +
  "每个字符会被当作一个 token，按一定间隔逐个发送给客户端，" +
  "用来模拟大模型 API（比如 OpenAI / Anthropic / MiniMax）返回 SSE 流的过程。";

let requestCount: number = 0;
const FAIL_UNTIL: number = 2;

type DeltaPayload = { type: "delta"; index: number; content: string };
type StartPayload = { type: "start"; id: string };
type StopPayload = { type: "stop"; reason: string; totalTokens: number };

async function handleJsonStream(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  setSSEHeaders(res);
  let closed: boolean = false;

  requestCount++;
  const thisRequest: number = requestCount;
  const shouldFail: boolean = thisRequest <= FAIL_UNTIL;

  const lastId: string | undefined = req.headers["last-event-id"] as string | undefined;
  const offset: number = lastId !== undefined ? parseInt(lastId, 10) + 1 : 0;

  console.log(`[请求 #${thisRequest}] Last-Event-ID=${lastId ?? "无"} offset=${offset} shouldFail=${shouldFail}`);

  req.on("close", () => {
    console.log(`[请求 #${thisRequest}] 客户端关闭连接`);
    closed = true;
  });

  const words: string[] = SAMPLE_TEXT.split("");
  const remaining: number = words.length - offset;
  const breakAt: number = offset + Math.floor(remaining / 3);

  const heartbeat: NodeJS.Timeout = setInterval(() => {
    if (!closed) res.write(": heartbeat\n\n");
  }, 15000);

  try {
    const startPayload: StartPayload = { type: "start", id: "msg_" + Date.now() };
    writeSSE(res, JSON.stringify(startPayload));

    for (let i: number = offset; i < words.length; i++) {
      if (closed) break;

      if (shouldFail && i === breakAt) {
        console.log(`[请求 #${thisRequest}] 模拟故障，在位置 ${i} 强制断开`);
        req.destroy();
        return;
      }

      const payload: DeltaPayload = { type: "delta", index: i, content: words[i] };
      writeSSE(res, JSON.stringify(payload), i);
      await sleep(60);
    }

    if (!closed) {
      const stopPayload: StopPayload = { type: "stop", reason: "complete", totalTokens: words.length };
      writeSSE(res, JSON.stringify(stopPayload), words.length);
      writeSSE(res, "[DONE]", undefined, "done");
      res.end();
    }
  } finally {
    clearInterval(heartbeat);
  }
}

const server: http.Server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
  const url: URL = new URL(req.url!, `http://${req.headers.host}`);

  if (url.pathname === "/stream/json" && req.method === "GET") {
    handleJsonStream(req, res);
  } else if (url.pathname === "/" && req.method === "GET") {
    requestCount = 0;
    handleIndex(req, res, "json-eventsource");
  } else if (url.pathname === "/main.ts" && req.method === "GET") {
    handleTs(req, res, "json-eventsource");
  } else {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  }
});

server.listen(PORT, () => {
  console.log(`服务已启动: http://localhost:${PORT}`);
});
