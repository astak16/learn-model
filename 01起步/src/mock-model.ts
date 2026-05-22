import type { LanguageModel } from "ai";
import type {
  LanguageModelV3CallOptions,
  LanguageModelV3Usage,
  LanguageModelV3StreamPart,
  LanguageModelV3FinishReason,
} from "@ai-sdk/provider";

const RESPONSES: Record<string, string> = {
  default:
    "你好！我是模拟模型。填了 DASHSCOPE_API_KEY 后会自动切换到真实的 Qwen。",
  greeting: "你好！虽然是模拟的，但流式输出的效果和真实 API 一致 :)",
  name: '你刚才告诉我了呀！我能"记住"是因为代码把对话历史传给了我。',
  intro: "我是通义千问（模拟版），在本地模拟回复，机制和真实 API 完全一致。",
};

function pickResponse(prompt: LanguageModelV3CallOptions["prompt"]): string {
  const userMsgs = (prompt || []).filter((m) => m.role === "user");
  const last = userMsgs[userMsgs.length - 1];
  const text = (last?.content || [])
    .map((c) => ("text" in c ? c.text : ""))
    .join("")
    .toLowerCase();
  if (text.includes("介绍你自己") || text.includes("你是谁"))
    return RESPONSES.intro;
  if (text.includes("你好") || text.includes("hello"))
    return RESPONSES.greeting;
  if (text.includes("叫什么") || text.includes("记住")) return RESPONSES.name;
  return RESPONSES.default;
}

const USAGE: LanguageModelV3Usage = {
  inputTokens: {
    total: 10,
    noCache: 10,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 20, text: 20, reasoning: undefined },
};

function createDelayedStream(
  chunks: LanguageModelV3StreamPart[],
  delayMs = 30,
): ReadableStream {
  return new ReadableStream({
    start(controller) {
      let i = 0;
      function next() {
        if (i < chunks.length) {
          controller.enqueue(chunks[i++]);
          setTimeout(next, delayMs);
        } else {
          controller.close();
        }
      }
      next();
    },
  });
}

const finishReason: LanguageModelV3FinishReason = {
  unified: "stop",
  raw: undefined,
};

export function createMockModel(): LanguageModel {
  return {
    specificationVersion: "v3" as const,
    provider: "mock",
    modelId: "mock-model",
    get supportedUrls() {
      return Promise.resolve({});
    },

    async doGenerate({ prompt }: LanguageModelV3CallOptions) {
      return {
        content: [{ type: "text" as const, text: pickResponse(prompt) }],
        finishReason,
        usage: USAGE,
        warnings: [],
      };
    },

    async doStream({ prompt }: LanguageModelV3CallOptions) {
      const text = pickResponse(prompt);
      const id = "text-1";
      const chunks: LanguageModelV3StreamPart[] = [
        { type: "text-start" as const, id },
        ...text.split("").map((char) => ({
          type: "text-delta" as const,
          id,
          delta: char,
        })),
        { type: "text-end" as const, id },
        {
          type: "finish" as const,
          finishReason,
          usage: USAGE,
        },
      ];
      return { stream: createDelayedStream(chunks, 30) };
    },
  };
}
