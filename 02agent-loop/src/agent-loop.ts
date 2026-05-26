import { LanguageModel, ModelMessage, streamText, ToolSet } from "ai";

const MAX_STEPS = 10;

export const agentLoop = async (
  model: LanguageModel,
  tools: ToolSet,
  messages: ModelMessage[],
  system: string,
) => {
  let step = 0;
  while (step < MAX_STEPS) {
    step++;
    console.log(`\n--- Step ${step} ---`);

    const result = streamText({
      model,
      system,
      tools,
      messages,
    });
    let hasToolCall = false;
    let fullText = "";

    for await (const part of result.fullStream) {
      switch (part.type) {
        case "text-delta":
          process.stdout.write(part.text);
          fullText += part.text;
          break;

        case "tool-call":
          hasToolCall = true;
          console.log(
            `  [调用: ${part.toolName}(${JSON.stringify(part.input)})]`,
          );
          break;

        case "tool-result":
          console.log(`  [结果: ${JSON.stringify(part.output)}]`);
          break;
      }
    }

    const stepMessages = await result.response;
    messages.push(...stepMessages.messages);

    if (!hasToolCall) {
      if (fullText) console.log();
      break;
    }

    console.log("  → 模型还在工作，继续下一步...");

    if (step >= MAX_STEPS) {
      console.log("达到最大步骤数，强制结束对话。");
      break;
    }
  }
};
