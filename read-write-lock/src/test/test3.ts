import { lock, log, reader, sleep, writer } from "../tool";

async function main() {
  console.log("\n========== 场景三：持续到来的读者可能让写者迟迟抢不到锁（写者饥饿）==========\n");
  let writerDone = false;
  reader("G0", 400); // 先让一个读者占住并发读锁
  const pendingWriter = writer("2", 300).then(() => {
    writerDone = true;
  }); // writer 此时请求，会发现 concurrentCount > 0，只能排队
  await sleep(150);
  // 后续读者每 150ms 接力到来、每个读 400ms（间隔 < 时长，保证读者之间首尾重叠），
  // 只要接力不断，concurrentCount 就不会降到 0，writer-2 就迟迟排不上队
  for (let i = 1; i < 8; i++) {
    reader(`G${i}`, 400);
    if (i < 7) await sleep(150);
  }
  log(`最后一个读者已发出请求，此刻 writer-2 完成了吗？→ ${writerDone ? "是" : "否，仍在等待读者潮退去"}`);
  await pendingWriter;
  log("writer-2 最终执行完毕（读者接力停止、并发计数归零后，写锁才被释放给它）");
  console.log("\n========== 结束，锁的最终状态 ==========");
  console.log(lock.status);
}
main();
