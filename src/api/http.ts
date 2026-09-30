import axios, { AxiosError, type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios'
import { readDb, writeDb } from '@/mocks/db'
import {
  applyRuleChange,
  commitBaseline,
  guardReview,
  recomputeRegions,
} from '@/utils/reconcile'
import type {
  Baseline,
  ConflictResponse,
  DashboardData,
  IgnoreRule,
  ImportRunPayload,
  Project,
  ResolveRereviewPayload,
  ReviewSessionContext,
  ReviewSubmitPayload,
  RuleChangeResponse,
  RunFilters,
  ScreenshotRun,
} from '@/types'

export const api = axios.create({
  baseURL: '/mock-api',
  timeout: 8000,
  headers: { 'Content-Type': 'application/json' },
})

const respond = <T>(config: InternalAxiosRequestConfig, data: T, status = 200) => ({
  data,
  status,
  statusText: status === 200 ? 'OK' : 'Created',
  headers: {},
  config,
})

const parseBody = <T>(config: InternalAxiosRequestConfig): T => {
  if (typeof config.data === 'string') return JSON.parse(config.data) as T
  return config.data as T
}

const httpError = (
  config: InternalAxiosRequestConfig,
  status: number,
  body: ConflictResponse | { message: string },
) =>
  new AxiosError(body.message, String(status), config, null, {
    data: body,
    status,
    statusText: status === 409 ? 'Conflict' : status === 404 ? 'Not Found' : 'Bad Request',
    headers: {},
    config,
  })

/**
 * Mock 侧的服务端串行化：同一标签页内并发请求按入队顺序逐个裁决，
 * 配合每次处理前重新 readDb()，跨标签页也能读到彼此已落库的判定。
 */
let chain: Promise<unknown> = Promise.resolve()
const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
  const result = chain.then(task, task)
  chain = result.catch(() => undefined)
  return result
}

const cloneRules = (rules: IgnoreRule[]): IgnoreRule[] => rules.map((rule) => ({ ...rule }))

const mockAdapter: AxiosAdapter = (config) =>
  enqueue(async () => {
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
        staleRuns: db.runs.filter((run) => run.status === 'pending' && run.diffState === 'stale')
          .length,
        pendingRereview:
          db.runs.filter((run) => run.rereview && !run.rereview.resolved).length +
          db.baselines.filter((baseline) => baseline.rereview && !baseline.rereview.resolved)
            .length,
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

    // 打开评审：记下当前基线版本与规则版本，作为之后提交审批的乐观锁依据
    const sessionMatch = path.match(/^\/runs\/([^/]+)\/review-session$/)
    if (method === 'post' && sessionMatch) {
      const tx = readDb()
      const run = tx.runs.find((item) => item.id === sessionMatch[1])
      if (!run) throw new Error('运行记录不存在')
      const writable = run.status === 'pending'
      if (writable && run.diffState === 'stale') {
        // 评审人看到按新规则重算的差异区域，失效态解除
        run.diffState = 'current'
        writeDb(tx)
      }
      const session: ReviewSessionContext = {
        runId: run.id,
        writable,
        baselineVersion: run.baselineVersion,
        rulesVersion: run.rulesVersion,
        diffState: run.diffState,
        openedAt: new Date().toISOString(),
      }
      return respond(config, session)
    }

    const reviewMatch = path.match(/^\/runs\/([^/]+)\/review$/)
    if (method === 'patch' && reviewMatch) {
      const payload = parseBody<ReviewSubmitPayload>(config)
      // 同步事务：重新读取最新快照（可能包含另一标签页刚落库的判定），
      // 随后 裁决 -> 变更 -> 落库 在同一同步 turn 内完成，杜绝跨标签页覆盖
      const tx = readDb()
      const run = tx.runs.find((item) => item.id === reviewMatch[1])
      if (!run) throw new Error('运行记录不存在')

      const activeBaseline = tx.baselines.find(
        (item) =>
          item.projectId === run.projectId &&
          item.page === run.page &&
          item.device === run.device &&
          item.theme === run.theme &&
          item.active,
      )
      const activeBaselineVersion = activeBaseline?.version ?? run.baselineVersion

      // 乐观锁：运行必须仍可审、规则版本与有效基线必须与打开评审时一致
      const verdict = guardReview(
        run,
        activeBaselineVersion,
        payload.expectedBaselineVersion,
        payload.expectedRulesVersion,
      )
      if (!verdict.ok) {
        if (verdict.code === 'RUN_DECIDED') {
          const body: ConflictResponse = {
            code: 'RUN_DECIDED',
            message:
              verdict.status === 'approved'
                ? `该运行已被 ${verdict.reviewer ?? '其他评审人'} 批准并创建基线，不能重复审批`
                : `该运行已被 ${verdict.reviewer ?? '其他评审人'} ${
                    verdict.status === 'rejected' ? '驳回' : '处理'
                  }，提交未生效`,
            details: { status: verdict.status, reviewer: verdict.reviewer },
          }
          throw httpError(config, 409, body)
        }
        if (verdict.code === 'RULES_CHANGED') {
          throw httpError(config, 409, {
            code: 'RULES_CHANGED',
            message: `忽略规则已从 v${verdict.expected} 变更到 v${verdict.current}，差异区域已按新规则重算，请确认后重试`,
            details: {
              expectedRulesVersion: verdict.expected,
              currentRulesVersion: verdict.current,
            },
          } satisfies ConflictResponse)
        }
        throw httpError(config, 409, {
          code: 'BASELINE_CHANGED',
          message: `有效基线已从 ${verdict.expected} 变更为 ${verdict.current}，请基于最新基线重新评审`,
          details: {
            expectedBaselineVersion: verdict.expected,
            currentBaselineVersion: verdict.current,
          },
        } satisfies ConflictResponse)
      }

      const reviewedAt = new Date().toISOString()
      run.status = payload.decision
      run.diffState = 'current'
      run.review = {
        category: payload.category,
        decision: payload.decision,
        reviewer: payload.reviewer,
        reason: payload.reason,
        reviewedAt,
        baselineVersion: activeBaselineVersion,
        rulesVersion: run.rulesVersion,
      }
      if (payload.decision === 'approved') {
        // 最早通过乐观锁的审批才能创建基线；同作用域旧有效基线停用但保留留痕
        commitBaseline(tx.baselines, run, payload.reviewer, payload.reason, reviewedAt)
      }
      writeDb(tx)
      return respond(config, run)
    }

    if (method === 'post' && path === '/runs/merge') {
      const tx = readDb()
      const ids = parseBody<string[]>(config)
      const selected = tx.runs.filter((run) => ids.includes(run.id))
      if (selected.length < 2) throw new Error('至少选择两条运行记录进行合并')
      const [first, ...rest] = selected
      first.mergedRunIds = selected.map((run) => run.id)
      first.status = 'merged'
      first.mismatchRate =
        selected.reduce((sum, run) => sum + run.mismatchRate, 0) / Math.max(selected.length, 1)
      first.regions = rest.flatMap((run) => run.regions).slice(0, 8)
      writeDb(tx)
      return respond(config, first, 201)
    }

    if (method === 'post' && path === '/runs/import') {
      const tx = readDb()
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
          rulesVersion: tx.rulesVersion,
          diffState: 'current',
          baselineImage: payload.baselineImage,
          currentImage: file.dataUrl,
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
              selector: `.imported-region-${index + 1}`,
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
              selector: `.imported-region-${index + 1}-meta`,
            },
          ],
        }
        // 导入即按当前规则集判定一次忽略区域
        run.regions = recomputeRegions(run.regions, tx.rules, run)
        return run
      })
      tx.runs.unshift(...imported)
      writeDb(tx)
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
      const tx = readDb()
      const input = parseBody<Omit<IgnoreRule, 'id' | 'createdAt' | 'version'>>(config)
      const previousRules = cloneRules(tx.rules)
      const rule: IgnoreRule = {
        ...input,
        id: `rule-${Date.now()}`,
        createdAt: new Date().toISOString(),
        version: tx.rulesVersion,
      }
      tx.rules.unshift(rule)
      const reconcile = applyRuleChange(
        tx,
        previousRules,
        tx.rules,
        rule.id,
        new Date().toISOString(),
      )
      writeDb(tx)
      return respond<RuleChangeResponse>(config, { rule, reconcile }, 201)
    }

    const ruleMatch = path.match(/^\/rules\/([^/]+)$/)
    if (method === 'patch' && ruleMatch) {
      const tx = readDb()
      const payload = parseBody<Partial<IgnoreRule>>(config)
      const rule = tx.rules.find((item) => item.id === ruleMatch[1])
      if (!rule) throw new Error('规则不存在')
      const previousRules = cloneRules(tx.rules)
      Object.assign(rule, payload)
      const reconcile = applyRuleChange(
        tx,
        previousRules,
        tx.rules,
        rule.id,
        new Date().toISOString(),
      )
      writeDb(tx)
      return respond<RuleChangeResponse>(config, { rule, reconcile })
    }
    if (method === 'delete' && ruleMatch) {
      const tx = readDb()
      const index = tx.rules.findIndex((item) => item.id === ruleMatch[1])
      if (index < 0) throw new Error('规则不存在')
      const previousRules = cloneRules(tx.rules)
      const removedId = tx.rules[index].id
      tx.rules.splice(index, 1)
      const reconcile = applyRuleChange(
        tx,
        previousRules,
        tx.rules,
        removedId,
        new Date().toISOString(),
      )
      writeDb(tx)
      return respond(config, { success: true, reconcile })
    }

    // 人工确认复核：原判定与基线保持不变，仅解除待复核标记
    if (method === 'post' && path === '/reconcile/resolve') {
      const tx = readDb()
      const payload = parseBody<ResolveRereviewPayload>(config)
      const resolvedAt = new Date().toISOString()
      for (const run of tx.runs) {
        if (payload.runIds?.includes(run.id) && run.rereview && !run.rereview.resolved) {
          run.rereview.resolved = true
          run.rereview.resolvedAt = resolvedAt
        }
      }
      for (const baseline of tx.baselines) {
        if (
          payload.baselineIds?.includes(baseline.id) &&
          baseline.rereview &&
          !baseline.rereview.resolved
        ) {
          baseline.rereview.resolved = true
          baseline.rereview.resolvedAt = resolvedAt
        }
      }
      writeDb(tx)
      return respond(config, { resolvedAt })
    }

    throw new Error(`Mock API 未实现：${method.toUpperCase()} ${path}`)
  })

api.defaults.adapter = mockAdapter

export const getProjects = async (): Promise<Project[]> => (await api.get<Project[]>('/projects')).data
export const getDashboard = async (): Promise<DashboardData> =>
  (await api.get<DashboardData>('/dashboard')).data
export const getRuns = async (filters: RunFilters = {}): Promise<ScreenshotRun[]> =>
  (await api.get<ScreenshotRun[]>('/runs', { params: filters })).data
export const getRun = async (id: string): Promise<ScreenshotRun> =>
  (await api.get<ScreenshotRun>(`/runs/${id}`)).data
export const openReviewSession = async (id: string): Promise<ReviewSessionContext> =>
  (await api.post<ReviewSessionContext>(`/runs/${id}/review-session`)).data
export const reviewRun = async (
  id: string,
  payload: ReviewSubmitPayload,
): Promise<ScreenshotRun> => (await api.patch<ScreenshotRun>(`/runs/${id}/review`, payload)).data
export const mergeRuns = async (ids: string[]): Promise<ScreenshotRun> =>
  (await api.post<ScreenshotRun>('/runs/merge', ids)).data
export const importRuns = async (payload: ImportRunPayload): Promise<ScreenshotRun[]> =>
  (await api.post<ScreenshotRun[]>('/runs/import', payload)).data
export const getBaselines = async (projectId?: string): Promise<Baseline[]> =>
  (await api.get<Baseline[]>('/baselines', { params: { projectId } })).data
export const getRules = async (): Promise<IgnoreRule[]> =>
  (await api.get<IgnoreRule[]>('/rules')).data
export const createRule = async (
  payload: Omit<IgnoreRule, 'id' | 'createdAt' | 'version'>,
): Promise<RuleChangeResponse> => (await api.post<RuleChangeResponse>('/rules', payload)).data
export const toggleRule = async (id: string, enabled: boolean): Promise<RuleChangeResponse> =>
  (await api.patch<RuleChangeResponse>(`/rules/${id}`, { enabled })).data
export const deleteRule = async (
  id: string,
): Promise<{ success: boolean; reconcile: RuleChangeResponse['reconcile'] }> =>
  (await api.delete<{ success: boolean; reconcile: RuleChangeResponse['reconcile'] }>(
    `/rules/${id}`,
  )).data
export const resolveRereview = async (
  payload: ResolveRereviewPayload,
): Promise<{ resolvedAt: string }> =>
  (await api.post<{ resolvedAt: string }>('/reconcile/resolve', payload)).data
