## ReadableStream

`EventSource` 默认只支持 `GET` 请求，当需要使用 `POST` 请求时，需要用 `fetch` 改写

`fetch` 改写核心逻辑

### 1. 外层死循环与指数重连机制

代码的核心是一个 `while (!stopped)` 的死循环。这个循环是用来模拟浏览器原生 `EventSource` 的自动重连特性。

只要没有手动停止 `(stopped = false)` 且没有完美接收完数据 `(return)`，一旦 `try` 块中的代码因为网络中断抛出异常，就会被 `catch` 捕获。客户端会等待 `3s`，然后发起下一次 `while` 循环，重新调用 `fetch`

```ts
while (!stopped) {
  try {
    const res = await fetch(url, { ... });
    // ... 读取数据 ...
    return; // 如果服务端正常结束（done），直接 return 退出循环
  } catch (err) {
    // 如果中途报错（网络断开、服务器崩溃等），进入这里
    if (retryCount >= MAX_RETRY) return; // 超过最大重连次数，放弃
    retryCount++;
    await new Promise((r) => setTimeout(r, 3000)); // 等待 3 秒后，继续下一次 while 循环尝试重连
  }
}
```

### 2. 基于 `Last-Event-ID` 的断点续传

在解析数据的过程中，只要发现某条消息带有 `id:（例如 id: 15）`，客户端就会更新本地的 `lastEventId = "15"`。

当网络断开触发下一次 `while` 循环重连时，`fetch` 就会在请求头里带上 `Last-Event-ID: 15`。服务端收到后，就会从第 `16` 个 `token` 开始继续发送，实现了无缝续传

```ts
let lastEventId: string | null = null;
// ... 在 fetch 的 headers 中：
headers: lastEventId ? { "Last-Event-ID": lastEventId } : {},
```

### 3. 流式读取与文本解码（Reader + Decoder）

普通的 `fetch` 默认会等待所有数据下载完。而要实现流式，代码使用了 `res.body!.getReader()`

内部的 `while(true)` 循环在持续监听网络。每当服务器用 `res.write()` 发送一点数据，`await reader.read()` 就会被唤醒并拿到一个 `value（Uint8Array 二进制数组）`。由于大模型的字符可能被网络切碎（比如一个复杂的汉字占 `3` 字节，可能分两次传输），所以必须用 `TextDecoder({ stream: true })` 来确保拼装时不会出现乱码

```ts
const reader = res.body!.getReader();
const decoder = new TextDecoder();
let buffer = "";

while (true) {
  const { done, value } = await reader.read(); // 每次只读取网络层刚到达的一小块二进制数据（Chunk）
  if (done) break;
  buffer += decoder.decode(value, { stream: true }); // 将二进制原始字节转化为文本字符串，并追加到缓冲区
  // ... 解析缓冲区 ...
}
```

### 4. 缓冲区文本切片与协议解析

这是整段代码最考验逻辑的地方

网络传输是流式的，这意味着前后端传输的边界是不确定的。比如后端发了两次 `data: A\n\n`，前端收到的块可能是 `data: A\n\ndata: A\n\n`。

为了准确还原出每条消息，代码采用了 `缓冲区（buffer）` 机制：

```ts
const parts = buffer.split("\n\n"); // 1. 用标准的 SSE 结束符 \n\n 切割字符串
buffer = parts.pop()!; // 2. 关键：把切出来的最后一部分拿出来放回缓冲区
```

为什么要 `pop()`？因为最后一部分可能只是半条消息（比如 `data: 正在输`，还没有遇到 `\n\n`）。把它留到下一次 `reader.read()` 拼接完整后，再在下一次循环中处理。

解析单条消息：对于那些已经完整的 `parts`，代码会按行 `（\n）` 进一步拆解，提取出 `event`、`data` 和 `id`：

```ts
for (const line of part.split("\n")) {
  if (line.startsWith("event:")) eventName = line.slice(6).trim();
  else if (line.startsWith("data:")) data += line.slice(5).trim();
  else if (line.startsWith("id:")) id = line.slice(3).trim();
}
```

### 5. 业务状态处理

解析出完整的 `eventName` 和 `data` 后，客户端根据不同的响应状态渲染页面：

```ts
if (eventName === "done") {
  statusEl.textContent += "，流接收完成 ✓";
  return; // 正常结束，跳出所有循环
}

const obj = JSON.parse(data) as SSEPayload;
if (obj.type === "delta") {
  out.textContent += obj.content; // 大模型逐字吐出文本，直接追加到页面上
}
if (obj.type === "stop") {
  statusEl.textContent = "共 " + obj.totalTokens + " 个 token"; // 收到结束信号，展示统计信息
}
```
