// OpenAI 兼容协议（Provider B）验收脚本：真起 node:http 回放帧，不引入测试框架。
//   node --experimental-transform-types scripts/openai-stream.test.mjs
//
// 覆盖：请求体转换 → 帧翻译 → reply.ts 归约 → view.ts 投影，以及错误/断流/非 SSE 三种失败路径，
// 并回归 Anthropic 协议路径（确保没有多叠一层 /v1、speech 的 /v1/tools 没被改写）。
import { createServer } from 'node:http'
import { register } from 'node:module'

register('./ts-js-resolve.mjs', import.meta.url)

// 构建期常量与浏览器存储的替身，必须在 import 业务代码之前就位
globalThis.__API_ORIGIN__ = 'https://api.deepseek.com'
const storage = new Map()
globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
}

let scenario = 'normal'
const requests = []
const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}
const sseOpen = (res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' })
}
const frame = (payload) => `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`

const normalFrames = [
  { id: 'chatcmpl-1', model: 'deepseek-chat', choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: '思考一' } }] },
  { id: 'chatcmpl-1', choices: [{ index: 0, delta: { reasoning_content: '，思考二' } }] },
  { id: 'chatcmpl-1', choices: [{ index: 0, delta: { content: '你好' } }] },
  { id: 'chatcmpl-1', choices: [{ index: 0, delta: { content: '，世界' } }] },
  { id: 'chatcmpl-1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  // usage 在 finish_reason 之后的独立 chunk 里——如果一收到 finish_reason 就收尾，这里会丢
  { id: 'chatcmpl-1', choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
]

const anthropicFrames = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","model":"deepseek-flash"}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
]

const server = createServer((req, res) => {
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', async () => {
    const raw = Buffer.concat(chunks)
    let body = null
    try {
      body = raw.length ? JSON.parse(raw.toString('utf8')) : null
    } catch {
      body = null
    }
    requests.push({ url: req.url, method: req.method, headers: req.headers, body, bytes: raw.length })

    if (req.url === '/models' || req.url === '/v1/models') {
      return json(res, 200, { data: [] })
    }
    if (req.url.startsWith('/v1/tools/')) {
      if (scenario === 'tools-404') {
        return json(res, 404, { error: { message: 'Not Found', type: 'invalid_request_error' } })
      }
      if (scenario === 'tools-405') {
        return json(res, 405, { error: { message: 'Method Not Allowed' } })
      }
      if (scenario === 'tools-500') {
        return json(res, 500, { error: { message: '语音服务暂时不可用' } })
      }
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      return res.end(Buffer.from([0, 0, 1, 0]))
    }
    if (req.url === '/anthropic/v1/messages') {
      sseOpen(res)
      for (const raw of anthropicFrames) {
        res.write(raw)
      }
      return res.end()
    }
    if (req.url !== '/v1/chat/completions') {
      return json(res, 404, { error: { message: `unexpected ${req.url}` } })
    }

    if (scenario === 'error') {
      sseOpen(res)
      return res.end(frame({ error: { message: 'quota exceeded' } }))
    }
    // 老网关把 stream_options 当未知字段：带该字段就 400，不带就正常出流
    if (scenario === 'reject-stream-options' && body?.stream_options) {
      return json(res, 400, { error: { message: 'Unknown field: stream_options', type: 'invalid_request_error' } })
    }
    if (scenario === 'model-400') {
      return json(res, 400, { error: { message: 'model deepseek-flash not found' } })
    }
    if (scenario === 'not-sse') {
      return json(res, 200, { ok: true })
    }
    if (scenario === 'truncated') {
      sseOpen(res)
      res.write(frame({ id: 'c', choices: [{ index: 0, delta: { content: '半截' } }] }))
      return res.end() // 既没有 finish_reason 也没有 [DONE]
    }
    if (scenario === 'finish-only') {
      sseOpen(res)
      res.write(frame({ id: 'c', model: 'm', choices: [{ index: 0, delta: { content: '完整' } }] }))
      res.write(frame({ id: 'c', choices: [{ index: 0, delta: {}, finish_reason: 'length' }] }))
      return res.end() // 有的网关不回 [DONE]，只有 finish_reason
    }
    if (scenario === 'split') {
      // 把整段 SSE 按 7 字节切片写出，切点会落在中文的 UTF-8 中间，验证解码器不炸
      sseOpen(res)
      const text = [...normalFrames.map(frame), frame('[DONE]')].join('')
      const buffer = Buffer.from(text, 'utf8')
      for (let offset = 0; offset < buffer.length; offset += 7) {
        res.write(buffer.subarray(offset, offset + 7))
        await new Promise((resolve) => setTimeout(resolve, 1))
      }
      return res.end()
    }
    sseOpen(res)
    // 和真网关一致：没要求 include_usage 就不下发 usage chunk
    for (const payload of body?.stream_options ? normalFrames : normalFrames.filter((chunk) => !chunk.usage)) {
      res.write(frame(payload))
    }
    res.write(frame('[DONE]'))
    res.end()
  })
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const baseUrl = `http://127.0.0.1:${server.address().port}`

const { setEndpointOverride, resolveEndpoint } = await import('../src/services/api/endpoint.ts')
const { streamMessage, verifyApiKey, ApiError } = await import('../src/services/api/client.ts')
const { toOpenAiMessages, toOpenAiBody } = await import('../src/services/api/openai.ts')
const { synthesize, transcribe } = await import('../src/services/api/speech.ts')
const { applyEvent, getReplyText } = await import('../src/services/chat/reply.ts')
const { buildReplyView } = await import('../src/services/chat/view.ts')

let failed = 0
const eq = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      got=${JSON.stringify(actual)}\n      want=${JSON.stringify(expected)}`}`)
}
const ok = (name, condition, detail = '') => {
  if (!condition) failed++
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${condition ? '' : `  ${detail}`}`)
}

const collect = async (generator) => {
  const events = []
  for await (const event of generator) {
    events.push(event)
  }
  return events
}
const collectUntilThrow = async (generator) => {
  const events = []
  let error = null
  try {
    for await (const event of generator) {
      events.push(event)
    }
  } catch (caught) {
    error = caught
  }
  return { events, error }
}

const requestBody = {
  model: 'deepseek-flash',
  system: '你是助手。',
  messages: [
    { role: 'latest_reminder', content: '现在是 2026-11-16。' },
    { role: 'user', content: '你好' },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '上一轮的思考', signature: 'sig' },
        { type: 'text', text: '上次的回答' },
      ],
    },
    { role: 'user', content: '再说一次' },
  ],
  thinking: { type: 'enabled' },
  tools: [{ type: 'deepseek_web_search', name: 'deepseek_web_search' }],
  safety_check: { level: 'high' },
}
const signal = () => new AbortController().signal

// ---------- 1. 请求体转换（纯函数） ----------
eq('system 置顶，latest_reminder 降级为 system，assistant 只搬文本', toOpenAiMessages(requestBody), [
  { role: 'system', content: '你是助手。' },
  { role: 'system', content: '现在是 2026-11-16。' },
  { role: 'user', content: '你好' },
  { role: 'assistant', content: '上次的回答' },
  { role: 'user', content: '再说一次' },
])

const outBody = toOpenAiBody(requestBody)
eq(
  '请求体只留 model/messages/stream/stream_options',
  Object.keys(outBody).sort(),
  ['messages', 'model', 'stream', 'stream_options']
)
ok('丢弃 thinking/tools/safety_check（OpenAI 协议无对应字段，发出去会 400）', !('tools' in outBody) && !('thinking' in outBody) && !('safety_check' in outBody))

// ---------- 2. 端点：openai-chat ----------
setEndpointOverride({ protocol: 'openai-chat', baseUrl })
eq('覆盖生效', resolveEndpoint(), { protocol: 'openai-chat', baseUrl: `${baseUrl}`, source: 'override' })

// ---------- 3. 正常流：帧 → 事件 ----------
scenario = 'normal'
requests.length = 0
const events = await collect(streamMessage('test-key', requestBody, signal()))
eq(
  '事件骨架（块边界由帧合成）',
  events.map((event) => event.type),
  [
    'message_start',
    'content_block_start',
    'content_block_delta',
    'content_block_delta',
    'content_block_stop',
    'content_block_start',
    'content_block_delta',
    'content_block_delta',
    'content_block_stop',
    'message_delta',
    'message_stop',
  ]
)
eq('message_start 带服务端 id/model', events[0].message, { id: 'chatcmpl-1', model: 'deepseek-chat' })
eq(
  'reasoning_content → thinking 块，正文 → text 块，index 依次 0/1',
  events.filter((event) => event.type === 'content_block_start').map((event) => [event.index, event.content_block.type]),
  [
    [0, 'thinking'],
    [1, 'text'],
  ]
)
const lastDelta = events.find((event) => event.type === 'message_delta')
eq('finish_reason=stop → end_turn', lastDelta.delta.stop_reason, 'end_turn')
eq('usage 取到 finish_reason 之后那个独立 chunk', lastDelta.usage, {
  input_tokens: 10,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  output_tokens: 5,
})
eq('以 message_stop 收尾', events.at(-1), { type: 'message_stop' })

const sent = requests.find((entry) => entry.url === '/v1/chat/completions')
ok('打到 /v1/chat/completions（不叠 /anthropic/v1）', Boolean(sent), JSON.stringify(requests.map((r) => r.url)))
ok('鉴权走 Authorization: Bearer', sent?.headers.authorization === 'Bearer test-key', String(sent?.headers.authorization))
ok('请求体带 stream: true', sent?.body?.stream === true)
ok('请求体不含 tools/thinking', sent?.body && !('tools' in sent.body) && !('thinking' in sent.body))

// ---------- 4. 归约 + 投影（store 不感知协议） ----------
let blocks = new Map()
let reply = {
  id: 'r1',
  role: 'assistant',
  createdAt: 0,
  model: 'deepseek-flash',
  thinking: true,
  search: false,
  prefix: true,
  status: 'streaming',
  blocks: [],
}
for (const event of events) {
  reply = applyEvent(reply, event, Date.now(), blocks)
}
eq('归约出两个块', reply.blocks.map((block) => block.type), ['thinking', 'text'])
eq('思考文本累积', reply.blocks[0].thinking, '思考一，思考二')
ok('思考块有起止时间（可渲染耗时）', typeof reply.blocks[0].startedAt === 'number' && typeof reply.blocks[0].endedAt === 'number')
eq('回复正文', getReplyText(reply), '你好，世界')
eq('stopReason 落到 ReplyView 可用的状态', reply.stopReason, 'end_turn')
const view = buildReplyView(reply, false)
eq('投影：answer 就是正文', view.answer?.text, '你好，世界')
eq('投影：思考进 steps，不进正文', view.steps.map((step) => step.type), ['thinking'])

// ---------- 5. 多字节切片 ----------
scenario = 'split'
const splitEvents = await collect(streamMessage('test-key', requestBody, signal()))
const splitBlocks = new Map()
const splitReply = splitEvents.reduce(
  (acc, event) => applyEvent(acc, event, Date.now(), splitBlocks),
  { id: 'r2', role: 'assistant', createdAt: 0, model: 'deepseek-flash', prefix: true, status: 'streaming', blocks: [] }
)
eq('按 7 字节切片（切点落在中文 UTF-8 中间）仍解析出完整正文', getReplyText(splitReply), '你好，世界')

// ---------- 6. 失败路径 ----------
scenario = 'error'
const streamError = await collectUntilThrow(streamMessage('test-key', requestBody, signal()))
ok('流内 error 帧 → ApiError(stream) 并带服务端文案', streamError.error instanceof ApiError && streamError.error.kind === 'stream' && streamError.error.message === 'quota exceeded', String(streamError.error))

scenario = 'not-sse'
const protocolError = await collectUntilThrow(streamMessage('test-key', requestBody, signal()))
ok('200 但非 SSE → ApiError(protocol)', protocolError.error instanceof ApiError && protocolError.error.kind === 'protocol', String(protocolError.error))

scenario = 'truncated'
const truncated = await collectUntilThrow(streamMessage('test-key', requestBody, signal()))
ok('没有 finish_reason/[DONE] 就断流 → ApiError(interrupted)', truncated.error instanceof ApiError && truncated.error.kind === 'interrupted', String(truncated.error))
ok('断流前已收到的正文不丢', truncated.events.some((event) => event.type === 'content_block_delta' && event.delta.text === '半截'))

scenario = 'finish-only'
const finishOnly = await collect(streamMessage('test-key', requestBody, signal()))
eq('只有 finish_reason 没有 [DONE] 也算正常结束', finishOnly.at(-1), { type: 'message_stop' })
eq('finish_reason=length → max_tokens（可续写）', finishOnly.find((event) => event.type === 'message_delta').delta.stop_reason, 'max_tokens')

// ---------- 6.5 stream_options 兼容退化 ----------
scenario = 'reject-stream-options'
requests.length = 0
const degraded = await collect(streamMessage('test-key', requestBody, signal()))
const chatCalls = requests.filter((entry) => entry.url === '/v1/chat/completions')
eq('老网关拒绝 stream_options 时自动重发一次', chatCalls.length, 2)
ok('第一次带 stream_options', Boolean(chatCalls[0]?.body?.stream_options))
ok('第二次不带 stream_options', chatCalls[1]?.body && !('stream_options' in chatCalls[1].body))
eq(
  '退化后正文照旧流式到达',
  degraded.filter((event) => event.type === 'content_block_delta' && event.delta.type === 'text_delta').map((event) => event.delta.text).join(''),
  '你好，世界'
)
ok('退化后没有 usage（如实为空，不编造）', degraded.find((event) => event.type === 'message_delta')?.usage === undefined)

scenario = 'model-400'
requests.length = 0
const modelError = await collectUntilThrow(streamMessage('test-key', requestBody, signal()))
ok('其它 400（模型名不存在）不重试，原样抛 http', modelError.error instanceof ApiError && modelError.error.kind === 'http' && modelError.error.status === 400, String(modelError.error))
eq('其它 400 只发一次请求', requests.filter((entry) => entry.url === '/v1/chat/completions').length, 1)

// ---------- 7. 两种协议互不污染 ----------
scenario = 'normal'
requests.length = 0
await verifyApiKey('test-key')
ok('openai 协议校验 Key 走 /v1/models', requests[0]?.url === '/v1/models', requests[0]?.url)

requests.length = 0
const audio = await synthesize('test-key', '你好', 'stella', signal())
ok('语音仍打 /v1/tools/tts（不叠第二层 /v1）', requests[0]?.url === '/v1/tools/tts', requests[0]?.url)
ok('语音返回字节流', Boolean(audio))

// 网关没有 /v1/tools：不能把裸 404 抛给界面（ARCHITECTURE §7 裁决 2）
scenario = 'tools-404'
const tts404 = await synthesize('test-key', '你好', 'stella', signal()).then(
  () => null,
  (error) => error
)
ok(
  'TTS 404 → ApiError(protocol) 且文案说明是服务商不支持',
  tts404 instanceof ApiError &&
    tts404.kind === 'protocol' &&
    tts404.status === 404 &&
    tts404.message.includes('/v1/tools'),
  String(tts404)
)
const asr404 = await transcribe('test-key', new Blob(['x'])).then(
  () => null,
  (error) => error
)
ok('ASR 404 同样映射（不是只改 TTS）', asr404 instanceof ApiError && asr404.kind === 'protocol', String(asr404))

scenario = 'tools-405'
const tts405 = await synthesize('test-key', '你好', 'stella', signal()).then(
  () => null,
  (error) => error
)
ok('405 也映射为 protocol（有的网关对不支持的方法回 405）', tts405 instanceof ApiError && tts405.kind === 'protocol' && tts405.status === 405, String(tts405))

scenario = 'tools-500'
const tts500 = await synthesize('test-key', '你好', 'stella', signal()).then(
  () => null,
  (error) => error
)
ok(
  '500 保持 http 分类并透传服务端文案（不许被 404 映射污染）',
  tts500 instanceof ApiError && tts500.kind === 'http' && tts500.message === '语音服务暂时不可用',
  String(tts500)
)

scenario = 'normal'

setEndpointOverride({ protocol: 'anthropic-messages' })
requests.length = 0
const anthropicEvents = await collect(streamMessage('test-key', requestBody, signal()))
eq('切回 anthropic：仍以 message_stop 结束', anthropicEvents.at(-1).type, 'message_stop')
eq('切回 anthropic：路径 /anthropic/v1/messages', requests[0]?.url, '/anthropic/v1/messages')
ok('切回 anthropic：鉴权用 x-api-key', requests[0]?.headers['x-api-key'] === 'test-key', String(requests[0]?.headers['x-api-key']))

requests.length = 0
await verifyApiKey('test-key')
eq('anthropic 协议校验 Key 走 /models', requests[0]?.url, '/models')

// 附件：OpenAI 协议下明确报错，而不是静默失败
setEndpointOverride({ protocol: 'openai-chat', baseUrl })
const uploadError = await import('../src/services/api/client.ts').then(({ uploadFile }) =>
  uploadFile('test-key', new Blob(['x']), null).then(
    () => null,
    (error) => error
  )
)
ok('OpenAI 协议上传附件 → ApiError(protocol) 且给出可操作提示', uploadError instanceof ApiError && uploadError.kind === 'protocol' && uploadError.message.includes('Anthropic'), String(uploadError))

server.close()
console.log(failed === 0 ? '\n全部通过' : `\n失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
