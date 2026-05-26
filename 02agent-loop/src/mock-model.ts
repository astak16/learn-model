import type { LanguageModel } from "ai";
import type {
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";

type ToolCallIntent = {
  toolName: string;
  args: Record<string, unknown>;
};

const TEXT_RESPONSES: Record<string, string> = {
  default:
    "你好！我是 Super Agent 的模拟模型。当前使用本地模拟回复，工具调用的机制和真实 API 完全一样。\n\n在 .env 里填入 DASHSCOPE_API_KEY 即可切换到真实的 Qwen 模型。",
  greeting: "你好！我是 Super Agent v0.2，现在我不只能聊天，还能调用工具了 :)",
  name: "你刚才告诉我了呀！不过说实话，我是模拟模型，能“记住”是因为代码把对话历史传给了我。",
};

const USAGE = {
  inputTokens: {
    total: 10,
    noCache: 10,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 20, text: 20, reasoning: undefined },
};

const OP_MAP: Record<string, string> = {
  "+": "+",
  "-": "-",
  "*": "*",
  "/": "/",
  加: "+",
  减: "-",
  乘: "*",
  除: "/",
  加上: "+",
  减去: "-",
  乘以: "*",
  除以: "/",
  和: "+",
  与: "+",
  差: "-",
  积: "*",
  商: "/",
};

const WEATHER_KEYWORDS = [
  "天气",
  "weather",
  "温度",
  "热",
  "冷",
  "气温",
  "下雨",
  "晴",
];
const CITY_PATTERN = /(北京|上海|深圳|广州|杭州|成都)/g;

function inferOperator(text: string): string | null {
  const keys = Object.keys(OP_MAP).sort((a, b) => b.length - a.length);
  const matched = keys.find((k) => text.includes(k));
  return matched ? OP_MAP[matched] : null;
}

const createDelayedStream = (
  chunks: LanguageModelV3StreamPart[],
  delayMs = 30,
) => {
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
};

/** 天气意图：需要天气关键词 + 城市名 */
function detectWeatherIntent(text: string): ToolCallIntent | null {
  const hasKeyword = WEATHER_KEYWORDS.some((kw) => text.includes(kw));
  const cities = text.match(CITY_PATTERN);
  if (!hasKeyword || !cities?.length) return null;
  return { toolName: "get_weather", args: { city: cities[0] } };
}

/** 计算意图：结构化算式（含运算符）或自然语言描述 */
function detectCalcIntent(text: string): ToolCallIntent | null {
  // Case 1: 结构化算式，如 "3 + 5"、"10加20"
  const structuredMatch = text.match(
    /(\d+)\s*([+\-*/]|加上?|减去?|乘以?|除以?)\s*(\d+)/,
  );
  if (structuredMatch) {
    const [, a, rawOp, b] = structuredMatch;
    const op = OP_MAP[rawOp] ?? rawOp;
    return { toolName: "calculator", args: { expression: `${a} ${op} ${b}` } };
  }

  // Case 2: 自然语言算式，如 "100和50的差是多少"
  const isCalcIntent = ["计算", "等于", "是多少", "结果"].some((kw) =>
    text.includes(kw),
  );
  if (isCalcIntent) {
    const nums = text.match(/\d+/g);
    if (nums && nums.length >= 2) {
      const op = inferOperator(text) ?? "+"; // fallback 用加法
      return {
        toolName: "calculator",
        args: { expression: `${nums[0]} ${op} ${nums[1]}` },
      };
    }
  }

  return null;
}

const extractUserText = (
  prompt: LanguageModelV3CallOptions["prompt"],
): string => {
  const userMsgs = (prompt || []).filter((m) => m.role === "user");
  const last = userMsgs[userMsgs.length - 1];
  return (last?.content || [])
    .map((c) => ("text" in c ? c.text : ""))
    .join("")
    .toLowerCase();
};

const hasToolResults = (
  prompt: LanguageModelV3CallOptions["prompt"],
): boolean => {
  const msgs = prompt || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "tool") return true;
    if (msgs[i].role === "user") return false;
  }
  return false;
};

const detectToolIntent = (
  prompt: LanguageModelV3CallOptions["prompt"],
): ToolCallIntent | null => {
  if (hasToolResults(prompt)) return null;
  const text = extractUserText(prompt);

  const weatherIntent = detectWeatherIntent(text);
  if (weatherIntent) return weatherIntent;

  const calcIntent = detectCalcIntent(text);
  if (calcIntent) return calcIntent;

  return null;
};

const pickTextResponse = (
  prompt: LanguageModelV3CallOptions["prompt"],
): string => {
  if (hasToolResults(prompt)) {
    const toolMsgs = (prompt || []).filter((m) => m.role === "tool");
    const lastTool = toolMsgs[toolMsgs.length - 1];
    const content = (lastTool.content || [])
      .map((c) => {
        if (c.type === "tool-result") {
          if (c.output.type === "text") return c.output.value;
          if (c.output.type === "json") return JSON.stringify(c.output.value);
          if (c.output.type === "execution-denied") return c.output.reason;
        }
        return "";
      })
      .join("");
    if (
      content.includes("天气") ||
      content.includes("℃") ||
      content.includes("°C")
    )
      return `根据查询结果: ${content}`;
    if (content.includes("=")) return `计算结果是: ${content}`;
    return `工具返回了以下信息: ${content}`;
  }
  const text = extractUserText(prompt);
  if (text.includes("你好") || text.includes("hello"))
    return TEXT_RESPONSES.greeting;
  if (text.includes("叫什么") || text.includes("名字"))
    return TEXT_RESPONSES.name;
  return TEXT_RESPONSES.default;
};

export const createMockModel = (): LanguageModel => ({
  specificationVersion: "v3" as const,
  provider: "mock",
  modelId: "mock-model",
  get supportedUrls() {
    return Promise.resolve({});
  },
  async doGenerate({ prompt }: LanguageModelV3CallOptions) {
    const intent = detectToolIntent(prompt);
    if (intent) {
      return {
        content: [
          {
            type: "tool-call" as const,
            toolName: intent.toolName,
            input: JSON.stringify(intent.args),
            toolCallId: `call-${Date.now()}`,
          },
        ],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: USAGE,
        warnings: [],
      };
    }
    return {
      content: [{ type: "text" as const, text: pickTextResponse(prompt) }],
      finishReason: { unified: "stop" as const, raw: undefined },
      usage: USAGE,
      warnings: [],
    };
  },

  async doStream({ prompt }: LanguageModelV3CallOptions) {
    const intent = detectToolIntent(prompt);
    if (intent) {
      const callId = `call-${Date.now()}`;
      const argsJson = JSON.stringify(intent.args);
      const chunks: LanguageModelV3StreamPart[] = [
        { type: "tool-input-start", id: callId, toolName: intent.toolName },
        { type: "tool-input-delta", id: callId, delta: argsJson },
        { type: "tool-input-end", id: callId },
        {
          type: "tool-call",
          toolCallId: callId,
          toolName: intent.toolName,
          input: argsJson,
        },
        {
          type: "finish",
          finishReason: { unified: "tool-calls" as const, raw: undefined },
          usage: USAGE,
        },
      ];
      return { stream: createDelayedStream(chunks) };
    }
    const id = "text-1";
    const text = pickTextResponse(prompt);
    const chunks: LanguageModelV3StreamPart[] = [
      { type: "text-start", id },
      ...text
        .split("")
        .map((char) => ({ type: "text-delta" as const, id, delta: char })),
      { type: "text-end", id },
      {
        type: "finish",
        finishReason: { unified: "stop", raw: undefined },
        usage: USAGE,
      },
    ];

    return { stream: createDelayedStream(chunks) };
  },
});
