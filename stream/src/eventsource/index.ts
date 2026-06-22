import http, { IncomingMessage, ServerResponse } from "http";
import { handleIndex, handleTs, setSSEHeaders, sleep, writeSSE } from "../utils";

const SAMPLE_TEXT =
  "这是一个模拟流式响应的 demo。" +
  "每个字符会被当作一个 token，按一定间隔逐个发送给客户端，" +
  "用来模拟大模型 API（比如 OpenAI / Anthropic / MiniMax）返回 SSE 流的过程。";

let requestCount = 0;
const FAIL_UNTIL = 2;

const handleTextStream = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
  setSSEHeaders(res);
  let close = false;

  requestCount++;
  const thisRequest = requestCount;
  const shouldFail = thisRequest <= FAIL_UNTIL;

  // 读取浏览器自动携带的 Last-Event-ID，得到续传起点
  const lastId = req.headers["last-event-id"] as string | undefined;
  const offset = lastId !== undefined ? parseInt(lastId, 10) + 1 : 0;

  console.log(`[请求 #${thisRequest}] Last-Event-ID=${lastId ?? "无"} offset=${offset} shouldFail=${shouldFail}`);

  req.on("close", () => {
    console.log(`[请求 #${thisRequest}] 客户端关闭连接`);
    close = true;
  });

  const chars = Array.from(SAMPLE_TEXT);
  // 故障点：在本次剩余内容的 1/3 处断开
  const remaining = chars.length - offset;
  const breakAt = offset + Math.floor(remaining / 3);

  const heartbeat = setInterval(() => {
    if (!close) res.write(": heartbeat\n\n");
  }, 15000);

  try {
    for (let i = offset; i < chars.length; i++) {
      if (close) break;

      if (shouldFail && i === breakAt) {
        console.log(`[请求 #${thisRequest}] 模拟故障，在位置 ${i} 强制断开`);
        res.destroy();
        return;
      }

      // 每条消息都带上当前索引作为 id
      writeSSE(res, chars[i], i);
      await sleep(60);
    }

    if (!close) {
      writeSSE(res, "[DONE]", undefined, "done");
      res.end();
    }
  } finally {
    clearInterval(heartbeat);
  }
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  if (url.pathname === "/stream" && req.method === "GET") {
    handleTextStream(req, res);
  } else if (url.pathname === "/" && req.method === "GET") {
    requestCount = 0;
    handleIndex(req, res, "eventsource");
  } else if (url.pathname === "/main.ts" && req.method === "GET") {
    handleTs(req, res, "eventsource");
  } else {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  }
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`服务已启动: http://localhost:${PORT}`);
});
