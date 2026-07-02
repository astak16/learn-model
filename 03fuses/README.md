# 给 Agent 装上保险丝：AI Agent 系统的容错设计实践

在一个普通的后端服务里，"容错"通常指的是网络请求失败后怎么重试、超时怎么处理。但当服务的主体变成一个会自主决策、多轮调用工具的 Agent 之后，"故障"的定义也变了——它不再只是一次 HTTP 请求的失败，还可能是模型陷入了一种"技术上没有报错，但逻辑上原地打转"的状态。

这篇文章基于一个简单的 Agent Demo（用 AI SDK 实现的工具调用循环），拆解其中的容错设计。整个系统叠了三层防护，外加工具执行层面的兜底，层层递进，缺一不可。

## 第一层：网络请求容错——先分类，再决定要不要重试

最基础的一层，应对的是 LLM API 调用本身的失败：限流、服务过载、网络抖动。这类失败的关键不是"要不要重试"，而是先判断"这次失败值不值得重试"：

```typescript
export const isRetryable = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  const message = error.message;
  const statusMatch = message.match(/(\d{3})/);
  if (statusMatch) {
    const status = parseInt(statusMatch[1]);
    if ([429, 529, 408].includes(status)) return true;
    if (status >= 500 && status < 600) return true;
    if (status >= 400 && status < 500) return false;
  }
  if (message.includes("ECONNRESET") || message.includes("EPIPE")) return true;
  if (message.includes("ETIMEDOUT") || message.includes("timeout")) return true;
  if (message.includes("fetch failed") || message.includes("network")) return true;
  if (message.includes("No output generated")) return true;
  return false;
};
```

这段代码本质上是一份错误分类表：

- **429（限流）、408（请求超时）、529（Anthropic 的过载错误码）**：虽然落在 4xx 区间，但明确标记为可重试，所以要写在通用 4xx 判断之前，不然会被后面 `status >= 400 && status < 500 → false` 的规则误伤。
- **5xx**：服务端错误大概率是瞬时的，重试有意义。
- **其余 4xx**：请求本身有问题（参数错、鉴权失败），重试只会拿到一模一样的失败，直接放弃更划算。
- **ECONNRESET / ETIMEDOUT / fetch failed 等**：网络层的瞬时抖动，值得重试。

这里有一个值得留意的取舍：判断状态码的方式是从 `error.message` 里用正则抠出一个三位数字，而不是读一个结构化的 `error.status` 字段。这个做法的前提是"错误信息里恰好包含真实状态码"——如果上游库把错误规整成了结构化类型，直接读字段显然更稳健；但很多时候拿到手的就是一个只有 `message` 的原生 `Error`，正则匹配是没有结构化信息时的务实退路。

判断完"值不值得重试"，接下来才是"怎么重试"：

```typescript
export function calculateDelay(attempt: number, baseMs = 500, maxMs = 30000) {
  const exponential = baseMs * Math.pow(2, attempt - 1);
  const capped = Math.min(exponential, maxMs);
  return Math.max(0, Math.round(capped + (Math.random() * 2 - 1) * capped * 0.25));
}
```

指数退避（每次翻倍）叠加封顶（`maxMs`），再加上 ±25% 的随机抖动。抖动不是可有可无的装饰——如果多个客户端在同一时刻遇到限流，且都按固定间隔重试，重试请求会重新扎堆，形成新一轮拥堵；抖动把这些重试请求在时间上错开，是低成本但很有效的解法。

在 Agent 主循环里，这套逻辑包了一层 for 循环：

```typescript
for (let attempt = 1; ; attempt++) {
  try {
    const result = streamText({ model, system, tools, messages, maxRetries: 0 /* ... */ });
    for await (const part of result.fullStream) {
      /* ... */
    }
    stepResponse = await result.response;
    break;
  } catch (error) {
    if (attempt > MAX_RETRIES || !isRetryable(error as Error)) throw error;
    const delay = calculateDelay(attempt, 2000);
    await sleep(delay);
    hasToolCall = false;
    fullText = "";
    shouldBreak = false;
    lastToolCall = null;
  }
}
```

两个细节值得注意：

1. `streamText` 显式传了 `maxRetries: 0`，把 AI SDK 自带的重试关掉了。如果不关，两套重试逻辑叠在一起，实际重试次数和延迟会变得难以预测。既然要自己控制退避策略和错误分类，就要把重试逻辑完全接管过来，而不是两边都开着。
2. 重试前重置了 `fullText`、`hasToolCall` 这些局部状态。失败发生在流式响应的中途——上一次尝试可能已经吐出了一部分文本、记录了一次工具调用，这些"半成品"状态如果不清空，重试成功后会和新一轮的结果叠在一起，导致重复文本或者幽灵工具调用。**重试一个流式请求，本质上是重试整个流的生命周期，而不只是重新发一次请求。**

## 第二层：Agent 循环容错——模型也会"卡住"，而且不报错

第一层解决的是"请求失败了怎么办"，但 Agent 系统还有一类更隐蔽的故障：请求全部成功，模型也在正常输出，但它反复调用同一个工具、拿到同样的结果，逻辑上毫无进展。这种"卡住"不会抛异常，传统的重试机制完全捕捉不到。

这段逻辑的核心，是把每一次工具调用变成一个可比较的指纹：

```typescript
const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.sort().map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as any)[k])}`).join(",")}}`;
};

export function hashToolCall(toolName: string, params: unknown): string {
  return `${toolName}:${hash(stableStringify(params))}`;
}
```

对参数对象的 key 排序之后再序列化，是为了让 `{city: "北京", unit: "c"}` 和 `{unit: "c", city: "北京"}` 这种字段顺序不同、语义相同的调用产出同一个 hash——否则哈希对比会因为字段顺序的偶然差异而失效。

有了"调用指纹"和"结果指纹"，系统在一个长度为 30 条的滑动历史窗口里维护了三种检测器：

- **完全重复（generic_repeat）**：同一个工具、同一组参数在窗口里出现的次数达到阈值——警告线是 5 次，熔断线是 8 次。
- **乒乓循环（ping_pong）**：在两个不同调用之间来回切换，阈值同样是 5 次警告、8 次熔断。Demo 里专门写了一个测试场景来复现这种情况——交替查询"北京"和"上海"的天气，模拟模型在两个选项之间反复横跳、既不收敛也不报错的状态。
- **无进展熔断（circuit breaker）**：同一个调用、同一组参数，连续多次拿到完全相同的结果，阈值给到了 10 次——这是三者里最严格的一种判断：不只是"调用重复"，而是"调用重复且没有获得任何新信息"，所以给了它最高的门槛和"熔断"这个更强硬的名字。

三种检测器背后是同一套分级响应模式：

```typescript
if (recentCount >= WARNING_THRESHOLD) {
  return { stuck: true, level: "warning", detector: "generic_repeat", count: recentCount, message: `...` };
}
```

达到警告阈值时，系统不会立刻掐断循环，而是往对话历史里插入一条系统提示，让模型自己意识到"在重复"、尝试换个思路：

```typescript
messages.push({
  role: "user" as const,
  content: `【系统提醒】${detection.message}。请换一个思路解决问题，不要重复同样的操作`,
});
```

只有当行为持续到更高的阈值，才会真正终止循环。这个"先提醒、不行再熔断"的两级响应，和第一层"先重试、超过次数再放弃"的思路是同构的——只是第一层作用在网络请求上，这一层作用在模型的行为模式上。**容错的对象，从"请求"扩展成了"决策"。**

## 第三层：硬性步数上限——保证一定会停下来

即便有了循环检测，也不能百分百保证覆盖所有卡住的情况——检测逻辑本身也可能有覆盖不到的模式。所以整个 Agent 循环还兜了一层最朴素的保底：

```typescript
const MAX_STEPS = 15;
while (step < MAX_STEPS) {
  step++;
  // ...
  if (shouldBreak) break; // 循环检测触发熔断
  messages.push(...stepResponse.messages);
  if (!hasToolCall) break; // 模型主动结束（没有新的工具调用）
  // 否则进入下一步
}
```

整个循环有三条退出路径：模型自己判断任务完成（没有新的工具调用）、循环检测判定熔断、达到步数上限强制停止。前两条路径都依赖"判断逻辑是对的"这个前提，而步数上限不依赖任何判断——它只是一个纯粹的计数器。**这一层不追求聪明，只追求兜底**：不管前面的检测逻辑设计得多完善，Agent 消耗的资源和时间始终有一个确定的上界。

## 工具执行也要优雅降级

容错不只发生在 Agent 主循环这一层，工具本身的实现也遵循同样的原则——出错时返回一段能解释情况的文本，而不是把异常直接抛出去：

```typescript
execute: async ({ expression }: { expression: string }) => {
  try {
    const result = new Function(`return ${expression}`)();
    return `${expression} = ${result}`;
  } catch {
    return `无法计算: ${expression}`;
  }
},
```

如果这里不 catch，一个非法表达式会让异常直接冒到 Agent 主循环之外，导致整个进程崩溃。返回一段描述失败的文本，本质上是把"工具执行失败"也变成了一种正常的工具返回结果——模型能看到这个结果，进而决定是换个表达式重试，还是向用户说明算不出来。天气工具对未知城市的处理是同样的思路：

```typescript
return mockWeather[city] || `${city}：暂无数据`;
```

**工具层面永远不应该让异常直接穿透到 Agent 循环之外**——它应该被转换成一个模型可以"看懂"、并据此继续决策的结果。

## 用 Mock 模型给容错逻辑做故障演练

容错代码有一个天然的尴尬：它存在的意义就是处理"很难稳定复现"的情况——限流什么时候触发、网络什么时候抖动，都不是能主动控制的。这个 Demo 里的 Mock 模型专门解决了这个问题，把两类故障做成了可以按需触发的固定剧本：

```typescript
if (text.includes("测试重试") || text.includes("test retry")) {
  retryTestCount++;
  if (retryTestCount <= 2) {
    throw new Error("429 Too Many Requests - Rate limit exceeded");
  }
  // 第三次固定成功
}

if (text.includes("测试死循环") || text.includes("test dead loop")) {
  return { toolName: "get_weather", args: { city: alternating() === 2 ? "北京" : "上海" } };
}
```

前两次调用固定抛出 429，第三次固定成功，用来验证重试逻辑是否生效；后者固定在两个城市之间交替，用来验证乒乓循环检测的阈值设置得对不对。这样一来，重试机制和循环检测都不用碰真实 API、也不用祈祷网络刚好抖一下才能验证。**容错代码本身也是需要测试的代码，而测试它最好的方式，是把它要应对的故障场景做成确定性的、可重复触发的模拟。**

## 小结

把这几层放在一起看，能提炼出几条比较通用的设计原则：

1. **先分类，再重试**：不是所有失败都值得重试，判断"重试是否可能成功"永远是第一步。
2. **退避要带抖动**：固定间隔的重试在规模化之后会自我放大成拥堵，随机抖动是低成本的解法。
3. **Agent 的故障不止是异常**：一次成功的、没有报错的工具调用，也可能是"卡住"的信号，这类故障需要专门的行为层检测。
4. **分级响应，先给一次自我修正的机会**：无论是网络重试还是循环提醒，"警告优先、无效再强制停止"这套两级响应，都比一遇到问题就直接终止更稳健。
5. **兜底不需要聪明，只需要确定**：步数上限这种最朴素的保护，恰恰是因为不依赖任何"判断是否正确"的前提，才能作为整个系统最后的安全网。
6. **异常不应该穿透执行边界**：无论是工具还是 Agent 步骤，失败都应该被转换成调用方能理解、能继续决策的结果，而不是直接抛出去。
7. **容错逻辑本身需要可测试性**：把难以复现的故障场景做成确定性的 mock，才能真正验证容错代码是否真的奏效。

从网络层的重试，到行为层的循环检测，再到步数上限这个最后的保险丝——这套设计思路本质上是同一个原则在不同层级上的重复应用：**先尝试识别和分类问题，给系统一次自我修正的机会，再在必要时果断兜底。**
