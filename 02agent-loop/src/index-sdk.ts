import { stepCountIs, streamText, type ModelMessage } from "ai";
import { createMockModel } from "./mock-model";
import { createInterface } from "node:readline";
import { calculatorTool, weatherTool } from "./tools";

const SYSTEM = `你是 Super Agent，一个有工具调用能力的 AI 助手。
需要查询信息时，主动使用工具，不要编造数据。
回答要简洁直接。`;

const model = createMockModel();
const tools = { get_weather: weatherTool, calculator: calculatorTool };

const messages: ModelMessage[] = [];
const rl = createInterface({ input: process.stdin, output: process.stdout });

const ask = () => {
  rl.question("\nYou: ", async (input) => {
    const trimmed = input.trim();
    if (!trimmed || trimmed === "exit") {
      console.log("Bye!");
      rl.close();
      return;
    }

    messages.push({ role: "user", content: trimmed });

    const result = streamText({
      model,
      system: SYSTEM,
      tools,
      messages,
      stopWhen: stepCountIs(5),
    });

    process.stdout.write("Assistant: ");
    let fullResponse = "";

    for await (const part of result.fullStream) {
      switch (part.type) {
        case "text-delta":
          process.stdout.write(part.text);
          fullResponse += part.text;
          break;
        case "tool-call":
          console.log(
            `\n  [调用工具: ${part.toolName}(${JSON.stringify(part.input)})]`,
          );
          break;
        case "tool-result":
          console.log(`  [工具返回: ${JSON.stringify(part.output)}]`);
          break;
      }
    }

    console.log();
    messages.push({ role: "assistant", content: fullResponse });

    ask();
  });
};

ask();
