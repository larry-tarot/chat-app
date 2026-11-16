# 本轮任务板 · v0.5「端点可配」

目标：把「API 地址写死在构建期」变成**运行时可选**，让这套前端能接自建网关 / OpenAI 兼容中转站。
完整依据见 `ARCHITECTURE.md`。基线 commit：`P0 基线`（`pnpm type` 0 error / `pnpm build` 269ms / 8090 可开）。

**契约已冻结**：`src/services/api/endpoint.ts`（架构师已实现，`node scripts/endpoint.test.mjs` 12 项全绿）。
需要改动接口的场景，先在本 thread 说明，不要各自改。

---

## @coder —— L4 协议层（只碰 `src/services/api/**`）

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

**边界**：不要动 `src/components/**`、不要动 `endpoint.ts` 的导出签名。

## @小码 —— L2/L5（只碰 `src/components/settings/**` + `src/i18n/**` + `services/settings.ts`）

- [ ] `SettingsDialog` 新增「服务商」分区：协议下拉（Anthropic 兼容 / OpenAI 兼容）+ 端点地址输入框 + 「恢复默认」按钮
- [ ] 保存时调 `setEndpointOverride()`；返回 `false`（非法地址）时原地报错、不落库
- [ ] Key 校验复用 `verifyApiKey()`（它改完后会自动打到新端点，见 @coder 第一条）；**不要**自己写 fetch
- [ ] `i18n/zh.ts` + `en.ts`：新增 6 条文案（协议、端点地址、端点占位、恢复默认、地址非法、网关 CORS 提示）
- [ ] 网络错误分支文案：「连接失败——请确认网关已放行跨域（CORS）且地址可达」，这是本方案最大的坑
- [ ] 设置键迁移：旧 key（`chat-demo:*`）保持不变，只**新增** `chat-demo:endpoint-*`；不做破坏性迁移
- [ ] 验收：手点 ① 填 `gw.example.com` → 自动补 `https://` ② 切 OpenAI 协议刷新后仍生效 ③ 填 `ftp://x` 报错且旧值保留

**边界**：不要动 `src/services/api/**`、不要动 `services/chat/**`。

## 架构师（我）—— P2 合流与产物验收

- [ ] 复核两个 PR：协议边界（L2 无 `services/api` 直接引用）、`view.ts` 对缺扩展块的容忍
- [ ] 产物验收：`file://` 双击可用、gh-pages 子路径、bundle ≤5MB、88 个 async chunk 不回归
- [ ] 把 `endpoint.ts` 的 `apiBase` 与实际请求 URL 做一次对照表（防止各家网关前缀差异）

**冲突规避**：三个人的文件集合不重叠。`endpoint.ts` 归我，谁都不许改；`client.ts`/`speech.ts`/`openai.ts` 归 @coder；`settings/**`+`i18n/**` 归 @小码。
