# chat-demo

[English](README.md) | 简体中文

基于 DeepSeek API 的静态聊天示例。无需应用后端，浏览器直接请求配置的 API 服务。

点击 [在线体验](https://deepseek-ai.github.io/chat-demo/) 即可使用，也可以前往 [Releases](https://github.com/deepseek-ai/deepseek-chat-demo/releases) 下载压缩包，解压后双击 `index.html` 在本地使用，无需安装或构建。首次使用时，请在设置中填写 API Key。

## 运行

准备 Node.js 22.12+ 和 pnpm：

```sh
git clone https://github.com/deepseek-ai/chat-demo.git
cd chat-demo
pnpm install
pnpm dev
```

打开 http://localhost:8090 。

生成静态产物：

```sh
pnpm build
```

产物位于 `dist/`，可部署到静态服务器，也可直接打开 `dist/index.html`。直接打开时，浏览器和 API 服务需允许 `file://` 页面的存储与跨域请求。

## 服务商与端点

本 fork 把 **API 地址从构建期常量改成了运行时配置**：不重新构建也能指向自建网关或中转站。

- 设置 → 服务商：选择协议（`Anthropic 兼容` / `OpenAI 兼容`）并填写端点地址。地址不写协议时自动补 `https://`，尾斜杠与查询串会被规范化去掉；点「保存」会立刻用当前 API Key 探一次 `/models`，成功显示「已保存，连接正常」，失败也会**保留配置**并说明原因（未放行 CORS / Key 无效 / 网关报错）。
- API Key 在 设置 → **数据管理** 里填写；服务商分区底部有「前往配置」按钮可直达。
- 「恢复默认」回到构建期注入的地址（默认 `https://api.deepseek.com`）。
- **先填端点、后配 Key 是允许的**：此时状态行会显示「已保存；填入 API Key 后会校验连通性」——没有 Key 就没有请求发出，所以不会声称「连接正常」。补上 Key 的那一刻才会真正探活，**这是预期行为，不是报错**。

| 能力 | Anthropic 兼容 | OpenAI 兼容 |
|---|---|---|
| 文本流式对话 | ✅ | ✅ |
| 深度思考 | ✅ | ⚠️ 取决于网关是否下发 `reasoning_content` |
| 联网搜索 / 读链接 / 引用 | ✅ | ❌ 入口置灰 |
| 附件与图片 | ✅ | ❌ 入口置灰 |
| 语音输入 / 朗读 | ✅ | ❌ 入口置灰 |
| 会话标题 | ✅ 服务端下发 | ✅ 用首条提问本地截断兜底 |
| token 用量 | ✅ | ⚠️ 网关支持 `stream_options` 才有 |

### 接自建网关前必须确认

1. **放行 CORS**。不放行时界面只会提示「连接失败」，看不出是跨域问题：

```text
Access-Control-Allow-Origin: <你的页面 origin，或 *>
Access-Control-Allow-Headers: Authorization, Content-Type, x-api-key, anthropic-beta
Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS
```

`OPTIONS` 预检需返回 204。直接双击 `index.html` 打开时页面 origin 是 `null`，网关必须能接受它。

2. **协议对齐**。Anthropic 兼容端点需实现 `POST /anthropic/v1/messages`（SSE）、`GET /models`、`POST /anthropic/v1/files`；OpenAI 兼容端点需实现 `POST /v1/chat/completions`（`stream: true`）与 `GET /v1/models`。

3. **部分老网关不认 `stream_options`**。若网关以「未知字段」为由返回 400，本客户端会自动去掉 `include_usage` 重发一次。此时该轮**不显示 token 用量属于预期行为，不是故障**。

## 构建产物与可复现性

交付的离线包就是 `dist/` 的压缩结果，可以用一条命令重建并核对：

```sh
pnpm install && pnpm build
sh scripts/release.sh        # 构建 + 打 zip + 打印清单哈希
```

当前源码基线的清单哈希为 `419032ecac2516ad8900cbc9234559be1027d053220ddb9cbed99751cfe01d63`：
**153 个文件 / 4,409,126 字节 / 89 个 js**。换台机器重建后哈希不一致，说明源码或依赖版本变了——别把旧包当新包发。

## 部署

静态托管只需要 `dist/` 里的内容。两种形态都实测过：

- 独立域名或端口：站点根目录指向 `dist/`；
- 子路径（如 `/my-org/chat-demo/`）：产物按脚本自身地址推导资源路径，直接可用。

`deploy/nginx.conf` 可直接抄用，关键是两条缓存规则：

| 路径 | 响应头 | 为什么 |
|---|---|---|
| `/index.html` | `no-cache` | 入口壳不带内容哈希，缓存了就会「旧壳 + 新 chunk」白屏 |
| `/static/{js,css,media}/**` | `max-age=31536000, immutable` | 文件名带内容哈希，永不失效 |

该配置在 nginx/1.31.8 上 `nginx -t` 通过，并实测：`/index.html` → `no-cache`、主包与 async chunk → `immutable`、gzip 生效、子路径下 async chunk 仍返回 200、整页可在 nginx 后正常对话。

## 功能

- 多会话、自动标题、重命名与删除；编辑提问、重新生成和切换消息分支。
- 流式回答、深度思考、智能搜索、链接阅读与来源引用；支持停止和符合条件的继续生成。
- 附件上传、粘贴与拖拽，语音输入和回复朗读；移动端录音时输入框首行显示实时频谱。
- Markdown、代码高亮、KaTeX 公式和 Mermaid 图表。
- 简体中文与英文、浅色与深色主题、移动端布局、位置设置、历史导入导出。

## 数据

API Key 和设置保存在浏览器 localStorage，会话及附件原件保存在 IndexedDB，本地数据按浏览器用户配置和站点源（origin）隔离。发送对话、上传附件和使用语音功能时，相应内容会提交给配置的 API 服务。

设置中的历史导入导出使用 ZIP 格式。导入会在确认并校验成功后替换全部本地会话和附件；导出包含会话与本地可用的图片原件，不包含 API Key、设置或非图片附件原件。格式与保留范围见[历史导入导出](src/services/chat/history/README.md)。

设置 → 数据管理 → 删除所有对话，会在确认后清空全部本地会话、附件原件和未发送的草稿，停止正在生成的回复并回到新对话。API Key 和其他设置保留，已上传到 API 服务的文件不受影响。

## 开发

| 命令          | 用途                |
| ------------- | ------------------- |
| `pnpm dev`    | 启动开发服务器      |
| `pnpm build`  | 构建到 `dist/`      |
| `pnpm type`   | TypeScript 类型检查 |
| `pnpm lint`   | oxlint 检查         |
| `pnpm format` | oxfmt 格式化        |

[rspack.config.ts](rspack.config.ts) 默认连接 `https://api.deepseek.com`，该值现在只作为**运行时配置的默认值**（设置面板可覆盖，见上文「服务商与端点」）。`createConfig({ apiOrigin, devServer })` 支持在构建期改默认地址和开发服务器代理。

聊天默认使用 `deepseek-flash`，通过 Anthropic 兼容的 Messages / Files API 通信；切到 OpenAI 兼容协议时改走 `/v1/chat/completions`（能力差异见上表）。语音使用 ASR / TTS 接口。请求使用搜索、链接阅读、标题和 `latest_reminder` 等扩展，接入服务需支持相应能力。附件实际支持的格式以服务端校验为准。

```text
src/
  app/                 应用布局、主题与全局样式
  components/          聊天、设置、Markdown 等界面组件
  i18n/                中英文文案
  services/
    api/               API 请求、SSE 与协议类型
    chat/              会话、消息分支、本地存储与历史导入导出
    markdown/          Markdown 解析、代码高亮与图表
    speech/            录音与朗读
  utils/               通用工具
```

## 许可证

[MIT](LICENSE)。构建会将许可证复制到 `dist/LICENSE`，分发时请一并保留；第三方依赖遵循各自的许可证。
