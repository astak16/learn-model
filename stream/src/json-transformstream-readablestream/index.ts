import http from "http";
import { handleIndex, handleTs, setSSEHeaders, sleep } from "../utils";

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
type SSEPayload = StartPayload | DeltaPayload | StopPayload;
type SourceChunk =
  | { kind: "comment"; comment: string }
  | { kind: "event"; payload: SSEPayload | "[DONE]"; id?: number; event?: string };
type SSEMessage = { data: string; id?: number; event?: string };

function createSSEMessageStream(options: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  requestId: number;
  shouldFail: boolean;
  offset: number;
}): ReadableStream<SourceChunk> {
  const { req, res, requestId, shouldFail, offset } = options;
  const words: string[] = SAMPLE_TEXT.split("");
  const remaining: number = words.length - offset;
  const breakAt: number = offset + Math.floor(remaining / 3);
  let closed = false;
  let heartbeat: NodeJS.Timeout | undefined;

  req.on("close", () => {
    console.log(`[请求 #${requestId}] 客户端关闭连接`);
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
  });

  return new ReadableStream<SourceChunk>({
    start(controller) {
      heartbeat = setInterval(() => {
        if (!closed) controller.enqueue({ kind: "comment", comment: "heartbeat" });
      }, 15000);

      const run = async (): Promise<void> => {
        try {
          const startPayload: StartPayload = { type: "start", id: "msg_" + Date.now() };
          controller.enqueue({ kind: "event", payload: startPayload });

          for (let i: number = offset; i < words.length; i++) {
            if (closed) {
              controller.close();
              return;
            }

            if (shouldFail && i === breakAt) {
              console.log(`[请求 #${requestId}] 模拟故障，在位置 ${i} 强制断开`);
              closed = true;
              controller.error(new Error("Simulated SSE disconnect"));
              res.destroy();
              return;
            }

            const payload: DeltaPayload = { type: "delta", index: i, content: words[i] };
            controller.enqueue({ kind: "event", payload, id: i });
            await sleep(60);
          }

          if (!closed) {
            const stopPayload: StopPayload = { type: "stop", reason: "complete", totalTokens: words.length };
            controller.enqueue({ kind: "event", payload: stopPayload, id: words.length });
            controller.enqueue({ kind: "event", payload: "[DONE]", event: "done" });
            controller.close();
          }
        } catch (error) {
          if (!closed) controller.error(error);
        } finally {
          if (heartbeat) clearInterval(heartbeat);
        }
      };

      void run();
    },
    cancel() {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
    },
  });
}

function createSSEMessageTransformer(): TransformStream<SourceChunk, SSEMessage> {
  return new TransformStream<SourceChunk, SSEMessage>({
    transform(chunk, controller) {
      if (chunk.kind === "comment") {
        controller.enqueue({ data: chunk.comment, event: "comment" });
        return;
      }

      controller.enqueue({
        data: typeof chunk.payload === "string" ? chunk.payload : JSON.stringify(chunk.payload),
        id: chunk.id,
        event: chunk.event,
      });
    },
  });
}

function createSSEEncoder(): TransformStream<SSEMessage, string> {
  return new TransformStream<SSEMessage, string>({
    transform(message, controller) {
      if (message.event === "comment") {
        controller.enqueue(`: ${message.data}\n\n`);
        return;
      }

      let frame = "";
      if (message.id !== undefined) frame += `id: ${message.id}\n`;
      if (message.event) frame += `event: ${message.event}\n`;
      for (const line of message.data.split("\n")) {
        frame += `data: ${line}\n`;
      }
      frame += "\n";

      controller.enqueue(frame);
    },
  });
}

function createNodeResponseSink(res: http.ServerResponse): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({
    async write(chunk) {
      if (res.destroyed) return;
      if (res.write(chunk)) return;
      await new Promise<void>((resolve, reject) => {
        const onDrain = () => {
          cleanup();
          resolve();
        };
        const onError = (error: Error) => {
          cleanup();
          reject(error);
        };
        const onClose = () => {
          cleanup();
          resolve();
        };
        const cleanup = () => {
          res.off("drain", onDrain);
          res.off("error", onError);
          res.off("close", onClose);
        };

        res.once("drain", onDrain);
        res.once("error", onError);
        res.once("close", onClose);
      });
    },
    close() {
      if (!res.writableEnded && !res.destroyed) {
        res.end();
      }
    },
    abort() {
      if (!res.destroyed) {
        res.destroy();
      }
    },
  });
}

async function handleJsonStream(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  setSSEHeaders(res);

  requestCount++;
  const thisRequest: number = requestCount;
  const shouldFail: boolean = thisRequest <= FAIL_UNTIL;

  const lastId: string | undefined = req.headers["last-event-id"] as string | undefined;
  const parsedId: number = lastId !== undefined ? parseInt(lastId, 10) : -1;
  const offset: number = Number.isNaN(parsedId) ? 0 : parsedId + 1;

  console.log(`[请求 #${thisRequest}] Last-Event-ID=${lastId ?? "无"} offset=${offset} shouldFail=${shouldFail}`);

  try {
    await createSSEMessageStream({ req, res, requestId: thisRequest, shouldFail, offset })
      .pipeThrough(createSSEMessageTransformer())
      .pipeThrough(createSSEEncoder())
      .pipeThrough(new TextEncoderStream())
      .pipeTo(createNodeResponseSink(res));
  } catch (error) {
    if (!res.destroyed) {
      console.error(`[请求 #${thisRequest}] SSE 管道异常`, error);
      res.destroy();
    }
  }
}

const server: http.Server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
  const url: URL = new URL(req.url!, `http://${req.headers.host}`);

  if (url.pathname === "/stream/json" && req.method === "GET") {
    handleJsonStream(req, res);
  } else if (url.pathname === "/" && req.method === "GET") {
    requestCount = 0;
    handleIndex(req, res, "json-transformstream");
  } else if (url.pathname === "/main.ts" && req.method === "GET") {
    handleTs(req, res, "json-transformstream");
  } else {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  }
});

server.listen(PORT, () => {
  console.log(`服务已启动: http://localhost:${PORT}`);
});
