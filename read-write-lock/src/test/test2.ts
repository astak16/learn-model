import { lock, reader, sleep, writer } from "../tool";

async function main() {
  console.log("\n========== 场景二：写者要等所有读者释放锁，且独占执行 ==========");
  console.log("（注意：F 在 writer-1 已经排队之后才来，但因为此时 exclusiveLock 还是 false，");
  console.log(" F 会直接插队成功——这是这个实现的一个特性/局限：新读者可以在写者排队时继续插队）\n");
  await Promise.all([
    reader("D", 400),
    reader("E", 600),
    (async () => {
      await sleep(50); // 错开一点，方便看清 "writer 先请求、后拿到" 的顺序
      await writer("1", 500);
    })(),
    (async () => {
      await sleep(150); // 此时 writer-1 已经在排队了
      await reader("F", 300);
    })(),
  ]);
  console.log("\n========== 结束，锁的最终状态 ==========");
  console.log(lock.status);
}

main();
