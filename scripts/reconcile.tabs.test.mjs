/**
 * 跨标签页并发测试（自包含运行器）：
 * 用 esbuild 把 src/api/http.ts 打包成 CJS，再在两个独立的 vm 上下文中执行，
 * 模拟两个浏览器标签页：请求串行链互不可见，但共享同一份 localStorage。
 */
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { build } from 'esbuild'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// ---- 两个标签页共享的 localStorage ----
const storage = new Map()
const sharedLocalStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => void storage.set(key, value),
  removeItem: (key) => void storage.delete(key),
  clear: () => storage.clear(),
  key: (i) => [...storage.keys()][i] ?? null,
  get length() {
    return storage.size
  },
}

const bundled = (
  await build({
    entryPoints: ['src/api/http.ts'],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    alias: { '@': new URL('../src/', import.meta.url).pathname },
    logLevel: 'silent',
  })
).outputFiles[0].text

const loadTab = (id) => {
  const module = { exports: {} }
  // 交错延迟（0~20ms），模拟两个标签页请求到达顺序的不确定性
  const context = {
    module,
    exports: module.exports,
    require,
    console,
    process,
    setTimeout,
    clearTimeout,
    Promise,
    Date,
    Math,
    JSON,
    Error,
    Map,
    localStorage: sharedLocalStorage,
    window: {
      setTimeout: (handler) => setTimeout(handler, Math.floor(Math.random() * 20)),
    },
  }
  vm.createContext(context)
  vm.runInContext(bundled, context, { filename: `http-tab-${id}.js` })
  return module.exports
}

const tabA = loadTab('A')
const tabB = loadTab('B')

let passed = 0
const test = async (name, fn) => {
  await fn()
  passed += 1
  console.log(`✓ ${name}`)
}

const payload = (reviewer, expected) => ({
  category: 'design-change',
  decision: 'approved',
  reviewer,
  reason: '两个标签页同时评审同一批截图，最早有效审批胜出',
  ...expected,
})

await test('跨标签页并发提交（交错延迟 10 轮），每轮都只有最早的有效审批能创建基线', async () => {
  for (let round = 0; round < 10; round += 1) {
    storage.clear()
    await tabA.getRuns() // 完成首次播种

    const [sessionA, sessionB] = await Promise.all([
      tabA.openReviewSession('run-1048'),
      tabB.openReviewSession('run-1048'),
    ])
    const expectedA = {
      expectedBaselineVersion: sessionA.baselineVersion,
      expectedRulesVersion: sessionA.rulesVersion,
    }
    const expectedB = {
      expectedBaselineVersion: sessionB.baselineVersion,
      expectedRulesVersion: sessionB.rulesVersion,
    }

    const results = await Promise.allSettled([
      tabA.reviewRun('run-1048', payload('标签页甲', expectedA)),
      tabB.reviewRun('run-1048', payload('标签页乙', expectedB)),
    ])

    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    assert.equal(fulfilled.length, 1, `第 ${round + 1} 轮：应恰好一个审批成功`)
    assert.equal(rejected.length, 1, `第 ${round + 1} 轮：应恰好一个审批被拒`)

    const error = rejected[0].reason
    assert.equal(error.response.status, 409, `第 ${round + 1} 轮：被拒方应收到 409`)
    assert.equal(error.response.data.code, 'RUN_DECIDED')

    const baselines = await tabA.getBaselines()
    const active = baselines.filter(
      (b) => b.page === '订单结算页' && b.device === 'Desktop 1440' && b.active,
    )
    assert.equal(active.length, 1, `第 ${round + 1} 轮：同作用域只能有一个有效基线`)
    assert.equal(
      active[0].approvedBy,
      fulfilled[0].value.review.reviewer,
      `第 ${round + 1} 轮：基线必须属于最早有效审批`,
    )
    const run = await tabB.getRun('run-1048')
    assert.equal(run.review.reviewer, active[0].approvedBy)
  }
})

console.log(`\n${passed} 个跨标签页测试全部通过（共 10 轮随机交错）`)
process.exit(0)
