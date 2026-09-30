import assert from 'node:assert/strict'
import {
  applyRuleChange,
  commitBaseline,
  globMatch,
  guardReview,
  recomputeRegions,
  type RunLike,
} from '../src/utils/reconcile'
import type { Baseline, DifferenceRegion, IgnoreRule, ScreenshotRun } from '../src/types'

let passed = 0
const test = (name: string, fn: () => void) => {
  fn()
  passed += 1
  console.log(`✓ ${name}`)
}

const makeRegion = (over: Partial<DifferenceRegion> = {}): DifferenceRegion => ({
  id: 'r1',
  x: 72,
  y: 71,
  width: 18,
  height: 13,
  severity: 'low',
  pixels: 216,
  kind: 'environment',
  ignored: false,
  selector: '[data-visual-ignore="relative-time"]',
  delta: 6,
  ...over,
})

const timeRule = (over: Partial<IgnoreRule> = {}): IgnoreRule => ({
  id: 'rule-time',
  name: '动态时间区域',
  projectId: 'all',
  selector: '[data-visual-ignore="relative-time"]',
  pagePattern: '*',
  devicePattern: '*',
  maxDelta: 12,
  enabled: true,
  createdAt: '2026-09-02T09:00:00+08:00',
  version: 3,
  ...over,
})

const makeRun = (over: Partial<ScreenshotRun> = {}): ScreenshotRun => ({
  id: 'run-1',
  name: '回归',
  projectId: 'p-commerce',
  page: '订单结算页',
  device: 'Desktop 1440',
  theme: 'light',
  build: 'b1',
  status: 'pending',
  mismatchRate: 1,
  capturedAt: '2026-09-29T08:42:00+08:00',
  baselineVersion: 'v1',
  currentVersion: 'v2',
  rulesVersion: 3,
  diffState: 'current',
  regions: [makeRegion()],
  ...over,
})

const makeBaseline = (over: Partial<Baseline> = {}): Baseline => ({
  id: 'b1',
  projectId: 'p-commerce',
  page: '订单结算页',
  device: 'Desktop 1440',
  theme: 'light',
  version: 'v1',
  approvedBy: '沈宁',
  reason: '旧基线',
  approvedAt: '2026-09-19T11:30:00+08:00',
  runId: 'run-old',
  active: true,
  rulesVersion: 3,
  ...over,
})

const makeDb = () => ({
  rulesVersion: 3,
  runs: [] as ScreenshotRun[],
  baselines: [] as Baseline[],
})

// ---------- glob ----------
test('globMatch 支持 * 通配', () => {
  assert.equal(globMatch('*', '任意页面'), true)
  assert.equal(globMatch('/checkout/*', '/checkout/pay'), true)
  assert.equal(globMatch('/checkout/*', '/home'), false)
  assert.equal(globMatch('iPhone*', 'iPhone 15'), true)
})

// ---------- recompute ----------
test('recomputeRegions 按规则标记忽略并留痕规则版本', () => {
  const run: RunLike = { projectId: 'p-commerce', page: '订单结算页', device: 'Desktop 1440' }
  const rule = timeRule({ version: 7 })
  const [region] = recomputeRegions([makeRegion()], [rule], run)
  assert.equal(region.ignored, true)
  assert.equal(region.ruleId, 'rule-time')
  assert.equal(region.ruleVersion, 7)
  assert.equal(typeof region.delta, 'number')
})

test('色差超过 maxDelta 不再忽略', () => {
  const run: RunLike = { projectId: 'p-commerce', page: 'p', device: 'd' }
  const [region] = recomputeRegions([makeRegion({ delta: 20 })], [timeRule({ maxDelta: 5 })], run)
  assert.equal(region.ignored, false)
  assert.equal(region.ruleId, undefined)
})

test('停用规则与跨项目规则不生效', () => {
  const run: RunLike = { projectId: 'p-growth', page: 'p', device: 'd' }
  const [disabled] = recomputeRegions([makeRegion()], [timeRule({ enabled: false })], run)
  assert.equal(disabled.ignored, false)
  const [scoped] = recomputeRegions(
    [makeRegion()],
    [timeRule({ projectId: 'p-commerce' })],
    run,
  )
  assert.equal(scoped.ignored, false)
})

// ---------- applyRuleChange ----------
test('规则改动：待审批运行先失效、按新规则重算并升级版本', () => {
  const db = makeDb()
  db.runs = [makeRun({ regions: [makeRegion({ ignored: true, ruleId: 'rule-time', ruleVersion: 3 })] })]
  const previous = [timeRule()]
  const next = [timeRule({ maxDelta: 0 })]
  const summary = applyRuleChange(db, previous, next, 'rule-time', 'now')
  assert.equal(summary.rulesVersion, 4)
  assert.deepEqual(summary.invalidatedRunIds, ['run-1'])
  assert.equal(db.runs[0].diffState, 'stale')
  assert.equal(db.runs[0].rulesVersion, 4)
  assert.equal(db.runs[0].regions[0].ignored, false)
  assert.equal(next[0].version, 4)
})

test('规则改动：作用域外的运行不受影响', () => {
  const db = makeDb()
  db.runs = [makeRun({ projectId: 'p-growth' })]
  const previous = [timeRule({ projectId: 'p-commerce' })]
  const next = [timeRule({ projectId: 'p-commerce', maxDelta: 0 })]
  const summary = applyRuleChange(db, previous, next, 'rule-time', 'now')
  assert.deepEqual(summary.invalidatedRunIds, [])
  assert.equal(db.runs[0].diffState, 'current')
  assert.equal(db.runs[0].rulesVersion, 3)
})

test('规则改动：已批准运行与有效基线保留原样，仅列入待复核', () => {
  const db = makeDb()
  const approvedRun = makeRun({
    status: 'approved',
    review: {
      category: 'design-change',
      decision: 'approved',
      reviewer: '林默',
      reason: '设计变更已确认',
      reviewedAt: '2026-09-28T18:02:00+08:00',
      baselineVersion: 'v1',
      rulesVersion: 3,
    },
  })
  db.runs = [approvedRun]
  db.baselines = [makeBaseline(), makeBaseline({ id: 'b2', active: false })]
  const summary = applyRuleChange(db, [timeRule()], [timeRule({ maxDelta: 200 })], 'rule-time', 'now')

  assert.deepEqual(summary.rereviewRunIds, ['run-1'])
  assert.deepEqual(summary.rereviewBaselineIds, ['b1'])
  // 原判定不动
  assert.equal(db.runs[0].status, 'approved')
  assert.equal(db.runs[0].review?.rulesVersion, 3)
  assert.equal(db.runs[0].review?.baselineVersion, 'v1')
  assert.equal(db.runs[0].rereview?.resolved, false)
  assert.equal(db.runs[0].rereview?.rulesVersion, 4)
  // 基线版本保留
  assert.equal(db.baselines[0].version, 'v1')
  assert.equal(db.baselines[0].active, true)
  // 停用基线不列入复核
  assert.equal(db.baselines[1].rereview, undefined)
})

test('删除规则也触发作用域对账', () => {
  const db = makeDb()
  db.runs = [makeRun()]
  const summary = applyRuleChange(db, [timeRule()], [], 'rule-time', 'now')
  assert.deepEqual(summary.invalidatedRunIds, ['run-1'])
  assert.equal(db.runs[0].regions[0].ignored, false)
})

// ---------- guardReview ----------
test('guardReview：依据版本一致时放行', () => {
  const run = makeRun()
  const result = guardReview(run, 'v1', 'v1', 3)
  assert.deepEqual(result, { ok: true })
})

test('guardReview：已被另一个标签页处理返回 RUN_DECIDED', () => {
  const run = makeRun({
    status: 'approved',
    review: {
      category: 'design-change',
      decision: 'approved',
      reviewer: '周航',
      reason: '另一标签页更早审批',
      reviewedAt: 't',
      baselineVersion: 'v1',
      rulesVersion: 3,
    },
  })
  const result = guardReview(run, 'v1', 'v1', 3)
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.code, 'RUN_DECIDED')
    if (result.code === 'RUN_DECIDED') assert.equal(result.reviewer, '周航')
  }
})

test('guardReview：规则版本变化返回 RULES_CHANGED', () => {
  const run = makeRun({ rulesVersion: 4, diffState: 'stale' })
  const result = guardReview(run, 'v1', 'v1', 3)
  assert.equal(result.ok, false)
  if (!result.ok && result.code === 'RULES_CHANGED') {
    assert.equal(result.expected, 3)
    assert.equal(result.current, 4)
  } else {
    assert.fail('应返回 RULES_CHANGED')
  }
})

test('guardReview：有效基线变化返回 BASELINE_CHANGED', () => {
  const run = makeRun()
  const result = guardReview(run, 'v2-new', 'v1', 3)
  assert.equal(result.ok, false)
  if (!result.ok && result.code === 'BASELINE_CHANGED') {
    assert.equal(result.expected, 'v1')
    assert.equal(result.current, 'v2-new')
  } else {
    assert.fail('应返回 BASELINE_CHANGED')
  }
})

// ---------- commitBaseline ----------
test('commitBaseline：最早的有效审批创建唯一有效基线，旧基线停用留痕', () => {
  const baselines = [makeBaseline(), makeBaseline({ id: 'b-old2', active: false })]
  const run = makeRun({ currentVersion: 'v2', rulesVersion: 4 })
  const created = commitBaseline(baselines, run, '林默', '批准理由', '2026-09-30T10:00:00+08:00')
  assert.equal(created.version, 'v2')
  assert.equal(created.rulesVersion, 4)
  assert.equal(created.active, true)
  assert.equal(baselines[0].active, true)
  // 原来有效的 b1 被停用，历史停用基线保持停用，全部记录仍在
  assert.equal(baselines.find((b) => b.id === 'b1')?.active, false)
  assert.equal(baselines.filter((b) => b.active).length, 1)
  assert.equal(baselines.length, 3)
})

console.log(`\n${passed} 个测试全部通过`)
