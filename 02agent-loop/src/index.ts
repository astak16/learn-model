import { type ModelMessage } from "ai";
import { createMockModel } from "./mock-model";
import { createInterface } from "node:readline";
import { calculatorTool, weatherTool } from "./tools";
import { agentLoop } from "./agent-loop";

const SYSTEM = `你是 Super Agent，一个有工具调用能力的 AI 助手。
需要查询信息时，主动使用工具，不要编造数据。
回答要简洁直接。`;

const model = createMockModel();
const tools = { get_weather: weatherTool, calculator: calculatorTool };

const messages: ModelMessage[] = [];
const rl = createInterface({ input: process.stdin, output: process.stdout });

function ask() {
  rl.question("\nYou: ", async (input) => {
    const trimmed = input.trim();
    if (!trimmed || trimmed === "exit") {
      console.log("Bye!");
      rl.close();
      return;
    }

    messages.push({ role: "user", content: trimmed });

    await agentLoop(model, tools, messages, SYSTEM);

    ask();
  });
}
ask();
