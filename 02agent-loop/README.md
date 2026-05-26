现在市面上的 Agent 教程太多了，要么太浅要么太碎。

之前一直关注的博主三元同学最近出了[Super Agent 实践课](https://sitor.ai/courses?ref=38F54SVU)，这门课从「底层实现级」角度拆解真实产品的工程决策，帮你建立完整的 Agent 知识体系，覆盖六大方向。

这门课学习下来让我对 Agent 有了全面的认知，下面是我的学习笔记

**往期学习笔记**

### 吃透 AI Agent 开发

1. [系统认知 Agent 六大支柱](https://juejin.cn/post/7637502462330224678)
2. [Agent循环原理](https://juejin.cn/post/7641544730451738658)
3. [大模型底层机制与Agent开发](https://juejin.cn/post/7642176685400735778)

在构建现在大语言模型（LLM）应用时，Agent（智能体）已经成为了最热门的话题。

不同于传统的单向文本对话，Agent 的核心能力在于主动使用工具与外部环境进行交互，获取信息、执行任务，并根据反馈进行调整。这种能力使得 Agent 可以应用在各种应用场景

结合 Vercel 设计理念，通过要组合本地的 Mock Model 与自定义工具来聊聊 Agent 底层的秘密：**循环机制（Loop）**

## 为什么需要循环

大语言模型本质上是一个基于概率的文本续写，如果用户问了一句“上海今天天气怎么样？顺便帮我算一下 1024 乘以 5 等于多少”

模型本身是没有实时天气 `API`，也没有精准的数学计算大脑

为了解决这个问题，我们引入 `ReAct` (Reasoning and Acting) 框架，模型在遇到无法直接回答的问题时，会经历思考与行动：

1. 思考（Thought）：分析用户意图，决定下一步做什么
2. 行动（Act）：输出一个特定的工具调用指令（`Tool Call`），告知客户端需要调用什么工具，传入什么参数
3. 观察（Observation）：客户端执行该工具，并将结果（`Tool Result`）作为新的上下文喂回给模型

这个过程往往不是一次性的，比如模型需要先调用天气工具，拿到结果后，再调用计算器工具，最后将所有结果综合起来给用户一个完整的回答

这就形成了一个循环：模型思考->输出工具调用意图->执行工具->带着结果继续喂给模型，这个不断迭代的过程就是我们所说的 **Agent循环（Agent Loop）**

如果没有这个循环机制，模型即使输出了工具调用意图，客户端也无法将工具结果反馈给模型，模型就无法根据最新信息进行调整，Agent 就会直接瘫痪

## 工具定义

在 Vercel SDK 中，工具（Tool）的定义非常结构化，它通常包含三个核心要素：

- `description`：描述工具的用途，这是给 LLM 看的说明书，模型判断何时使用此工具
- `inputSchema`：参数的 `JSON Schema` 校验规则，知道模型如何准确拼装参数
- `execute`：工具的执行函数，接收参数并返回结果，这个函数由开发者实现，定义了工具的实际功能

```ts
import { jsonSchema, tool } from "ai";
const weatherTool = tool({
  description: "查询指定城市的天气信息",
  inputSchema: jsonSchema<{ city: string }>({
    type: "object",
    properties: {
      city: { type: "string", description: "城市名称，如“北京”、“上海”" },
    },
    required: ["city"],
    additionalProperties: false,
  }),
  execute: async ({ city }) => {
    // mock 数据，可以替换为真实的天气 API 调用
    const mockWeather: Record<string, string> = {
      北京: "晴，15-25°C，东南风 2 级",
      上海: "多云，18-22°C，西南风 3 级",
      深圳: "阵雨，22-28°C，南风 2 级",
    };
    return mockWeather[city] || `${city}：暂无数据`;
  },
});
```

[weatherTool 源码](https://github.com/astak16/learn-model/blob/main/02agent-loop/src/tools.ts#L3)

```ts
import { jsonSchema } from "ai";
const calculatorTool = {
  description: "计算数学表达式的结果。当用户提问涉及数学运算时使用",
  inputSchema: jsonSchema({
    type: "object",
    properties: {
      expression: { type: "string", description: '数学表达式，如 "2 + 3 * 4"' },
    },
    required: ["expression"],
    additionalProperties: false,
  }),
  execute: async ({ expression }: { expression: string }) => {
    try {
      const result = new Function(`return ${expression}`)();
      return `${expression} = ${result}`;
    } catch {
      return `无法计算: ${expression}`;
    }
  },
};
```

[calculatorTool 源码](https://github.com/astak16/learn-model/blob/main/02agent-loop/src/tools.ts#L23)

### jsonSchema

`jsonSchema` 是 Vercel SDK（ai包） 提供的一个工具，用于定义工具输入参数的结构和校验规则。它基于 JSON Schema 标准，可以帮助我们清晰地描述工具需要什么样的输入，以及如何验证这些输入的正确性

`jsonSchema` 的作用是把普通的 JSON Schema 包装成 AI SDK 认识的 `Schema` 类型，它只是一个类型适配器，让你用原始 JSON Schema 语法的同事保持类型安全

`jsonSchema` 返回的是一个带有 `Symbol` 标记的包装对象，不是普通的 `JSON` 对象，无法直接用 `console.log` 打印出它的内容，而是会显示为一个特殊的对象：

```
{
  _type: undefined,
  jsonSchema: [Getter],
  validate: undefined,
  Symbol(vercel.ai.schema): true
};
```

原始的 JSON Schema 保存在 `jsonSchema` 属性中，可以通过访问这个属性来查看或使用它

## SDK 循环

在 Vercel AI SDK 的封装中（`generateText` 或 `streamText`），已经内置了循环机制。当模型输出工具调用意图时，SDK 会自动识别并执行对应的工具函数，然后将结果反馈给模型，继续下一轮的思考与行动

当把 `tools` 传入 `generateText` 或 `streamText` 时，并且指定了 `stopWhen: stepCountIs(5)`，SDK 内部会在捕获到 `tool-call` 类型的 `chunk` 后，自动去寻找对应的工具，然后执行工具的 `execute` 函数，并将结果作为新的上下文继续喂给模型，触发下一轮循环，最后直到满足停止条件（如达到最大步骤数）

```ts
const ask = () => {
  rl.question("\nYou: ", async (input) => {
    const trimmed = input.trim();
    if (!trimmed || trimmed === "exit") {
      console.log("Bye!");
      rl.close();
      return;
    }

    messages.push({ role: "user", content: trimmed });

    const result = streamText({
      model,
      system: SYSTEM,
      tools,
      messages,
      stopWhen: stepCountIs(5),
    });

    process.stdout.write("Assistant: ");
    let fullResponse = "";

    for await (const part of result.fullStream) {
      switch (part.type) {
        case "text-delta":
          process.stdout.write(part.text);
          fullResponse += part.text;
          break;
        case "tool-call":
          console.log(
            `\n  [调用工具: ${part.toolName}(${JSON.stringify(part.input)})]`,
          );
          break;
        case "tool-result":
          console.log(`  [工具返回: ${JSON.stringify(part.output)}]`);
          break;
      }
    }

    console.log();
    messages.push({ role: "assistant", content: fullResponse });

    ask();
  });
};
```

[ask 源码](https://github.com/astak16/learn-model/blob/main/02agent-loop/src/index-sdk.ts#L16)

这种封装虽然让开发者几行代码就能跑起一个 Agent，但也隐藏了循环的细节，对于一些需要精细化控制每次循环的行为，就显得不太灵活了

### stepCountIs

这里的循环最大次数是通过 `stopWhen: stepCountIs(5)` 来控制的，`stepCountIs` 是一个工厂函数，返回一个判断函数，当循环步骤数达到指定值时返回 `true`，告诉 SDK 停止循环

为什么使用 `stepCountIs(5)` 而不是直接传入一个数字呢？

这是函数式编程中很常见的**柯里化/策略模式**——把配置值包装成行为，让调用方传入的是"能被执行的逻辑"，而不是"裸数据"

```ts
// 如果接受裸数据，框架只能写死一种判断方式
if (steps.length >= stopWhen) stop(); // 只支持按步数

// 如果接受函数，框架只需要调用它
if (await stopWhen(state)) stop(); // 支持任何判断逻辑
```

这样的好处是框架不需要为每种停止条件都写一个 `if`，扩展点留给了调用方

```ts
// 框架的 stopWhen 接口永远不变
if (await stopWhen(state)) stop();

// 但调用方可以随意扩展停止条件
stopWhen: stepCountIs(5);
stopWhen: tokenLimitReached(1000);
stopWhen: (state) => state.steps.some((s) => s.text.includes("DONE"));
stopWhen: anyOf(stepCountIs(5), tokenLimitReached(1000));
```

这就是所谓"把配置值包装成行为"的意义

## 手写循环

为了彻底掌握 Agent 灵魂，我们可以自己手写一个循环来实现工具调用的功能，而不是依赖 SDK 的封装

使用 `streamText` 来发起一次模型调用，捕获流式响应中的 `tool-call` 和 `tool-result`，并在每轮结束时将模型产生的历史消息追加回上下文，来实现一个完整的 Agent 循环

```ts
import { LanguageModel, ModelMessage, streamText, ToolSet } from "ai";

const MAX_STEPS = 5;

export const agentLoop = async (
  model: LanguageModel,
  tools: ToolSet,
  messages: ModelMessage[],
  system: string,
) => {
  let step = 0;
  while (step < MAX_STEPS) {
    step++;
    console.log(`\n--- Step ${step} ---`);

    // 1. 发起当前轮次的模型调用，不设置 stopWhen，只跑一次
    const result = streamText({ model, system, tools, messages });

    let hasToolCall = false;
    let fullText = "";

    // 2. 消费流式响应，同时精准捕获 text-delta 和 tool-call/result
    for await (const part of result.fullStream) {
      switch (part.type) {
        case "text-delta":
          process.stdout.write(part.text); // 实时打印文本打字机
          fullText += part.text;
          break;

        case "tool-call":
          hasToolCall = true; // 标记本轮模型决定调用工具
          console.log(
            `  [调用: ${part.toolName}(${JSON.stringify(part.input)})]`,
          );
          break;

        case "tool-result":
          console.log(`  [结果: ${JSON.stringify(part.output)}]`);
          break;
      }
    }

    // 3. 极其关键的一步：将本轮模型产生的历史消息（包含模型吐出的 tool_calls）追加回上下文
    const stepMessages = await result.response;
    messages.push(...stepMessages.messages);

    // 4. 出口条件判断：如果本轮没有任何工具调用意图，说明模型已经“思考完毕”，直接结束循环
    if (!hasToolCall) {
      if (fullText) console.log();
      break;
    }

    console.log("  → 模型还在工作，继续下一步...");

    if (step >= MAX_STEPS) {
      console.log("达到最大步骤数，强制结束对话。");
      break;
    }
  }
};
```

[agentLoop 源码](https://github.com/astak16/learn-model/blob/main/02agent-loop/src/agent-loop.ts#L5)

## mock model

mock model 的本质上是一个基于上下文的状态机

它实现了 Vercel AI SDK 定义的 `LanguageModel` 接口（包含 `doGenerate` 和 `doStream` 方法），遵循以下核心行为逻辑：

1. 意图拦截与工具下发
2. 上下文状态识别与响应

### 意图拦截与工具下发

当用户在终端输入 “上海今天天气怎么样”，mock model 需要先通过 `extractUserText` 拿到用户的最新输入，并经过关键词匹配，识别出用户的意图，返回工具函数

```ts
{ toolName: "get_weather", args: { city: cities[0] } };
```

识别用户意图函数：

```ts
const detectToolIntent = (
  prompt: LanguageModelV3CallOptions["prompt"],
): ToolCallIntent | null => {
  // 是否是工具调用，如果最新的是工具调用，则不再继续解析工具调用意图，直接返回 null
  if (hasToolResults(prompt)) return null;
  const text = extractUserText(prompt);

  const weatherIntent = detectWeatherIntent(text);
  if (weatherIntent) return weatherIntent;

  const calcIntent = detectCalcIntent(text);
  if (calcIntent) return calcIntent;

  return null;
};
```

用户输入提取函数：

```ts
// 从 prompt 中提取用户最新的输入文本
const extractUserText = (
  prompt: LanguageModelV3CallOptions["prompt"],
): string => {
  const userMsgs = (prompt || []).filter((m) => m.role === "user");
  const last = userMsgs[userMsgs.length - 1];
  return (last?.content || [])
    .map((c) => ("text" in c ? c.text : ""))
    .join("")
    .toLowerCase();
};
```

天气意图函数

```ts
function detectWeatherIntent(text: string): ToolCallIntent | null {
  const hasKeyword = WEATHER_KEYWORDS.some((kw) => text.includes(kw));
  const cities = text.match(CITY_PATTERN);
  if (!hasKeyword || !cities?.length) return null;
  return { toolName: "get_weather", args: { city: cities[0] } };
}
```

在 `doStream` 中，模型会将这些意图切切碎输出，Vercel AI SDK 将各个厂商的工具调用意图统一抽象成 `LanguageModelV3StreamPart` 类型的流式响应，并把 `finishReason` 标记为 `tool-calls`。这就逼真地模拟了真实的大模型调用工具时的流式输出

```ts
const chunks: LanguageModelV3StreamPart[] = [
  { type: "tool-input-start", id: callId, toolName: intent.toolName },
  { type: "tool-input-delta", id: callId, delta: argsJson },
  { type: "tool-input-end", id: callId },
  {
    type: "tool-call",
    toolCallId: callId,
    toolName: intent.toolName,
    input: argsJson,
  },
  {
    type: "finish",
    finishReason: { unified: "tool-calls" as const, raw: undefined },
    usage: USAGE,
  },
];
```

### 上下文状态识别与响应

当外层的 `agentLoop` 捕获到模型输出的 `tool-call`，并执行工具函数后，会把工具结果作为新的上下文继续喂给模型

这时模型需要能够识别出上下文中已经有工具调用结果了，就不能再继续输出工具调用意图了，否则就会陷入死循环

因此代码中实现了一个 `hasToolResults` 函数

```ts
const hasToolResults = (
  prompt: LanguageModelV3CallOptions["prompt"],
): boolean => {
  const msgs = prompt || [];
  // 从后往前找，如果遇到是工具调用返回 true，否则返回 false
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "tool") return true;
    if (msgs[i].role === "user") return false;
  }
  return false;
};
```

一旦 `hasToolResults` 返回 `true`，`detectToolIntent` 就会直接返回 `null`，

此时模型就会进入 `pickTextResponse` 逻辑，解析出上一步工具调用的结果，并基于这个结果生成最终的文本回复

```ts
async doStream({ prompt }: LanguageModelV3CallOptions) {
  const intent = detectToolIntent(prompt);
  if (intent) {
    const callId = `call-${Date.now()}`;
    const argsJson = JSON.stringify(intent.args);
    const chunks: LanguageModelV3StreamPart[] = [
      { type: "tool-input-start", id: callId, toolName: intent.toolName },
      { type: "tool-input-delta", id: callId, delta: argsJson },
      { type: "tool-input-end", id: callId },
      {
        type: "tool-call",
        toolCallId: callId,
        toolName: intent.toolName,
        input: argsJson,
      },
      {
        type: "finish",
        finishReason: { unified: "tool-calls" as const, raw: undefined },
        usage: USAGE,
      },
    ];
    return { stream: createDelayedStream(chunks) };
  }
  const id = "text-1";
  const text = pickTextResponse(prompt);
  const chunks: LanguageModelV3StreamPart[] = [
    { type: "text-start", id },
    ...text
      .split("")
      .map((char) => ({ type: "text-delta" as const, id, delta: char })),
    { type: "text-end", id },
    {
      type: "finish",
      finishReason: { unified: "stop", raw: undefined },
      usage: USAGE,
    },
  ];

  return { stream: createDelayedStream(chunks) };
}
```

## 总结

这个循环是分了两部分

1. 第一部分：只做决策，不给结果，只吐出 `tool-call` 终止当前轮次
2. 第二部分：识别工具结果，吐出 `text-delta`，结束整个循环

掌握手写循环，就真正理解了 Agent 的核心机制，才能在实际应用中根据需求灵活调整循环的行为和停止条件

_学习完成于 2026-05-25_

_基于[从"能聊天"到"能干活"——给 Agent 装上 while 循环](https://sitor.ai/courses/super-agent/sa-02-agent-loop?ref=38F54SVU)学习笔记整理_
