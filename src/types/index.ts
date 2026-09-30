export type ReviewCategory = 'design-change' | 'render-error' | 'environment-noise'
export type RunStatus = 'pending' | 'approved' | 'rejected' | 'merged'
export type Severity = 'high' | 'medium' | 'low'

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
  /** 区域对应的 DOM 选择器，用于规则改动后重新匹配忽略规则 */
  selector?: string
  /** 区域实测色差，用于与忽略规则的最大色差阈值比较 */
  colorDelta?: number
}

export interface ReviewRecord {
  category: ReviewCategory
  decision: 'approved' | 'rejected'
  reviewer: string
  reason: string
  reviewedAt: string
  /** 审批通过时的规则集版本 */
  rulesVersion?: number
  /** 复核时的规则集版本 */
  reconfirmedAt?: string
  reconfirmedBy?: string
}

/** 打开评审时记下的版本快照，作为提交时的对账依据 */
export interface ReviewSnapshot {
  baselineId: string | null
  baselineVersion: string
  rulesVersion: number
  openedAt: string
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
  baselineImage?: string
  currentImage?: string
  regions: DifferenceRegion[]
  review?: ReviewRecord
  mergedRunIds?: string[]
  /** 差异区域按哪一版规则集计算 */
  regionsRulesVersion: number
  /** 打开评审时锁定的基线与规则版本快照；规则变动后重算差异时会刷新 */
  reviewSnapshot?: ReviewSnapshot
  /** 规则集版本落后于当前版本，差异区域已按新规则重算，原判定已失效 */
  invalidated?: boolean
  /** 已批准运行被规则改动标记为待复核 */
  needsReview?: boolean
  /** 并发提交冲突的原因，保留输入供重试 */
  conflict?: string | null
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
  /** 基线创建时的规则集版本 */
  rulesVersion: number
  /** 基线所依据的运行是否已被规则改动标记为待复核（基线本身保留原样） */
  needsReview?: boolean
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
}

export interface DashboardData {
  pendingReview: number
  approvedToday: number
  highRisk: number
  activeBaselines: number
  /** 规则改动后待复核的已批准运行数量 */
  needsReview: number
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
  /** 打开评审时的版本快照，用于并发对账 */
  snapshot?: ReviewSnapshot
}

export interface VersionMeta {
  rulesVersion: number
  rulesUpdatedAt: string
}

export interface ReconfirmPayload {
  reviewer: string
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
