let abortController: AbortController | null = null;
const out = document.getElementById("out") as HTMLElement;
const statusEl = document.getElementById("status") as HTMLElement;

interface ToolCallDelta {
  index: number;
  id?: string;
  type?: "function";
  function?: { name?: string; arguments?: string };
}

interface Delta {
  role?: "assistant";
  content?: string | null;
  tool_calls?: ToolCallDelta[];
}

interface ChatCompletionChunk {
  id: string;
  created: number;
  model: string;
  object: "chat.completion.chunk";
  choices: [{ index: 0; delta: Delta; finish_reason: string | null }];
}

let retryCount: number = 0;
let stopped: boolean = false;
const MAX_RETRY: number = 3;

async function connectOpenAI(withTools: boolean): Promise<void> {
  stopAll();
  stopped = false;
  out.textContent = "";
  statusEl.textContent = "请求中: /v1/chat/completions";
  abortController = new AbortController();
  let lastEventId: string | null = null;
  while (!stopped) {
    const body = withTools
      ? {
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: "上海天气怎么样" }],
          tools: [{ type: "function", function: { name: "get_weather" } }],
        }
      : { model: "gpt-4o-mini", messages: [{ role: "user", content: "你好" }] };

    const headers = new Headers({ "Content-Type": "application/json" });
    if (lastEventId) {
      headers.set("Last-Event-ID", lastEventId);
    }

    const res = await fetch("/v1/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: abortController.signal,
    });

    statusEl.textContent = "已连接: /v1/chat/completions";

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let toolArgsBuffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";

        for (const part of parts) {
          let eventName = "message";
          let data = "";
          let id: string | null = null;

          for (const line of part.split("\n")) {
            if (line.startsWith("event:")) eventName = line.slice(6).trim();
            else if (line.startsWith("data:")) data += line.slice(5).trim();
            else if (line.startsWith("id:")) id = line.slice(3).trim();
          }
          if (id) lastEventId = id;

          if (eventName === "done" || data === "[DONE]") {
            statusEl.textContent += "，流接收完成 ✓";
            return; // 等价于 es.close()
          }

          const chunk = JSON.parse(data) as ChatCompletionChunk;
          const delta = chunk.choices?.[0]?.delta ?? {};
          const finishReason = chunk.choices?.[0]?.finish_reason;

          if (delta.content) {
            out.textContent += delta.content;
          }
          if (delta.tool_calls) {
            const tc = delta.tool_calls[0];
            if (tc.id) out.textContent += "[tool_call: " + tc.function?.name + "]\n";
            if (tc.function?.arguments) {
              toolArgsBuffer += tc.function.arguments;
              out.textContent = out.textContent.split("\narguments:")[0] + "\narguments: " + toolArgsBuffer;
            }
          }
          if (finishReason) {
            statusEl.textContent = "完成，finish_reason = " + finishReason;
          }
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      if (stopped) return;
      if (retryCount >= MAX_RETRY) {
        statusEl.textContent = `已重连 ${MAX_RETRY} 次，仍失败，放弃`;
        return;
      }
      retryCount++;
      statusEl.textContent = `连接断开，等待自动重连（第 ${retryCount} 次）...`;
      await new Promise((r) => setTimeout(r, 3000)); // 模拟 EventSource 默认 retry: 3000ms
    }
  }
}

function stopAll(): void {
  if (abortController) {
    abortController.abort();
    abortController = null;
    stopped = true;
  }
}

(document.getElementById("btn3") as HTMLButtonElement).onclick = () => connectOpenAI(false).catch(console.error);
(document.getElementById("btn4") as HTMLButtonElement).onclick = () => connectOpenAI(true).catch(console.error);
(document.getElementById("btnStop") as HTMLButtonElement).onclick = () => {
  stopAll();
  statusEl.textContent = "已手动断开";
};
