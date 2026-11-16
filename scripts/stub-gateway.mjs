// 本地 OpenAI 兼容网关桩，仅用于浏览器端到端验收（真 CORS + 真 SSE）。
//   node scripts/stub-gateway.mjs [port]
// 端点：
//   GET  /v1/models                 → 200
//   POST /v1/chat/completions       → SSE 回放：reasoning_content 两帧 + 正文三帧 + finish_reason + usage + [DONE]
//   POST /anthropic/v1/messages     → Anthropic 帧回放（同一条链路的两条协议都验）
import { createServer } from 'node:http'

const port = Number(process.argv[2] ?? 8799)
const log = []

const cors = (res) => {
  res.setHeader('access-control-allow-origin', '*')
  res.setHeader('access-control-allow-headers', '*')
  res.setHeader('access-control-allow-methods', 'GET,POST,DELETE,OPTIONS')
  res.setHeader('access-control-expose-headers', 'content-type')
}
const json = (res, status, body) => {
  cors(res)
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
const frame = (payload) => `data: ${JSON.stringify(payload)}\n\n`

const answer = '网关回放成功：这条回答走的是 **OpenAI 兼容协议**（/v1/chat/completions）。'

createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    cors(res)
    res.writeHead(204)
    return res.end()
  }
  let raw = ''
  req.on('data', (chunk) => {
    raw += chunk
  })
  req.on('end', async () => {
    log.push({ method: req.method, url: req.url, len: raw.length })
    if (req.url === '/__log') {
      return json(res, 200, log)
    }
    if (req.url === '/v1/models' || req.url === '/models') {
      return json(res, 200, { data: [{ id: 'stub' }] })
    }
    if (req.url === '/v1/chat/completions') {
      cors(res)
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' })
      const chunks = [
        { id: 'chatcmpl-1', model: 'stub-model', choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: '先想一下：' } }] },
        { id: 'chatcmpl-1', choices: [{ index: 0, delta: { reasoning_content: '用户只想看能不能通。' } }] },
      ]
      for (const chunk of chunks.slice(0, 5)) {
        res.write(frame(chunk))
      }
      // 正文分三段，能看出是流式拼接而不是一次性渲染
      for (const piece of answer.match(/[\s\S]{1,12}/g) ?? []) {
        res.write(frame({ id: 'chatcmpl-1', choices: [{ index: 0, delta: { content: piece } }] }))
        await new Promise((resolve) => setTimeout(resolve, 40))
      }
      res.write(frame({ id: 'chatcmpl-1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }))
      res.write(frame({ id: 'chatcmpl-1', choices: [], usage: { prompt_tokens: 42, completion_tokens: 18 } }))
      res.write(frame('[DONE]'))
      return res.end()
    }
    if (req.url === '/anthropic/v1/messages') {
      cors(res)
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      const events = [
        ['message_start', { type: 'message_start', message: { id: 'm1', model: 'deepseek-flash' } }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '网关回放成功：这条回答走的是 Anthropic 兼容协议（/anthropic/v1/messages）。' } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null } }],
        ['message_stop', { type: 'message_stop' }],
      ]
      for (const [name, payload] of events) {
        res.write(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`)
      }
      return res.end()
    }
    json(res, 404, { error: { message: `stub 没有 ${req.url}` } })
  })
}).listen(port, '127.0.0.1', () => {
  console.log(`stub gateway on http://127.0.0.1:${port}`)
})
