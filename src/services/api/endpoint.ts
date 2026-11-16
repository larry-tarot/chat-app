/**
 * 端点配置：运行时优先（localStorage），构建期兜底（__API_ORIGIN__）。
 *
 * 本文件是「API 到底打到哪」的唯一真相源。硬约束（见 ARCHITECTURE.md §4）：
 *  1. 不 import src/services/settings.ts —— 避免 zustand store 循环依赖；
 *  2. 不 import 任何 components/*；
 *  3. 所有 API 调用方（client.ts / speech.ts / 未来的 openai.ts）都必须经过这里取 baseUrl。
 *
 * API Key 不在此文件保管：它仍归 settings.ts 所有，调用方自行传入。
 */

/** 上游协议。Anthropic Messages 是 DeepSeek 兼容接口；OpenAI 兼容用于自建网关/中转站。 */
export type Protocol = 'anthropic-messages' | 'openai-chat'

export type EndpointConfig = {
  protocol: Protocol
  /** 不带尾斜杠的基址，例如 https://api.deepseek.com */
  baseUrl: string
  /** 配置来源：override = 用户在设置里填的；default = 构建期注入的 */
  source: 'override' | 'default'
}

/** 与 settings.ts 同前缀，独立键，互不覆盖 */
export const ENDPOINT_KEYS = {
  protocol: 'chat-demo:endpoint-protocol',
  baseUrl: 'chat-demo:endpoint-base-url',
} as const

export const DEFAULT_PROTOCOL: Protocol = 'anthropic-messages'

/** 构建期注入的默认基址，降级为 fallback，不再被直接拼进 URL */
export const DEFAULT_BASE_URL = __API_ORIGIN__

const isProtocol = (value: unknown): value is Protocol =>
  value === 'anthropic-messages' || value === 'openai-chat'

/**
 * 规范化用户输入的地址：去空白、去尾斜杠、补协议、校验 scheme。
 * 返回 null 表示输入非法，调用方应保留旧值并提示用户。
 */
export const normalizeBaseUrl = (input: string | null | undefined): string | null => {
  if (typeof input !== 'string') {
    return null
  }
  let value = input.trim()
  if (!value) {
    return null
  }
  // 允许用户只填 example.com 或 10.0.0.2:8080
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value)) {
    value = `https://${value}`
  }
  value = value.replace(/\/+$/, '')
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return null
    }
    // 只保留 origin + path，丢弃 query/hash，避免拼出 /v1?x=1/messages
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
  } catch {
    return null
  }
}

/** 纯函数：给定原始存储值与兜底值，算出最终配置。便于单测，不碰浏览器。 */
export const resolveEndpointFrom = (
  read: (key: string) => string | null,
  fallbackBaseUrl: string = DEFAULT_BASE_URL
): EndpointConfig => {
  const rawProtocol = read(ENDPOINT_KEYS.protocol)
  const baseUrl = normalizeBaseUrl(read(ENDPOINT_KEYS.baseUrl))
  if (baseUrl === null) {
    return { protocol: DEFAULT_PROTOCOL, baseUrl: normalizeBaseUrl(fallbackBaseUrl) ?? fallbackBaseUrl, source: 'default' }
  }
  return {
    protocol: isProtocol(rawProtocol) ? rawProtocol : DEFAULT_PROTOCOL,
    baseUrl,
    source: 'override',
  }
}

const read = (key: string): string | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(key)
  } catch {
    // 隐私模式 / file:// 下存储不可用：静默降级到构建期默认值
    return null
  }
}

const write = (key: string, value: string | null) => {
  try {
    if (typeof localStorage === 'undefined') {
      return
    }
    if (value === null) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, value)
    }
  } catch {
    // 同上：读不到就当没配过
  }
}

/** 当前生效配置。每次调用都重新读存储，保证设置面板改完立即生效（无需刷新）。 */
export const resolveEndpoint = (): EndpointConfig => resolveEndpointFrom(read)

/**
 * 写入覆盖配置。baseUrl 非法时返回 false 且不改动已有值。
 * 传 null 表示清除单项覆盖。
 */
export const setEndpointOverride = (patch: {
  protocol?: Protocol | null
  baseUrl?: string | null
}): boolean => {
  let baseUrl = patch.baseUrl
  if (baseUrl !== undefined && baseUrl !== null) {
    const normalized = normalizeBaseUrl(baseUrl)
    if (normalized === null) {
      return false
    }
    baseUrl = normalized
  }
  if (patch.protocol !== undefined) {
    write(ENDPOINT_KEYS.protocol, isProtocol(patch.protocol) ? patch.protocol : null)
  }
  if (baseUrl !== undefined) {
    write(ENDPOINT_KEYS.baseUrl, baseUrl)
  }
  return true
}

export const clearEndpointOverride = () => {
  write(ENDPOINT_KEYS.protocol, null)
  write(ENDPOINT_KEYS.baseUrl, null)
}

/** 各协议下的路径前缀。Anthropic 走兼容前缀，OpenAI 走 /v1。 */
export const apiBase = (config: EndpointConfig): string =>
  config.protocol === 'anthropic-messages'
    ? `${config.baseUrl}/anthropic/v1`
    : `${config.baseUrl}/v1`
