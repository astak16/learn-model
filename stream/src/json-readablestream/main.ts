(() => {
  type DeltaPayload = { type: "delta"; index: number; content: string };
  type StopPayload = { type: "stop"; reason: string; totalTokens: number };
  type StartPayload = { type: "start"; id: string };
  type SSEPayload = StartPayload | DeltaPayload | StopPayload;

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
        // retryCount = 0; // 连上了就清零

        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            const parts = buffer.split("\n\n");
            buffer = parts.pop()!;

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

              if (eventName === "done") {
                statusEl.textContent += "，流接收完成 ✓";
                return;
              }
              if (!data) continue;
              const obj = JSON.parse(data) as SSEPayload;
              if (obj.type === "delta") out.textContent += obj.content;
              if (obj.type === "stop") statusEl.textContent = "共 " + obj.totalTokens + " 个 token";
            }
          }
        } finally {
          reader.releaseLock();
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
        await new Promise((r) => setTimeout(r, 3000)); // 模拟 EventSource 默认 retry: 3000ms
      }
    }
  }

  (document.getElementById("btn2") as HTMLButtonElement).onclick = () => connectByFetch("/stream/json");
  (document.getElementById("btnStop") as HTMLButtonElement).onclick = () => {
    stopped = true;
    statusEl.textContent = "已手动断开";
  };
})();
