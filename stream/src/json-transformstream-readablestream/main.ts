(() => {
  type DeltaPayload = { type: "delta"; index: number; content: string };
  type StopPayload = { type: "stop"; reason: string; totalTokens: number };
  type StartPayload = { type: "start"; id: string };
  type SSEPayload = StartPayload | DeltaPayload | StopPayload;

  type SSEEvent = {
    eventName: string;
    data: string;
    id: string | null;
  };
  type ParsedSSEMessage = {
    eventName: string;
    id: string | null;
    payload: SSEPayload | null;
  };

  /** TransformStream 1：string（块）→ SSE 帧字符串（按 \n\n 切分） */
  function makeSSEFrameTransformer(): TransformStream<string, string> {
    let buffer = "";
    return new TransformStream<string, string>({
      transform(chunk, controller) {
        // 统一换行，兼容服务端使用 CRLF 发送 SSE
        buffer += chunk.replace(/\r\n/g, "\n");
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? ""; // 末尾不完整的帧留在 buffer
        for (const part of parts) {
          if (part !== "") controller.enqueue(part);
        }
      },
      flush(controller) {
        // 流结束时处理残留帧
        if (buffer !== "") controller.enqueue(buffer);
      },
    });
  }

  /** TransformStream 2：SSE 帧字符串 → 解析后的 SSEEvent 对象 */
  function makeSSEEventParser(): TransformStream<string, SSEEvent> {
    return new TransformStream<string, SSEEvent>({
      transform(frame, controller) {
        let eventName = "message";
        let id: string | null = null;
        const dataLines: string[] = [];

        for (const line of frame.split("\n")) {
          if (line.startsWith(":")) continue;
          if (line.startsWith("event:")) eventName = line.slice(6).replace(/^ /, "");
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
          else if (line.startsWith("id:")) id = line.slice(3).replace(/^ /, "");
        }

        controller.enqueue({ eventName, data: dataLines.join("\n"), id });
      },
    });
  }

  /** TransformStream 3：SSEEvent 对象 → 业务 payload */
  function makeSSEPayloadParser(): TransformStream<SSEEvent, ParsedSSEMessage> {
    return new TransformStream<SSEEvent, ParsedSSEMessage>({
      transform(event, controller) {
        if (event.eventName === "done") {
          controller.enqueue({ eventName: event.eventName, id: event.id, payload: null });
          return;
        }
        if (!event.data) return;

        controller.enqueue({
          eventName: event.eventName,
          id: event.id,
          payload: JSON.parse(event.data) as SSEPayload,
        });
      },
    });
  }

  let retryCount: number = 0;
  let stopped: boolean = false;
  const MAX_RETRY: number = 3;
  const out = document.getElementById("out") as HTMLElement;
  const statusEl = document.getElementById("status") as HTMLElement;

  async function connectByFetch(url: string): Promise<void> {
    stopped = false;
    out.textContent = "";
    statusEl.textContent = "连接中: " + url;

    let lastEventId: string | null = null;

    while (!stopped) {
      try {
        const res = await fetch(url, {
          headers: lastEventId ? { "Last-Event-ID": lastEventId } : {},
        });
        statusEl.textContent = retryCount === 0 ? "已连接: " + url : `第 ${retryCount} 次重连成功，自动续传 ✓`;

        // 构造 pipeline：字节流 → 文本块 → SSE 帧 → SSEEvent → 业务 payload
        const eventStream: ReadableStream<ParsedSSEMessage> = res
          .body!.pipeThrough(new TextDecoderStream())
          .pipeThrough(makeSSEFrameTransformer())
          .pipeThrough(makeSSEEventParser())
          .pipeThrough(makeSSEPayloadParser());

        for await (const { eventName, id, payload } of eventStream) {
          if (id) lastEventId = id;

          if (eventName === "done") {
            statusEl.textContent += "，流接收完成 ✓";
            return;
          }
          if (!payload) continue;

          if (payload.type === "delta") out.textContent += payload.content;
          if (payload.type === "stop") statusEl.textContent = "共 " + payload.totalTokens + " 个 token";
        }

        // reader 正常 done（服务端正常关闭连接），不算错误，跳出重连循环
        return;
      } catch (err) {
        if (stopped) return;
        if (retryCount >= MAX_RETRY) {
          statusEl.textContent = `已重连 ${MAX_RETRY} 次，仍失败，放弃`;
          return;
        }
        retryCount++;
        statusEl.textContent = `连接断开，等待自动重连（第 ${retryCount} 次）...`;
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  (document.getElementById("btn2") as HTMLButtonElement).onclick = () => connectByFetch("/stream/json");
  (document.getElementById("btnStop") as HTMLButtonElement).onclick = () => {
    stopped = true;
    statusEl.textContent = "已手动断开";
  };
})();

// ReadableStream 的 for-await 兼容适配（浏览器中 ReadableStream 未实现 Symbol.asyncIterator）
// pipeThrough 返回的流同样需要这个 polyfill
if (!ReadableStream.prototype[Symbol.asyncIterator]) {
  (ReadableStream.prototype as any)[Symbol.asyncIterator] = async function* () {
    const reader = this.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        yield value;
      }
    } finally {
      reader.releaseLock();
    }
  };
}
