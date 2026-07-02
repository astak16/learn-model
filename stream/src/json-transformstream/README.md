`ReadableStream` + `start(controller)` 和 `TransformStream` + `getWriter()` 是两个不同方式的实现流的方式

`ReadableStream` 的 `start(controller)` 方法用于在流开始时进行初始化操作

`TransformStream` 的 `getWriter()` 方法则用于获取一个可写的流写入器，以便将数据写入到流中

他们的区别是 `writer` 是有背压的，而 `controller` 是没有背压的。也就是说，当使用 `writer` 写入数据时，如果下游处理速度较慢，写入操作会被阻塞，直到下游准备好接收更多数据。而使用 `controller` 时，数据可以被立即推送到流中，而不考虑下游的处理速度

```ts
await writer.write({ kind: "event", payload, id: i });
```

如果消费端（`transform.readable`）跟不上，`for` 循环会一直在这一行等待，不会执行下面，用 `ReadableStream` + `start(controller)` 的方式则不会有背压

|              | ReadableStream + controller      | TransformStream + writer               |
| :----------- | :------------------------------- | :------------------------------------- |
| 写入方法     | controller.enqueue()，同步无阻塞 | writer.write()，返回 Promise，可 await |
| 背压         | 无，队列无限增长                 | 有，队列满时 write() 挂起              |
| 多生产者协调 | 各自调用，靠 closed 标志松散互斥 | 共享 writer，写操作天然排队            |
| 出错         | controller.error(err)            | writer.abort(err)                      |
| 正常结束     | controller.close()               | writer.close()                         |
| 下游取消信号 | 构造选项里的 cancel() 回调       | writer.closed Promise reject           |

`controller.enqueue()` 只解决了“怎么把数据放进流里”，`writer.write()` 额外解决了“什么时候应该放慢”
