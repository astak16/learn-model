## 流式输出

`ReadableStream` 可以实现流式输出，它通过 `pull` 方法按需拉取数据：

```ts
function createDelayedStream(chunks: string[], delayMs = 200) {
  let i = 0;
  return new ReadableStream<string>({
    async pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      await new Promise((r) => setTimeout(r, delayMs));
      controller.enqueue(chunks[i++]);
    },
  });
}
const stream = createDelayedStream(["The", " quick", " brown", " fox"]);
const fn = async () => {
  for await (const chunk of stream) {
    console.log(chunk);
  }
};
fn();
```

`start` 也能实现类似的效果。

与 `pull` 不同，`start` 在对象构造时立即调用，通常用于准备工作

要用 `start` 模拟 `pull` 的节奏，可以将逻辑封装成函数并用 `setTimeout` 递归调用：

```ts
function createDelayedStream(chunks: string[], delayMs = 200) {
  let i = 0;
  return new ReadableStream<string>({
    async start(controller) {
      async function next() {
        if (i >= chunks.length) {
          controller.close();
          return;
        }
        setTimeout(next, delayMs);
        controller.enqueue(chunks[i++]);
      }
      next();
    },
  });
}
const stream = createDelayedStream(["The", " quick", " brown", " fox"]);
const fn = async () => {
  for await (const chunk of stream) {
    console.log(chunk);
  }
};
fn();
```

那这两种写法有什么本质区别？

`pull` 有背压机制。

数据生产出来必须等下游消费后才会继续生产，就像管道放满了就不能再往里放，需要等下游取走才能继续

`start + setTimeout` 是自驱的，它不关心下游有没有消费，只要计时器触发就继续生产，数据会堆积在内部队列里。数据量小时没有问题，但数据量大时可能造成内存持续增长

用下面这个例子对比两者的行为差异：

```ts
function makeStream(useSetTimeout: boolean) {
  let i = 0;
  const log = (msg: string) => console.log(`[${useSetTimeout ? "一次性" : "按需"}] ${msg}`);
  if (useSetTimeout) {
    return new ReadableStream<number>({
      start(controller) {
        function produce() {
          if (i >= 5) return controller.close();
          log(`生产 ${i}`);
          controller.enqueue(i++);
          setTimeout(produce, 50);
        }
        produce();
      },
    });
  } else {
    return new ReadableStream<number>({
      async pull(controller) {
        await new Promise((r) => setTimeout(r, 0));
        if (i >= 5) return controller.close();
        log(`生产 ${i}`);
        controller.enqueue(i++);
      },
    });
  }
}

async function consumeSlowly(stream: ReadableStream<number>) {
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    console.log("消费", value);
    await new Promise((r) => setTimeout(r, 500)); // 消费很慢
  }
}
```

`setTimeout` 版——不等消费，`5` 个数据很快全部生产完，堆在队列里等待：

```js
consumeSlowly(makeStream(true)); // setTimeout 版：5 个很快全生产完，堵在队列里

// 输出
// [一次性] 生产 0
// 消费 0
// [一次性] 生产 1
// [一次性] 生产 2
// [一次性] 生产 3
// [一次性] 生产 4
// 消费 1
// 消费 2
// 消费 3
// 消费 4
```

`pull` 版——生产节奏跟着消费走，每次只生产一个

这是因为 `ReadableStream` 的 `highWaterMark `默认为 `1`，即内部队列最多缓存 `1` 个数据块，队列满时 `pull` 就不会再被调用，直到消费者取走数据：

```js
consumeSlowly(makeStream(false)); // pull 版：生产节奏跟消费对齐

// 输出
// [按需] 生产 0
// 消费 0
// [按需] 生产 1
// 消费 1
// [按需] 生产 2
// 消费 2
// [按需] 生产 3
// 消费 3
// [按需] 生产 4
// 消费 4
```
