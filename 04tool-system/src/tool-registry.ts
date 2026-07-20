import { jsonSchema } from "ai";

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  isConcurrencySafe?: boolean;
  isReadOnly?: boolean;
  maxResultChars?: number;
  execute: (input: any) => Promise<unknown>;
}

const DEFAULT_MAX_RESULT_CHARS = 3000;

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();
  private exclusiveLock = false;
  private concurrentCount = 0;
  private waitQueue: Array<() => void> = [];

  register(...tools: ToolDefinition[]): void {
    for (const tool of tools) {
      this.tools.set(tool.name, tool);
    }
  }
  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  getAll(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  private async acquireConcurrent() {
    while (this.exclusiveLock) {
      await new Promise<void>((r) => this.waitQueue.push(r));
    }
    this.concurrentCount++;
  }
  private releaseConcurrent() {
    this.concurrentCount--;
    if (this.concurrentCount === 0) this.drainQueue();
  }

  private async acquireExclusive() {
    while (this.exclusiveLock || this.concurrentCount > 0) {
      await new Promise<void>((r) => this.waitQueue.push(r));
    }
    this.exclusiveLock = true;
  }

  private async releaseExclusive() {
    this.exclusiveLock = false;
    this.drainQueue();
  }

  private drainQueue() {
    const waiting = this.waitQueue.splice(0);
    for (const r of waiting) r();
  }

  toAISDKFormat(): Record<string, any> {
    const result: Record<string, any> = {};
    for (const [name, tool] of this.tools) {
      const maxChars = tool.maxResultChars;
      const executeFn = tool.execute;
      const isSafe = tool.isConcurrencySafe;
      const register = this;

      result[name] = {
        description: tool.description,
        inputSchema: jsonSchema(tool.parameters),
        execute: async (input: any) => {
          if (isSafe) {
            await register.acquireConcurrent();
            console.log(` [并发] ${name} 获取共享锁`);
          } else {
            await register.acquireExclusive();
            console.log(` [串行] ${name} 获取独占锁，等待其他工具完成`);
          }
          try {
            const raw = await executeFn(input);
            const text = typeof raw === "string" ? raw : JSON.stringify(raw);
            return truncateResult(text, maxChars);
          } finally {
            if (isSafe) {
              register.releaseConcurrent();
            } else {
              register.releaseExclusive();
            }
          }
        },
      };
    }
    return result;
  }
}

export function truncateResult(text: string, maxChars: number = DEFAULT_MAX_RESULT_CHARS): string {
  if (text.length <= maxChars) return text;

  const headSize = Math.floor(maxChars * 0.6);
  const tailSize = maxChars - headSize;
  const head = text.slice(0, headSize);
  const tail = text.slice(-tailSize);
  const dropped = text.length - headSize - tailSize;
  return `${head}\n\n... [省略 ${dropped} 字符] ...\n\n${tail}`;
}
