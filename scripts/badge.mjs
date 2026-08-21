// 生成 shields.io endpoint 徽章数据（真实数据，非静态值）
// 用法：先跑 test:coverage + e2e + audit，再执行  node scripts/badge.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function readJson(rel) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'))
  } catch {
    return null
  }
}

function writeBadge(name, label, message, color) {
  const data = { schemaVersion: 1, label, message, color }
  fs.writeFileSync(path.join(root, 'coverage', name), JSON.stringify(data))
  console.log(label + ': ' + message + ' (' + color + ')')
}

function colorFor(pct) {
  if (pct >= 90) return 'brightgreen'
  if (pct >= 80) return 'green'
  if (pct >= 70) return 'yellowgreen'
  if (pct >= 50) return 'yellow'
  return 'red'
}

// coverage（与 CI 门槛口径一致：statements）
const summary = readJson('coverage/coverage-summary.json')
if (summary) {
  const pct = Math.round(summary.total.statements.pct)
  writeBadge('coverage.json', 'coverage', pct + '%', colorFor(pct))
} else {
  writeBadge('coverage.json', 'coverage', 'n/a', 'lightgrey')
}

// deps（npm audit：生产依赖 high+critical 数量）
const audit = readJson('audit.json')
if (audit && audit.metadata && audit.metadata.vulnerabilities) {
  const v = audit.metadata.vulnerabilities
  const bad = (v.high || 0) + (v.critical || 0)
  writeBadge('deps.json', 'deps', bad === 0 ? '0 high' : bad + ' high', bad === 0 ? 'brightgreen' : 'red')
} else {
  writeBadge('deps.json', 'deps', 'n/a', 'lightgrey')
}

// tests（vitest json 输出，CI 每次实时生成）
const tr = readJson('test-results.json')
if (tr) {
  const msg = tr.numPassedTests + '/' + tr.numTotalTests + ' passed'
  writeBadge('tests.json', 'tests', msg, (tr.numFailedTests || 0) === 0 ? 'brightgreen' : 'red')
} else {
  writeBadge('tests.json', 'tests', 'n/a', 'lightgrey')
}

// e2e（playwright json 输出，CI 每次实时生成）
const er = readJson('e2e-results.json')
if (er && er.stats) {
  const msg = er.stats.expected + ' passed'
  writeBadge('e2e.json', 'e2e', msg, (er.stats.unexpected || 0) === 0 ? 'brightgreen' : 'red')
} else {
  writeBadge('e2e.json', 'e2e', 'n/a', 'lightgrey')
}

