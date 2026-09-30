export type ReviewCategory = 'design-change' | 'render-error' | 'environment-noise'
export type RunStatus = 'pending' | 'approved' | 'rejected' | 'merged'
export type Severity = 'high' | 'medium' | 'low'
/** 差异区域对账状态：current 依据当前规则集，stale 规则变更后待评审人确认重算结果 */
export type DiffState = 'current' | 'stale'

export interface Project {
  id: string
  name: string
  code: string
  owner: string
  pageCount: number
}

export interface DifferenceRegion {
  id: string
  x: number
  y: number
  width: number
  height: number
  severity: Severity
  pixels: number
  kind: 'layout' | 'content' | 'color' | 'environment'
  ignored: boolean
  ruleId?: string
  /** 规则版本，命中忽略时留痕 */
  ruleVersion?: number
  /** 区域对应的稳定 DOM 选择器，用于与忽略规则匹配 */
  selector?: string
  /** 实测色差，与规则 maxDelta 比较 */
  delta?: number
}

export interface ReviewRecord {
  category: ReviewCategory
  decision: 'approved' | 'rejected'
  reviewer: string
  reason: string
  reviewedAt: string
  /** 审批时所针对的基线版本 */
  baselineVersion: string
  /** 审批时差异区域所依据的规则集版本 */
  rulesVersion: number
}

/** 规则变更后挂在已批准运行 / 有效基线上的待复核标记，原判定保留不动 */
export interface RereviewFlag {
  reason: 'rules-changed'
  fromRulesVersion: number
  rulesVersion: number
  changedAt: string
  resolved: boolean
  resolvedAt?: string
}

export interface ScreenshotRun {
  id: string
  name: string
  projectId: string
  page: string
  device: string
  theme: 'light' | 'dark'
  build: string
  status: RunStatus
  mismatchRate: number
  capturedAt: string
  baselineVersion: string
  currentVersion: string
  /** 差异区域最近一次重算所依据的规则集版本 */
  rulesVersion: number
  diffState: DiffState
  baselineImage?: string
  currentImage?: string
  regions: DifferenceRegion[]
  review?: ReviewRecord
  mergedRunIds?: string[]
  rereview?: RereviewFlag
}

export interface Baseline {
  id: string
  projectId: string
  page: string
  device: string
  theme: 'light' | 'dark'
  version: string
  approvedBy: string
  reason: string
  approvedAt: string
  runId: string
  active: boolean
  /** 创建该基线时所依据的规则集版本 */
  rulesVersion: number
  rereview?: RereviewFlag
}

export interface IgnoreRule {
  id: string
  name: string
  projectId: string
  selector: string
  pagePattern: string
  devicePattern: string
  maxDelta: number
  enabled: boolean
  createdAt: string
  /** 规则最近一次变更后对应的规则集版本 */
  version: number
}

export interface DashboardData {
  pendingReview: number
  approvedToday: number
  highRisk: number
  activeBaselines: number
  /** 规则变更后差异失效、等待评审人确认重算的待审批运行 */
  staleRuns: number
  /** 已批准但因规则变更列入待复核的运行 */
  pendingRereview: number
  trend: Array<{ date: string; total: number; failed: number }>
}

export interface RunFilters {
  projectId?: string
  page?: string
  device?: string
  theme?: string
  build?: string
  status?: string
  keyword?: string
}

export interface ReviewPayload {
  category: ReviewCategory
  decision: 'approved' | 'rejected'
  reviewer: string
  reason: string
}

/** 提交审批必须携带打开评审时记下的依据版本，作为乐观锁 */
export interface ReviewSubmitPayload extends ReviewPayload {
  expectedBaselineVersion: string
  expectedRulesVersion: number
}

/** 打开评审时返回的对账上下文 */
export interface ReviewSessionContext {
  runId: string
  writable: boolean
  baselineVersion: string
  rulesVersion: number
  diffState: DiffState
  openedAt: string
}

export interface RuleReconcileSummary {
  rulesVersion: number
  /** 差异失效并已按新规则重算的待审批运行 */
  invalidatedRunIds: string[]
  /** 保留原判定、列入待复核的已批准运行 */
  rereviewRunIds: string[]
  /** 列入待复核的有效基线 */
  rereviewBaselineIds: string[]
}

export interface RuleChangeResponse {
  rule: IgnoreRule
  reconcile: RuleReconcileSummary
}

export type ConflictCode =
  | 'RUN_DECIDED'
  | 'RULES_CHANGED'
  | 'BASELINE_CHANGED'

export interface ConflictDetails {
  status?: RunStatus
  reviewer?: string
  expectedRulesVersion?: number
  currentRulesVersion?: number
  expectedBaselineVersion?: string
  currentBaselineVersion?: string
}

export interface ConflictResponse {
  code: ConflictCode
  message: string
  details?: ConflictDetails
}

export interface ResolveRereviewPayload {
  runIds?: string[]
  baselineIds?: string[]
}

export interface ImportRunPayload {
  projectId: string
  page: string
  device: string
  theme: 'light' | 'dark'
  build: string
  baselineVersion: string
  currentVersion: string
  files: Array<{ name: string; size: number; dataUrl: string }>
  baselineImage?: string
}
