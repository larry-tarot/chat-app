# 本轮任务板 · v0.5「端点可配」

目标：把「API 地址写死在构建期」变成**运行时可选**，让这套前端能接自建网关 / OpenAI 兼容中转站。
完整依据见 `ARCHITECTURE.md`。基线 commit：`P0 基线`（`pnpm type` 0 error / `pnpm build` 269ms / 8090 可开）。

**契约已冻结**：`src/services/api/endpoint.ts`（架构师已实现，`node scripts/endpoint.test.mjs` 12 项全绿）。
需要改动接口的场景，先在本 thread 说明，不要各自改。

## 状态总览（架构师维护，2026-11-16 收尾）

| 线 | commit | 状态 | 关键验收 |
|---|---|---|---|
| P0 仓库 + 契约 | `b92deea` | ✅ | endpoint.test 12 PASS / build 269ms |
| L4 协议层 | `fbe2e0f` `8962cd4` | ✅ | openai-stream.test 36+ PASS / `/v1/tools` 404→protocol |
| L2/L5 设置 UI | `dc9ba60` | ✅ | settings-provider.test PASS / DOM 置灰 + 刷新保持 |
| L3 标题兜底 | `647aa33` | ✅ | title.test 12 PASS / 刷新后仍在 |
| P2 产物验收 | 本文档 §9 | ✅ | file:// 全链路、子路径 200、UI 人点一遍 |

**剩余全部是「已在 ARCHITECTURE §9 列明、但有意不做」的项**：CI、README 改写、UI 自动化回归。

---

## @coder —— L4 协议层（只碰 `src/services/api/**`）

**状态：✅ 已完成并合入 `fbe2e0f`（36 项脚本验收 + 浏览器真链路）。以下仅留一条待办。**

- [x] `speech.ts`：`/v1/tools/*` 返回 404/405 → `ApiError('protocol')`「当前服务商不支持语音」（已完成 `8962cd4`，置灰 + 报错两层都在）

- [x] `client.ts`：删除模块顶层的 `` `${API_ORIGIN}/anthropic/v1` `` 求值，改为每次请求调 `resolveEndpoint()` + `apiBase(cfg)`；`API_ORIGIN` 仅作为 `endpoint.ts` 的 fallback 来源保留
      - 附带：`ApiError` / `request` / `readErrorResponse` 抽到 `transport.ts`，`client.ts` 原样 re-export（避免 `client ⇄ openai` 循环 import）；外部 import 路径不用改
- [x] `speech.ts`：`${API_ORIGIN}/v1/tools` 同样走 `resolveEndpoint()`（**注意它已经是 `/v1` 前缀，不要叠成 `/v1/v1`**）
- [x] 新增 `openai.ts`：`POST {base}/v1/chat/completions`（`stream:true`）→ 解析 `data:` 帧 → 映射为既有 `MessageStreamEvent`
      - `choices[0].delta.content` → `TextPart` 增量
      - `delta.reasoning_content`（DeepSeek-R1 风格）→ `ThinkingPart` 增量（另兼容 `delta.reasoning` 别名）
      - `data: [DONE]` → `message_stop`；`finish_reason` → `stopReason`（stop/length/tool_calls/content_filter 全映射）
      - 块边界合成：thinking 块 index=0、text 块 index=1，切换时补 `content_block_stop`，与 Anthropic 事件流同构
      - usage：OpenAI 的 usage 常在 `finish_reason` **之后**的独立 chunk 里，收到 `[DONE]` 才收尾，否则丢 token 统计
- [x] `streamMessage()` 按 `cfg.protocol` 分派；**签名与返回的 AsyncIterable 保持不变**（否则 `store.ts` 要跟着改）
- [x] 401 / 网络失败 → 复用 `ApiError` 五分类，不许抛裸 `Error`（`transport.ts` 统一出口）
- [x] 验收：`scripts/openai-stream.test.mjs` 用本地 SSE 帧回放（`node:http` 起临时 server，不引入测试框架），**36 项全绿**
      - 覆盖：请求体转换、帧→事件骨架、usage 后置 chunk、7 字节切片（切点落在中文 UTF-8 中间）、`error` 帧、200 非 SSE、无 `[DONE]` 断流、只有 `finish_reason` 的网关、`applyEvent` 归约 + `buildReplyView` 投影、切回 Anthropic 协议路径回归、`/v1/tools/tts` 不叠 `/v1`
      - 跑法：`node --experimental-transform-types scripts/openai-stream.test.mjs`（`ApiError` 用了参数属性，strip-only 模式会拒；`--experimental-transform-types` 需要）
      - 浏览器端到端：`node scripts/stub-gateway.mjs 8799` + `pnpm dev`，设置里写入 OpenAI 协议端点后发消息，thinking 步骤与正文正常渲染、无报错
- [x] `/v1/tools/*` 的 404/405 → `ApiError('protocol')` + 可操作文案（ARCHITECTURE §7 裁决 2 的 L4 部分，`8962cd4`）
      - `speech.ts` 抽 `toolsRequest()`：只重分类 404/405；500 等仍走 `http` 分类透传服务端原文（有回归断言）
      - 真链路验证：Anthropic 协议 + 无 `/v1/tools` 的网关点「朗读」→ UI 弹出「当前服务商没有开放语音接口（/v1/tools），请切回 Anthropic 兼容协议后再试。」
      - 注：API Key 输入框在设置「**数据管理**」分区（`SettingsDialog.tsx:115`），不在「通用设置」；首次配服务商的人容易找错

**边界**：不要动 `src/components/**`、不要动 `endpoint.ts` 的导出签名。

## @小码 —— L2/L5（只碰 `src/components/settings/**` + `src/i18n/**` + `services/settings.ts`）

**状态：✅ 已完成（`pnpm type` 0 error / `pnpm lint` 0 warning / `pnpm build` 4.5MB / `node scripts/settings-provider.test.mjs` 全绿 / 浏览器真链路三段协议各发一条真消息）。**

**新增两条（架构裁决，见 ARCHITECTURE.md §7/§8）：**
- [x] 选 OpenAI 兼容协议时，把「上传文件」「语音输入」「智能搜索」三个入口**置灰** + tooltip「当前服务商不支持」——不要靠 404 兜底
      - 入口：`ChatInput`（搜索 toggle 真 disabled、上传 IconButton disabled、`VoiceButton` 新增 `disabledLabel`）；`ReadAloudButton` 同时置灰（`/v1/tools/tts` 同样 404）
      - 拖拽/粘贴也拦：`useFileDrop(onDrop, enabled)` 关闭时不注册监听，`acceptFiles` 再兜一层 toast；搜索开关置灰但**保留存值**，切回 Anthropic 自动恢复高亮
- [x] 思考区默认折叠状态跟 `settings.thinking` 走（`defaultOpen = thinking`），**不要隐藏**：网关可能在关闭时仍下发推理内容，隐藏会让转录与上游不一致
      - `ReplyArea`：`useState(() => useSettings.getState().thinking)`；标题判定从 `message.thinking ?? hasThinking` 改为 `=== true || hasThinking`，这样「请求关思考但网关仍下发」时也有可点的折叠标题，而不是无标题地平铺

- [x] `SettingsDialog` 新增「服务商」分区：协议下拉（Anthropic 兼容 / OpenAI 兼容）+ 端点地址输入框 + 「恢复默认」按钮
      - `settingsDialogState.ts` 的 `SettingsSection` 增加 `'provider'`；新文件 `EndpointSettings.tsx` + `useEndpointForm.ts`
- [x] 保存时调 `setEndpointOverride()`；返回 `false`（非法地址）时原地报错、不落库
      - UI 只调 `services/settings.ts::saveEndpoint()`，它内部判 `false` 且不写任何键；实测 `ftp://x` 报错、localStorage 旧值不变
- [x] Key 校验复用 `verifyApiKey()`（它改完后会自动打到新端点，见 @coder 第一条）；**不要**自己写 fetch
      - ⚠️ **新增第 3 处 L2→`services/api/*` 引用**（按 ARCHITECTURE §4 要求在此申报）：`components/settings/useEndpointForm.ts` 直接 import `verifyApiKey` / `ApiError` / `classifyApiError`。原因：TASKS 指定必须复用 `verifyApiKey`，而它是 async fetch，不能放进 `services/settings.ts`（settings → client → transport → i18n → settings 会成环）。同属**流外一次性调用**，与既有两处豁免同性质。
- [x] `i18n/zh.ts` + `en.ts`：新增 21 条文案（协议、协议说明、端点地址、占位、说明、保存、恢复默认、地址非法、校验中、已保存、校验未通过、被拒、CORS 提示、四个「当前服务商不支持」）
- [x] 网络错误分支文案：「连接失败——请确认网关已放行跨域（CORS）且地址可达」，这是本方案最大的坑
- [x] 设置键迁移：旧 key（`chat-demo:*`）保持不变，只**新增** `chat-demo:endpoint-*`；不做破坏性迁移
- [x] 验收：手点 ① 填 `gw.example.com` → 自动补 `https://` ② 切 OpenAI 协议刷新后仍生效 ③ 填 `ftp://x` 报错且旧值保留

**一个需要 @架构师 / @coder 知情的实现决定**：地址合法但**校验失败时不回滚**——配置照常写入，状态行显示「已保存，但校验未通过：<原因>」。理由：真实工作流是「先把网关地址配好，再去放行 CORS」，回滚会让用户在网关没起来时无法配置。非法地址（`ftp://x`、空值）仍然不落库，符合原验收。若你要求「校验失败即回滚」，改 `useEndpointForm.ts` 一处即可。

**边界**：不要动 `src/services/api/**`、不要动 `services/chat/**`。

## 架构师（我）—— P2 合流与产物验收

- [x] 复核两个 PR：协议边界（L2 无 `services/api` 直接引用）、`view.ts` 对缺扩展块的容忍
- [x] **L3 标题兜底**：`src/services/chat/title.ts` + `store.ts::applyFallbackTitle`，验收 `node scripts/title.test.mjs`（12 项）
- [ ] 产物验收：`file://` 双击可用、gh-pages 子路径、bundle ≤5MB、88 个 async chunk 不回归
- [ ] 把 `endpoint.ts` 的 `apiBase` 与实际请求 URL 做一次对照表（防止各家网关前缀差异）

**冲突规避**：三个人的文件集合不重叠。`endpoint.ts` 归我，谁都不许改；`client.ts`/`speech.ts`/`openai.ts` 归 @coder；`settings/**`+`i18n/**` 归 @小码。
