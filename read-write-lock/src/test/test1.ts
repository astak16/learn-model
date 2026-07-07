import { lock, reader } from "../tool";

async function main() {
  console.log("\n========== 场景一：多个读者应并发执行 ==========\n");
  await Promise.all([reader("A", 500), reader("B", 500), reader("C", 500)]);
  console.log("\n========== 结束，锁的最终状态 ==========");
  console.log(lock.status);
}

main();
