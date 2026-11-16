// 让 Node 能直接跑 TypeScript 源码：把源码里的 `./x.js` 说明符回指到 `./x.ts`。
// 只在验收脚本里通过 module.register 加载，不参与打包（rspack 认的是 tsconfig 里的 .js → .ts）。
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const resolve = async (specifier, context, nextResolve) => {
  if (specifier.endsWith('.js') && (specifier.startsWith('./') || specifier.startsWith('../'))) {
    const candidate = specifier.slice(0, -3) + '.ts'
    const parent = context.parentURL
    if (parent) {
      const url = new URL(candidate, parent)
      if (existsSync(fileURLToPath(url))) {
        return nextResolve(candidate, context)
      }
    }
  }
  return nextResolve(specifier, context)
}
