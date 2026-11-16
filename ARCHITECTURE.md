# chat-demo 架构说明 · v0.1（架构师出稿）

> 事实来源：`~/projects/chat-demo`（fork 自 deepseek-ai/chat-demo@main），所有数字均为本地实测，非估计。

实测基线：`src` 下 TS/TSX **14,517 行 / 166 个文件**；`pnpm install` 9.3s，`pnpm build` **288ms**，产物 `dist/` **4.5MB**（js 3.3MB / media 1.1MB / css 112K），主包 `main.9820cd3a.js` 464KB，另有 **88 个 async chunk**（正文按需加载已成立）。

---

## 1. 一句话架构

**没有后端的一层**：静态 SPA 直接用浏览器连 `https://api.deepseek.com` 的 Anthropic Messages 兼容接口，会话与附件存 IndexedDB，设置存 localStorage。整个"服务端"被删掉，代价是用户自带 Key。

```
┌─ L0 构建层  rspack.config.ts ─────────────────────────────┐
│  DefinePlugin: __API_ORIGIN__ = 'https://api.deepseek.com' │  ← 唯一致命硬编码点
│  swc(TSX) · lightningcss(CSS Modules) · publicPath:'auto'  │
│  HtmlRspackPlugin: scriptLoading:'defer'  ← 为 file:// 服务 │
└──────────────────────────────┬────────────────────────────┘
┌─ L1 应用层  src/app (321 行) ─┴────────────────────────────┐
│  App.tsx 布局壳 · theme.ts/theme.css · viewport.ts(移动端) │
└──────────────────────────────┬────────────────────────────┘
┌─ L2 组件层  src/components (5,888 行) ────────────────────┐
│  base(Button/Modal/Select/Toast/Tooltip/anchored 定位/icons)│
│  chatInput(+VoiceButton/Spectrum/DraftAttachments/DragMask) │
│  messages(MessageList/UserMessage/AssistantMessage/ReplyArea)│
│  markdown(MarkdownAstRenderer/CodeBlock/MermaidDiagram/KaTeX)│
│  files · search(来源卡片) · session · settings · sider       │
└──────────────────────────────┬────────────────────────────┘
┌─ L3 状态层  src/services/chat ─┴──────────────────────────┐
│  store.ts 1094 行  zustand 单 store（会话/流控制器/错误位） │
│  branches.ts       消息树：parentId + selectedChildId       │
│  reply.ts  347 行  流事件 → AssistantMessage.blocks[] 归约  │
│  view.ts   400 行  消息 → ReplyView{steps,answer,sources}   │
│  db.ts     251 行  IndexedDB + staging 两阶段提交           │
│  history/  导入导出 ZIP（schema/zipReader/zipWriter/toLocal）│
└──────────────────────────────┬────────────────────────────┘
┌─ L4 协议层  src/services/api ─┴───────────────────────────┐
│  client.ts 189  request()/verifyApiKey()/streamMessage()    │
│  sse.ts    136  手写 SSE decoder（分片/UTF-8/lastEventId）  │
│  parseEvent.ts 231  事件帧 → MessageStreamEvent（类型守卫） │
│  types.ts  260  协议类型：thinking/server_tool_use/citations│
│  speech.ts · errors.ts(分类 unauthorized/network/...)       │
└──────────────────────────────┬────────────────────────────┘
┌─ L5 存储层 ──────────────────┴────────────────────────────┐
│  localStorage：apiKey/locale/theme/location/ttsVoice/...    │
│  IndexedDB(idb)：sessions · sessionSummaries · files        │
│                 + *Staging（导入前落盘，commitStaging 原子化）│
└───────────────────────────────────────────────────────────┘
```

## 2. 一条消息的完整链路（这是套代码最有价值的部分）

```
sendMessage(sessionId)
  → toRequestMessages(history, question)        reply.ts：按轮次裁上下文
  → streamMessage()  ─── HTTP POST /anthropic/v1/messages (SSE)
  → ServerSentEventDecoder → readMessageEvent   sse.ts / parseEvent.ts
  → applyEvent(reply, event)                    reply.ts：事件归约，幂等
  → AssistantMessage.blocks[]  (ThinkingPart | TextPart | ServerToolBlock)
  → buildReplyView(reply, streaming)            view.ts：块序列 → 步骤视图
  → ReplyView{steps[], answer, sources[]}       ← UI 只吃这个
  → saveSession() → db.ts（写 sessions + files）
```

**单向、三段隔离**：`UI 不解析协议`（只认 `ReplyView`）、`协议不进组件`、`归约与投影分离`（`reply.ts` 归约，`view.ts` 投影）。改造必须守住这条边界——所有新 provider 的差异都在 L4/L3 消化掉，**L2 一行不改**。

## 3. 五个关键判断：保留 / 改造 / 放弃

| 项 | 决策 | 理由 |
|---|---|---|
| 手写 SSE decoder | **保留** | `file://` + 多 provider 都要它；不引第三方 |
| `__API_ORIGIN__` 构建期常量 | **改造（本轮核心）** | 现在"URL 不能填"是产品级缺陷；改为运行时配置 |
| Anthropic Messages 协议 | **保留为 Provider A，新增 OpenAI 兼容 Provider B** | 用户已有 `~/projects/ai-chat-web` 走 OpenAI 协议，两条腿都要 |
| store.ts 1094 行单 store | **暂留，加 selector 边界** | 重构成本高、收益低；先冻结对外 API，内部再拆 |
| localStorage 存 API Key | **保留，但显式风险提示 + 可选 sessionStorage** | 换 sessionStorage 会毁掉"双击 index.html 免登录"体验 |
| PWA / SW / manifest | **v0.5 不做** | 与 `file://` 直开互斥；等真有安装需求再上 |

## 4. 模块契约（本轮冻结，实现方照此编码）

```ts
// 新增 src/services/api/endpoint.ts —— 端点配置的唯一真相源
export type Protocol = 'anthropic-messages' | 'openai-chat'
export type EndpointConfig = {
  protocol: Protocol
  baseUrl: string        // 不带尾斜杠；运行时来自 localStorage
  source: 'override' | 'default'
}
// 注意：API Key 不归 endpoint.ts 保管（仍由 settings.ts 所有），避免与 zustand store 循环依赖
/** 解析顺序：本地设置 → 构建期默认值（__API_ORIGIN__ + deepseek-anthropic） */
export const resolveEndpoint = (): EndpointConfig
export const setEndpointOverride = (patch: Partial<EndpointConfig>) => void
export const clearEndpointOverride = () => void
```

三条硬约束：
1. **所有出网请求只能走 `client.ts` 的 `request()` / `streamMessage()`**，签名不变；`endpoint.ts` 不 import `settings.ts`（zustand 循环依赖），由调用方注入。
2. `client.ts` 里 `API_ORIGIN` 常量降级为 **default fallback**，不得再被模块顶层求值进 URL 字符串。
3. L2 组件**只允许** import：`chat/store.ts`、`chat/view.ts`、`chat/types.ts`、`services/settings.ts`、`i18n`。**不得新增**对 `services/api/*` 的直接引用。
   - 复核结果：全量 grep `src/components` → `services/api`，只有 **2 处**且都是上游既有：`settings/useApiKeyForm.ts`（存 Key 前 `verifyApiKey`）、`chatInput/useVoiceInput.ts`（`transcribe`）。两者都是**流外的一次性调用**，绕 store 反而制造耦合，**列为豁免**；新增第三处需在本 thread 申报。
   - @coder 的 `fbe2e0f` 未新增任何 L2→api 引用，`openai.ts` 只被 `client.ts` 引用，边界干净。

## 5. 任务分解（本轮）

| 阶段 | 归属 | 交付物 | 验收（可执行） |
|---|---|---|---|
| P0 ✅已完成 | **架构师（我）** | 仓库落地 `~/projects/chat-demo`、`ARCHITECTURE.md`、`src/services/api/endpoint.ts`（已实现，12 项验收全绿）、`scripts/endpoint.test.mjs` | `pnpm type` 0 error ✅ / `pnpm build` 269ms 4.5MB ✅ / `pnpm dev` 8090 HTTP 200 且 UI 已挂载 ✅ / `node scripts/endpoint.test.mjs` 12 PASS ✅ |
| P1-a ✅已完成 `fbe2e0f` | **@coder** | L4 provider 层：`openai.ts` 适配 + `transport.ts` 抽离（解循环依赖）+ `client.ts`/`speech.ts` 走 `resolveEndpoint()` | `node --experimental-transform-types scripts/openai-stream.test.mjs` 36 项全绿 ✅ / `pnpm type` 0 err / `pnpm lint` 0 warn ✅ |
| P1-b | **@小码** | L2/L5：`SettingsDialog` 新增「服务商 / 端点地址」分区 + zh/en i18n + 设置键迁移 v1→v2 + 存 Key 前的 `verifyApiKey` 走新配置 | 手动点：填错 URL → 中文明确报错「网关未放行 CORS」；切换 provider 后刷新不丢配置 |
| P2 ✅已完成 `647aa33` | **架构师（我）** | 合流复核 + **L3 标题兜底**（`chat/title.ts` + `scripts/title.test.mjs`）+ 产物验收 | `scripts/title.test.mjs` 12 项全绿 ✅ / 浏览器真链路：OpenAI 协议发消息 → 侧栏标题自动生成、刷新后仍在 ✅ / **`file://` 双击直开实测走通一整轮流式对话**（CORS origin=null、Markdown→`<strong>` 正常、标题兜底生效）✅ / 待做：gh-pages 子路径（等 @小码 UI 落地后一次性做）|

依赖顺序：**我出 `endpoint.ts` 桩 → @coder 实现 → @小码 接 UI**。接口本轮冻结，谁要改先在本 thread 说。

## 6. 风险清单（按爆炸半径排序）

1. **CORS 是 DeepSeek 专属特权**：实测它把任何 Origin（含 `null`）原样反射回写。换自家网关 100% 会挂 → 网络错误必须能识别并给出"检查网关 CORS"的可读提示（@小码）。
2. **provider 协议断层**：`thinking` / `server_tool_use` / `citations` 是 DeepSeek 扩展块，OpenAI 协议下**不存在**。`view.ts` 必须容忍空块序列，否则接 OpenAI 端点会白屏（@coder + 我复核）。
3. **`file://` 下 IndexedDB 不稳**（Safari 隐私模式）：已有 `initError` 分支，改造中不得删。
4. **导入 ZIP 会整体替换本地数据**（`replaceHistory`）：加"端点配置"后用户更可能多环境切换，导入前必须二次确认。
5. **无测试框架**（`package.json` 无 test script）：P1 的验收用 Node 脚本回放 SSE 帧，不引入 jest/vitest，避免动构建链。

## 7. 协议能力矩阵（v0.5 实测，不是推测）

`Anthropic 兼容` = DeepSeek 官方接口；`OpenAI 兼容` = 自建网关/中转站。缺能力的项**必须在 UI 上显式禁用**，靠 404 兜底是最差体验。

| 能力 | Anthropic 兼容 | OpenAI 兼容 | 处理方式 |
|---|---|---|---|
| 流式正文 | ✅ | ✅ | `openai.ts` → `TextPart` |
| 深度思考 | ✅ `thinking` 块 | ⚠️ 看网关是否下发 `reasoning_content`/`reasoning` | 有就产出 `ThinkingPart`，**不丢数据**；显示由 L2 按开关默认折叠 |
| 联网搜索 / 读链接 / 引用 | ✅ `server_tool_use` + `citations` | ❌ 无等价 | `search` 开关在 OpenAI 协议下置灰 |
| 附件上传 / 图片 | ✅ Files API | ❌ 无等价（**L4 明确报 `ApiError('protocol')`，不静默降级**） | 上传入口置灰 + 文案「当前服务商不支持附件」 |
| 语音输入 / 朗读 | ✅ `/v1/tools/asr|tts` | ❌ 404 | 入口置灰；L4 把 404/405 映射成 `protocol` 类错误带可读文案 |
| 会话标题 | ✅ `delta.title` | ❌ 无 | **L3 兜底**：`chat/title.ts` 用首条用户消息截断，已实测 |
| 消息分支 / 编辑 / 重生成 | ✅ | ✅ | 纯本地（`branches.ts`），协议无关 |
| 续写 | ✅ | ✅ `finish_reason=max_tokens` | 已有 |

## 8. 三个跨层裁决（本轮定案，勿再讨论）

1. **标题兜底归 L3，不归 L4**：L4 不知道「会话」存在，接受。实现：`src/services/chat/title.ts` 纯函数 + `store.ts` 在 `finally` 里 `applyFallbackTitle`，只在 `status ∈ {done, stopped}`、标题为空、非导入中时写入。实测：OpenAI 协议发一条 → 侧栏立刻出现「帮我验一下切换到兼容协议后会话标题还会不会一直是…」，刷新后仍在（已落 IndexedDB）。
2. **语音/上传/搜索在 OpenAI 协议下置灰（L2），不是弹 404**：L4 已把上传改成明确的 `protocol` 报错，语音仍需 L4 把 404 映射为可读错误作为**防御层**。两层都要，别互相依赖。
3. **thinking 开关只控「请求」，不控「显示」**：网关收到 disabled 仍可能下发推理内容，L4 照常产出（数据不丢）。L2 的唯一动作是**默认折叠**（`defaultOpen = settings.thinking`），不是隐藏——隐藏会让转录与上游不一致。
