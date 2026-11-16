import { getVisibleMessages } from './branches.js'
import type { Session } from './types.js'

/**
 * 会话标题兜底（L3）。
 *
 * 服务端标题是 DeepSeek 的扩展字段：`message_delta.delta.title`（store.ts 里消费）。
 * OpenAI 兼容协议没有这个字段，也没有等价的 title 接口，于是切换协议后侧栏会永远停在
 * 「新对话」。L4 不该知道「会话」这个概念，所以兜底放在 L3：回复收尾后若标题仍为空，
 * 用首条可见用户消息生成。
 *
 * 只在服务端没有下发标题时生效，用户手动重命名过的（title 非空）一律不覆盖。
 */

/** 侧栏标题的可读长度上限（中文按字符算，24 字≈侧栏两行） */
export const FALLBACK_TITLE_MAX_CHARS = 24

/** 纯文本附件：没有正文时用文件名/类型兜底 */
const filesTitle = (session: Session): string => {
  const first = getVisibleMessages(session).find((message) => message.role === 'user')
  if (!first || first.role !== 'user' || first.files.length === 0) {
    return ''
  }
  const image = first.files.find((file) => file.isImage)
  if (image) {
    return image.name || '图片对话'
  }
  return first.files[0].name || '附件对话'
}

/** 去掉 Markdown 里对标题没有意义的噪音：代码块、链接地址、行首标记、多余空白 */
const stripMarkup = (text: string): string =>
  text
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`{1,3}/g, '')
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()

/** 按字符截断，保留语义边界：优先在标点/空格处下刀 */
const truncate = (text: string, max: number): string => {
  if (text.length <= max) {
    return text
  }
  const window = text.slice(0, max)
  const cut = Math.max(
    window.lastIndexOf(' '),
    window.lastIndexOf('，'),
    window.lastIndexOf('。'),
    window.lastIndexOf('、'),
    window.lastIndexOf('?'),
    window.lastIndexOf('？')
  )
  const head = cut > max / 2 ? window.slice(0, cut) : window
  return `${head.trimEnd()}…`
}

/**
 * 生成兜底标题；无法生成时返回 ''（调用方保持原标题不变）。
 * 纯函数，不依赖浏览器，可被 scripts/title.test.mjs 直接跑。
 */
export const deriveFallbackTitle = (session: Session): string => {
  const question = getVisibleMessages(session).find((message) => message.role === 'user')
  const text = question && question.role === 'user' ? stripMarkup(question.content) : ''
  if (text) {
    return truncate(text, FALLBACK_TITLE_MAX_CHARS)
  }
  return truncate(filesTitle(session), FALLBACK_TITLE_MAX_CHARS)
}
