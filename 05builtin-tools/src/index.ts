import type { ModelMessage } from "ai";
import { createInterface } from "node:readline";
import { ToolRegistry } from "./tool-registry";
import { allTools } from "./tools";
import { agentLoop } from "./agent-loop";
import { createMockModel } from "./mock-model";

const model = createMockModel();

const registry = new ToolRegistry();
registry.register(...allTools);

const messages: ModelMessage[] = [];
const rl = createInterface({ input: process.stdin, output: process.stdout });

const SYSTEM = `你是 Super Agent，一个有工具调用能力的 AI 助手。
你有以下工具可用：get_weather, calculator, read_file, write_file, list_directory。
需要查询信息或操作文件时，主动使用工具，不要编造数据。
可以同时调用多个互不冲突的工具来提高效率。
回答要简洁直接。`;

const ask = () => {
  rl.question("\nYou: ", async (input: string) => {
    const trimmed = input.trim();
    if (!trimmed || trimmed === "exit") {
      console.log("Bye!");
      rl.close();
      return;
    }
    messages.push({ role: "user", content: trimmed });

    await agentLoop(model, registry, messages, SYSTEM);

    ask();
  });
};
console.log('Super Agent v0.4 — Tool System (type "exit" to quit)');
console.log('试试："帮我看看当前目录"、"读取 package.json"、"测试并发"、"测试截断"\n');
ask();
