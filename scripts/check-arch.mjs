/**
 * check-arch: 架构依赖方向扫描（W4.4）。
 * 规则：
 *   1. Cesium / MapLibre 只允许在 src/infra/** 与 src/globe/facade/** 引用；
 *   2. src/domain/** 零外部依赖（相对导入必须仍落在 src/domain 内）；
 *   3. src/app/**（表现层）不得被其它层反向导入。
 * 用法：node scripts/check-arch.mjs；退出码非 0 表示存在违规。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const SRC = join(ROOT, 'src')
const FORBIDDEN_PKGS = ['cesium', 'maplibre-gl']
const ALLOWED_IMPL = ['src/infra', 'src/globe/facade']

const IMPORT_RE = /(?:from\s*|import\s*\(\s*|require\(\s*|import\s+)['"]([^'"]+)['"]/g

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (/\.(ts|tsx|js|mjs)$/.test(name)) out.push(full)
  }
  return out
}

function rel(p) {
  return relative(ROOT, p).split(sep).join('/')
}

const violations = []

for (const file of walk(SRC)) {
  const text = readFileSync(file, 'utf8')
  const fileRel = rel(file)
  const isTest = /\.test\.(ts|tsx)$/.test(fileRel)
  const isDomain = fileRel.startsWith('src/domain/')
  const isAllowedImpl = ALLOWED_IMPL.some((d) => fileRel.startsWith(d + '/'))
  const isApp = fileRel.startsWith('src/app/')

  for (const match of text.matchAll(IMPORT_RE)) {
    const spec = match[1]
    // 1) 渲染引擎引用收敛（测试文件豁免：mock/动态导入引擎属于测试职责）
    if (!isTest && FORBIDDEN_PKGS.some((p) => spec === p || spec.startsWith(p + '/'))) {
      if (!isAllowedImpl) {
        violations.push(`${fileRel}: ${spec} 只能在 src/infra/** 与 src/globe/facade/** 引用`)
      }
    }
    if (!spec.startsWith('.')) continue
    // 2) Domain 零依赖
    if (isDomain) {
      const target = resolve(file, '..', spec)
      if (!target.startsWith(join(SRC, 'domain'))) {
        violations.push(`${fileRel}: Domain 层禁止外部依赖（${spec}）`)
      }
    }
    // 3) 表现层不被反向依赖
    if (!isApp && /(^|\/)\.\.\/app(\/|$)/.test(spec)) {
      violations.push(`${fileRel}: 表现层 src/app 禁止被其它层导入（${spec}）`)
    }
  }
}

if (violations.length > 0) {
  console.error(`[check-arch] ${violations.length} 处架构违规:`)
  for (const v of violations) console.error(`  - ${v}`)
  process.exit(1)
}
console.log('[check-arch] OK：依赖方向与渲染引擎引用均符合架构约束')
