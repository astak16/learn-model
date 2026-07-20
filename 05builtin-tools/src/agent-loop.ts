import { LanguageModel, ModelMessage, streamText } from "ai";
import { ToolRegistry } from "./tool-registry";
import { calculateDelay, isRetryable, sleep } from "./retry";

const MAX_STEPS = 15;
const MAX_RETRIES = 3;
const TOKEN_BUDGET = 50000;

export async function agentLoop(
  model: LanguageModel,
  registry: ToolRegistry,
  messages: ModelMessage[],
  system: string,
) {
  let step = 0;
  let totalTokens = 0;
  while (step < MAX_STEPS) {
    step++;
    console.log(`\n--- Step ${step} ---`);

    let hasToolCall = false;
    let fullText = "";
    let shouldBreak = false;
    let lastToolCall: { name: string; input: unknown } | null = null;
    let stepResponse: any;
    let stepUsage: any;

    for (let attempt = 1; ; attempt++) {
      try {
        const result = streamText({
          model,
          system,
          tools: registry.toAISDKFormat(),
          messages,
          maxRetries: 0,
          providerOptions: { openai: { parallelToolCalls: true } },
          onError: () => {},
        });

        for await (const part of result.fullStream) {
          switch (part.type) {
            case "text-delta": {
              process.stdout.write(part.text);
              fullText += part.text;
              break;
            }
            case "tool-call": {
              hasToolCall = true;
              break;
            }
            case "tool-result": {
              const output = typeof part.output === "string" ? part.output : JSON.stringify(part.output);
              const preview = output.length > 120 ? output.slice(0, 120) + "..." : output;
              console.log(`   [结果: ${part.toolName}] ${preview}`);
              break;
            }
          }
        }
        stepResponse = await result.response;
        stepUsage = await result.usage;
        break;
      } catch (error) {
        if (attempt > MAX_RETRIES || !isRetryable(error as Error)) throw error;
        const delay = calculateDelay(attempt);
        console.log(`  [重试] 第 ${attempt}/${MAX_RETRIES} 次，${delay}ms 后...`);
        await sleep(delay);
        hasToolCall = false;
        fullText = "";
        shouldBreak = false;
        lastToolCall = null;
      }
    }
    if (shouldBreak) {
      console.log("\n[循环监测触发，Agent 已停止]");
      break;
    }
    messages.push(...stepResponse!.messages);
    console.log(!hasToolCall);
    if (!hasToolCall) {
      if (fullText) console.log();
      break;
    }

    console.log("  \u2192 继续下一步...");
  }

  if (step >= MAX_STEPS) {
    console.log("\n[达到最大步数]");
  }
}
