import "dotenv/config";
import { streamText } from "ai";
import { createMockModel } from "./mock-model";

const model = createMockModel();

async function main() {
  const result = streamText({
    model,
    prompt: "用一句话介绍你自己",
  });

  for await (const chunk of result.textStream) {
    process.stdout.write(chunk);
  }

  console.log(); // 换行
}

main();
