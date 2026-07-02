在之前的文章中，我们用 `fetch + ReadableStream` 手写了一个可以断线重连、自动续传的 `SSE` 客户端。代码能跑，但有一个隐患：流的读取、解码、分帧、解析全部堆在同一个 `for await` 循环里，职责混杂

这篇文章的目标是用 `TransformStream` 把它拆开，让每一步都做且只做一件事

客户端解析核心逻辑：

```ts
const decoder = new TextDecoder();
let buffer = "";

for await (const value of readableStreamToAsyncIterable(res.body!)) {
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
      /* 结束 */ return;
    }
    if (!data) continue;
    const obj = JSON.parse(data) as SSEPayload;
    // 处理业务逻辑...
  }
}
```

这段代码同时承担了四件事：

1. 解码：`TextDecoder.decode()` 把 `Uint8Array` 变成字符串
2. 分帧：按 `\n\n` 切割，把字节流变成一条条 `SSE` 帧
3. 解析：把每帧的 `event:` / `data:` / `id:` 行提取出来
4. 消费：处理 `SSEPayload`，更新 UI

这样写逻辑都在一起，一旦逻辑变复杂，这里代码会迅速膨胀

`Web Streams API` 提供了三种基础对象，`TransformStream` 是其中之一，另外两个是 `ReadableStream` 和 `WritableStream`

它同时拥有一个可写端（`writable`）和一个可读端（`readable`）：数据写进去，经过转换，从另一端读出来

```
WritableStream  →  [transform logic]  →  ReadableStream
    writable                                 readable
```

构造时传入一个 `Transformer` 对象，关键方法只有两个：

```ts
new TransformStream<Input, Output>({
  transform(chunk: Input, controller) {
    // 把 chunk 转换后推出去
    controller.enqueue(someOutput);
    // 也可以什么都不推（过滤）
    // 也可以推多个（拆分）
  },
  flush(controller) {
    // 上游关闭时调用，处理末尾残留
  },
});
```

最重要的特性：`TransformStream` 可以链接成管道

```ts
source
  .pipeThrough(new TextDecoderStream()) // Uint8Array → string
  .pipeThrough(new SSEFrameStream()) // string → string（帧）
  .pipeThrough(new SSEEventParser()); // string → SSEEvent
```

`pipeThrough` 返回的仍是 `ReadableStream`，可以继续链下去。链的末端用 `pipeTo(writableStream)` 收尾，返回 `Promise<void>`，整条管道跑完就 `resolve`

## 服务端 TransformStream

服务端的职责是把业务数据转成合规的 `SSE` 帧，写进 `http.ServerResponse`。旧版本用手动拼字符串、手动调用 `res.write()`，新版本把这条链拆成四段

```ts
await createSSEMessageStream({ req, res, requestId, shouldFail, offset })
  .pipeThrough(createSSEMessageTransformer()) // SourceChunk → SSEMessage
  .pipeThrough(createSSEEncoder()) // SSEMessage → string（SSE 帧文本）
  .pipeThrough(new TextEncoderStream()) // string → Uint8Array
  .pipeTo(createNodeResponseSink(res)); // 写入 ServerResponse
```

### createSSEMessageStream

`createSSEMessageStream` 是业务数据源

这是整条管道的起点，返回一个 `ReadableStream<SourceChunk>`。它用 `new ReadableStream({ start(controller) { ... } })` 构造，在 start 里异步推数据：

```ts
type SourceChunk =
  | { kind: "comment"; comment: string }
  | { kind: "event"; payload: SSEPayload | "[DONE]"; id?: number; event?: string };
```

心跳注释、业务 `payload`、终止信号 `[DONE]`，全部以类型安全的 `SourceChunk` 推出去，不掺任何 `SSE` 格式细节

值得注意的是 `cancel` 钩子：

```ts
cancel() {
  closed = true;
  if (heartbeat) clearInterval(heartbeat);
}
```

当下游管道被取消（比如客户端断开），`cancel` 会自动被调用，心跳定时器得以清理。这是管道机制自动传播取消信号的体现，旧版本需要手动监听 `req.on("close")` 来处理

### createSSEMessageTransformer

把 `SourceChunk` 转成统一的 `SSEMessage`：

```ts
type SSEMessage = { data: string; id?: number; event?: string };

function createSSEMessageTransformer(): TransformStream<SourceChunk, SSEMessage> {
  return new TransformStream({
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
```

### createSSEEncoder

把 `SSEMessage` 转成符合 `SSE` 规范的文本帧：

```ts
function createSSEEncoder(): TransformStream<SSEMessage, string> {
  return new TransformStream({
    transform(message, controller) {
      if (message.event === "comment") {
        controller.enqueue(`: ${message.data}\n\n`);
        return;
      }
      let frame = "";
      if (message.id !== undefined) frame += `id: ${message.id}\n`;
      if (message.event) frame += `event: ${message.event}\n`;
      for (const line of message.data.split("\n")) {
        frame += `data: ${line}\n`; // 多行 data 每行单独一个 data: 前缀
      }
      frame += "\n";
      controller.enqueue(frame);
    },
  });
}
```

注意多行 `data` 的处理：`SSE` 协议要求每行单独加 `data: 前缀`，`split("\n")` 后逐行拼接

### TextEncoderStream + createNodeResponseSink

`TextEncoderStream` 是浏览器和 `Node.js 18+` 内置的，把 `string` 转成 `Uint8Array`，直接复用即可。

`createNodeResponseSink` 是整条管道的终点，把字节块写进 `http.ServerResponse`

```ts
function createNodeResponseSink(res: http.ServerResponse): WritableStream<Uint8Array> {
  return new WritableStream({
    async write(chunk) {
      if (res.destroyed) return;
      if (res.write(chunk)) return; // write 返回 true 表示缓冲区未满，直接继续
      await new Promise<void>((resolve, reject) => {
        res.once("drain", resolve); // 缓冲区满了，等 drain 再继续
        res.once("error", reject);
        res.once("close", resolve);
      });
    },
    close() {
      if (!res.writableEnded && !res.destroyed) res.end();
    },
    abort() {
      if (!res.destroyed) res.destroy();
    },
  });
}
```

这里的 `drain` 处理是背压的关键：`Node.js` 的 `res.write()` 返回 `false` 时表示内核 `TCP` 缓冲区已满，`await drain` 让管道暂停写入，等缓冲区腾出空间再继续。这正是 `WritableStream` 背压机制的用武之地—— `write` 返回 `Promise` 时，上游会自动暂停推数据

## 客户端 TransformStream

客户端的职责是把收到的字节流还原成业务对象。和服务端正好相反的方向

```ts
const eventStream: ReadableStream<ParsedSSEMessage> = res
  .body!.pipeThrough(new TextDecoderStream()) // Uint8Array → string
  .pipeThrough(makeSSEFrameTransformer()) // string → SSE 帧字符串
  .pipeThrough(makeSSEEventParser()) // SSE 帧 → SSEEvent 对象
  .pipeThrough(makeSSEPayloadParser()); // SSEEvent → ParsedSSEMessage

for await (const { eventName, id, payload } of eventStream) {
  // 只剩业务逻辑
}
```

### TextDecoderStream

`TextDecoderStream` 直接复用，把 `Uint8Array` 转成 `string`，无需手写

### makeSSEFrameTransformer —— 按 \n\n 切帧

`makeSSEFrameTransformer` 按 `\n\n` 切帧

```ts
function makeSSEFrameTransformer(): TransformStream<string, string> {
  let buffer = "";
  return new TransformStream({
    transform(chunk, controller) {
      buffer += chunk.replace(/\r\n/g, "\n"); // 兼容 CRLF
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? ""; // 末尾不完整的帧留到下次
      for (const part of parts) {
        if (part !== "") controller.enqueue(part);
      }
    },
    flush(controller) {
      if (buffer !== "") controller.enqueue(buffer); // 流结束时处理残留
    },
  });
}
```

`flush` 是容易漏掉的地方：如果服务端最后一帧没有以 `\n\n` 结尾就关闭了连接，`buffer` 里的内容会在 `flush` 里被补发出去，而不是无声丢弃

### makeSSEEventParser

`makeSSEEventParser` —— 解析字段

多行 `data` 用数组收集再 `join("\n")`，和服务端 `createSSEEncoder` 里的 `split("\n")` 形成对称

```ts
function makeSSEEventParser(): TransformStream<string, SSEEvent> {
  return new TransformStream({
    transform(frame, controller) {
      let eventName = "message";
      let id: string | null = null;
      const dataLines: string[] = [];

      for (const line of frame.split("\n")) {
        if (line.startsWith(":")) continue; // 注释行忽略
        if (line.startsWith("event:")) eventName = line.slice(6).replace(/^ /, "");
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
        else if (line.startsWith("id:")) id = line.slice(3).replace(/^ /, "");
      }

      controller.enqueue({ eventName, data: dataLines.join("\n"), id });
    },
  });
}
```

### makeSSEPayloadParser

`makeSSEPayloadParser` —— 反序列化为业务对象

`JSON.parse` 在这里发生，和服务端的 `JSON.stringify` 对称。`done` 事件没有 `payload`，单独处理后直接透传，让消费端能感知到流结束

```ts
function makeSSEPayloadParser(): TransformStream<SSEEvent, ParsedSSEMessage> {
  return new TransformStream({
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
```

### for await 与 AsyncIterable polyfill

管道末端 `eventStream` 是 `ReadableStream<ParsedSSEMessage>`，但浏览器里 `ReadableStream` 不原生支持 `for await`（`Node.js 18+` 才支持）

打上这个 `polyfill` 之后，`pipeThrough` 返回的任何 `ReadableStream` 都可以直接 `for await`，不需要再手动 `getReader()`

```ts
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
```

## TextEncoder

`TextEncoderStream` 是一个内置的 `TransformStream<string, Uint8Array>`——输入端进字符串，输出端出 `UTF-8` 编码后的字节(`Uint8Array`)。

> `TextDecoderStream` 正好和其相反

可以理解成"流式版"的 `new TextEncoder().encode(str)`，但是按 `chunk` 一段一段处理，而不是一次性给你一个完整字符串

`TextEncoderStream` 即使分多次 `write()`，它内部会先缓存住、不立刻输出，等后面 `write()` 写回来之后，才合并编码成正确的的字符串

## 端到端数据流

服务端的 `createSSEEncoder` 负责拼 `SSE` 格式，客户端的 `makeSSEEventParser` 负责拆 `SSE` 格式——两者互为镜像

```
服务端
  createSSEMessageStream         → SourceChunk
  createSSEMessageTransformer    → SSEMessage
  createSSEEncoder               → string（"id: 3\ndata: {...}\n\n"）
  TextEncoderStream              → Uint8Array
  createNodeResponseSink         → http.ServerResponse → 网络

                    ──── HTTP/SSE ────▶

客户端
  res.body                       → Uint8Array
  TextDecoderStream              → string
  makeSSEFrameTransformer        → string（"id: 3\ndata: {...}"）
  makeSSEEventParser             → SSEEvent
  makeSSEPayloadParser           → ParsedSSEMessage
  for await                      → 业务逻辑
```

## 管道带来的三个额外收益

1. 背压自动传播
   - 服务端 `createNodeResponseSink` 的 `write` 返回 `Promise` 时，整条管道自动暂停——`createSSEMessageStream` 里的 `await sleep(60)` 不会继续推数据。不需要手动协调生产速度和写入速度
2. 取消信号自动传播
   - 客户端断开连接时，`createNodeResponseSink` 的 `abort` 被调用，取消信号沿管道向上传播，最终触发 `createSSEMessageStream` 的 `cancel`，心跳定时器自动清理。`pipeTo` 返回的 `Promise` 也随之 `reject`，被外层 `catch` 捕获
3. 每段独立可测
   - `createSSEEncoder` 可以单独测试：给它喂一个 `SSEMessage`，验证输出的字符串格式是否正确。`makeSSEFrameTransformer` 可以单独测试：给它喂跨块的碎片数据，验证 `buffer` 拼接和 `flush` 是否正确。不需要启动完整服务才能验证某一段逻辑
