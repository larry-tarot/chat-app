# chat-demo

English | [简体中文](README.zh-CN.md)

A static chat demo powered by the DeepSeek API. No application backend is required: the browser connects directly to the configured API service.

You can [try the app online](https://deepseek-ai.github.io/chat-demo/) or download the archive from [Releases](https://github.com/deepseek-ai/deepseek-chat-demo/releases), extract it, and double-click `index.html` to use it locally without installation or a build. Enter your API key in Settings before your first chat.

## Getting started

Install Node.js 22.12+ and pnpm, then run:

```sh
git clone https://github.com/deepseek-ai/chat-demo.git
cd chat-demo
pnpm install
pnpm dev
```

Open http://localhost:8090.

To build the static site:

```sh
pnpm build
```

The output is written to `dist/`. Deploy it to a static web server or open `dist/index.html` directly. Opening the file directly requires browser support for storage on `file://` pages and an API service that permits their cross-origin requests.

## Provider & endpoint

This fork makes the **API address a runtime setting** instead of a build-time constant: point it at your own gateway or relay without rebuilding.

- Settings → Provider: pick a protocol (`Anthropic compatible` / `OpenAI compatible`) and enter the endpoint. A missing scheme gets `https://`, trailing slashes and query strings are normalized away. "Save" probes `/models` with the current key; a failed probe keeps the configuration and explains why (CORS not allowed / invalid key / gateway error).
- The API key lives in Settings → **Data** (the Provider section has a "Configure now" shortcut).
- "Reset" restores the build-time default (`https://api.deepseek.com`).

| Capability | Anthropic compatible | OpenAI compatible |
|---|---|---|
| Streaming chat | ✅ | ✅ |
| Deep thinking | ✅ | ⚠️ only if the gateway sends `reasoning_content` |
| Web search / link reading / citations | ✅ | ❌ disabled |
| Attachments and images | ✅ | ❌ disabled |
| Voice input / read aloud | ✅ | ❌ disabled |
| Conversation title | ✅ server-provided | ✅ local fallback from the first prompt |
| Token usage | ✅ | ⚠️ only with `stream_options` support |

Before pointing it at your own gateway:

1. **Allow CORS**, otherwise the UI only says "connection failed":

```text
Access-Control-Allow-Origin: <your page origin, or *>
Access-Control-Allow-Headers: Authorization, Content-Type, x-api-key, anthropic-beta
Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS
```

`OPTIONS` preflight must return 204. Opening `index.html` from disk sends `origin: null`, which the gateway must accept.

2. **Match the protocol.** Anthropic compatible endpoints need `POST /anthropic/v1/messages` (SSE), `GET /models`, `POST /anthropic/v1/files`; OpenAI compatible endpoints need `POST /v1/chat/completions` (`stream: true`) and `GET /v1/models`.

3. **Older gateways may reject `stream_options`.** If a gateway answers 400 for that field, the client retries once without `include_usage`. **No token usage for that turn is expected, not a bug.**

## Reproducible builds & deployment

The offline archive is just `dist/` zipped. Rebuild and verify it with one command:

```sh
pnpm install && pnpm build
sh scripts/release.sh        # build + zip + print the manifest hash
```

Current source baseline manifest hash: `3aa530887ee43f7d29721d00e8e4b8db27b6d6e41497b5b886e7ce4180bfc47e`
(153 files / 4,408,942 bytes / 89 js). A different hash means source or dependency versions changed — do not ship an old archive as new.

Static hosting only needs the contents of `dist/`; both a site root and a subpath (`/my-org/chat-demo/`) are verified. `deploy/nginx.conf` is a ready-to-copy config — the two rules that matter are `Cache-Control: no-cache` for `index.html` and `immutable` for the content-hashed `static/**`. Leaving `index.html` cached gives users an old shell with new chunks (blank page).

## Features

- Multiple conversations with automatic titles, renaming, and deletion; edit prompts, regenerate replies, and switch between message branches.
- Streaming replies, deep thinking, smart search, link reading, and source citations; stop generation or continue eligible replies.
- Upload, paste, or drag and drop attachments; use voice input and read replies aloud. A live audio spectrum appears in the first row of the input area while recording on mobile.
- Markdown, syntax highlighting, KaTeX math, and Mermaid diagrams.
- Simplified Chinese and English, light and dark themes, mobile layouts, location settings, and chat history import and export.

## Data and storage

Your API key and settings are stored in the browser's localStorage. Conversations and original attachments are stored in IndexedDB. Local data is isolated by browser profile and site origin. Sending messages, uploading attachments, and using speech features sends the relevant content to the configured API service.

History import and export in Settings use ZIP archives. After confirmation and successful validation, importing replaces all local conversations and attachments. Exports include conversations and locally available original images, but exclude API keys, settings, and original non-image attachments. See the [history import/export documentation (Chinese)](src/services/chat/history/README.md) for the archive format and preservation details.

Settings → Data → Delete all chats clears all local conversations, original attachments, and unsent drafts after confirmation. It stops ongoing replies and returns to a new chat. Your API key and settings are preserved; files already uploaded to the API service are not deleted.

## Development

| Command       | Description                  |
| ------------- | ---------------------------- |
| `pnpm dev`    | Start the development server |
| `pnpm build`  | Build into `dist/`           |
| `pnpm type`   | Run TypeScript type checks   |
| `pnpm lint`   | Lint with oxlint             |
| `pnpm format` | Format with oxfmt            |

[rspack.config.ts](rspack.config.ts) uses `https://api.deepseek.com` by default. Use `createConfig({ apiOrigin, devServer })` to customize the API origin and development server proxy.

Chat uses `deepseek-flash` by default through Anthropic-compatible Messages / Files APIs. Speech features use ASR / TTS endpoints. Requests include extensions for search, link reading, titles, and `latest_reminder`, so the configured service must support the corresponding capabilities. Supported attachment formats are determined by server-side validation.

```text
src/
  app/                 Application layout, themes, and global styles
  components/          Chat, settings, Markdown, and other UI components
  i18n/                English and Chinese translations
  services/
    api/               API requests, SSE, and protocol types
    chat/              Conversations, message branches, storage, and history import/export
    markdown/          Markdown parsing, syntax highlighting, and diagrams
    speech/            Audio recording and read-aloud playback
  utils/               Shared utilities
```

## License

[MIT](LICENSE). The build copies the license to `dist/LICENSE`; include it when distributing the app. Third-party dependencies are subject to their own licenses.
