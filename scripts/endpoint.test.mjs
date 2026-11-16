// 端点配置验收脚本（不引入测试框架，直接 node scripts/endpoint.test.mjs）
// 依赖 Node >= 22.18 的原生 TS 类型剥离；通过 globalThis.__API_ORIGIN__ 模拟构建期常量。
globalThis.__API_ORIGIN__ = 'https://api.deepseek.com'

const { normalizeBaseUrl, resolveEndpointFrom, apiBase, ENDPOINT_KEYS } = await import(
  '../src/services/api/endpoint.ts'
)

let failed = 0
const eq = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      got=${JSON.stringify(actual)}\n      want=${JSON.stringify(expected)}`}`)
}

// 1. 规范化
eq('裸域名补 https 并去尾斜杠', normalizeBaseUrl(' api.example.com/ '), 'https://api.example.com')
eq('保留端口与路径', normalizeBaseUrl('http://10.0.0.2:8080/v1/'), 'http://10.0.0.2:8080/v1')
eq('丢弃 query/hash', normalizeBaseUrl('https://gw.example.com/base/?k=1#x'), 'https://gw.example.com/base')
eq('非法 scheme 拒绝', normalizeBaseUrl('ftp://gw.example.com'), null)
eq('空值拒绝', normalizeBaseUrl('   '), null)
eq('非字符串拒绝', normalizeBaseUrl(undefined), null)

// 2. 无覆盖 → 构建期默认
const store = {}
const read = (k) => (k in store ? store[k] : null)
eq('默认配置', resolveEndpointFrom(read), {
  protocol: 'anthropic-messages',
  baseUrl: 'https://api.deepseek.com',
  source: 'default',
})

// 3. 有覆盖 → 运行时值优先
store[ENDPOINT_KEYS.baseUrl] = 'https://gw.internal/'
store[ENDPOINT_KEYS.protocol] = 'openai-chat'
const cfg = resolveEndpointFrom(read)
eq('覆盖生效', cfg, { protocol: 'openai-chat', baseUrl: 'https://gw.internal', source: 'override' })
eq('openai 路径前缀', apiBase(cfg), 'https://gw.internal/v1')

// 4. 非法协议值回落默认，地址仍然生效
store[ENDPOINT_KEYS.protocol] = 'garbage'
eq('非法协议回落', resolveEndpointFrom(read).protocol, 'anthropic-messages')
eq('anthropic 路径前缀', apiBase(resolveEndpointFrom(read)), 'https://gw.internal/anthropic/v1')

// 5. 损坏的地址 → 整体回落构建期默认
store[ENDPOINT_KEYS.baseUrl] = 'not a url ###'
eq('损坏地址回落默认', resolveEndpointFrom(read), {
  protocol: 'anthropic-messages',
  baseUrl: 'https://api.deepseek.com',
  source: 'default',
})

console.log(failed === 0 ? '\n✅ 全部通过' : `\n❌ ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
