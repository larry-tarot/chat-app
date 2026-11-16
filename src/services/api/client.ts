import { apiBase, resolveEndpoint, type EndpointConfig } from './endpoint.js'
import { streamOpenAiChat } from './openai.js'
import { readMessageEvent } from './parseEvent.js'
import { readServerSentEvents } from './sse.js'
import { ApiError, isErrorBody, readErrorResponse, request } from './transport.js'
import type { CreateMessageRequest, FileObject, FilePurpose, MessageStreamEvent } from './types.js'

/**
 * Provider A：Anthropic Messages 兼容协议（DeepSeek 官方接口）。
 * 请求地址不再在模块顶层拼死：每次请求前 `resolveEndpoint()` 现取，
 * 设置面板改完端点/协议后无需刷新即可生效（见 endpoint.ts）。
 */

export { ApiError, readErrorResponse, request } from './transport.js'
export type { ApiErrorKind } from './transport.js'

/** 构建期注入的默认地址，仅作兜底；真实请求地址一律走 resolveEndpoint() */
export const API_ORIGIN = __API_ORIGIN__
/** 引用 Files API 上传的图片、调用 Anthropic 兼容 Files API 时必须携带 */
const FILES_BETA = 'files-api-2025-04-14'

/** Files API 只存在于 Anthropic 兼容协议；OpenAI 兼容网关没有等价接口 */
const requireAnthropic = (config: EndpointConfig, action: string): EndpointConfig => {
  if (config.protocol !== 'anthropic-messages') {
    throw new ApiError(
      'protocol',
      `${action}只在 Anthropic 兼容协议下可用；当前是 OpenAI 兼容协议，请切换协议或移除附件。`
    )
  }
  return config
}

const anthropicHeaders = (apiKey: string, beta: boolean): Record<string, string> => ({
  // DeepSeek 兼容接口的鉴权方式，也可使用 Authorization: Bearer。
  'x-api-key': apiKey,
  // Files API 和通过 file_id 引用图片时必传；纯文本聊天无需携带。
  ...(beta ? { 'anthropic-beta': FILES_BETA } : {}),
})

/** 用 GET /models 校验 API Key（不产生费用）。两种协议路径不同，鉴权都用 Bearer。 */
export const verifyApiKey = async (apiKey: string, signal?: AbortSignal): Promise<void> => {
  const config = resolveEndpoint()
  const url =
    config.protocol === 'anthropic-messages'
      ? `${config.baseUrl}/models`
      : `${apiBase(config)}/models`
  await request(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
    signal,
  })
}

/**
 * POST /anthropic/v1/files 上传附件（不设过期时间，会话里的历史附件一直可用）。
 * purpose 为 null 时不传该字段（图片）；purpose 必须排在 file 之前。
 */
export const uploadFile = async (
  apiKey: string,
  file: File,
  purpose: FilePurpose | null,
  signal?: AbortSignal
): Promise<FileObject> => {
  const config = requireAnthropic(resolveEndpoint(), '上传附件')
  const form = new FormData()
  if (purpose) {
    form.append('purpose', purpose)
  }
  form.append('file', file)
  const response = await request(`${apiBase(config)}/files`, {
    method: 'POST',
    headers: anthropicHeaders(apiKey, true),
    body: form,
    signal,
  })
  return (await response.json()) as FileObject
}

/** DELETE /anthropic/v1/files/{file_id} */
export const deleteFile = async (apiKey: string, fileId: string): Promise<void> => {
  const config = requireAnthropic(resolveEndpoint(), '删除附件')
  await request(`${apiBase(config)}/files/${encodeURIComponent(fileId)}`, {
    method: 'DELETE',
    headers: anthropicHeaders(apiKey, true),
  })
}

const hasFile = (body: CreateMessageRequest) =>
  body.messages.some(
    (message) =>
      typeof message.content !== 'string' &&
      message.content.some((block) => block.type === 'image' || block.type === 'document')
  )

/**
 * POST /anthropic/v1/messages（stream: true），逐个产出流式事件，收到 message_stop 时结束。
 * ping、保活注释与无法解析的内容不产出；中止请求时抛出 signal 的 AbortError。
 */
export async function* streamMessage(
  apiKey: string,
  body: CreateMessageRequest,
  signal: AbortSignal
): AsyncGenerator<MessageStreamEvent> {
  const config = resolveEndpoint()
  if (config.protocol === 'openai-chat') {
    yield* streamOpenAiChat(config, apiKey, body, signal)
    return
  }
  const response = await request(`${apiBase(config)}/messages`, {
    method: 'POST',
    headers: {
      ...anthropicHeaders(apiKey, hasFile(body)),
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({ ...body, stream: true }),
    signal,
  })
  const contentType = response.headers.get('Content-Type') ?? ''
  if (!response.body || !contentType.includes('text/event-stream')) {
    throw await readErrorResponse(response, 'protocol', '')
  }
  for await (const { event: eventName, data } of readServerSentEvents(response.body, signal)) {
    let payload: unknown
    try {
      payload = JSON.parse(data)
    } catch {
      if (eventName !== 'error') {
        continue
      }
    }
    if (isErrorBody(payload)) {
      throw new ApiError('stream', payload.error.message)
    }
    if (eventName === 'error') {
      throw new ApiError('stream', data)
    }
    const event = readMessageEvent(payload)
    if (!event) {
      continue
    }
    yield event
    if (event.type === 'message_stop') {
      return
    }
  }
  // 服务端没有提供错误内容时保持为空，不推测断流原因。
  throw new ApiError('interrupted', '')
}
