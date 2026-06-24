`readableStreamToAsyncIterable` 是把 `ReadableStream` 转换成 `AsyncGenerator` 这样就能使用 `for await... of` 来遍历，而不用手写 `reader.read()` 的 `while` 循环

`ReadableStream` 原生不能直接使用 `for await (const x of stream)` 遍历，这是因为在浏览器环境中 `ReadableStream` 没有实现 `Symbol.asyncIterator`

如果想使用 `for await...of` 的写法去消费流，就需要把 `ReadableStream` 包装成标准的 `AsyncIterable`

正常写法：

```ts
const reader = stream.getReader();
try {
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    // 处理 value
  }
} finally {
  reader.releaseLock();
}
```

用 `AsyncIterable` 包装后的写法：

```ts
for await (const value of readableStreamToAsyncIterable(stream)) {
  // 处理 value,代码更干净
}
```

这里需要说明的是 `reader.releaseLock()`

`getReader()` 会给这个流加一个“锁”`(lock)`，同一时间只能有一个 `reader` 在读这个流。如果你读完了(或者中途因为外部 `break`/抛错而提前退出)，必须 `releaseLock()` 释放这个锁，否则这个流就永远“锁死”了，没人能再读它(比如想用 `stream.cancel()` 或者再拿一个新 `reader`)。

`finally` 保证无论是正常读完(`done` 为 `true` 然后 `break`)、还是异常情况(比如外部消费者提前 `return/break` 掉 `for-await` 循环、或者读取过程中抛错),锁都一定会被释放
