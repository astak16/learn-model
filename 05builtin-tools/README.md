### fast-glob

- `fg`: `pattern` 是 `glob` 的匹配模式，返回匹配到到文件路径数组
- `cwd: resolve(path)`: 设置搜索的根目录，`resolve(path)` 把传入的 `path` 转成绝对路径，作为 `glob` 匹配的基准目录
- `ignore: ["node_modules/**", ".git/**"]`: 忽略搜索的文件目录
- `dot: false`: 不匹配以 `.` 开头的隐藏文件/目录
- `onlyFiles: true`: 结果只包含文件，不包含目录
- `followSymbolicLinks: false`: 遇到 `symlink` 时不要跟进去搜索，避免死循环或者搜索到链接目标外的内容

```ts
const fn = async ({ pattern, path }: { pattern: string; path: string }) => {
  const results = await fg(pattern, {
    cwd: resolve(path),
    ignore: ["node_modules/**", ".git/**"],
    dot: false,
    onlyFiles: true,
    followSymbolicLinks: false,
  });
};
fn({ pattern: "**/*.ts", path: "." });
```

### grepTool

这是一个文本搜索工具，行为类似与 `grep -r`，可以作为 `LLM agent` 工具调用，输入

- `pattern`: 正则表达式，字符串（自动忽略大小写）
- `path`：搜索起点，可以是文件或者目录

判断 `path` 是文件还是目录：

- 目录 -> `walk`，递归遍历，跳过 `node_nodules`、`.git`、`dist` 等
- 文件 -> `searchFile`，按行，用正则匹配，跳过二进制扩展名(图片，字体，`lock` 文件)

```ts
const fn = async ({ pattern, path }: { pattern: string; path: string }) => {
  const baseDir = resolve(path);
  const regex = new RegExp(pattern, "i");
  const matches: string[] = [];
  const SKIP = new Set(["node_modules", ".git", "dist"]);
  const BIN_EXT = new Set([".png", ".jpg", ".gif", ".woff", ".woff2", ".ico", ".lock"]);

  function searchFile(filePath: string) {
    if (matches.length >= 50) return;
    const ext = filePath.slice(filePath.lastIndexOf("."));
    if (BIN_EXT.has(ext)) return;

    let content: string;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      return;
    }

    const lines = content.split("\n");
    const rel = relative(baseDir, filePath);
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) {
        matches.push(`${rel}:${i + 1}: ${lines[i].trimEnd()}`);
        if (matches.length >= 50) return;
      }
    }
  }

  function walk(dir: string) {
    if (matches.length >= 50) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const name of entries) {
      if (SKIP.has(name)) continue;
      const full = join(dir, name);
      try {
        const stat = statSync(full);
        if (stat.isDirectory()) walk(full);
        else searchFile(full);
      } catch {
        /* skip */
      }
    }
  }

  const stat = statSync(baseDir);
  if (stat.isFile()) {
    searchFile(baseDir);
  } else {
    walk(baseDir);
  }
  if (matches.length === 0) return `没有找到匹配 "${pattern}" 的内容`;
  const suffix = matches.length >= 50 ? "\n... (结果已截断，共 50+ 条匹配)" : "";
  console.log(suffix);
};

fn({ pattern: "import.*from", path: "." });
```

### bashTool

这是一个给 `LLM agent` 用的 `shell` 命令工具

分两层保护：

- `echo test`: 先探测环境是否支持
  - `{ stdio: "ignore" }` 忽略输出，`stdin`、`stdout`、`stderr` 全部丢弃
- 执行命令做错误兜底

| 参数                              | 作用                                                                             |
| :-------------------------------- | :------------------------------------------------------------------------------- |
| `encoding: "utf-8"`               | 返回值是字符串而非 `Buffer`                                                      |
| `timeout: 10000`                  | 最多跑 `10` 秒，超时强制杀掉进程                                                 |
| `maxBuffer: 1024 \* 1024`         | 输出内容上限 `1MB`，超出会抛错（防止某条命令刷屏式输出撑爆内存/上下文）          |
| `stdio: ["pipe", "pipe", "pipe"]` | `stdin/stdout/stderr` 都走管道以便捕获（其实是 `execSync` 默认值，这里显式写出） |

```ts
const fn = async ({ command }: { command: string }) => {
  try {
    execSync("echo test", { stdio: "ignore" });
  } catch {
    return `[bash 不可用] 当前环境（WebContainer）不支持 shell 命令。本地终端运行 pnpm start 可使用 bash 工具。`;
  }

  try {
    const output = execSync(command, {
      encoding: "utf-8",
      timeout: 10000,
      maxBuffer: 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });
    console.log(output);
  } catch (err: any) {
    const stderr = err.stderr || "";
    const stdout = err.stdout || "";
    console.log({ stderr, stdout, errStatus: err.status, errMsg: err.message });
  }
};

fn({ command: "ls1" });
```
