import type {
  Baseline,
  DifferenceRegion,
  IgnoreRule,
  RuleReconcileSummary,
  ScreenshotRun,
} from '@/types'

export interface RunLike {
  projectId: string
  page: string
  device: string
}

/** 极简 glob：仅支持 * 通配，页面/设备模式匹配用 */
export const globMatch = (pattern: string, value: string): boolean => {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`).test(value)
}

export const ruleAppliesToRun = (rule: IgnoreRule, run: RunLike): boolean =>
  rule.enabled &&
  (rule.projectId === 'all' || rule.projectId === run.projectId) &&
  globMatch(rule.pagePattern, run.page) &&
  globMatch(rule.devicePattern, run.device)

/** 区域没有绑定选择器时（历史数据），按坐标派生稳定选择器参与匹配 */
export const regionSelector = (region: DifferenceRegion): string =>
  region.selector ?? `[data-diff-region="${region.x}-${region.y}"]`

/** 无真实像素分析时，由区域属性派生确定性的实测色差 */
export const regionDelta = (region: DifferenceRegion): number =>
  region.delta ??
  ((region.x * 7 + region.y * 11 + region.width * 5 + region.height * 3 + region.pixels) % 24)

export interface RegionMatch {
  ruleId: string
  ruleVersion: number
}

export const matchRegionRule = (
  region: DifferenceRegion,
  rules: IgnoreRule[],
  run: RunLike,
): RegionMatch | undefined => {
  const selector = regionSelector(region)
  const delta = regionDelta(region)
  const hit = rules.find(
    (rule) =>
      ruleAppliesToRun(rule, run) &&
      rule.selector === selector &&
      delta <= rule.maxDelta,
  )
  return hit ? { ruleId: hit.id, ruleVersion: hit.version } : undefined
}

/**
 * 按给定规则集重算差异区域：重新决定忽略标记与命中规则版本，
 * 区域几何位置和差异像素本身不变（截图没有重新采集）。
 */
export const recomputeRegions = (
  regions: DifferenceRegion[],
  rules: IgnoreRule[],
  run: RunLike,
): DifferenceRegion[] =>
  regions.map((region) => {
    const match = matchRegionRule(region, rules, run)
    return {
      ...region,
      ignored: Boolean(match),
      ruleId: match?.ruleId,
      ruleVersion: match?.ruleVersion,
      delta: regionDelta(region),
      selector: regionSelector(region),
    }
  })

export interface ReconcileStore {
  rulesVersion: number
  runs: ScreenshotRun[]
  baselines: Baseline[]
}

/**
 * 应用一次规则变更并做版本对账：
 * - 规则集版本 +1，被变更的规则版本指向新版本；
 * - 待审批运行：作用域内先失效，再按新规则重算差异区域，置 stale；
 * - 已批准运行：判定与基线版本保留原样，仅挂待复核标记；
 * - 有效基线：规则影响到其作用域的，挂待复核标记（历史版本不改动）。
 * 返回受影响的各类 ID，便于界面提示。
 */
export const applyRuleChange = (
  db: ReconcileStore,
  previousRules: IgnoreRule[],
  nextRules: IgnoreRule[],
  changedRuleId: string,
  changedAt: string,
): RuleReconcileSummary => {
  const previousVersion = db.rulesVersion
  const nextVersion = previousVersion + 1
  db.rulesVersion = nextVersion

  const changedBefore = previousRules.find((rule) => rule.id === changedRuleId)
  const changedAfter = nextRules.find((rule) => rule.id === changedRuleId)
  if (changedAfter) changedAfter.version = nextVersion

  const invalidatedRunIds: string[] = []
  const rereviewRunIds: string[] = []
  const rereviewBaselineIds: string[] = []

  const makeFlag = () => ({
    reason: 'rules-changed' as const,
    fromRulesVersion: previousVersion,
    rulesVersion: nextVersion,
    changedAt,
    resolved: false,
  })

  // 变更规则在改前或改后作用域覆盖该目标，即认为可能影响判定
  const inChangedScope = (scope: RunLike): boolean =>
    (changedBefore ? ruleAppliesToRun(changedBefore, scope) : false) ||
    (changedAfter ? ruleAppliesToRun(changedAfter, scope) : false)

  for (const run of db.runs) {
    const runScope: RunLike = {
      projectId: run.projectId,
      page: run.page,
      device: run.device,
    }
    if (!inChangedScope(runScope)) continue

    if (run.status === 'pending') {
      // 先失效，再按新规则重算差异区域；即使结果相同也要评审人按新版本重新确认
      const after = recomputeRegions(run.regions, nextRules, runScope)
      run.regions = after
      run.rulesVersion = nextVersion
      run.diffState = 'stale'
      invalidatedRunIds.push(run.id)
    } else if (run.status === 'approved') {
      // 原判定（审批记录与基线版本）保留原样，只列待复核
      if (!run.rereview || run.rereview.resolved || run.rereview.rulesVersion < nextVersion) {
        run.rereview = makeFlag()
        rereviewRunIds.push(run.id)
      }
    }
  }

  for (const baseline of db.baselines) {
    if (!baseline.active) continue
    const scope: RunLike = {
      projectId: baseline.projectId,
      page: baseline.page,
      device: baseline.device,
    }
    if (!inChangedScope(scope)) continue
    if (!baseline.rereview || baseline.rereview.resolved || baseline.rereview.rulesVersion < nextVersion) {
      baseline.rereview = makeFlag()
      rereviewBaselineIds.push(baseline.id)
    }
  }

  return {
    rulesVersion: nextVersion,
    invalidatedRunIds,
    rereviewRunIds,
    rereviewBaselineIds,
  }
}

/** 提交审批前的乐观锁裁决；冲突时返回冲突码，否则放行 */
export type ReviewGuardResult =
  | { ok: true }
  | { ok: false; code: 'RUN_DECIDED'; status: ScreenshotRun['status']; reviewer?: string }
  | { ok: false; code: 'RULES_CHANGED'; expected: number; current: number }
  | { ok: false; code: 'BASELINE_CHANGED'; expected: string; current: string }

export const guardReview = (
  run: ScreenshotRun,
  activeBaselineVersion: string,
  expectedBaselineVersion: string,
  expectedRulesVersion: number,
): ReviewGuardResult => {
  if (run.status !== 'pending') {
    return {
      ok: false,
      code: 'RUN_DECIDED',
      status: run.status,
      reviewer: run.review?.reviewer,
    }
  }
  if (run.rulesVersion !== expectedRulesVersion) {
    return {
      ok: false,
      code: 'RULES_CHANGED',
      expected: expectedRulesVersion,
      current: run.rulesVersion,
    }
  }
  if (activeBaselineVersion !== expectedBaselineVersion) {
    return {
      ok: false,
      code: 'BASELINE_CHANGED',
      expected: expectedBaselineVersion,
      current: activeBaselineVersion,
    }
  }
  return { ok: true }
}

/** 审批通过后创建基线：同一作用域只允许一个有效基线，旧基线停用留痕 */
export const commitBaseline = (
  baselines: Baseline[],
  run: ScreenshotRun,
  reviewer: string,
  reason: string,
  approvedAt: string,
): Baseline => {
  for (const baseline of baselines) {
    if (
      baseline.active &&
      baseline.projectId === run.projectId &&
      baseline.page === run.page &&
      baseline.device === run.device &&
      baseline.theme === run.theme
    ) {
      baseline.active = false
    }
  }
  const baseline: Baseline = {
    id: `base-${approvedAt.replace(/\D/g, '')}-${run.id}`,
    projectId: run.projectId,
    page: run.page,
    device: run.device,
    theme: run.theme,
    version: run.currentVersion,
    approvedBy: reviewer,
    reason,
    approvedAt,
    runId: run.id,
    active: true,
    rulesVersion: run.rulesVersion,
  }
  baselines.unshift(baseline)
  return baseline
}
