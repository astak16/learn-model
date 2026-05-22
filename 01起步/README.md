现在市面上的 Agent 教程太多了，要么太浅要么太碎。

之前一直关注的博主三元同学最近出了[Super Agent 实践课](https://sitor.ai/courses?ref=38F54SVU)，这门课从「底层实现级」角度拆解真实产品的工程决策，帮你建立完整的 Agent 知识体系，覆盖六大方向。

这门课学习下来让我对 Agent 有了全面的认知，下面是我的学习笔记

**往期学习笔记**

### 吃透 AI Agent 开发

1. [系统认知 Agent 六大支柱](https://juejin.cn/post/7637502462330224678)
2. [Agent循环原理](https://juejin.cn/post/7641544730451738658)
3. [大模型底层机制与Agent开发](https://juejin.cn/post/7642176685400735778)

在开发 ai 应用时，我们需要频繁调试前端交互与接口逻辑，如果在开发阶段都真实调用大模型的 api，不仅费时，费钱，网络延迟还会降低开发效率

通过深入 Vercel AI SDK 底层协议，我们可以非常轻松地手写一个简易的 Mock Model，它完全不依赖网络请求，却能完美的欺骗 Vercel AI SDK，在本地提供一个一模一样的单次生成(`generateText`)和流式响应(`streamText`)体验

## 介绍 Vercel AI SDK

Vercel AI SDK 是目前最火热的 AI 框架之一，它的核心设计理念是「统一接口」

无论是 OpenAI，Anthropic，还是国内的模型，在 AI SDK 看来都是一个实现了特定接口的 LanguageModel 对象

当我们调用 generateText 和 streamText 时，SDK 底层实际上实在调用该模型的 doGenerate 和 doStream 方法

这意味着只要我们按照 Vercel AI SDK 要求的格式返回数据，就可以自定义任何模型行为了

## 写一个 Mock Model

要实现 Mock Model，需要具备简单的「理解」能力：能够根据用户的输入，返回对应的硬编码文本

首先，要定义好几处的响应库匹配逻辑，它会遍历对话历史，根据用户发送的最新一条消息来决定返回什么：

```ts
const RESPONSES: Record<string, string> = {
  default:
    "你好！我是模拟模型。虽然我没有真正调用 API，但我能根据你的输入返回预设的文本，来模拟真实的对话体验 :)",
  greeting: "你好！虽然是模拟的，但流式输出的效果和真实 API 一致 :)",
  name: '你刚才告诉我了呀！我能"记住"是因为代码把对话历史传给了我。',
  intro: "我是大模型（模拟版），在本地模拟回复，机制和真实 API 完全一致。",
};
```

使用 pickResponse 函数来根据用户输入选择合适的响应：

```ts
function pickResponse(
  prompt: DoGenerateOptions["prompt"] | DoStreamOptions["prompt"],
): string {
  const userMsgs = (prompt || []).filter((m) => m.role === "user");
  const last = userMsgs[userMsgs.length - 1];
  const text = (last?.content || [])
    .map((c) => ("text" in c ? c.text : ""))
    .join("")
    .toLowerCase();
  if (text.includes("介绍你自己") || text.includes("你是谁"))
    return RESPONSES.intro;
  if (text.includes("你好") || text.includes("hello"))
    return RESPONSES.greeting;
  if (text.includes("叫什么") || text.includes("记住")) return RESPONSES.name;
  return RESPONSES.default;
}
```

模拟 `token` 消化

```ts
const USAGE: DoGenerateResult["usage"] = {
  inputTokens: 10,
  outputTokens: 20,
  totalTokens: 30,
};
```

接下来，我们构建符合 Vercel AI SDK 规范（v2 版本）的模型骨架：

```ts
export function createMockModel(): LanguageModel{
  return {
    specificationVersion: "v2" as const,
    provider: "mock",
    modelId: "mock-model",
    get supportedUrls() {
      return Promise.resolve({});
    },

    // 待实现...
    async doGenerate({ prompt }: DoGenerateOptions) { ... },
    async doStream({ prompt }: DoStreamOptions) { ... }
  };
}
```

### 实现 generateText

单次生成的实现非常直接

当你在上层调用 `generateText` 时，SDK 会调用模型的 `doGenerate` 方法，我们只需要返回一个符合规范的对象即可：

- 文本内容
- 结束原因
- token 使用统计
- 警告信息（如果有）

```ts
async doGenerate({ prompt }: DoGenerateOptions) {
  return {
    content: [{ type: "text", text: pickResponse(prompt) }],
    finishReason: "stop",
    usage: USAGE,
    warnings: [],
  };
}
```

### 实现 streamText

流式输出的原理要稍微复杂一些

SDK 的 `doStream` 方法需要返回一个包含 `stream` 属性的对象

而这个 `stream` 必须符合**标准网络流格式**的数据源

为了模拟打字机效果，我们需要将一整句话拆成单个字符，并以 AI SDK 定义的「数据库(chunk)」格式有序的发送出去

```ts
async doStream({ prompt }: DoStreamOptions) {
  const text = pickResponse(prompt);
  const id = "text-1";
  // 组装 SDK 定义的标准流事件队列
  const chunks = [
    { type: "text-start", id }, // 开始文本传输
    ...text
      .split("")
      .map((char) => ({ type: "text-delta", id, delta: char })),
    { type: "text-end", id }, // 结束文本传输
    { type: "finish", finishReason: "stop", usage: USAGE }, // 整个流结束，附带统计信息
  ];
  // 返回通过 ReadableStream 包装的延迟流
  return { stream: createDelayedStream(chunks, 30) };
}
```

#### ReadableStream

上文中的 `createDelayedStream` 是利用 web 标准的 `ReadableStream` 实现的。

它通过 `setTimeout` 产生一定的时间间隔（这里设置为 30ms），将预先准备好的 `chunks` 逐个推送到流中，模拟出真实的网络延迟和打字机效果

```ts
function createDelayedStream(
  chunks: StreamPart[],
  delayMs = 30,
): ReadableStream {
  return new ReadableStream({
    start(controller) {
      let i = 0;
      function next() {
        if (i < chunks.length) {
          controller.enqueue(chunks[i++]); // 吐出下一个数据块
          setTimeout(next, delayMs); // 等待后继续
        } else {
          controller.close(); // 数据发完，关闭流
        }
      }
      next();
    },
  });
}
```

## 调用 mock model

[mock model 源码](https://github.com/astak16/learn-model/blob/main/01%E8%B5%B7%E6%AD%A5/src/mock-model.ts)

写好了 Mock Model 之后，在业务代码中的调用方法与官方提供的 openai 或者 anthropic 模型完全一样：

可以直接把他传给 `generateText` 和 `streamText`：

```ts
async function main() {
  const { text } = await generateText({
    model: createMockModel(),
    prompt: "用一句话介绍你自己",
  });
  console.log(text);
}

main();
```

[doGenerate 源码](https://github.com/astak16/learn-model/blob/main/01%E8%B5%B7%E6%AD%A5/src/index-generate.ts)

```ts
async function main() {
  const result = streamText({
    model: createMockModel(),
    prompt: "用一句话介绍你自己",
  });

  for await (const chunk of result.textStream) {
    process.stdout.write(chunk);
  }
  console.log(); // 换行
}
main();
```

[doStream 源码](https://github.com/astak16/learn-model/blob/main/01%E8%B5%B7%E6%AD%A5/src/index-stream.ts)

## 总结

通过实现 `doGenerate` 和 `doStream` 方法，我们成功构建了一个完全本地运行的 Mock Model

这套方案非常适合用来编写前端单元测试（UI Verification），或是作为离线开发、环境降级时的兜底方案。

_学习完成于 2026-05-21_

_基于[10 分钟，让你的 AI 开口说话](https://sitor.ai/courses/super-agent/sa-01-hello-agent?ref=38F54SVU)学习笔记整理_
