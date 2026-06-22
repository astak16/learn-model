(() => {
  let es: EventSource | null = null;
  let retryCount: number = 0;
  let stopped: boolean = false;
  const MAX_RETRY: number = 3;

  const out = document.getElementById("out") as HTMLDivElement;
  const statusEl = document.getElementById("status") as HTMLDivElement;

  function connect(url: string): void {
    stopped = false;
    retryCount = 0;
    out.textContent = "";
    statusEl.textContent = `连接中: ${url}`;

    // 直接 new EventSource，不做任何手动重连
    // 断线时浏览器会自动重连，并在请求头带上 Last-Event-ID（即最后收到的 id 字段值）
    // 后端读取 Last-Event-ID 就知道从哪里续传
    es = new EventSource(url);

    es.onopen = () => {
      if (retryCount === 0) {
        statusEl.textContent = `已连接: ${url}`;
      } else {
        statusEl.textContent = `第 ${retryCount} 次重连成功，自动续传 ✓`;
      }
    };

    es.addEventListener("message", (e: MessageEvent<string>) => {
      out.textContent += e.data;
    });

    es.addEventListener("done", () => {
      es?.close();
      es = null;
      statusEl.textContent = `流接收完成 ✓`;
    });

    es.onerror = () => {
      // 手动断开时 stopped=true，直接关掉不重连
      if (stopped) {
        es?.close();
        es = null;
        return;
      }

      // 达到重连上限时才关闭
      if (retryCount >= MAX_RETRY) {
        es?.close();
        es = null;
        statusEl.textContent = `已重连 ${MAX_RETRY} 次，仍失败，放弃`;
        return;
      }

      // 其余情况：什么都不做，让浏览器自己重连
      // EventSource 内置重连会自动带上 Last-Event-ID header
      retryCount++;
      statusEl.textContent = `连接断开，等待浏览器自动重连（第 ${retryCount} 次）...`;
    };
  }

  (document.getElementById("btn1") as HTMLButtonElement).onclick = () => connect("/stream");

  (document.getElementById("btnStop") as HTMLButtonElement).onclick = () => {
    stopped = true;
    if (es) {
      es.close();
      es = null;
    }
    statusEl.textContent = "已手动断开";
  };
})();
