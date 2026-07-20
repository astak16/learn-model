# Agent 工具系统怎么设计:注册、并发锁与截断

跑一下 `index.ts` 会看到这几行:

```
Super Agent v0.4 — Tool System (type "exit" to quit)
试试："帮我看看当前目录"、"读取 package.json"、"测试并发"、"测试截断"
```

"Tool System""测试并发""测试截断"——这三个词基本就是这一版要解决的问题:工具怎么统一管理、模型一次调用好几个工具时怎么互不干扰、工具返回内容太大时怎么处理。三件事最后都收进了一个类里——`ToolRegistry`。这篇文章顺着这一个类，看它怎么把三件事一次性处理掉。

## 工具的统一契约

工具会越加越多——查天气、算算术、读写文件、列目录——如果每个工具各写各的调用约定，agent loop 里迟早要写一堆 if-else 去适配不同形状。`tool-registry.ts` 里的 `ToolDefinition` 把这件事收敛成一个接口，所有工具都得实现:

```ts
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  isConcurrencySafe?: boolean;
  isReadOnly?: boolean;
  maxResultChars?: number;
  execute: (input: any) => Promise<unknown>;
}
```

`name`/`description`/`parameters` 是喂给模型看的（`parameters` 直接就是 JSON Schema），`execute` 是真正的实现。真正有意思的是剩下那三个可选字段——它们不影响模型怎么"看"这个工具，只影响 registry 怎么"跑"这个工具。这也是整套设计的核心思路:把执行期的安全策略变成挂在工具定义上的声明式字段，而不是让每个工具自己去处理锁和截断。

## 注册本体:一个 Map

有了统一接口，剩下的问题就是找个地方存起来、按名字取出来。答案很朴素:

```ts
private tools = new Map<string, ToolDefinition>();

register(...tools: ToolDefinition[]): void {
  for (const tool of tools) {
    this.tools.set(tool.name, tool);
  }
}
```

所以 `index.ts` 里只用一行 `registry.register(...allTools)`，工具从哪来（`tools.ts`）和工具怎么被消费（`agent-loop.ts`）就彻底解耦了。要加一个新工具，只要满足 `ToolDefinition` 接口、塞进 `allTools` 数组就行，别的代码不用碰。

真正的复杂度在下一步——把这份内部定义转换成 AI SDK 认识的格式。

## 从内部定义到 AI SDK 格式

`agent-loop.ts` 里 `streamText` 要的工具格式，跟内部 `ToolDefinition` 不是一回事，衔接的活儿在 `toAISDKFormat()` 里做:

```ts
toAISDKFormat(): Record<string, any> {
  const result: Record<string, any> = {};
  for (const [name, tool] of this.tools) {
    result[name] = {
      description: tool.description,
      inputSchema: jsonSchema(tool.parameters),
      execute: async (input: any) => {
        // 锁的获取/释放 + 结果截断，统一在这里注入
      },
    };
  }
  return result;
}
```

关键在于:真正暴露给 AI SDK 的 `execute`，并不是 `tools.ts` 里写的那个原始函数，而是一层包装。锁和截断全部在这一层统一注入——`readFileTool` 的 `execute` 只管读文件，完全不用知道自己会被排队、会被截断。

## 并发控制:为什么工具之间需要一把锁

`agent-loop.ts` 里开了 `parallelToolCalls: true`，模型可以一步内同时发起好几个工具调用——查两个城市的天气完全没必要排队。但工具不是都无害的:`write_file` 有副作用，如果跟另一个正在读同一文件的 `read_file` 同时跑，可能读到写了一半的内容；两个 `write_file` 同时写同一个文件，谁的结果最终生效也说不准。全都串行最安全，但白白浪费了大部分工具本来能并发的收益；全都放开并发最快，但守不住 `write_file` 这类工具的安全。`ToolRegistry` 按工具是否"并发安全"分成两类分别处理，本质是一把标准的**读写锁**:

```ts
private exclusiveLock = false;
private concurrentCount = 0;
private waitQueue: Array<() => void> = [];

private async acquireConcurrent() {
  while (this.exclusiveLock) {
    await new Promise<void>((r) => this.waitQueue.push(r));
  }
  this.concurrentCount++;
}

private async acquireExclusive() {
  while (this.exclusiveLock || this.concurrentCount > 0) {
    await new Promise<void>((r) => this.waitQueue.push(r));
  }
  this.exclusiveLock = true;
}
```

`waitQueue` 里存的不是 Promise 本身，而是它的 resolve 函数——一个典型的 deferred Promise 模式:先创建一个"待兑现"的 Promise 把执行挂起，兑现它的权力单独存进队列，等条件满足时再由持锁方从外部触发。

`isConcurrencySafe: true` 的工具走 `acquireConcurrent`：只要没有独占锁就能进，多个可以叠着跑——日志原文是 `[并发] xxx 获取共享锁`。其它工具走 `acquireExclusive`：必须等独占锁和所有共享锁都清空才能拿到——日志原文是 `[串行] xxx 获取独占锁，等待其他工具完成`。对应到 `tools.ts`，`write_file` 是唯一声明了 `isConcurrencySafe: false` 的工具，其它四个都可以并发跑。

有个细节值得留意:字段没声明时 `isConcurrencySafe` 是 `undefined`，走 `else` 分支，也就是独占锁——默认策略是"当作有副作用、串行执行"，工具必须显式声明 `isConcurrencySafe: true` 才能拿到并发的权利。对一个由模型自主决定调用哪些工具的系统来说，这是偏保守但合理的默认值。

再仔细看 `acquireConcurrent` 的判断条件，只看了 `exclusiveLock`，没看是不是已经有人在排队等独占锁。也就是说，如果并发安全的工具持续不断地进来，`concurrentCount` 可能一直降不到 0，一个在排队的 `write_file` 就可能被无限期地晾在那——这是读写锁里典型的"写者饥饿"（writer starvation）:这份实现明显偏向"读优先"，没有对等待中的写者做任何优先级保证。再加上 `drainQueue()` 是一次性唤醒所有等待者而不是唤醒队首一个（正确性没问题——JS 单线程，唤醒后到重新加锁之间没有 `await`，不会被打断——但等待者一多，每次释放锁要唤醒一整批，其中大部分会发现条件又不满足，只能重新排队）。工具调用频率不高时这些都无所谓，但如果之后某个并发安全的工具变得高频，可能需要加一条"有写者在等时，新读者也排队"的规则来保证公平。

## 防止结果撑爆上下文:为什么不能简单截尾巴

工具的返回值最终要塞回对话历史，跟着下一轮请求一起发给模型，而上下文窗口是有限资源。读一个大文件或列一个几千项的目录，返回内容轻松几万字符，原样塞回去很快耗掉预算，还会拉高每一轮的成本。最省事的处理是把超长内容直接截到尾部，但很多场景下最有用的信息恰恰在末尾——命令报错、文件结尾的总结——截尾巴会先把这些丢掉。`truncateResult` 选择保留头部 60% + 尾部 40%，中间挖空:

```ts
export function truncateResult(text: string, maxChars: number = DEFAULT_MAX_RESULT_CHARS): string {
  if (text.length <= maxChars) return text;
  const headSize = Math.floor(maxChars * 0.6);
  const tailSize = maxChars - headSize;
  const head = text.slice(0, headSize);
  const tail = text.slice(-tailSize);
  const dropped = text.length - headSize - tailSize;
  return `${head}\n\n... [省略 ${dropped} 字符] ...\n\n${tail}`;
}
```

并用一行提示告诉模型省略了多少字符，而不是悄悄丢内容。默认阈值 `DEFAULT_MAX_RESULT_CHARS = 3000`，每个工具可以用 `maxResultChars` 单独覆盖——`read_file` 就把它压到了 `500`，因为文件长度没有上限，也没有"越往后越不重要"的规律，需要更激进地控制。

## 九个工具怎么组合这几个开关

| 工具           | isConcurrencySafe | isReadOnly | maxResultChars |
| -------------- | ----------------- | ---------- | -------------- |
| get_weather    | true              | true       | 默认 3000      |
| calculator     | true              | true       | 默认 3000      |
| read_file      | true              | true       | 500            |
| write_file     | false             | false      | 默认 3000      |
| list_directory | true              | true       | 默认 3000      |
| edit_file      | false             | false      | 默认 3000      |
| glob           | true              | true       | 默认 3000      |
| grep           | true              | true       | 3000           |
| bash           | false             | false      | 3000           |

## 一个悬空的字段

`isReadOnly` 这一列，每个工具都老老实实声明了，但翻遍 `ToolRegistry` 的锁逻辑，没有任何地方读取过这个字段——真正决定并发策略的只有 `isConcurrencySafe`。这两个字段在五个工具上恰好完全同向（只读的都并发安全，会写的都不安全），不确定是巧合，还是 `isReadOnly` 本来是留给未来的权限审批或审计日志用的。至少现在，它是一个声明了但没人监听的字段。

## 小结

工具注册这件事，表面是"给 agent 挂个新能力"，实际是接口契约、并发安全、上下文成本三个问题揉在一起。这套实现把这些策略都变成了工具定义上的声明式字段，而不是散落在每个工具的实现里；默认值也都偏保守——默认独占、默认截断——把出错的代价尽量往小压。`isReadOnly` 的悬空、读写锁对写者缺乏公平保证，是留给下一版本的两处可以打磨的地方。
