import assert from 'node:assert/strict'
import type { AxiosRequestConfig } from 'axios'

// ---- 浏览器环境垫片：localStorage ----
const storage = new Map<string, string>()
;(globalThis as { localStorage: Storage }).localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, value),
  removeItem: (key: string) => void storage.delete(key),
  clear: () => storage.clear(),
  key: (index: number) => [...storage.keys()][index] ?? null,
  get length() {
    return storage.size
  },
}

// 让 mock 的 180ms 延迟瞬时完成
const originalSetTimeout = globalThis.setTimeout
;(globalThis as { setTimeout: typeof setTimeout }).setTimeout = ((handler: TimerHandler) =>
  originalSetTimeout(handler, 0)) as typeof setTimeout
;(globalThis as { window: { setTimeout: typeof setTimeout } }).window = {
  setTimeout: (handler: TimerHandler) => originalSetTimeout(handler, 0),
} as never

async function main() {
const { api } = await import('../src/api/http')

let passed = 0
const test = async (name: string, fn: () => Promise<void> | void) => {
  await fn()
  passed += 1
  console.log(`✓ ${name}`)
}

const call = (config: AxiosRequestConfig) => api.request(config)

const payload = (reviewer: string) => ({
  category: 'design-change' as const,
  decision: 'approved' as const,
  reviewer,
  reason: '两个标签页同时评审同一批截图',
})

await test('两个标签页同时打开评审，拿到相同的依据版本', async () => {
  const [a, b] = await Promise.all([
    call({ method: 'post', url: '/runs/run-1048/review-session' }),
    call({ method: 'post', url: '/runs/run-1048/review-session' }),
  ])
  assert.equal(a.data.rulesVersion, b.data.rulesVersion)
  assert.equal(a.data.baselineVersion, b.data.baselineVersion)
  assert.equal(a.data.writable, true)
})

await test('同时提交审批：最早的有效审批创建基线，后到者 409 且输入不丢', async () => {
  const sessionRes = await call({ method: 'post', url: '/runs/run-1047/review-session' })
  const expected = {
    expectedBaselineVersion: sessionRes.data.baselineVersion,
    expectedRulesVersion: sessionRes.data.rulesVersion,
  }

  // 两个标签页用同一份评审输入（各自保留在自己表单里）同时提交
  const [first, second] = await Promise.allSettled([
    call({
      method: 'patch',
      url: '/runs/run-1047/review',
      data: { ...payload('评审人甲'), ...expected },
    }),
    call({
      method: 'patch',
      url: '/runs/run-1047/review',
      data: { ...payload('评审人乙'), ...expected },
    }),
  ])

  assert.equal(first.status, 'fulfilled')
  if (first.status === 'fulfilled') {
    assert.equal(first.value.data.status, 'approved')
    assert.equal(first.value.data.review.reviewer, '评审人甲')
  }

  assert.equal(second.status, 'rejected')
  if (second.status === 'rejected') {
    const err = second.reason as { response?: { status?: number; data?: unknown } }
    assert.equal(err.response?.status, 409)
    const body = err.response?.data as { code: string; details?: { reviewer?: string } }
    assert.equal(body.code, 'RUN_DECIDED')
    assert.equal(body.details?.reviewer, '评审人甲')
  }

  // 同作用域只有一个有效基线，且属于最早审批
  const baselines = (await call({ method: 'get', url: '/baselines' })).data as Array<{
    page: string
    device: string
    active: boolean
    version: string
    approvedBy: string
  }>
  const scoped = baselines.filter((b) => b.page === '商品列表页' && b.device === 'iPhone 15')
  assert.equal(scoped.filter((b) => b.active).length, 1)
  assert.equal(scoped[0].version, 'v6.18.0-rc2')
  assert.equal(scoped[0].approvedBy, '评审人甲')
  // 旧基线仍在（已停用留痕）
  assert.equal(scoped.length, 2)
})

await test('后到者按最新状态重试时，运行已不可审，输入仍可保留在表单（由前端承载）', async () => {
  const run = (await call({ method: 'get', url: '/runs/run-1047' })).data as { status: string }
  assert.equal(run.status, 'approved')
  // 前端重新打开会话会拿到 writable:false，不会误放出再次审批入口
  const session = (
    await call({ method: 'post', url: '/runs/run-1047/review-session' })
  ).data as { writable: boolean }
  assert.equal(session.writable, false)
})

await test('规则改动后，旧依据提交返回 RULES_CHANGED 409，差异已按新规则重算', async () => {
  // 在 run-1044 上打开评审（规则 v3）
  const sessionRes = await call({ method: 'post', url: '/runs/run-1044/review-session' })
  const oldExpected = {
    expectedBaselineVersion: sessionRes.data.baselineVersion,
    expectedRulesVersion: sessionRes.data.rulesVersion,
  }

  // 另一处把规则改严（maxDelta 12 -> 0），触发对账
  await call({ method: 'patch', url: '/rules/rule-time', data: { maxDelta: 0 } })

  // 旧标签页提交：409 RULES_CHANGED
  const stale = await Promise.allSettled([
    call({ method: 'patch', url: '/runs/run-1044/review', data: { ...payload('旧标签页'), ...oldExpected } }),
  ])
  const result = stale[0]
  assert.equal(result.status, 'rejected')
  if (result.status === 'rejected') {
    const body = (result.reason as { response?: { data?: { code: string } } }).response?.data
    assert.equal(body?.code, 'RULES_CHANGED')
  }

  // 运行已失效并重算（rule-time 不再忽略命中区域）
  const runRes = await call({ method: 'get', url: '/runs/run-1044' })
  assert.equal(runRes.data.diffState, 'stale')
  assert.equal(runRes.data.rulesVersion, oldExpected.expectedRulesVersion + 1)

  // 已批准运行 run-1046 与有效基线列入待复核，原判定保留
  const approvedRun = (await call({ method: 'get', url: '/runs/run-1046' })).data as {
    status: string
    rereview?: { resolved: boolean; rulesVersion: number }
  }
  assert.equal(approvedRun.status, 'approved')
  assert.equal(approvedRun.rereview?.resolved, false)
  assert.equal(approvedRun.rereview?.rulesVersion, 4)

  // 重试：重新打开会话（失效态解除），用新版本提交成功
  const newSession = (
    await call({ method: 'post', url: '/runs/run-1044/review-session' })
  ).data as { rulesVersion: number; writable: boolean; diffState: string; baselineVersion: string }
  assert.equal(newSession.rulesVersion, 4)
  assert.equal(newSession.writable, true)
  assert.equal(newSession.diffState, 'current')
  const retry = await call({
    method: 'patch',
    url: '/runs/run-1044/review',
    data: {
      ...payload('旧标签页重试'),
      expectedBaselineVersion: newSession.baselineVersion ?? sessionRes.data.baselineVersion,
      expectedRulesVersion: newSession.rulesVersion,
    },
  })
  assert.equal(retry.data.status, 'approved')
})

console.log(`\n${passed} 个集成测试全部通过`)
}

main().then(() => process.exit(0), (error) => {
  console.error(error)
  process.exit(1)
})
