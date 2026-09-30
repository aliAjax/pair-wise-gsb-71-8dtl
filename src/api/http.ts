import axios, { AxiosError, type AxiosAdapter, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios'
import { readDb, writeDb, type Database } from '@/mocks/db'
import type {
  Baseline,
  DashboardData,
  DifferenceRegion,
  IgnoreRule,
  ImportRunPayload,
  Project,
  ReconfirmPayload,
  ReviewPayload,
  RunFilters,
  ScreenshotRun,
  VersionMeta,
} from '@/types'

export const api = axios.create({
  baseURL: '/mock-api',
  timeout: 8000,
  headers: { 'Content-Type': 'application/json' },
})

const STATUS_TEXT: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  409: 'Conflict',
}

const respond = <T>(config: InternalAxiosRequestConfig, data: T, status = 200) => ({
  data,
  status,
  statusText: STATUS_TEXT[status] ?? 'OK',
  headers: {},
  config,
})

interface ConflictBody {
  message: string
  code: 'run-decided' | 'baseline-changed' | 'rules-changed' | 'session-missing'
  run: ScreenshotRun
  meta: VersionMeta
}

const conflict = (
  config: InternalAxiosRequestConfig,
  code: ConflictBody['code'],
  message: string,
  run: ScreenshotRun,
  meta: VersionMeta,
) => respond<ConflictBody>(config, { message, code, run, meta }, 409)

const parseBody = <T>(config: InternalAxiosRequestConfig): T => {
  if (typeof config.data === 'string') return JSON.parse(config.data) as T
  return config.data as T
}

/** * 通配的简单模式匹配，用于规则作用范围（页面 / 设备） */
const globMatch = (pattern: string | undefined, value: string): boolean => {
  if (!pattern || pattern === '*') return true
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`).test(value)
}

const ruleMatchesRun = (rule: IgnoreRule, run: ScreenshotRun): boolean =>
  (rule.projectId === 'all' || rule.projectId === run.projectId) &&
  globMatch(rule.pagePattern, run.page) &&
  globMatch(rule.devicePattern, run.device)

/** 按当前规则集重新计算差异区域的忽略标记 */
const applyRules = (run: ScreenshotRun, rules: IgnoreRule[]): DifferenceRegion[] =>
  run.regions.map((region) => {
    const matched = rules.find(
      (rule) =>
        rule.enabled &&
        ruleMatchesRun(rule, run) &&
        Boolean(region.selector) &&
        rule.selector === region.selector &&
        (region.colorDelta ?? 0) <= rule.maxDelta,
    )
    return matched
      ? { ...region, ignored: true, ruleId: matched.id }
      : { ...region, ignored: false, ruleId: undefined }
  })

const findActiveBaseline = (db: Database, run: ScreenshotRun): Baseline | undefined =>
  db.baselines.find(
    (item) =>
      item.projectId === run.projectId &&
      item.page === run.page &&
      item.device === run.device &&
      item.theme === run.theme &&
      item.active,
  )

type RuleScope = Pick<IgnoreRule, 'projectId' | 'pagePattern' | 'devicePattern'>

const scopeMatches = (scope: RuleScope, target: { projectId: string; page: string; device: string }): boolean =>
  (scope.projectId === 'all' || scope.projectId === target.projectId) &&
  globMatch(scope.pagePattern, target.page) &&
  globMatch(scope.devicePattern, target.device)

/**
 * 规则改动后的版本对账：
 * - 待审批运行：旧判定先失效（清空评审快照），差异区域按新规则重算；
 * - 已批准运行与有效基线：保留原样，标记待复核。
 */
const reconcileAfterRuleChange = (db: Database, scopes: RuleScope[]): void => {
  for (const run of db.runs) {
    if (!scopes.some((scope) => scopeMatches(scope, run))) continue
    if (run.status === 'pending') {
      run.regions = applyRules(run, db.rules)
      run.regionsRulesVersion = db.meta.rulesVersion
      if (run.reviewSnapshot) {
        run.invalidated = true
        run.reviewSnapshot = undefined
      }
    } else if (run.status === 'approved') {
      run.needsReview = true
    }
  }
  for (const baseline of db.baselines) {
    if (!baseline.active || baseline.rulesVersion >= db.meta.rulesVersion) continue
    const linkedRun = db.runs.find((run) => run.id === baseline.runId)
    if (linkedRun?.needsReview || scopes.some((scope) => scopeMatches(scope, baseline))) {
      baseline.needsReview = true
    }
  }
}

const mockAdapter: AxiosAdapter = async (config) => {
  const response = (await mockHandler(config)) as AxiosResponse
  // 自定义适配器需对 4xx/5xx 返回 rejected Promise，axios 才会进入 catch 分支
  if (response.status >= 400) {
    const message =
      (response.data as { message?: string } | undefined)?.message ??
      `请求失败（${response.status}）`
    return Promise.reject(new AxiosError(message, String(response.status), config, null, response))
  }
  return response
}

const mockHandler = async (config: InternalAxiosRequestConfig) => {
  await new Promise((resolve) => window.setTimeout(resolve, 180))
  const db = readDb()
  const method = (config.method ?? 'get').toLowerCase()
  const path = config.url ?? ''

  if (method === 'get' && path === '/projects') {
    return respond<Project[]>(config, db.projects)
  }

  if (method === 'get' && path === '/dashboard') {
    const dashboard: DashboardData = {
      pendingReview: db.runs.filter((run) => run.status === 'pending').length,
      approvedToday: db.runs.filter(
        (run) => run.review?.decision === 'approved' && run.review.reviewedAt.startsWith('2026-09-29'),
      ).length,
      highRisk: db.runs.filter((run) => run.mismatchRate >= 5 && run.status !== 'merged').length,
      activeBaselines: db.baselines.filter((baseline) => baseline.active).length,
      needsReview: db.runs.filter((run) => run.needsReview).length,
      trend: [
        { date: '09-23', total: 36, failed: 7 },
        { date: '09-24', total: 42, failed: 4 },
        { date: '09-25', total: 39, failed: 9 },
        { date: '09-26', total: 47, failed: 6 },
        { date: '09-27', total: 44, failed: 5 },
        { date: '09-28', total: 52, failed: 11 },
        { date: '09-29', total: 29, failed: 8 },
      ],
    }
    return respond(config, dashboard)
  }

  if (method === 'get' && path === '/meta') {
    return respond<VersionMeta>(config, db.meta)
  }

  if (method === 'get' && path === '/runs') {
    const filters = (config.params ?? {}) as RunFilters
    const keyword = filters.keyword?.trim().toLowerCase()
    const data = db.runs.filter((run) => {
      return (
        (!filters.projectId || run.projectId === filters.projectId) &&
        (!filters.page || run.page === filters.page) &&
        (!filters.device || run.device === filters.device) &&
        (!filters.theme || run.theme === filters.theme) &&
        (!filters.build || run.build === filters.build) &&
        (!filters.status || run.status === filters.status) &&
        (!keyword ||
          run.name.toLowerCase().includes(keyword) ||
          run.page.toLowerCase().includes(keyword) ||
          run.id.toLowerCase().includes(keyword))
      )
    })
    return respond(config, data)
  }

  const runMatch = path.match(/^\/runs\/([^/]+)$/)
  if (method === 'get' && runMatch) {
    const run = db.runs.find((item) => item.id === runMatch[1])
    if (!run) throw new Error('运行记录不存在')
    return respond(config, run)
  }

  const sessionMatch = path.match(/^\/runs\/([^/]+)\/review-session$/)
  if (method === 'post' && sessionMatch) {
    const run = db.runs.find((item) => item.id === sessionMatch[1])
    if (!run) throw new Error('运行记录不存在')
    // 规则改动后打开评审：先按新规则失效旧判定并重算差异区域，再记下新的版本快照
    if (run.status === 'pending') {
      if (run.regionsRulesVersion !== db.meta.rulesVersion) {
        run.regions = applyRules(run, db.rules)
        run.regionsRulesVersion = db.meta.rulesVersion
      }
      const baseline = findActiveBaseline(db, run)
      run.reviewSnapshot = {
        baselineId: baseline?.id ?? null,
        baselineVersion: baseline?.version ?? run.baselineVersion,
        rulesVersion: db.meta.rulesVersion,
        openedAt: new Date().toISOString(),
      }
      run.invalidated = false
      run.conflict = null
      writeDb(db)
    }
    return respond(config, run)
  }

  const reviewMatch = path.match(/^\/runs\/([^/]+)\/review$/)
  if (method === 'patch' && reviewMatch) {
    const payload = parseBody<ReviewPayload>(config)
    const run = db.runs.find((item) => item.id === reviewMatch[1])
    if (!run) throw new Error('运行记录不存在')

    // 并发对账：只有仍处于待审批、且基于打开时同一版本快照的审批才有效
    if (run.status !== 'pending') {
      run.conflict = '该运行已由其他评审人完成判定，审批结果以最早提交为准。'
      writeDb(db)
      return conflict(config, 'run-decided', run.conflict, run, db.meta)
    }
    const snapshot = payload.snapshot
    if (!snapshot) {
      return conflict(
        config,
        'session-missing',
        '请先打开评审页加载当前基线与忽略规则版本，再提交审批。',
        run,
        db.meta,
      )
    }
    if (snapshot.rulesVersion !== db.meta.rulesVersion) {
      run.conflict = '提交期间忽略规则已更新，差异区域已按新规则重算，请确认后重新提交。'
      run.invalidated = true
      run.reviewSnapshot = undefined
      writeDb(db)
      return conflict(config, 'rules-changed', run.conflict, run, db.meta)
    }
    if (run.regionsRulesVersion !== db.meta.rulesVersion) {
      run.regions = applyRules(run, db.rules)
      run.regionsRulesVersion = db.meta.rulesVersion
    }
    const activeBaseline = findActiveBaseline(db, run)
    const currentBaselineId = activeBaseline?.id ?? null
    if (payload.decision === 'approved' && currentBaselineId !== snapshot.baselineId) {
      run.conflict = '提交期间基线已被另一评审页创建的新版本顶替，请基于最新基线重新核对。'
      run.invalidated = true
      run.reviewSnapshot = undefined
      writeDb(db)
      return conflict(config, 'baseline-changed', run.conflict, run, db.meta)
    }

    run.status = payload.decision
    run.review = {
      ...payload,
      reviewedAt: new Date().toISOString(),
      rulesVersion: db.meta.rulesVersion,
    }
    run.invalidated = false
    run.needsReview = false
    run.conflict = null
    run.reviewSnapshot = undefined
    if (payload.decision === 'approved') {
      // 最早到达的有效审批创建新基线，同时让同页面仍在审批的运行失效重评
      if (activeBaseline) activeBaseline.active = false
      db.baselines.unshift({
        id: `base-${Date.now()}`,
        projectId: run.projectId,
        page: run.page,
        device: run.device,
        theme: run.theme,
        version: run.currentVersion,
        approvedBy: payload.reviewer,
        reason: payload.reason,
        approvedAt: new Date().toISOString(),
        runId: run.id,
        active: true,
        rulesVersion: db.meta.rulesVersion,
      })
      for (const other of db.runs) {
        if (
          other.id === run.id ||
          other.status !== 'pending' ||
          other.projectId !== run.projectId ||
          other.page !== run.page ||
          other.device !== run.device ||
          other.theme !== run.theme
        ) {
          continue
        }
        other.invalidated = true
        other.conflict = '基线已更新为新版本，请基于新基线重新核对差异。'
        other.reviewSnapshot = undefined
      }
    }
    writeDb(db)
    return respond(config, run)
  }

  const reconfirmMatch = path.match(/^\/runs\/([^/]+)\/reconfirm$/)
  if (method === 'post' && reconfirmMatch) {
    const payload = parseBody<ReconfirmPayload | undefined>(config)
    const run = db.runs.find((item) => item.id === reconfirmMatch[1])
    if (!run) throw new Error('运行记录不存在')
    if (!run.needsReview) return respond(config, run)
    run.needsReview = false
    if (run.review) {
      run.review.reconfirmedAt = new Date().toISOString()
      run.review.reconfirmedBy = payload?.reviewer || run.review.reviewer
    }
    // 运行复核后，其对应基线的待复核标记一并清除；基线版本本身保持原样
    for (const baseline of db.baselines) {
      if (baseline.runId === run.id) baseline.needsReview = false
    }
    writeDb(db)
    return respond(config, run)
  }

  if (method === 'post' && path === '/runs/merge') {
    const ids = parseBody<string[]>(config)
    const selected = db.runs.filter((run) => ids.includes(run.id))
    if (selected.length < 2) throw new Error('至少选择两条运行记录进行合并')
    const [first, ...rest] = selected
    first.mergedRunIds = selected.map((run) => run.id)
    first.status = 'merged'
    first.mismatchRate =
      selected.reduce((sum, run) => sum + run.mismatchRate, 0) / Math.max(selected.length, 1)
    first.regions = rest.flatMap((run) => run.regions).slice(0, 8)
    first.regionsRulesVersion = db.meta.rulesVersion
    first.reviewSnapshot = undefined
    first.invalidated = false
    writeDb(db)
    return respond(config, first, 201)
  }

  if (method === 'post' && path === '/runs/import') {
    const payload = parseBody<ImportRunPayload>(config)
    if (
      !payload.projectId ||
      !payload.page.trim() ||
      !payload.device.trim() ||
      !payload.build.trim() ||
      payload.files.length === 0
    ) {
      throw new Error('项目、页面、设备、构建版本和截图文件不能为空')
    }
    const imported = payload.files.map((file, index) => {
      const runId = `run-${Date.now()}-${index + 1}`
      const mismatchRate = Number((0.8 + ((file.name.length + index * 3) % 58) / 10).toFixed(2))
      const severity = mismatchRate >= 5 ? 'high' : mismatchRate >= 2 ? 'medium' : 'low'
      const run: ScreenshotRun = {
        id: runId,
        name: `${payload.page} ${payload.device}回归`,
        projectId: payload.projectId,
        page: payload.page.trim(),
        device: payload.device.trim(),
        theme: payload.theme,
        build: payload.build.trim(),
        status: 'pending',
        mismatchRate,
        capturedAt: new Date().toISOString(),
        baselineVersion: payload.baselineVersion.trim() || '当前有效基线',
        currentVersion: payload.currentVersion.trim() || payload.build.trim(),
        baselineImage: payload.baselineImage,
        currentImage: file.dataUrl,
        regionsRulesVersion: db.meta.rulesVersion,
        regions: [
          {
            id: `${runId}-r1`,
            x: 12 + index * 3,
            y: 22 + index * 2,
            width: 24,
            height: 14,
            severity,
            pixels: Math.round(file.size / 8 || 620),
            kind: 'layout',
            ignored: false,
            selector: '.checkout-summary-bar',
            colorDelta: 46,
          },
          {
            id: `${runId}-r2`,
            x: 58,
            y: 52,
            width: 16,
            height: 10,
            severity: severity === 'high' ? 'medium' : 'low',
            pixels: Math.round(file.size / 18 || 180),
            kind: 'color',
            ignored: false,
            selector: '.price-tag',
            colorDelta: 18,
          },
        ],
      }
      return run
    })
    db.runs.unshift(...imported)
    writeDb(db)
    return respond(config, imported, 201)
  }

  if (method === 'get' && path === '/baselines') {
    const projectId = config.params?.projectId as string | undefined
    return respond(
      config,
      db.baselines.filter((baseline) => !projectId || baseline.projectId === projectId),
    )
  }

  if (method === 'get' && path === '/rules') {
    return respond<IgnoreRule[]>(config, db.rules)
  }

  if (method === 'post' && path === '/rules') {
    const input = parseBody<Omit<IgnoreRule, 'id' | 'createdAt'>>(config)
    const rule: IgnoreRule = {
      ...input,
      id: `rule-${Date.now()}`,
      createdAt: new Date().toISOString(),
    }
    db.rules.unshift(rule)
    db.meta.rulesVersion += 1
    db.meta.rulesUpdatedAt = new Date().toISOString()
    reconcileAfterRuleChange(db, [rule])
    writeDb(db)
    return respond(config, rule, 201)
  }

  const ruleMatch = path.match(/^\/rules\/([^/]+)$/)
  if (method === 'patch' && ruleMatch) {
    const payload = parseBody<Partial<IgnoreRule>>(config)
    const rule = db.rules.find((item) => item.id === ruleMatch[1])
    if (!rule) throw new Error('规则不存在')
    const previousScope: RuleScope = {
      projectId: rule.projectId,
      pagePattern: rule.pagePattern,
      devicePattern: rule.devicePattern,
    }
    Object.assign(rule, payload)
    db.meta.rulesVersion += 1
    db.meta.rulesUpdatedAt = new Date().toISOString()
    // 作用范围缩小或扩大都可能影响判定，按改动前后两个范围对账
    reconcileAfterRuleChange(db, [previousScope, rule])
    writeDb(db)
    return respond(config, rule)
  }
  if (method === 'delete' && ruleMatch) {
    const index = db.rules.findIndex((item) => item.id === ruleMatch[1])
    if (index < 0) throw new Error('规则不存在')
    const [removed] = db.rules.splice(index, 1)
    db.meta.rulesVersion += 1
    db.meta.rulesUpdatedAt = new Date().toISOString()
    reconcileAfterRuleChange(db, [removed])
    writeDb(db)
    return respond(config, { success: true })
  }

  const baselineReconfirmMatch = path.match(/^\/baselines\/([^/]+)\/reconfirm$/)
  if (method === 'post' && baselineReconfirmMatch) {
    const baseline = db.baselines.find((item) => item.id === baselineReconfirmMatch[1])
    if (!baseline) throw new Error('基线不存在')
    baseline.needsReview = false
    const linkedRun = db.runs.find((run) => run.id === baseline.runId)
    if (linkedRun) {
      linkedRun.needsReview = false
      if (linkedRun.review) linkedRun.review.reconfirmedAt = new Date().toISOString()
    }
    writeDb(db)
    return respond(config, baseline)
  }

  throw new Error(`Mock API 未实现：${method.toUpperCase()} ${path}`)
}

api.defaults.adapter = mockAdapter

export const getProjects = async (): Promise<Project[]> => (await api.get<Project[]>('/projects')).data
export const getDashboard = async (): Promise<DashboardData> =>
  (await api.get<DashboardData>('/dashboard')).data
export const getRuns = async (filters: RunFilters = {}): Promise<ScreenshotRun[]> =>
  (await api.get<ScreenshotRun[]>('/runs', { params: filters })).data
export const getRun = async (id: string): Promise<ScreenshotRun> =>
  (await api.get<ScreenshotRun>(`/runs/${id}`)).data
export const reviewRun = async (id: string, payload: ReviewPayload): Promise<ScreenshotRun> =>
  (await api.patch<ScreenshotRun>(`/runs/${id}/review`, payload)).data
export const openReviewSession = async (id: string): Promise<ScreenshotRun> =>
  (await api.post<ScreenshotRun>(`/runs/${id}/review-session`)).data
export const reconfirmRun = async (id: string, reviewer: string): Promise<ScreenshotRun> =>
  (await api.post<ScreenshotRun>(`/runs/${id}/reconfirm`, { reviewer })).data
export const reconfirmBaseline = async (id: string): Promise<Baseline> =>
  (await api.post<Baseline>(`/baselines/${id}/reconfirm`)).data
export const getVersionMeta = async (): Promise<VersionMeta> =>
  (await api.get<VersionMeta>('/meta')).data
export const mergeRuns = async (ids: string[]): Promise<ScreenshotRun> =>
  (await api.post<ScreenshotRun>('/runs/merge', ids)).data
export const importRuns = async (payload: ImportRunPayload): Promise<ScreenshotRun[]> =>
  (await api.post<ScreenshotRun[]>('/runs/import', payload)).data
export const getBaselines = async (projectId?: string): Promise<Baseline[]> =>
  (await api.get<Baseline[]>('/baselines', { params: { projectId } })).data
export const getRules = async (): Promise<IgnoreRule[]> =>
  (await api.get<IgnoreRule[]>('/rules')).data
export const createRule = async (
  payload: Omit<IgnoreRule, 'id' | 'createdAt'>,
): Promise<IgnoreRule> => (await api.post<IgnoreRule>('/rules', payload)).data
export const toggleRule = async (id: string, enabled: boolean): Promise<IgnoreRule> =>
  (await api.patch<IgnoreRule>(`/rules/${id}`, { enabled })).data
export const deleteRule = async (id: string): Promise<{ success: boolean }> =>
  (await api.delete<{ success: boolean }>(`/rules/${id}`)).data
