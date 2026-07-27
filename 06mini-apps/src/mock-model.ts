/**
 * Mock Model v0.4.2 — Mini Apps
 *
 * 在 sa-04b 基础上新增三个 demo 场景：
 * 1. 代码分析 Agent：list_directory + grep 找出项目所有 TODO/FIXME，最后给出归类总结
 * 2. Research Agent：fetch_url 抓文档（可并行多个 URL），最后做综合摘要
 * 3. Vibe Coding：Agent 调多次 write_file 生成完整 React 多文件应用
 *
 * 同时保留 sa-04b 的"测试编辑/搜索/glob/bash/重试"等内置 demo。
 */

import { VIBE_APP_TSX, VIBE_BUTTON_TSX, VIBE_STYLES_CSS } from "./template";
import { LanguageModel } from "ai";
import {
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
  LanguageModelV3ToolResultOutput,
} from "@ai-sdk/provider";

let retryTestCount = 0;

const TEXT_RESPONSES: Record<string, string> = {
  default:
    "你好！我是 Super Agent v0.4.2 — Mini Apps。试试这三个 demo：\n  1. 找出项目里所有 TODO\n  2. 去 https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling 看下文档总结\n  3. 做一个待办清单的网页应用",
};

interface ToolCallIntent {
  toolName: string;
  args: Record<string, unknown>;
}

function extractUserText(prompt: LanguageModelV3CallOptions["prompt"]): string {
  const userMsgs = (prompt || []).filter((m) => m.role === "user");
  const last = userMsgs[userMsgs.length - 1];
  if (!last) return "";
  if (typeof last.content === "string") return last.content;
  return (last.content || []).map((c) => ("text" in c ? c.text : "")).join("");
}

function hasToolResults(prompt: LanguageModelV3CallOptions["prompt"]): boolean {
  const msgs = prompt || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "tool") return true;
    if (msgs[i].role === "user") return false;
  }
  return false;
}

function lastToolResults(prompt: LanguageModelV3CallOptions["prompt"]): { toolName: string; output: string }[] {
  const msgs = prompt ?? [];
  const out: { toolName: string; output: string }[] = [];

  for (let i = msgs.length - 1; i >= 0; i--) {
    // 必须先保存到变量，帮助 TypeScript 稳定收窄
    const msg = msgs[i];

    if (msg.role === "tool") {
      for (const part of msg.content) {
        // 排除 tool-approval-response
        if (part.type !== "tool-result") {
          continue;
        }

        out.unshift({
          toolName: part.toolName,
          output: stringifyToolOutput(part.output),
        });
        // const val = part.output?.value || part.output || part.result || "";
        // out.unshift({ toolName: part.toolName || "", output: String(val) });
      }
    } else if (msg.role === "user") {
      break;
    }
  }

  return out;
}

function stringifyToolOutput(output: LanguageModelV3ToolResultOutput): string {
  if (output.type === "text" || output.type === "error-text") {
    return output.value;
  }
  if (output.type === "json" || output.type === "error-json") {
    return JSON.stringify(output.value);
  }
  if (output.type === "execution-denied") {
    return output.reason || "Tool execution denied";
  }
  if (output.type === "content") {
    return output.value.map((part) => (part.type === "text" ? part.text : "")).join("");
  }
  return JSON.stringify(output);
}

type Scenario = "code-analysis" | "research" | "vibe-coding" | null;

function detectDemoScenario(text: string): Scenario {
  if (
    text.includes("TODO") ||
    text.includes("todo") ||
    text.includes("FIXME") ||
    (text.includes("找出") && text.includes("项目")) ||
    text.includes("扫一下")
  ) {
    return "code-analysis";
  }
  if (/https?:\/\//.test(text)) {
    return "research";
  }
  if (
    text.includes("待办") ||
    (text.includes("做一个") && text.includes("应用")) ||
    (text.includes("生成") && text.includes("网页")) ||
    text.includes("vibe")
  ) {
    return "vibe-coding";
  }
  return null;
}

// ==== Demo 1: 代码分析 ====

function planCodeAnalysis(): ToolCallIntent[] {
  return [
    { toolName: "list_directory", args: { path: "sample-project" } },
    { toolName: "grep", args: { pattern: "TODO|FIXME", path: "sample-project" } },
  ];
}

function summarizeCodeAnalysis(results: { toolName: string; output: string }[]): string {
  const grepResult = results.find((r) => r.toolName === "grep")?.output || "";
  const lines = grepResult.split("\n").filter((l) => l.includes(":") && (l.includes("TODO") || l.includes("FIXME")));

  const fileGroups = new Map<string, string[]>();
  for (const line of lines) {
    const fileMatch = line.match(/^([^:]+):/);
    if (fileMatch) {
      const file = fileMatch[1];
      if (!fileGroups.has(file)) fileGroups.set(file, []);
      fileGroups.get(file)!.push(line);
    }
  }

  let summary = `项目里一共找到 ${lines.length} 处 TODO/FIXME，分布在 ${fileGroups.size} 个文件：\n`;
  for (const [file, items] of fileGroups) {
    summary += `\n- ${file}（${items.length} 处）`;
    for (const item of items.slice(0, 3)) {
      const cleaned = item.replace(/^[^:]+:\d+:\s*\/\/\s*/, "   * ");
      summary += `\n${cleaned}`;
    }
  }
  summary += `\n\n建议优先处理 FIXME 标记的几条，那些是上线前必须修的硬伤。`;
  return summary;
}

// ==== Demo 2: Research Agent ====

function planResearch(text: string): ToolCallIntent[] {
  const urls = text.match(/https?:\/\/[^\s,，。、]+/g) || [];
  return urls.slice(0, 3).map((url) => ({ toolName: "fetch_url", args: { url } }));
}

function summarizeResearch(results: { toolName: string; output: string }[]): string {
  const fetched = results.filter((r) => r.toolName === "fetch_url");
  if (fetched.length === 0) return "没有抓取到任何内容。";

  if (fetched.length === 1) {
    const content = fetched[0].output;
    const sentences = content
      .split(/[\n。.]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 10)
      .slice(0, 4);
    return `读完文档，重点提炼如下：\n\n${sentences.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n\n核心思路：这份资料主要在讲工具调用的接口约定和执行模型，关键是用 inputSchema 描述参数、用 execute 实际运行。`;
  }

  let summary = `对比了 ${fetched.length} 个页面的内容：\n`;
  for (let i = 0; i < fetched.length; i++) {
    const first =
      fetched[i].output
        .split(/[\n。.]/)
        .map((s) => s.trim())
        .filter(Boolean)[0] || "";
    summary += `\n${i + 1}. ${first.slice(0, 100)}`;
  }
  return summary;
}

// ==== Demo 3: Vibe Coding ====
// 注意：app/index.html 已经预置在模板里（带 import maps + Babel 实时编译 loader）
// Agent 只需要生成应用组件（App.tsx 是入口、必须 createRoot）+ 其他组件 + 样式

function planVibeCoding(): ToolCallIntent[] {
  return [
    { toolName: "write_file", args: { path: "app/styles.css", content: VIBE_STYLES_CSS } },
    { toolName: "write_file", args: { path: "app/Button.tsx", content: VIBE_BUTTON_TSX } },
    { toolName: "write_file", args: { path: "app/App.tsx", content: VIBE_APP_TSX } },
    { toolName: "start_preview", args: {} },
  ];
}

function summarizeVibeCoding(results: { toolName: string; output: string }[]): string {
  const previewMsg = results.find((r) => r.toolName === "start_preview")?.output || "";
  return `搞定！我已经在 app/ 目录下生成了一个待办清单应用：
  - styles.css  样式（紫色渐变背景、卡片式布局）
  - Button.tsx  可复用的按钮组件
  - App.tsx     主应用入口（用 createRoot 渲染到 #root）

模板自带的 app/index.html 是固定的 ESM bootstrap，用 import maps + Babel Standalone 在浏览器里实时编译 TSX，不需要重新生成。

${previewMsg}`;
}

// ==== sa-04b 已有的测试场景（保留兼容性）====

function detectParallelIntent(text: string): ToolCallIntent[] | null {
  if (text.includes("测试并发") || text.includes("test parallel")) {
    return [
      { toolName: "get_weather", args: { city: "北京" } },
      { toolName: "get_weather", args: { city: "上海" } },
      { toolName: "list_directory", args: { path: "." } },
    ];
  }
  return null;
}

function detectLegacyToolIntent(prompt: LanguageModelV3CallOptions["prompt"]): ToolCallIntent | null {
  const text = extractUserText(prompt).toLowerCase();
  if (text.includes("测试死循环")) return { toolName: "get_weather", args: { city: "北京" } };
  if (hasToolResults(prompt)) return null;
  if (text.includes("测试截断")) return { toolName: "read_file", args: { path: "sample-data.txt" } };
  if (text.includes("测试编辑"))
    return {
      toolName: "edit_file",
      args: { path: "sample-data.txt", old_string: "一、工具注册机制", new_string: "一、工具注册机制（已更新）" },
    };
  if (text.includes("测试搜索")) return { toolName: "grep", args: { pattern: "export", path: "src" } };
  if (text.includes("测试glob")) return { toolName: "glob", args: { pattern: "**/*.ts" } };
  if (text.includes("测试bash")) return { toolName: "bash", args: { command: 'echo "Hello from bash!" && date' } };
  if (text.includes("目录") || text.includes("ls")) return { toolName: "list_directory", args: { path: "." } };
  const fileMatch = text.match(/(\S+\.[\w]+)/);
  if (fileMatch && (text.includes("读") || text.includes("看"))) {
    return { toolName: "read_file", args: { path: fileMatch[1] } };
  }
  return null;
}

// ==== Mock model 主入口 ====

function pickIntents(prompt: LanguageModelV3CallOptions["prompt"]): ToolCallIntent[] | null {
  if (hasToolResults(prompt)) return null;
  const text = extractUserText(prompt);
  const scenario = detectDemoScenario(text);
  if (scenario === "code-analysis") return planCodeAnalysis();
  if (scenario === "research") return planResearch(text);
  if (scenario === "vibe-coding") return planVibeCoding();

  const parallel = detectParallelIntent(text);
  if (parallel) return parallel;
  const legacy = detectLegacyToolIntent(prompt);
  return legacy ? [legacy] : null;
}

function pickTextResponse(prompt: LanguageModelV3CallOptions["prompt"]): string {
  if (!hasToolResults(prompt)) return TEXT_RESPONSES.default;

  const text = extractUserText(prompt);
  const scenario = detectDemoScenario(text);
  const results = lastToolResults(prompt);
  console.log("---results start---", results, "---results end---");
  if (scenario === "code-analysis") return summarizeCodeAnalysis(results);
  if (scenario === "research") return summarizeResearch(results);
  if (scenario === "vibe-coding") return summarizeVibeCoding(results);

  // 兜底：拼接工具输出
  const combined = results.map((r) => r.output).join("\n");
  return `工具返回了以下信息：\n${combined}`;
}

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 20, text: 20, reasoning: undefined },
};

function createDelayedStream(chunks: LanguageModelV3StreamPart[], delayMs = 30): ReadableStream {
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

function makeToolCallChunks(intents: ToolCallIntent[]): LanguageModelV3StreamPart[] {
  const chunks: LanguageModelV3StreamPart[] = [];
  for (const intent of intents) {
    const callId = `call-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const argsJson = JSON.stringify(intent.args);
    chunks.push(
      { type: "tool-input-start", id: callId, toolName: intent.toolName },
      { type: "tool-input-delta", id: callId, delta: argsJson },
      { type: "tool-input-end", id: callId },
      { type: "tool-call", toolCallId: callId, toolName: intent.toolName, input: argsJson },
    );
  }
  chunks.push({ type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage: USAGE });
  return chunks;
}

export function createMockModel(): LanguageModel {
  return {
    specificationVersion: "v3" as const,
    provider: "mock",
    modelId: "mock-model-v0.4.2",

    get supportedUrls() {
      return Promise.resolve({});
    },

    async doGenerate({ prompt }: LanguageModelV3CallOptions) {
      const text = extractUserText(prompt);

      if (text.includes("测试重试") || text.includes("test retry")) {
        retryTestCount++;
        if (retryTestCount <= 2) {
          throw new Error("429 Too Many Requests - Rate limit exceeded");
        }
        retryTestCount = 0;
        return {
          content: [{ type: "text" as const, text: "重试成功！" }],
          finishReason: { unified: "stop" as const, raw: undefined },
          usage: USAGE,
          warnings: [],
        };
      }

      const intents = pickIntents(prompt);
      if (intents && intents.length > 0) {
        return {
          content: intents.map((intent) => ({
            type: "tool-call" as const,
            toolCallId: `call-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            toolName: intent.toolName,
            input: JSON.stringify(intent.args),
          })),
          finishReason: { unified: "tool-calls" as const, raw: undefined },
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
      const text = extractUserText(prompt);

      if (text.includes("测试重试") || text.includes("test retry")) {
        retryTestCount++;
        if (retryTestCount <= 2) {
          throw new Error("429 Too Many Requests - Rate limit exceeded");
        }
        retryTestCount = 0;
        const reply = "重试成功！";
        const id = "text-1";
        const chunks: LanguageModelV3StreamPart[] = [
          { type: "text-start", id },
          ...reply.split("").map((char) => ({ type: "text-delta" as const, id, delta: char })),
          { type: "text-end", id },
          { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: USAGE },
        ];
        return { stream: createDelayedStream(chunks, 30) };
      }

      const intents = pickIntents(prompt);
      if (intents && intents.length > 0) {
        return { stream: createDelayedStream(makeToolCallChunks(intents), 15) };
      }

      const replyText = pickTextResponse(prompt);
      const id = "text-1";
      const chunks: LanguageModelV3StreamPart[] = [
        { type: "text-start", id },
        ...replyText.split("").map((char) => ({ type: "text-delta" as const, id, delta: char })),
        { type: "text-end", id },
        { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: USAGE },
      ];
      return { stream: createDelayedStream(chunks, 15) };
    },
  };
}
