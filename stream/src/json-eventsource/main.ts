(() => {
  type DeltaPayload = { type: "delta"; index: number; content: string };
  type StopPayload = { type: "stop"; reason: string; totalTokens: number };
  type StartPayload = { type: "start"; id: string };
  type SSEPayload = StartPayload | DeltaPayload | StopPayload;

  let es: EventSource | null = null;
  let retryCount: number = 0;
  let stopped: boolean = false;
  const MAX_RETRY: number = 3;
  const out = document.getElementById("out") as HTMLElement;
  const statusEl = document.getElementById("status") as HTMLElement;

  function connect(url: string): void {
    stopped = false;
    out.textContent = "";
    statusEl.textContent = "连接中: " + url;

    es = new EventSource(url);

    es.onopen = () => {
      if (retryCount === 0) {
        statusEl.textContent = "已连接: " + url;
      } else {
        statusEl.textContent = `第 ${retryCount} 次重连成功，自动续传 ✓`;
      }
    };

    es.onmessage = (e: MessageEvent<string>) => {
      const obj = JSON.parse(e.data) as SSEPayload;
      if (obj.type === "delta") out.textContent += obj.content;
      if (obj.type === "stop") statusEl.textContent = "完成，共 " + obj.totalTokens + " 个 token";
    };

    es.addEventListener("done", () => {
      es!.close();
      es = null;
      statusEl.textContent = "流接收完成 ✓";
    });

    es.onerror = () => {
      if (stopped) {
        es?.close();
        es = null;
        return;
      }

      if (retryCount >= MAX_RETRY) {
        es?.close();
        es = null;
        statusEl.textContent = `已重连 ${MAX_RETRY} 次，仍失败，放弃`;
        return;
      }

      retryCount++;
      statusEl.textContent = `连接断开，等待浏览器自动重连（第 ${retryCount} 次）...`;
    };
  }

  (document.getElementById("btn2") as HTMLButtonElement).onclick = () => connect("/stream/json");
  (document.getElementById("btnStop") as HTMLButtonElement).onclick = () => {
    stopped = true;
    if (es) {
      es.close();
      es = null;
    }
    statusEl.textContent = "已手动断开";
  };
})();
