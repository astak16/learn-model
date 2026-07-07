# 从零实现读写锁：一个 TypeScript 并发控制的入门样本

## 为什么需要读写锁

在并发编程里，最简单粗暴的做法是用一把互斥锁（Mutex）保护共享资源——谁想访问，谁就得排队，一次只放一个进去。这样做安全，但浪费。

设想一个缓存系统：大部分操作是"读"（查询缓存），少部分操作是"写"（更新缓存）。读操作彼此之间并不冲突——你读我也读，数据又没变，为什么要排队？真正需要互斥的，只有"写的时候不能有人读，读的时候不能有人写"这一条规则。

读写锁（Read-Write Lock）就是为这种场景设计的：

- **多个读操作可以并发执行**
- **写操作必须独占**——执行期间不允许任何读或写同时发生

下面这份不到 90 行的 `ReadWriteLock` 实现，把这套规则用 TypeScript 完整地跑了一遍，还顺带暴露出了一个经典的公平性问题：**写者饥饿（Writer Starvation）**。

## 核心状态：三个字段说清楚锁在干什么

```typescript
export class ReadWriteLock {
  private exclusiveLock = false;
  private concurrentCount = 0;
  private waitQueue: Array<() => void> = [];
```

- `exclusiveLock`：是否有写者正在独占执行
- `concurrentCount`：当前有多少个读者正在并发读
- `waitQueue`：被阻塞的操作，以 `resolve` 回调的形式存起来

整个锁的逻辑，本质上就是"根据这两个布尔/计数状态，决定谁能通过、谁得等"。

## 读锁：计数 + 等待

```typescript
private async acquireConcurrent(): Promise<void> {
  while (this.exclusiveLock) {
    await new Promise<void>((r) => this.waitQueue.push(r));
  }
  this.concurrentCount++;
}

private releaseConcurrent(): void {
  this.concurrentCount--;
  if (this.concurrentCount === 0) this.drainQueue();
}
```

拿读锁的逻辑很直接：只要没有写者在独占，就把并发计数 +1，直接进去。释放的时候计数 -1，如果减到 0 了（意味着"最后一个读者走了"），就唤醒等待队列——因为这时候可能有个写者正等着这一刻。

注意这里 `while (this.exclusiveLock)` 用的是 `while` 而不是 `if`。这是整个实现里最容易被忽略、但又最关键的一个细节，下面单独讲。

## 写锁：独占，条件更严格

```typescript
private async acquireExclusive(): Promise<void> {
  while (this.exclusiveLock || this.concurrentCount > 0) {
    await new Promise<void>((r) => this.waitQueue.push(r));
  }
  this.exclusiveLock = true;
}

private releaseExclusive(): void {
  this.exclusiveLock = false;
  this.drainQueue();
}
```

写者的通行条件更苛刻：不仅不能有别的写者在跑（`exclusiveLock`），也不能有任何读者在跑（`concurrentCount > 0`）。两个条件占一个就得等。写完释放时直接把 `exclusiveLock` 置回 `false`，然后唤醒所有等待者——不管是读者还是下一个写者，都有机会重新竞争。

## 为什么必须用 `while` 而不是 `if`

这是并发控制里一个经典的坑：**"被唤醒"不等于"抢到锁"**。

`drainQueue` 唤醒等待队列时，是一次性把所有等待的 `resolve` 全部调用掉：

```typescript
private drainQueue(): void {
  const waiting = this.waitQueue.splice(0);
  for (const resolve of waiting) resolve();
}
```

假设此刻队列里同时排着 3 个读者和 1 个写者，锁一释放，这 4 个 `resolve` 全被触发，它们的 `await` 都会恢复执行——但恢复执行不代表条件已经满足了。如果用 `if` 判断一次就往下走，写者和读者可能会在同一时刻都以为自己"拿到锁"了，独占性直接被打破。

用 `while` 的话，每个被唤醒的操作都会重新检查一遍条件：如果条件还不满足（比如写者醒来一看，还有读者在跑），就重新把自己的 `resolve` 塞回 `waitQueue`，接着等下一次唤醒。这保证了状态的最终一致性，代价是可能会有几轮"空唤醒"——这是用简单性换来的合理开销。

## 用 `withRead` / `withWrite` 保证异常安全

```typescript
async withRead<T>(fn: () => Promise<T> | T): Promise<T> {
  await this.acquireConcurrent();
  try {
    return await fn();
  } finally {
    this.releaseConcurrent();
  }
}
```

这里的 `try/finally` 是必须的。如果 `fn()` 内部抛出异常，没有 `finally` 兜底的话，`releaseConcurrent()` 根本不会被执行，`concurrentCount` 就会永远多算一个——这个读锁会变成一把再也无法完全释放的"僵尸锁"，后续所有写者都会被永远卡住。`withWrite` 同理。

调用方完全不需要手动配对 acquire/release，业务代码写起来是这样的：

```typescript
export async function reader(id: string, durationMs: number) {
  await lock.withRead(async () => {
    // 读逻辑
  });
}
```

## 特性还是缺陷？插队与写者饥饿

这份实现里注释写得很实在——它没有回避自己的局限性，反而专门设计了三个场景来暴露问题。

**场景二**演示了一个"插队"现象：一个写者已经在排队了，但因为此刻 `exclusiveLock` 还是 `false`（写者还没真正拿到锁，只是在等），新来的读者判断 `acquireConcurrent` 里的 `while (this.exclusiveLock)` 时，发现条件是 `false`，可以直接通过——完全不会检查"是否有写者正在排队"。这是这个实现刻意保留的一个特性/局限：**读者的准入条件只看"是否有写者正在执行"，不看"是否有写者正在等待"**。

**场景三**把这个问题放大成了完整的"写者饥饿"演示：

```typescript
reader("G0", 400);
const pendingWriter = writer("2", 300).then(() => {
  writerDone = true;
});
await sleep(150);
for (let i = 1; i < 8; i++) {
  reader(`G${i}`, 400);
  if (i < 7) await sleep(150);
}
```

一个读者先占住并发锁，写者紧接着请求、发现 `concurrentCount > 0` 只能排队。然后后续读者每隔 150ms 接力到来、每人读 400ms——因为读者的到达间隔（150ms）小于单个读者的持续时间（400ms），读者之间首尾重叠，`concurrentCount` 就永远不会降到 0。只要这条"读者接力"不断，写者就永远拿不到锁。

这不是 bug，是读写锁这种朴素实现的固有权衡：**它优化了读的吞吐量，但没有对写者做任何优先级保证**。生产级的实现（比如 Java 的 `ReentrantReadWriteLock` 支持公平模式）通常会加一条规则："如果已经有写者在排队，后续读者也必须排队"，用牺牲一部分读并发性换取写者不被饿死。

## 小结

这份 `ReadWriteLock` 用不到 90 行代码，把读写锁的核心机制讲得很完整：

1. **并发读、独占写**——两套不同的准入条件
2. **`while` 循环重新检查条件**——唤醒不等于拿到锁，这是避免竞态条件的关键
3. **`try/finally` 保证锁一定被释放**——即使业务逻辑抛异常
4. **公平性是要额外设计的**——不加干预的话，源源不断的读者会让写者永远等待
