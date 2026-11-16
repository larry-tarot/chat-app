import { apiBase, type EndpointConfig } from './endpoint.js'
import { readServerSentEvents } from './sse.js'
import { ApiError, isErrorBody, readErrorResponse, request } from './transport.js'
import type {
  CreateMessageRequest,
  MessageParam,
  MessageStreamEvent,
  MessageUsage,
  StopReason,
} from './types.js'

/**
 * Provider B：OpenAI 兼容协议（/v1/chat/completions，SSE）。
 *
 * 职责只有一个：把 OpenAI 的 chunk 流翻译成**既有**的 `MessageStreamEvent`，
 * 让 store / reply.ts / view.ts 一行不改地工作。三类差异在这里消化：
 *
 *  1. 协议差异：OpenAI 无 message_start / content_block_*，需按 index 合成块边界；
 *  2. 推理差异：`delta.reasoning_content`（DeepSeek/vLLM）或 `delta.reasoning`
 *     （部分网关）映射为 thinking 块，与 Anthropic 的 thinking_delta 同构；
 *  3. 终止差异：OpenAI 以 `data: [DONE]` 结束，且 usage 常常在 finish_reason
 *     之后的**独立 chunk**（stream_options.include_usage）里到达，
 *     所以不拿到 [DONE] 不判定结束——否则会丢掉 token 统计。
 *
 * 不可映射的能力（深度联网搜索、Files API 附件、标题生成）在 OpenAI 协议下
 * 直接不发送，不报错：请求体里这些字段一律被丢弃，服务端也就不会拒。
 */

/** OpenAI chat.completion.chunk（只声明本文件用到的字段，其余忽略） */
type OpenAiDelta = {
  role?: string
  content?: string | null
  /** DeepSeek / vLLM 的推理链字段 */
  reasoning_content?: string | null
  /** 部分中转站使用的别名 */
  reasoning?: string | null
}

type OpenAiChoice = {
  index?: number
  delta?: OpenAiDelta
  finish_reason?: string | null
}

type OpenAiUsage = {
  prompt_tokens?: number
  completion_tokens?: number
}

type OpenAiChunk = {
  id?: string
  model?: string
  choices?: OpenAiChoice[]
  usage?: OpenAiUsage
  error?: { message?: string }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** 请求侧：Anthropic Messages → OpenAI chat messages */
export type OpenAiMessage = { role: 'system' | 'user' | 'assistant'; content: string }

/**
 * 只搬文本。思考块、服务端工具调用与结果、引用都不回传给 OpenAI 协议：
 * 历史思考本来就不该进上下文，搜索结果块没有任何 OpenAI 等价物。
 *
 * `latest_reminder` 是 Chat Engine 的扩展角色（本轮时间等元信息），
 * OpenAI 协议没有对应角色，这里降级为一条 system 消息：位置紧贴其后的 user，
 * 语义上最接近“本轮附加上下文”。
 */
export const toOpenAiMessages = (body: CreateMessageRequest): OpenAiMessage[] => {
  const messages: OpenAiMessage[] = []
  if (body.system.trim()) {
    messages.push({ role: 'system', content: body.system })
  }
  const textOf = (content: MessageParam['content']): string =>
    typeof content === 'string'
      ? content
      : content
          .map((block) => (block.type === 'text' ? block.text : ''))
          .filter((text) => text !== '')
          .join('\n\n')
  for (const message of body.messages) {
    if (message.role === 'latest_reminder') {
      messages.push({ role: 'system', content: message.content })
      continue
    }
    if (message.role === 'user') {
      // 附件块（image/document）在 OpenAI 协议下没有等价引用；调用方在上传阶段
      // 就会拿到明确报错，这里只保证不把空串塞进请求。
      const text = textOf(message.content) || '[附件]'
      messages.push({ role: 'user', content: text })
      continue
    }
    const text = textOf(message.content)
    if (text.trim()) {
      messages.push({ role: 'assistant', content: text })
    }
  }
  return messages
}

/** 请求体：thinking / safety_check / tools / title 在此丢弃（协议不支持，发出去会被 400） */
export const toOpenAiBody = (body: CreateMessageRequest, model: string = body.model) => ({
  model,
  messages: toOpenAiMessages(body),
  stream: true,
  stream_options: { include_usage: true },
})

const toUsage = (usage: OpenAiUsage | undefined): MessageUsage | undefined => {
  if (!usage) {
    return undefined
  }
  const input = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : undefined
  const output = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : undefined
  if (input === undefined && output === undefined) {
    return undefined
  }
  return {
    input_tokens: input ?? 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: output ?? 0,
  }
}

/** finish_reason → stop_reason；未知值按正常结束处理，不让界面显示“被截断” */
const toStopReason = (reason: string | null | undefined): StopReason => {
  switch (reason) {
    case 'length':
      return 'max_tokens'
    case 'tool_calls':
    case 'function_call':
      return 'tool_use'
    case 'content_filter':
      return 'refusal'
    default:
      return 'end_turn'
  }
}

const readChunk = (value: unknown): OpenAiChunk | null => {
  if (!isRecord(value)) {
    return null
  }
  if (isErrorBody(value)) {
    return { error: { message: value.error.message } }
  }
  return value as OpenAiChunk
}

/**
 * POST {baseUrl}/v1/chat/completions（stream: true），逐条产出翻译后的事件。
 * 与 client.ts 的 streamMessage 保持同构：正常结束一定以 message_stop 收尾；
 * 未收到 [DONE] 或 finish_reason 就断流，抛 interrupted，交给上层按断流处理。
 */
export async function* streamOpenAiChat(
  config: EndpointConfig,
  apiKey: string,
  body: CreateMessageRequest,
  signal: AbortSignal
): AsyncGenerator<MessageStreamEvent> {
  const response = await request(`${apiBase(config)}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(toOpenAiBody(body)),
    signal,
  })
  const contentType = response.headers.get('Content-Type') ?? ''
  if (!response.body || !contentType.includes('text/event-stream')) {
    throw await readErrorResponse(response, 'protocol', '')
  }

  let started = false
  /** 当前打开的内容块；切换 thinking ⇄ text 时先关旧块再开新块 */
  let openBlock: { index: number; kind: 'thinking' | 'text' } | null = null
  let nextIndex = 0
  let stopReason: StopReason = 'end_turn'
  let usage: MessageUsage | undefined
  let rejected = false
  /**
   * 收到 finish_reason 或 [DONE] 才算正常结束。
   * 两者都没有就断流，说明连接被中途掐断（网关超时、代理断连），
   * 必须抛 interrupted 让上层标记失败，不能假装 end_turn 完成。
   */
  let endSignalled = false

  const closeBlock = (events: MessageStreamEvent[]) => {
    if (openBlock) {
      events.push({ type: 'content_block_stop', index: openBlock.index })
      openBlock = null
    }
  }

  const openSegment = (events: MessageStreamEvent[], kind: 'thinking' | 'text'): number => {
    if (openBlock?.kind === kind) {
      return openBlock.index
    }
    closeBlock(events)
    const index = nextIndex
    nextIndex += 1
    events.push({
      type: 'content_block_start',
      index,
      content_block:
        kind === 'thinking' ? { type: 'thinking', thinking: '', signature: '' } : { type: 'text', text: '' },
    })
    openBlock = { index, kind }
    return index
  }

  for await (const frame of readServerSentEvents(response.body, signal)) {
    const data = frame.data.trim()
    if (!data) {
      continue
    }
    if (data === '[DONE]') {
      endSignalled = true
      break
    }
    let chunk: OpenAiChunk | null
    try {
      chunk = readChunk(JSON.parse(data))
    } catch {
      continue
    }
    if (!chunk) {
      continue
    }
    if (chunk.error) {
      throw new ApiError('stream', chunk.error.message ?? '')
    }
    const events: MessageStreamEvent[] = []
    if (!started) {
      started = true
      events.push({
        type: 'message_start',
        message: {
          // 没有服务端 id 时用一个本地 id，仅用于界面去重，不参与回传
          id: typeof chunk.id === 'string' && chunk.id ? chunk.id : `chatcmpl-${Date.now().toString(36)}`,
          model: typeof chunk.model === 'string' && chunk.model ? chunk.model : body.model,
        },
      })
    }
    const choice = chunk.choices?.[0]
    const delta = choice?.delta
    if (delta && !rejected) {
      const reasoning =
        typeof delta.reasoning_content === 'string'
          ? delta.reasoning_content
          : typeof delta.reasoning === 'string'
            ? delta.reasoning
            : ''
      const content = typeof delta.content === 'string' ? delta.content : ''
      if (reasoning) {
        const index = openSegment(events, 'thinking')
        events.push({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: reasoning } })
      }
      if (content) {
        const index = openSegment(events, 'text')
        events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: content } })
      }
    }
    if (choice?.finish_reason) {
      stopReason = toStopReason(choice.finish_reason)
      endSignalled = true
      // 内容安全拦截：后续正文不再采信（Anthropic 侧同样由 settleReply 丢弃）
      rejected = stopReason === 'refusal'
    }
    const chunkUsage = toUsage(chunk.usage)
    if (chunkUsage) {
      usage = chunkUsage
    }
    for (const event of events) {
      yield event
    }
  }

  if (!started || !endSignalled) {
    throw new ApiError('interrupted', '')
  }
  const tail: MessageStreamEvent[] = []
  closeBlock(tail)
  tail.push({
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    ...(usage ? { usage } : {}),
  })
  tail.push({ type: 'message_stop' })
  for (const event of tail) {
    yield event
  }
}
