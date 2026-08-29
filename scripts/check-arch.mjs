/**
 * check-arch: 架构依赖方向扫描（全依赖矩阵）。
 * 规则：
 *   1. Cesium / MapLibre 只允许在 src/infra/** 引用（测试文件豁免：mock/动态导入属于测试职责）；
 *   2. 层间相对导入必须落在允许矩阵内（见 LAYER_MATRIX）；
 *   3. domain 零外部依赖、app 不被其它层反向导入，由矩阵隐含强制；
 *   4. src/testing/** 是测试专用层，仅测试文件可引用；
 *   5. 未知/已删除的层目录（如 src/state）直接报错。
 * 用法：node scripts/check-arch.mjs；退出码非 0 表示存在违规。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const SRC = join(ROOT, 'src')
const FORBIDDEN_PKGS = ['cesium', 'maplibre-gl']
const ALLOWED_IMPL = ['src/infra']

// 全依赖矩阵：源层 → 允许导入的目标层（自引用始终允许）。
// 依赖方向保持无环：app（组合根）→ controller/globe/infra/service → domain；
// globe 可依赖 infra（Cesium 适配）与 service（数据访问）；infra 可依赖 service（ArcGIS 数据接口）。
const LAYER_MATRIX = {
  app: ['app', 'controller', 'domain', 'globe', 'infra', 'service'],
  controller: ['controller', 'domain', 'globe', 'service'],
  globe: ['globe', 'domain', 'infra', 'service'],
  service: ['service', 'domain'],
  infra: ['infra', 'domain', 'service'],
  domain: ['domain'],
}

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

/** 按路径前缀判断文件所属层（src 根文件 / 样式等非层目录归 app）。 */
function layerOf(fileRel) {
  if (!fileRel.startsWith('src/')) return null
  const seg = fileRel.slice(4).split('/')[0]
  if (seg === 'testing') return 'testing'
  if (seg in LAYER_MATRIX) return seg
  return 'app' // src 根文件（App.tsx/main.tsx）与 styles 等资源目录
}

const violations = []

for (const file of walk(SRC)) {
  const text = readFileSync(file, 'utf8')
  const fileRel = rel(file)
  const isTest = /\.test\.(ts|tsx)$/.test(fileRel)
  const srcLayer = layerOf(fileRel)
  const isAllowedImpl = ALLOWED_IMPL.some((d) => fileRel.startsWith(d + '/'))

  for (const match of text.matchAll(IMPORT_RE)) {
    const spec = match[1]
    // 1) 渲染引擎引用收敛（测试文件豁免）
    if (!isTest && FORBIDDEN_PKGS.some((p) => spec === p || spec.startsWith(p + '/'))) {
      if (!isAllowedImpl) {
        violations.push(`${fileRel}: ${spec} 只能在 src/infra/** 引用`)
      }
    }
    if (!spec.startsWith('.')) continue

    // 2) 层间依赖矩阵
    if (srcLayer === 'testing') continue // 测试层为跨层测试设施，豁免矩阵
    const target = resolve(file, '..', spec)
    if (!target.startsWith(SRC)) continue // 相对导入越出 src（资源/外部）不参与分层
    const targetRel = rel(target)
    const targetLayer = layerOf(targetRel)

    if (targetLayer === 'testing') {
      if (!isTest) violations.push(`${fileRel}: src/testing 只能被测试文件引用（${spec}）`)
      continue
    }
    if (!targetLayer || !LAYER_MATRIX[srcLayer]) {
      violations.push(`${fileRel}: 未知或已删除的层目录（${spec} → ${targetRel}）`)
      continue
    }
    if (srcLayer !== 'testing' && !LAYER_MATRIX[srcLayer].includes(targetLayer)) {
      violations.push(`${fileRel}: ${srcLayer} 层禁止依赖 ${targetLayer} 层（${spec}）`)
    }
  }
}

if (violations.length > 0) {
  console.error(`[check-arch] ${violations.length} 处架构违规:`)
  for (const v of violations) console.error(`  - ${v}`)
  process.exit(1)
}
console.log('[check-arch] OK：层间依赖矩阵与渲染引擎引用均符合架构约束')
