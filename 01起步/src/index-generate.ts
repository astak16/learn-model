import "dotenv/config";
import { generateText } from "ai";
import { createMockModel } from "./mock-model";

const model = createMockModel();

async function main() {
  const { text } = await generateText({
    model: model,
    prompt: "用一句话介绍你自己",
  });

  console.log(text);
}

main();
