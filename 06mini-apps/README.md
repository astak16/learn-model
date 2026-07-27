上一篇把骨架搭好了：一个 `agentLoop`，一套带并发/独占锁的 `ToolRegistry`，一套指数退避 + 抖动的重试逻辑。骨架本身很朴素——不过是"发消息、跑工具、把结果塞回去、再问一次模型"的循环，外加十来个读文件、写文件、抓网页的工具。

这一篇不改骨架，只回答一个问题：**同一套工具，怎么组装出三种完全不同的应用？**

答案不在工具里，而在两个地方：给模型的"执行剧本"（system prompt 里那段策略描述），以及工具本身的读写语义如何反过来决定了并发策略。三个 demo——代码分析、Research Agent、Vibe Coding——用的是同一批工具（`list_directory`、`grep`、`fetch_url`、`write_file`、`start_preview`……），组装方式不同，长出来的"应用"形态就完全不同。

## 一、代码分析：读代码的顺序，就是策略本身

system prompt 里给代码分析场景写的策略是这样的：

```
先 list_directory 看结构 → grep 定位关键内容 → 必要时 read_file 看细节 → 最后给出归纳总结
```

这其实是把一个有经验的开发者拿到陌生项目时的本能顺序，显式写成了脚本：先鸟瞰目录结构，再用搜索缩小范围，只有真正需要细节时才去整篇读文件。这个顺序本身就是在替模型省 token——`grep` 返回的是"文件名:行号:内容"这种高信息密度的摘要，比一上来 `read_file` 读一整个文件划算得多。

`grep` 工具的实现也在替这个策略兜底：跳过 `node_modules`、`.git`、`dist`，跳过图片字体等二进制扩展名，命中 50 条就截断并在末尾标注"结果已截断"。这些细节保证了即使目录很大，一次搜索也不会把 context 撑爆——这和上一篇 `truncateResult` 的头尾截断是同一个思路：**工具的职责不只是"做完事情"，还包括"把结果控制在模型消化得了的尺寸里"**。

真正把这个 demo 变成"应用"的，是最后一步的归纳:模型看到 `grep` 返回的原始行，按文件分组、统计每个文件里有几处 TODO/FIXME，还会补一句"建议优先处理 FIXME"。工具只负责搬运原始数据，结构化和判断是模型在结果之上做的——这也是为什么代码分析这类任务特别适合"先搜索、后总结"这种两段式设计。

## 二、Research Agent：并发安全，是从工具语义里长出来的

Research 场景的策略更简单："抓到 URL 就用 `fetch_url` 抓，多个 URL 可以并行。"

这句"可以并行"不是随口一说，它是 `ToolRegistry` 并发锁设计的直接受益者。回顾一下锁的分类:

```ts
if (isSafe) {
  await registry.acquireConcurrent(); // 共享锁：多个只读工具可以同时跑
} else {
  await registry.acquireExclusive(); // 独占锁：读写工具必须排队
}
```

`fetch_url` 被标记成 `isConcurrencySafe: true`——它只读网络、不碰本地状态，同时抓三个页面互不干扰，天然可以并行。而 `write_file`、`bash`、`start_preview` 全部是 `isConcurrencySafe: false`：它们会改变文件系统或进程状态，一旦并行执行，写入顺序、文件覆盖的先后就完全不可控。

这就是为什么 Research Agent 和 Vibe Coding 在"并行还是串行"这件事上走向了两个极端——**不是策略设计者拍脑袋决定的，而是工具本身的读写属性决定的**。并发安全应该是工具的固有属性,而不是调用方每次去猜。

摘要环节也分了单页/多页两条路径：只抓一个页面时逐句提炼要点；抓了多个页面时退化成每页摘一句做对比列表。这是个务实的取舍——多页面的深度综合摘要需要更强的推理能力，mock 模型没有能力做到，索性做最简单但足够可用的并列摘要，把"综合判断"这部分留给真实模型去接管。

## 三、Vibe Coding：从"生成代码"到"生成一个能跑的应用"

这是三个 demo 里最重的一个，因为它不只是调工具，还要解决"生成的代码怎么立刻跑起来给用户看"这个问题。

### 3.1 一个不让 Agent 碰的 bootstrap

`index.html` 里塞了一段浏览器端零构建的编译流水线：用 import maps 把 `react`、`react-dom` 指向 esm.sh 的 CDN 地址，再用 Babel Standalone 在浏览器里实时把 TSX 编译成 JS：

```js
async function loadModule(url) {
  if (cache.has(url)) return cache.get(url);
  const src = await (await fetch(url)).text();
  const compiled = transform(src, {
    presets: [
      ["react", { runtime: "automatic" }],
      ["typescript", { allExtensions: true, isTSX: true }],
    ],
  }).code;
  const resolved = await rewriteRelativeImports(compiled, url);
  const blobUrl = URL.createObjectURL(new Blob([resolved], { type: "application/javascript" }));
  cache.set(url, blobUrl);
  return blobUrl;
}
```

`rewriteRelativeImports` 用正则找出 `from './xxx'` 这样的相对导入，递归调用 `loadModule` 把每个依赖也编译成 blob URL 再替换回去——这就是为什么组件之间可以互相 `import`，却完全不需要 webpack、esbuild 之类的构建工具。整个"项目"跑在几个 blob URL 拼出来的模块图里。

正因为这套 bootstrap 已经能自洽运行，system prompt 里明确写了一条硬约束：

```
你**禁止**写入或修改 app/index.html（它已经能正确工作）
```

这条约束的意义在于**收窄 Agent 的自由度**——生成式代码最怕的就是"顺手把能跑的东西改坏"，与其指望模型每次都记得"这个文件很关键别动它"，不如直接在策略里划出一块禁区。Agent 只需要对付三类文件：样式、组件、入口，其余的交给固定的基础设施。

### 3.2 写文件的顺序，也是一种约定

Vibe Coding 的执行计划是固定顺序：

```
write_file(styles.css) → write_file(Button.tsx) → write_file(App.tsx) → start_preview()
```

这个顺序背后有两层考虑。第一层是依赖顺序——`App.tsx` 里 `import { Button } from './Button.tsx'`，虽然浏览器端是按需编译、理论上顺序不敏感，但先写被依赖的文件、后写入口文件，是更符合直觉、也更容易调试的写法。第二层是 `write_file` 天生独占锁——即使模型想把这几次写入并行发出去，`ToolRegistry` 也会强制它们排队执行，不会出现"App.tsx 写到一半、Button.tsx 还没落盘"这种半成品状态。

最后一步 `start_preview` 被 system prompt 标成"绝对不能省"，这也是刻意的：生成代码这件事的完成标志不是"文件都写完了"，而是"用户能在预览地址里看到东西在跑"。`start_preview` 起一个本地静态服务器把 `app/` 目录暴露出来，同时做了个很小但重要的安全检查——校验请求路径没有跳出 `app/` 根目录，防止路径穿越读到项目外的文件。

## 四、三个应用背后是同一套骨架

回头看，三个 demo 没有引入任何新的执行机制——`agentLoop` 还是那个 `agentLoop`，重试还是同一套 `isRetryable` + 指数退避，`ToolRegistry` 的锁还是同一套共享/独占逻辑。真正变化的只有两件事：

- **给模型的执行剧本不同**：代码分析是"先鸟瞰再搜索再总结"，Research 是"能并行就并行、按结果多少切摘要策略"，Vibe Coding 是"哪些文件能碰、哪些不能碰、什么时候必须起预览"。
- **工具的读写语义决定了并发策略**，而不是每个场景单独设计——`fetch_url` 只读所以能并行，`write_file`/`start_preview` 有副作用所以必须排队，这条规则在三个 demo 里是一致的。

顺带一提，`mock-model.ts` 用关键词和 URL 正则去识别这三种场景、伪造出对应的工具调用序列，这样调试整条链路——重试、并发锁、预览服务器——完全不需要真实的模型 API key，也不会因为模型的不确定性掩盖掉编排层本身的 bug。等编排逻辑跑通了，换成真实模型（比如接入的 `qwen-plus-latest`）时，行为上的差异才是模型推理能力本身的差异，而不是骨架的问题。

真正决定一个 Agent 能装成什么应用的，往往不是又发明了多少新工具，而是有没有把已有工具的读写边界、执行顺序和禁区想清楚,写进它能听懂的那份剧本里。

## 在浏览器中访问 ES Module

它的核心目标是

```
App.tsx
  ↓ fetch 下载源码
Babel 编译 TSX/TypeScript
  ↓
找到 ./xxx 相对导入
  ↓
递归下载并编译依赖
  ↓
把相对路径替换成 blob: URL
  ↓
生成当前模块的 blob: URL
  ↓
import(blobUrl) 执行模块
```

> 浏览器原本不能直接执行 `.tsx` 文件，所以先用 `fetch` 下载 `TSX` 源码，再用 `Babel` 转成普通 `JavaScript`；然后把相对依赖也递归处理成浏览器可以加载的 `Blob URL`，最后通过动态 `import()` 执行

### importmap

`importmap` 可以理解为导入映射表，正常情况下，浏览器只能直接导入完整 `URL` 或相对路径

```js
import React from "https://esm.sh/react@18.3.1";
```

不认识

```js
import React from "react";
```

因为 `"react"` 既不是：

```
./react.js
../react.js
/react.js
https://...
```

`importmap` 就是告诉浏览器：

```
看到 "react"
就替换成
"https://esm.sh/react@18.3.1"
```

```js
import React from "react";
// 等价于
import React from "https://esm.sh/react@18.3.1";
```

### Babel 的 transform

```js
import { transform } from "standalone";
```

`transform` 用于把源码转换成浏览器可以执行的 `JavaScript`

例如输入：

```ts
interface User {
  name: string;
}

const user: User = {
  name: "张三",
};

export default function App() {
  return <div>{user.name}</div>;
}
```

经过 `Babel` 后，可能得到类似

```js
import { jsx as _jsx } from "react/jsx-runtime";

const user = {
  name: "张三",
};

export default function App() {
  return _jsx("div", {
    children: user.name,
  });
}
```

### 模块缓存

这里创建了一个 Map，用于缓存已经处理过的模块

其中：

- `key`：原始模块的绝对 `URL`
- `value`：编译后生成的 `Blob URL`

```js
Map {
  "https://example.com/App.tsx" =>
    "blob:https://example.com/xxx",

  "https://example.com/components/Button.tsx" =>
    "blob:https://example.com/yyy"
}
```

缓存有两个作用：

1. 防止重复下载和编译
2. 保持模块身份一致

比如两个模块都引入了 `Button` 组件

```ts
import Button from "./Button.tsx";
```

没有缓存会：

- 下载两次
- `Babel` 编译两次
- 创建两个 `Blob URL`

### Babel 编译源码

```js
const compiled = transform(src, {
  presets: [
    ["react", { runtime: "automatic" }],
    ["typescript", { allExtensions: true, isTSX: true }],
  ],
  filename: url,
}).code;
```

`transform` 的第一个参数 `src` 是文件内容的字符串

第二个参数的 `presets` 取值:

- `["react", {runtime: "automatic"}]`
  - `react` 有两种模式 `classic` 或者 `automatic`
    - `classic`
      ```js
      React.createElement("div", null, "Hello");
      // 通常要写下面这个
      import React from "react";
      ```
    - `automatic`
      ```js
      import { jsx } from "react/jsx-runtime";
      // 不用写下面这个
      // import React from "react";
      //
      // 但是要配置
      "react/jsx-runtime": "..."
      ```
- `["typescript", { allExtensions: true, isTSX: true }]`
  - `allExtensions: true`: 告诉 `Babel` 不要只根据文件扩展名判断是否启用 `TypeScript` 解析，所有输入都按照 `TypeScript` 语法处理。因为这里的源码是通过字符串传入 `Babel` 的，`Babel` 并不一定像构建工具那样完整感知真实文件系统
  - `isTSX: true`: 告诉 `Babel` 文件允许出现 `JSX` 语法，即使是 `js` 或者 `ts` 也要按照 `tsx` 的方式解析

第三个参数 `filename`，作用是把当前模块 URL 作为 Babel 的文件名。

例如：

```
https://example.com/src/App.tsx
```

它主要有以下作用：

1. 错误信息中显示具体文件地址
2. 帮助 `Babel` 判断文件类型
3. 便于调试
4. 某些 `Babel` 插件会读取文件名

例如编译失败时，错误信息可能包含：

```
https://example.com/src/App.tsx: Unexpected token
```

比只显示：

```
unknown: Unexpected token
```

更容易定位问题

### rewriteRelativeImports

`rewriteRelativeImports` 函数的是改写相对导入

作用是把

```js
code = `
  import Button from "./components/Button.tsx";
`;

baseUrl = "https://example.com/src/App.tsx";
```

变成

```js
import Button from "blob:https://example.com/xxx";
```

它接收的参数 `code` 是 `transform` 转义后的代码，`url` 是当前模块的原始 `url`

为什么不能保留相对路径？

`Blob URL` 并没有正常的目录结构，无法按原始文件位置解析相对路径

浏览器的 `URL` 可以把相对路径变成绝对路径

```js
new URL("/shared/a.ts", "https://a.com/src/App.tsx").href; // -> https://a.com/shared/a.ts'
new URL("./shared/a.ts", "https://a.com/src/App.tsx").href; // -> https://a.com/src/shared/a.ts'
```

### Blob

`Blob` 可以理解为浏览器内存中的一个文件对象

构造 `Blob` 的第一个参数是 `[resolved]`，这里的 `resolved` 是一串字符串代码，

`type: "application/javascript"`，表示这个 Blob 的 MIME 类型是 JavaScript，它告诉浏览器：这段 `Blob` 内容是 `JavaScript` 模块

```js
new Blob([resolved], {
  type: "application/javascript",
});
```

`Blob` 本身只是一个内存对象，不能直接写进 `import()`，所以需要使用 `URL.createObjectURL(blob)`，然后可以被 `await import(blobUrl)`
