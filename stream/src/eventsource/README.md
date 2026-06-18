## 流式响应

`SSE` 允许服务端在建立连接后，像流水一样源源不断地像客户端发送请求，直到数据传输完全主动关闭

实现流式的基本步骤是：

- 服务端
  - 声明这是一个流（设置特殊的 `HTTP` 响应头）
  - 分批次写入数据（使用 `res.write()`）
  - 结束传输（调用 `res.end()`）
- 客户端
  - `EventSource`
    - `es.onopen = () => {}`：链接建立会触发
    - `es.onmessage = () => {}`：推送数据会触发
    - `es.onerror = () => {}`：`res.destroy()` 会触发
    - `es.close()` 关闭连接

### 服务端

要让浏览器知道“这不是一个普通的网页，而是一个持续的数据流”，必须设置特定的 `header`，如下

```ts
function setSSEHeaders(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // 给 nginx 用的
  });
  res.flushHeaders?.();
}
```

`SSE` 的数据格式,必须以 `键: 值\n` 的形式发送，并且每条消息以两个换行符 `\n\n` 结尾

- 发送数据：`data: 某个字\n\n`
- 发送自定义事件：`event: done\ndata: [DONE]\n\n`
- 发送消息 `ID`：`id: 12\ndata: 某个字\n\n`

代码如下所示

```ts
const writeSSE = (res: ServerResponse, data: unknown, id?: number, event?: string): void => {
  // id 字段是 SSE 协议内置的续传机制：
  // 浏览器断线重连时会自动在请求头带上 Last-Event-ID: <最后收到的 id>
  if (id !== undefined) {
    res.write(`id: ${id}\n`);
  }
  if (event) {
    res.write(`event: ${event}\n`);
  }
  const lines = String(data).split("\n");
  for (const line of lines) {
    res.write(`data: ${line}\n`);
  }
  res.write("\n");
};
```

在 `SSE` 规范里，`:` 开头的行是注释，专门用来当心跳的，浏览器的 `EventSource` 解析器会在协议层直接跳过它，不会触发 `onmessage`，也不会出现在 `Network` 面板 `EventStream` 视图里的消息列表中，

```js
const heartbeat = setInterval(() => {
  if (!close) res.write(": heartbeat\n\n");
}, 1500);
```

几个事件流说明：

- `id: 1\n\n`：可以用来做断点续传，客户端 `EventSource` 内置重连会自动带上 `Last-Event-ID` 的 `header`
- `data: 今天\n\n`：正常发送数据，默认是 `message` 事件，也可以写成 `event: message\ndata: 今天\n\n`，会触发客户端 `onmessage` 事件
- `event: done\ndata: [DONE]\n\n`：自定义事件，客户端可以使用 `addEventListener("done")` 监听
- `: heartbeat\n\n`：心跳监测，浏览器默认不解析，用 `curl` 可以看到

### 客户端

在客户端接收这种 `text/event-stream` 格式的数据，最标准、最优雅的做法是使用浏览器自带的 `EventSource API`

`EventSource` 默认只支持 `GET`

```js
const contentDiv = document.getElementById("content");

// 1. 初始化 EventSource，指向后端的 /stream 接口
const eventSource = new EventSource("/stream");

// 2. 监听默认事件（后端通过 writeSSE 发送的普通数据）
eventSource.onmessage = (event) => {
  // event.data 就是后端发送的单个字符
  contentDiv.textContent += event.data;
};

// 3. 监听自定义事件（后端最后发送的 event: done）
eventSource.addEventListener("done", (event) => {
  console.log("接收完毕，主动关闭连接");
  contentDiv.textContent += "\n【传输结束】";
  eventSource.close(); // 主动关闭连接，防止它再次重连
});

// 4. 监听错误（包括断线）
eventSource.onerror = (error) => {
  console.log("连接发生错误或断开，浏览器会自动尝试重连...", error);
};
```

断点续传

1. 第一次尝试：前端连接 `/stream`，收到第 `1` 到第 `15` 个字。
2. 连接被切断：后端执行了 `res.destroy()`。前端触发 `onerror` 事件。
3. 自动重连：此时浏览器在底层会自动重新发起请求。
4. 带上序号：因为第 `15` 个字带了 `id: 15`，浏览器重连时，会自动在 `HTTP` 请求头上加上：
   ```
   Last-Event-ID: 15
   ```
5. 完美续接：后端收到这个 `ID`，计算出 `offset`，从第 `16` 个字继续发送。
6. 用户无感知：在用户的网页上，字会继续往后蹦，根本感觉不到中间网络断开过！
