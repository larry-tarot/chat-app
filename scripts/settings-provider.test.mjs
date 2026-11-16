// 设置面板「服务商」分区的验收脚本（无测试框架，直接 node scripts/settings-provider.test.mjs）
// 覆盖三件事：
//   1. 端点规范化在 UI 里承诺的三个行为（自动补 https / 拒绝非法 scheme / 保留端口与路径）
//   2. zh 与 en 文案键完全对齐（漏一条英文会让界面报 key 本身）
//   3. 组件里出现的每个字面量文案键都真实存在（拼错 key 不会在编译期报错，只会显示原文）
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

globalThis.__API_ORIGIN__ = 'https://api.deepseek.com'

const { normalizeBaseUrl } = await import('../src/services/api/endpoint.ts')

let failed = 0
const ok = (name, pass, detail = '') => {
  if (!pass) failed++
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : `\n      ${detail}`}`)
}
const eq = (name, actual, expected) => {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  ok(name, pass, `got=${JSON.stringify(actual)} want=${JSON.stringify(expected)}`)
}

// 1. 端点地址：用户能填的三种形态
eq('gw.example.com 自动补 https', normalizeBaseUrl(' gw.example.com/ '), 'https://gw.example.com')
eq('localhost:8799 自动补 https', normalizeBaseUrl('localhost:8799'), 'https://localhost:8799')
eq('http 地址原样保留（自建桩常用）', normalizeBaseUrl('http://127.0.0.1:8799/'), 'http://127.0.0.1:8799')
eq('带路径的网关不丢前缀', normalizeBaseUrl('https://gw.example.com/api/'), 'https://gw.example.com/api')
eq('ftp://x 判非法（保存必须失败且不落库）', normalizeBaseUrl('ftp://x'), null)
eq('空白判非法', normalizeBaseUrl('  '), null)
eq('query/hash 被丢弃', normalizeBaseUrl('https://gw.example.com/?k=1#h'), 'https://gw.example.com')

// 2. zh / en 文案键对齐
const keysOf = (file) => {
  const source = readFileSync(new URL(`../src/i18n/${file}`, import.meta.url), 'utf8')
  const body = source.slice(source.indexOf('{'))
  return [...body.matchAll(/^ {2}(\w+):/gm)].map((match) => match[1])
}
const zhKeys = keysOf('zh.ts')
const enKeys = keysOf('en.ts')
const missingEn = zhKeys.filter((key) => !enKeys.includes(key))
const extraEn = enKeys.filter((key) => !zhKeys.includes(key))
ok(`zh 与 en 键数量一致（${zhKeys.length}）`, missingEn.length === 0 && extraEn.length === 0,
  `missingInEn=${missingEn.join(',')} extraInEn=${extraEn.join(',')}`)

// 3. 组件里引用的文案键都存在
const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : path.endsWith('.tsx') || path.endsWith('.ts') ? [path] : []
  })
const files = [...walk(new URL('../src/components', import.meta.url).pathname), ...walk(new URL('../src/services', import.meta.url).pathname)]
const used = new Set()
for (const file of files) {
  const source = readFileSync(file, 'utf8')
  for (const match of source.matchAll(/\b(?:t|translate)\('([a-zA-Z0-9_]+)'/g)) {
    used.add(match[1])
  }
  for (const match of source.matchAll(/showToast\(\{\s*key: '([a-zA-Z0-9_]+)'/g)) {
    used.add(match[1])
  }
}
const missing = [...used].filter((key) => !zhKeys.includes(key))
ok(`引用的 ${used.size} 个文案键全部存在于 zh.ts`, missing.length === 0, `missing=${missing.join(',')}`)

// 4. 新增的服务商文案确实带上了（防止只改中文忘了英文侧的空字符串）
for (const key of [
  'settingDialogAsideProviderOptionLabel',
  'settingsEndpointInvalid',
  'settingsEndpointUnreachable',
  'protocolNoUpload',
  'protocolNoVoice',
  'protocolNoSearch',
  'protocolNoTts',
]) {
  ok(`文案 ${key} 两侧都非空`, zhKeys.includes(key) && enKeys.includes(key))
}

console.log(failed === 0 ? '\n✅ 全部通过' : `\n❌ ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
