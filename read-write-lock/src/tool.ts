import { ReadWriteLock } from "./core";

const t0 = Date.now();
const elapsed = () => `${(Date.now() - t0).toString().padStart(4)}`;
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const log = (msg: string) => console.log(`[${elapsed()}ms] ${msg}`);

export const lock = new ReadWriteLock();

export async function reader(id: string, durationMs: number) {
  log(`🔵 reader-${id} 请求读锁...`);
  await lock.withRead(async () => {
    log(`🟢 reader-${id} 拿到读锁 (当前并发读者数=${lock.status.concurrentCount})`);
    await sleep(durationMs);
    log(`⚪ reader-${id} 读完，释放读锁`);
  });
}

export async function writer(id: string, durationMs: number) {
  log(`🟣 writer-${id} 请求写锁...`);
  await lock.withWrite(async () => {
    log(`🔴 writer-${id} 拿到写锁，独占执行中...`);
    await sleep(durationMs);
    log(`⚫ writer-${id} 写完，释放写锁`);
  });
}
