## JSON 流式输出

流式输出 `json`，需要使用自定义格式，结构完全由你自己定义

```ts
type DeltaPayload = { type: "delta"; index: number; content: string };
type StartPayload = { type: "start"; id: string };
type StopPayload = { type: "stop"; reason: string; totalTokens: number };
```
