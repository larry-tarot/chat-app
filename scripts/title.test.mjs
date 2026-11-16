// L3 会话标题兜底验收：node scripts/title.test.mjs（纯函数，无需浏览器/网络）
import { register } from 'node:module'

register('./ts-js-resolve.mjs', import.meta.url)
const { deriveFallbackTitle, FALLBACK_TITLE_MAX_CHARS } = await import(
  '../src/services/chat/title.ts'
)

let failed = 0
const eq = (name, actual, expected) => {
  const ok = actual === expected
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      got =${JSON.stringify(actual)}\n      want=${JSON.stringify(expected)}`}`)
}

const user = (content, files = []) => ({
  id: 'u1',
  role: 'user',
  content,
  files,
  createdAt: 1,
})
const assistantOk = { id: 'a1', role: 'assistant' }
const session = (messages, extra = {}) => ({
  id: 's1',
  title: '',
  createdAt: 1,
  updatedAt: 1,
  messages,
  ...extra,
})

// 1. 普通短问句原样作标题
eq('短问句原样', deriveFallbackTitle(session([user('怎么优化首屏加载？'), assistantOk])), '怎么优化首屏加载？')

// 2. 折叠空白 + 去 Markdown 噪音
eq(
  '折叠空白与行首标记',
  deriveFallbackTitle(session([user('  ## 帮我看看\n\n- 这段  代码\n- 为什么慢  '), assistantOk])),
  '帮我看看 这段 代码 为什么慢'
)
eq(
  '链接只留文字',
  deriveFallbackTitle(session([user('看下 [官方文档](https://x.com/a) 里的说明'), assistantOk])),
  '看下 官方文档 里的说明'
)
eq('代码块整体丢弃', deriveFallbackTitle(session([user('```ts\nconst a = 1\n```\n这段能跑吗'), assistantOk])), '这段能跑吗')

// 3. 超长按标点截断，长度不超上限
const long = '我想知道这个项目在切换到兼容协议之后，思考过程、联网搜索引用以及语音输入这些能力分别会受什么影响，需要逐条确认'
const title = deriveFallbackTitle(session([user(long), assistantOk]))
console.log(`      截断结果 = ${JSON.stringify(title)} (${title.length} 字符)`)
eq('截断不超过上限', title.length <= FALLBACK_TITLE_MAX_CHARS + 1, true)
eq('截断带省略号', title.endsWith('…'), true)
eq('截断在语义边界', long.startsWith(title.slice(0, -1)), true)

// 4. 只有附件、没有正文 → 用文件名；图片优先
eq(
  '图片用文件名',
  deriveFallbackTitle(
    session([
      user('', [{ id: 'f1', serverId: null, name: 'screenshot.png', size: 1, isImage: true, mimeType: 'image/png' }]),
      assistantOk,
    ])
  ),
  'screenshot.png'
)

// 5. 空会话 / 无用户消息 → 返回空串，调用方保持原标题
eq('空会话返回空串', deriveFallbackTitle(session([])), '')
eq('只有助手消息返回空串', deriveFallbackTitle(session([assistantOk])), '')

// 6. 分支会话：取当前选中分支的第一条用户提问，而不是历史分支
const branchSession = session(
  [
    { ...user('第一个分支的旧问题'), id: 'u-old', parentId: null, selectedChildId: null },
    { ...user('我当前真正问的问题'), id: 'u-new', parentId: null, selectedChildId: 'a-new' },
    { ...assistantOk, id: 'a-new', parentId: 'u-new' },
  ],
  { rootMessageId: 'u-new' }
)
eq('跟随选中分支', deriveFallbackTitle(branchSession), '我当前真正问的问题')

console.log(failed === 0 ? '\n✅ 全部通过' : `\n❌ ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
