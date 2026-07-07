/**
 * ReadWriteLock —— 读写锁的最小实现
 *
 * 规则：
 * - 允许多个"读"操作并发执行（用 concurrentCount 计数）
 * - "写"操作必须独占（exclusiveLock），执行期间不允许任何读/写同时进行
 * - waitQueue 存放被阻塞的 resolve 回调；锁状态变化时统一唤醒（drainQueue），
 *   唤醒后用 while 循环重新检查条件——因为"被唤醒"不等于"抢到锁"
 */
export class ReadWriteLock {
  private exclusiveLock = false;
  private concurrentCount = 0;
  private waitQueue: Array<() => void> = [];

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

  private drainQueue(): void {
    const waiting = this.waitQueue.splice(0);
    for (const resolve of waiting) resolve();
  }

  /** 用读锁包裹一段逻辑，自动 acquire/release（哪怕抛异常也会释放） */
  async withRead<T>(fn: () => Promise<T> | T): Promise<T> {
    await this.acquireConcurrent();
    try {
      return await fn();
    } finally {
      this.releaseConcurrent();
    }
  }

  /** 用写锁包裹一段逻辑，自动 acquire/release */
  async withWrite<T>(fn: () => Promise<T> | T): Promise<T> {
    await this.acquireExclusive();
    try {
      return await fn();
    } finally {
      this.releaseExclusive();
    }
  }

  /** 仅用于演示：查看当前锁状态 */
  get status() {
    return {
      exclusiveLock: this.exclusiveLock,
      concurrentCount: this.concurrentCount,
      waiting: this.waitQueue.length,
    };
  }
}
