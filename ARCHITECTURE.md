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
| P2 ✅已完成 | **架构师（我）** | 合流复核 + **L3 标题兜底**（`chat/title.ts` + `scripts/title.test.mjs`）+ 产物验收（`file://`、子路径、UI 全链路）| `scripts/title.test.mjs` 12 项全绿 ✅ / 浏览器真链路：OpenAI 协议发消息 → 侧栏标题自动生成、刷新后仍在 ✅ / **`file://` 双击直开实测走通一整轮流式对话**（CORS origin=null、Markdown→`<strong>` 正常、标题兜底生效）✅ / 待做：gh-pages 子路径（等 @小码 UI 落地后一次性做）|

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

## 9. 验收记录（全部为实跑，命令可复现）

L2/L5（@小码 `dc9ba60`）、L4（@coder `8962cd4`）、L3 兜底（@架构师 `647aa33`）合流后，我在同一台机器上跑完下列检查：

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型 / 静态检查 | `pnpm type` / `pnpm lint` | 0 error / 0 warning（124 files） |
| 产物 | `pnpm build` | 303ms / 4.5MB / 89 js（1 main + 88 async） |
| 四份脚本验收 | `node --experimental-transform-types scripts/{endpoint,openai-stream,settings-provider,title}.test.mjs` | 4/4 PASS，断言数 **12 / 47 / 16 / 11**（openai 从 40 加到 47，见 §10）|
| UI 全链路（人点） | 设置→服务商→选 OpenAI→填 `http://localhost:8799/`→保存 | 显示「已保存，连接正常」，存储落 `http://localhost:8799`（尾斜杠被规范化去掉） |
| 请求真的换了地址 | stub 网关 `GET /__log` | `GET /v1/models`（校验）+ `POST /v1/chat/completions`（256B） |
| 能力置灰 | DOM 检查 | 附件/语音/搜索 `disabled=true`，tooltip「当前服务商不支持…」 |
| 思考区折叠 | DOM 检查 | 只显示「已思考（用时 1 秒）」，推理正文默认不展开（开关关闭时） |
| 标题兜底 | 刷新后侧栏 | 「从 UI 走一遍完整链路：设置里配好网关后能不能…」，刷新后仍在 |
| `file://` 双击 | 打开 `dist/index.html` 发真消息 | SSE 流式通、`<strong>` 渲染通、标题兜底通（origin=null 被网关放行） |
| gh-pages 子路径 | 把 `dist/` 放进 `/my-org/chat-demo/` 静态服务 | main + `async/535`、`async/3806`、`async/4959`（含 css）全 200，UI 正常挂载 |

**仍未做（有意为之，不属于本轮）**：CI 流水线、README 面向使用者的改写、UI 交互的自动化回归（目前 UI 层靠人点 + 纯函数脚本）。

## 10. 发布前裁决与 v0.6 契约预案

### 10.1 裁决：接受 `9ada723`（stream_options 退化重发）

理由不是「它通过了自己写的测试」，而是**故障形态足够恶劣**：老网关把 `stream_options` 当未知字段返回 400 时，症状是「OpenAI 协议下整条消息发不出去，Anthropic 协议一切正常」，用户必然先怀疑 CORS，排查成本极高、复现条件又苛刻（要碰巧接的是旧版 vLLM/one-api）。

代码复核（我自己读的，不是听汇报）：

- 判定条件窄：`ApiError && status === 400 && /stream_options|include_usage|unknown (field|parameter)|unrecogni[sz]ed/i.test(message)`；模型名不存在之类的 400 **不重试**（有断言）。
- 只重发一次，且发生在出帧之前 → 不可能产生重复内容。
- 退化后本轮如实无 usage，不编造 token 数。

代价（接受）：多一条隐式重试路径；README 必须写明「无 usage 是预期」。

### 10.2 裁决：`endpoint.ts` 继续冻结到 v0.5 发布结束

`@coder` 提的 `provider → { chatPath, modelsPath, filesPath?, supportsUsage, supportsSpeech, supportsFiles, supportsSearch }` 方向正确，`@小码` 也确认 L2 只有一处判能力入口（`services/settings.ts::isAnthropicProtocol()`，四个置灰入口全消费它，无散落 if）。**但现在不动**：发布在即，冻结契约换形状会把「已验证的 v0.5」变成「未验证的 v0.5.1」。

**v0.6 开工第一件事**就是这次升级，形状按上表；届时 `apiBase()` 退化为读取器，`isAnthropicProtocol()` 改成读能力位，L2 四个调用点一行不改。加 Ollama（`/api/chat`、无 `stream_options`、无 files）就是往表里加一行，而不是加第三个分支。

### 10.3 发布形态（三条产物，都已本地验过）

| 形态 | 怎么产出 | 验证状态 |
|---|---|---|
| 静态站点（gh-pages/任意静态机） | `pnpm build` → `dist/` | 子路径 `/my-org/chat-demo/` 下 main + 3 个 async chunk 全 200 ✅ |
| 离线包（双击即用） | `dist/` 打 zip | 解压后 `index.html` 发真消息走通 ✅ |
| 源码开发 | `pnpm dev` | 8090 ✅ |

### 10.4 交付可复现性（采纳 @coder 的审计，并做成命令）

`release/*.zip` 不进版本库（二进制进 git 是另一个坑），改为**可重建**：`scripts/release.sh` 一条命令完成构建 → 打包 → 打印清单哈希。

实测（从源码重建两次，并与既有 zip 逐文件比对）：

```
diff -r --brief <解压的 zip> dist   → 0 行差异
文件数 153 / 4,409,186 字节 / 89 个 js（合入 `834bd1c` 后重出；改一行源码哈希就会变，这是它存在的意义）
清单哈希 ec9782af38e284d6fc9260735fb3e63c2b069d060f50a0ed3e3b2362aaa3f3a1
```

哈希写进了 README：以后谁手里的包对不上这个数，就是「源码变了但包没重出」，发布事故从此可判定而不是靠记忆。

### 10.5 部署：方案 3 的配置文件已实测，不是示例文本

采纳「自己传 `dist/`」作为主路径（变量最少），并交付 `deploy/nginx.conf`。本机装了 nginx 1.31.8，`nginx -t` 通过，且两种形态都真跑过：

| 形态 | 实测 |
|---|---|
| 站点根 = `dist/` | `/index.html` → `no-cache`；主包与 async chunk → `immutable`；`LICENSE` → 1 天；gzip 生效；整页对话正常（真 SSE） |
| 子路径 `/my-org/chat-demo/` | 上述缓存头同样正确；async chunk 200；SPA 回退 200 返回入口 |

配置里特意写了一条注释：**不要把 CORS 加到静态站上**——跨域发生在「浏览器 → API 网关」，在 nginx 上加头只会制造「我配过了」的错觉。

### 10.6 文案即断言（本轮最后一条原则，也是唯一一条适用于所有后续功能的）

发布前 @小码 在一条**没人测过的路径**上找到一个真缺陷：首次使用（无 API Key）保存端点时，状态行显示「已保存，连接正常」——但没有 Key 就不会发出任何请求，这句话在声明一件没发生的事。

改法只有 3 行 + 2 条文案（`d7bb3d2`），但它立下的规矩比改动本身重要：

> **界面上每一句状态描述，都必须对应一次真的发生过的动作。**

同一条原则已经在本轮三次生效：不编造 token 用量（`9ada723` 退化后如实无 usage）、404 不冒到界面上（`8962cd4` 映射成可读原因）、标题不由前端假装服务端下发（`647aa33` 本地兜底并承认是兜底）。

**审查动作**：新增任何 `ok` 类文案时，先问「这条消息背后有没有一次成功的请求/写入」。没有就改成「已保存，尚未校验」这类不撒谎的表述。

**重出产物的固定顺序**（本轮已走两遍，别改顺序）：

1. `git status` 必须干净；
2. `sh scripts/release.sh` → 拿新哈希与字节数；
3. 一次改完三处期望值：`README.md`、`README.zh-CN.md`、本文档 §10.4；
4. `grep -rn "<旧哈希>" . --exclude-dir={node_modules,dist,.git}` 必须 **0 行**；
5. 再跑一次 `sh scripts/release.sh`，哈希必须与第 2 步相同；
6. `unzip` 到临时目录后 `diff -r` 对比 `dist`，必须 0 行差异。

第 5、6 步是防「文档里写的是包里的数」与「包和 HEAD 不是同一份」这两类事故，任一失败就不发。

### 10.7 已知限制：端点地址里的凭据会被静默丢弃（决定：发布后第一个补丁修）

`@小码` 用纯函数直接验过，我复跑确认（`normalizeBaseUrl`）：

```
https://user:token@gw.example.com  → https://gw.example.com     凭据消失
https://user@gw.example.com/v1     → https://gw.example.com/v1   用户名消失，路径保留
https:///gw.example.com            → https://gw.example.com      自愈（畸形输入不崩，白捡的加固）
gw.example.com:abc / https://      → null                        正确拒绝
```

根因不在本轮改造：`endpoint.ts` 从 P0 起就是 `${url.origin}${url.pathname}`，而 URL 规范的 `origin` 本就不含凭据。所以这是**冻结契约里一条没写进注释的隐含行为**。

危害不是崩溃，是**静默丢用户输入**：之后第一次请求会 401 或 CORS 失败，两条文案都把用户引向错误方向，而他真正需要知道的是「你的凭据根本没被发出去」。

**裁决：不在发布前修。** 理由是这条规则适用于所有人：任何源码改动都要重出产物 + 三处哈希同改 + 重验；为一个人为构造的边角（多见于把 token 写进 URL 的文档示例）再转一圈，性价比不对。

**修复方案已定，留给 v0.5.1 第一个 commit**：L2 侧 `useEndpointForm` 在 `saveEndpoint` 前判 authority 是否含 `@`，命中就原地报「地址里不要带用户名/密码，网关鉴权请用 API Key」且不落库。**不动 `endpoint.ts`**——契约冻结期内不改，何况把它改成返回 `null` 会让「等等我配了一个带凭据的地址」变成一句无解释的「地址无效」。

**文档层已先补**（README 中英各一行「暂不支持」），因为 README 不参与打包：改它不改变清单哈希，属于零成本的知情披露。

### 10.8 发布出口：能力已就位，但两个按钮必须用户按

**已确认的事实**（不是推测，`gh` 只读查询 + 本地仓库检查）：

| 事实 | 结论 |
|---|---|
| `gh` 已登录 `larry-tarot`，scope 含 `repo`/`workflow` | 推送不需要额外配凭据 |
| `larry-tarot/chat-app` 存在：private、size 0、`has_pages=false` | 空仓库，可直接推 |
| **`.github/workflows/pages.yml` 早已存在**（继承自上游） | 不需要「加工作流」，需要「让它跑起来」 |
| 六个 action 的 SHA pin（`git/ref/tags` + 注解标签解引用） | 全部与注释版本一致；`pnpm/action-setup@v6.1.1` 是 annotated tag，解引用后 = `73e46992…` |
| 工作流触发条件 `push: branches: [main]` | **首推即触发**，而 Pages 未启用 → 必然红在 `configure-pages` |

**因此顺序不可颠倒**：先启用 Pages（`POST /repos/{owner}/{repo}/pages -f build_type=workflow` 或 Settings → Pages → GitHub Actions），再 push。反过来做，你会白得一次红色的 X，且失败原因和代码毫无关系。

**署名（commit 作者）只能 push 之前定**：历史里 18 个 commit 的作者分布是 `架构师×10 / coder×5 / Yifu×4`，邮箱均为 `*.local` 或 GitHub `noreply`（无真实邮箱进历史）。若要改署名，必须在 `git push` 之前重写历史；push 之后就得对公开仓库 force-push，代价与风险完全不同级。**架构师建议不改**：作者 `Yifu` 就是用户本人，不存在对第三方的归属损害；重写会让 18 个 commit 哈希全变、并作废「哪个产物对应哪个提交」的档案。若真正在意「AI 产出的代码挂在我名下」，正确做法是前向声明（README 一句 AI 协助说明，或此后用 `Co-authored-by` trailer），而不是倒着重写。

**我没有替用户执行的两步，以及为什么**：

1. **把仓库转 public** —— 账号级、对外可见、基本不可逆的动作，不是技术默认值，必须用户点头（免费账号的 Pages 只对 public 仓库开放）。
2. **`git push` 到用户账号** —— 一次对外写入，同样需要授权。

**合规项（本轮补）**：`LICENSE` 是 `Copyright (c) 2026 DeepSeek`，我们是 MIT fork。转为 public 后，README 开头必须声明 fork 关系并保留版权与许可证文本——两个 README 已补，且这是纯文档改动，`release.sh` 复跑确认清单哈希未变（`ec9782af`）。

## 11. v0.5.1 待办清单（发布后第一批，一次重出、一次重验）

这一批不夹带功能，只修「文案与错误指向」这一类问题。*来源：发布前最后两轮的评审，均已由架构师独立复验。*

| # | 问题 | 归属 | 改法 | 可执行验收 |
|---|---|---|---|---|
| ① | **地址可能指向与肉眼不同的主机**（`https://***@evil.example.com` → 存成 `https://evil.example.com`，用户以为配的是 `gw`） | L2 `useEndpointForm`：**`commitBaseUrl()` + `save()` 两处** | 判定只看**原始草稿**的 authority 是否含 `@`；命中就报错、不改写、不规范化、不落库 | **必须从输入框草稿进：粘贴 `https://user:token@gw…` → 失焦 → 草稿原样保留且报错**；只测「粘贴 → 保存」会漏 |
| ② | `network` 文案在全仓 3 个副本，同一原因两个结论 | **L5 规则 + L2/L3 各 1 行** | `services/settings.ts` 增加 `networkFailureKey()`，`describe.ts` / `apiFailure.ts` 只读键不判 source | `grep -rn networkFailureKey src/` 判定点 = 1；L2/L3 不再出现 `source === 'override'` |
| ③ | 网关返回网页时，气泡把整段 HTML 当错误文案 | L4 `readErrorResponse` | 响应体是 HTML 或超长非 JSON → 抛「端点返回的是网页而不是 API 响应，多半地址少了路径，或被登录页/防火墙拦截」 | 探针脚本：两协议各返回 `200 text/html`，断言 `kind==='protocol'` 且 message 不含 `<` |
| ④ | https 页面配 `http://` 端点失败时，界面只说「网络异常/检查 CORS」，不说可能是浏览器拦的 | **L5 规则（与 ② 同一处）+ L3/L2 各 1 行** | **不做保存时判定、不做 host 表**；只在**真的失败之后**追加一句解释：「端点用的是 `http://`，浏览器可能拦下了这次请求（混合内容 / 本地网络权限），请查看控制台」。归属与 ② 同一个 `networkFailureKey()` | 三条：① `http://` 端点 + 网络类失败 → 解释出现 ② `https://` 端点 + 网络类失败 → 不出现 ③ 保存任何 `http://` 端点 → 无任何预先警告 |
| ⑤ | 官方端点可用性 | —（已实测） | 无需改动 | OPTIONS 预检 `ACAO` 回显，`null` 源同样放行 |

**实测依据（架构师独立复跑，2026-11-16）**：

```
OPTIONS https://api.deepseek.com/anthropic/v1/messages
  Origin: https://larry-tarot.github.io → 200 · ACAO 回显该源 · allow-headers: content-type,x-api-key,anthropic-version
  Origin: null（file:// 双击）           → 200 · ACAO: null · allow-credentials: true
```

结论：**默认端点不需要任何 CORS 配置**，三种发布形态直连官方接口都成立；README 已按事实改写（原先像在暗示官方也要配）。

**明确不做的两件**（记入已知限制，不再评估）：
1. 用户把自建地址填成与默认完全相同的 host 时，`source` 仍为 `override`，断网会提示「检查网关 CORS」——技术上不算错，加一个 host 常量比较不值；
2. 历史 commit 署名不改（见 §10.8）。

**批次纪律**：一次改完 → `sh scripts/release.sh` 一次重出 → 三处期望值同改 → `grep -rn` 不得残留旧哈希 → 再跑一遍确认哈希稳定。

### 11.1 ① 的实现纪律（两位在发布前把坑挖到了底，写死避免重犯）

**实测（架构师复跑 `normalizeBaseUrl`，非手算）**：

```
"https://***@evil.example.com"          → "https://evil.example.com"   host=evil.example.com  ← 肉眼像 gw，实际去 evil
"***@evil.example.com"（无协议）         → "https://evil.example.com"   同上
"https://gw.example.com/path@v1"        → 原样保留                     路径里的 @ 合法，不该拦
"https://gw.example.com/?mail=a@b.com"  → "https://gw.example.com"      query 被规范化丢弃（既有契约）
```

所以 ① 不是措辞问题，是**地址可能指向与肉眼不同的主机**，优先级排第一。

**两个必须都改的位置**（`EndpointSettings.tsx:63` 已确认 `onBlur={form.commitBaseUrl}`）：

1. `commitBaseUrl()`（失焦）——它为了显示规范化结果会改写草稿，**凭据在这一刻就被抹掉**，之后 `save()` 再也看不到原始串；
2. `save()`——规范化之前判定，命中直接报错返回。

只在 `save()` 里判＝**真实操作里永远命中不到的死代码**（用户几乎不可能在输入框保持焦点时点保存）；而且 `tsc` 与「测 `saveEndpoint`」的单测都不会报。

**通用教训（比这条 bug 本身值钱）**：*任何会改写用户输入的步骤，都必须先确认这次改写是无损的。* `commitBaseUrl` 对「补 `https://`、去尾斜杠」是善意无损，对凭据是破坏性改写——它把证据抹掉，还让后面每一层都以为一切正常。

**判定写法**：不依赖 `URL` 解析语义（骗过人的恰恰是解析语义），改用与解析无关的兜底——取 `scheme://` 之后、`[/?#]` 之前的那段（authority），含 `@` 即拒绝；`url.username || url.password` 作为第二道。两者都只判**原始草稿**。

**契约层兜底：不做。** 让 `normalizeBaseUrl` 对凭据返回 `null` 会在「历史数据里已存了带凭据地址」时静默回落到默认端点，用户得到一个不一样的地址却没有任何解释。能说出「为什么」的那一层才该拦——这条口径三次评审都没变。

## 12. 发布记录（v0.5 已上线）

**站点**：https://larry-tarot.github.io/chat-app/ ｜ **仓库**：https://github.com/larry-tarot/chat-app （PUBLIC）
**发布提交**：`25ba6cd` ｜ **Pages**：`build_type=workflow`、`https_enforced=true` ｜ **CI**：一次运行，success

### 12.1 架构师独立复核（不采信汇报，逐条自己跑）

```
可见性      gh repo view → visibility=PUBLIC / isPrivate=false
Pages       gh api repos/.../pages → html_url=https://larry-tarot.github.io/chat-app/ · build_type=workflow
CI          gh run list → success @ 25ba6cd（唯一一次运行）
本地/远端   git rev-parse HEAD == ls-remote origin main == 25ba6cd · 工作树干净
线上字节    index.html / main.dc71f29f.js / async/1031.575fa503.js
            线上 sha256 与本地 dist 三者逐一相同
浏览器      https 真 URL：挂载正常、子路径 6 个静态资源全 200（含 async css/js）
仓库卫生    远端无 dist/、无 release/ 误提交
```

### 12.2 跑线上时才暴露的两条事实（已进 README）

1. **GitHub Pages 固定 `cache-control: max-age=600`**，不可自定义。因此 `deploy/nginx.conf` 里那两条精心设计的缓存策略**在 Pages 上不生效**——不是配错，是平台限制。含义：入口壳最长 10 分钟旧（安全侧可接受），带哈希的 chunk 也不会被长期缓存（性能侧损失，但 Pages 免费）。
2. **混合内容**：https 页面里只有 `http://localhost` / `127.0.0.1` 能直连，其余 `http://` 自定义端点会被拦。症状极具误导性——**端点保存能过、发消息毫无反应**，控制台才有 `Mixed Content`。已写进 README「接自建网关前必须确认」。

### 12.3 唯一仍未验证的一项（需要用户手上的东西）

**真实 API Key + 官方端点的完整对话**。预检（CORS 回显任意源，含 `null`）已实测，但 `200 + 真回答` 这一段必须有 Key 才能跑。这不是可以代理完成的验证——留作用户上线后的第一次真实验收。

v0.5.1 三项（`§11`）不受发布影响，按原批次推进：一次改完 → 一次重出 → 三处哈希同改 → 复跑。

### 12.4 ④ 的现场证据（架构师在线上站点复现，非转述）

```
页面 location.protocol = https:
输入 http://192.168.1.10:8080 → 保存
  localStorage.endpoint-base-url = "http://192.168.1.10:8080"
  状态行 = "Saved. Connectivity is checked once an API Key is added."
```

界面**确认了一次永远不可能成功的保存**：该页面上任何发往此地址的请求都会被浏览器混合内容策略丢弃，连页面自己都发不出去。有 Key 时更糟——探针失败会落到「请确认网关已放行 CORS」，把真因（混合内容）指成 CORS。

这与 ① 、② 是同一类：**界面在陈述一件它没有、也无法验证的事**。处理同 ②：判定放在保存前、不落库、给出可执行的原因。判定不需要发请求，只看页面自身协议与端点协议，因此零网络成本、零误报风险（必须带三条放行用例，dev 跑在 `http://localhost:8090` 时不能误伤）。

**两层都要**：README 已写明「自定义端点必须 https，仅 localhost/127.0.0.1 放行」——那是给「还没开始配的人」；④ 是给「正在配的人」。同「置灰 + 404 映射」的逻辑：文档与代码各挡一半，不互相替代。

## 13. 证据效力分级（本轮最大的一次方法论修正）

### 13.1 起点：一台不执行混合内容拦截的自动化浏览器

同一台自动化浏览器（`HeadlessChrome/145`，`isSecureContext: true`，源 `https://larry-tarot.github.io`）上，架构师独立跑出：

```
跨域 fetch https://example.com（无 ACAO）      → BLOCKED TypeError        ⇒ CORS 是强制的
跨域 fetch http://10.109.2.16:8802（本机 LAN，ACAO:*）→ 200 · body=probe-ok  ⇒ 混合内容没有被拦
跨域 fetch http://127.0.0.1:8802               → 200 · body=probe-ok      ⇒ 同上
```

结论不是「这台浏览器不守规矩」，而是**它守一半**：CORS 照常执行，混合内容被放行（`--allow-running-insecure-content` 一类开关）。这条事实一次性影响三类判断：

1. **④ 的前提是规范推导，不是实测**。架构师此前在线上站点观察到「https 页面保存 http 内网端点成功」，那只能证明界面行为；「永远不可能成功」是我按规范补的，**应当标注来源，不该写成实测语气**。
2. **④ 的 host 形态表全部作废（含「已验证」的四行）**：`127.0.0.1` / `localhost.` / `[::1]` 拿到 200 不能证明它们是「可信本地源」被额外放行——这台浏览器**对谁都放行**。用一台没有裁判的场地测「谁能进场」，测出来的四个 200 是同一个假绿。
3. **CORS 相关结论仍然成立**：`example.com` 被拦证明 CORS 强制中，所以「真实浏览器里预检通过、请求真的发出、401 分类正确」这几条不受影响；受影响的只有**混合内容**这一类。

### 13.2 由这次事故直接改掉的两个决定

**(1) ④ 从「硬拦截」降级为「软警告」。**
理由不是「实现麻烦」，而是**证据只到规范级**：浏览器允许站点级/企业策略放开不安全内容（Chrome 的站点设置里就有这一项），硬拦会把在那些环境下本来能通的配置挡死；而按我们自己的规矩（没跑过就不算过），拿规范级证据去做「拒绝保存」是不可接受的。①（凭据）方向相反——那是**我们自己的有损改写**，证据在代码里，所以硬拦。

一句话规则：**证据级别决定处置力度。不可靠的证据只能支撑提示，不能支撑禁止。**

**(2) 加这一节，把「用 C 级手段断言 B 级问题」变成可检查的错误。**
本轮三处「脚本全绿但实际有洞」——`aria-disabled` 只灰不禁用、`onBlur` 在保存前就把草稿改写掉、混合内容假绿——本质都是同一个错误。

| 级别 | 手段 | 能证明 | 不能证明 |
|---|---|---|---|
| **A** | `curl` / `node:http` 探针 / 纯函数脚本 | 协议、帧格式、路径、响应头、值域逻辑 | 浏览器策略（预检执行、混合内容、存储配额） |
| **B** | 普通浏览器手点（非自动化、无放宽开关） | 用户真实可见行为，含浏览器安全策略 | 大规模重复、并发与长跑 |
| **C** | 自动化 headless（本项目默认） | 交互流程、DOM 状态、请求确实发出、文案与布局 | **逐项待定**：CORS ✔（已证强制）、混合内容 ✘（已证放行）——**新策略必须先测这条浏览器守不守，再谈结论** |

**写结论时的强制格式**：`<陈述> [A|B|C]，手段：<命令或操作>`。没有级别的结论一律视为未验证。

### 13.3 混合内容：实测把「一律拦截」推翻了（架构师，独立复现）

上一轮我们依据规范写了「https 页面里只有 localhost 能连 http，其余会被拦」。用**干净启动的 Chrome 157 headless（默认参数，无任何放行开关）** 从线上页面对三个目标发 `fetch(mode:'no-cors')` 隔离策略：

| 目标 | 结果 | 浏览器日志 |
|---|---|---|
| `http://127.0.0.1:8804`（loopback） | **不拦**，`type=opaque` | Mixed Content 警告 |
| `http://10.107.7.233:8804`（**内网 LAN**） | **不拦**，`type=opaque`（`mode:'cors'` 时也拿到 200 + body） | Mixed Content 警告 |
| `http://neverssl.com/`（**公网 http**） | **拦截**，`TypeError: Failed to fetch` | Mixed Content 警告 |
| `https://example.com`（无 ACAO，对照组） | 拦截（CORS），`TypeError` | CORS 报错 |

结论修正：**Chrome 157 对「https → http 内网/loopback」是放行（仅警告），对「https → http 公网」才拦**。因此：

1. 「https 页面配 http 内网网关永远不可能成功」——**错**（我上一轮就是这么写的，据此把 ④ 定为硬拦截，已改）；
2. 正确的用户事实是：内网 http 网关**能用**，公网 http 才需要换 https；
3. ④ 因此从「拦内网 http」改为「只提示公网 http」——**警告必须对应真实会发生的失败**，否则就是 §10.6 那条原则的反面：界面在断言一件不会发生的事。

未测：Safari / Firefox 的逐项行为（Firefox 有 `security.mixed_content.upgrade_display_content` 一类差异），以及 Chrome 未来版本（Local Network Access 权限模型正在演进）。README 已按「Chrome 实测 + 其他浏览器未测」的口径写。

**方法论收益**：这一格如果沿用「规范 + headless 单次观测」，我们会在 README 里长期写着一条错话，并且让 v0.5.1 去做一个基于错前提的拦截。**证据分级不是为了写文档，是为了不在产品里写假话。**

### 13.4 裁决：把「预测浏览器」换成「解释失败」（v0.5.1 的 ④ 由判定改为解释）

两位争论的落点其实一致：**判定权在浏览器，不在我们**。`@coder` 的版本时间线（138 opt-in → 142 默认弹权限 → 145 权限拆分 → 147 扩到 WebSocket → 156 移除 opt-out，`.local` 仍卡在 issue 409972641）说明：任何写进代码的 host 表，都是一张**会过期的快照**。今天正确，下个版本就变成「连接正常」那句话的翻版。

但「删掉 ④」也不完整——用户确实会在「保存能过、发消息没反应」这个状态里卡住，而现有文案会把他指向 CORS。所以采取第三种形态：

> **不做成功前的预测，做失败后的解释。**

实现上落到 ② 已经要建的那个 `networkFailureKey()` 里，多一行判断：

```
真的失败了（network 类） + 端点 baseUrl 是 http:// + 当前页面是 https:
  → 文案追加「浏览器可能拦下了这次请求（混合内容 / 本地网络权限），请看控制台」
```

为什么这个形态是对的，而不是又一次「我们说了不算」的断言：

1. **它陈述的是已经发生的事**（这次请求失败了），不是预测（这次请求会失败）；
2. **它不需要 host 表**：loopback / 私网 / 公网 / `.local` 的差异全部消失，因为它不区分；
3. **证据要求降到最低**：不需要知道 Chrome 哪一版怎么变，只需要知道「http + https 页面 + 失败」这三个我们**自己就能观测**的事实。

一句话规则（补进 §13.1，适用于所有后续功能）：

> **对不由我们决定的系统行为（浏览器策略、网关实现、上游版本），只做失败后的解释，不做成功前的预测。**

**连带结论**：④ 从 v0.5.1 的「一项判定」退化为「② 里的一个分支」，v0.5.1 变成 ①、②（含 ④）、③ 三项，一次重出覆盖。README 仍按 `@小码` 的分浏览器表写（文档可以带版本区间和「未测」标注，产品界面不可以）。
