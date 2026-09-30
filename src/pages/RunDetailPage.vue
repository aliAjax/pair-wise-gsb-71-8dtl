<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { Message } from '@arco-design/web-vue'
import DiffCanvas from '@/components/DiffCanvas.vue'
import StatusTag from '@/components/StatusTag.vue'
import { getRun, openReviewSession, reconfirmRun, reviewRun } from '@/api/http'
import { useReviewStore } from '@/stores/review'
import type { DifferenceRegion, ReviewCategory, ReviewSnapshot } from '@/types'

interface ReviewForm {
  category: ReviewCategory
  decision: 'approved' | 'rejected'
  reviewer: string
  reason: string
}

const route = useRoute()
const router = useRouter()
const queryClient = useQueryClient()
const reviewStore = useReviewStore()
const runId = computed(() => String(route.params.id))
const localRegions = ref<DifferenceRegion[]>([])
const sessionReady = ref(false)
const sessionError = ref('')
const conflictMessage = ref('')
// 打开评审时锁定的版本快照，冲突后仍保留在本标签页用于重试
const lockedSnapshot = ref<ReviewSnapshot | null>(null)
const pollPending = ref(true)

const form = reactive<ReviewForm>({
  category: 'design-change',
  decision: 'approved',
  reviewer: '林默',
  reason: '',
})

const { data: run, isLoading } = useQuery({
  queryKey: computed(() => ['run', runId.value]),
  queryFn: () => getRun(runId.value),
  // 两个标签页同时评审时，及时感知另一页的规则改动与基线变更
  refetchInterval: computed(() => (pollPending.value ? 3000 : false)),
})

watch(
  () => run.value?.status,
  (status) => {
    pollPending.value = status === 'pending'
  },
)

const sessionMutation = useMutation({
  mutationFn: () => openReviewSession(runId.value),
  onSuccess: async (fresh) => {
    sessionReady.value = true
    sessionError.value = ''
    conflictMessage.value = ''
    lockedSnapshot.value = fresh.reviewSnapshot ?? null
    localRegions.value = fresh.regions.map((region) => ({ ...region }))
    await queryClient.invalidateQueries({ queryKey: ['run', runId.value] })
  },
  onError: (error: Error) => {
    sessionReady.value = false
    sessionError.value = error.message
  },
})

watch(
  run,
  (value) => {
    if (!value) return
    localRegions.value = value.regions.map((region) => ({ ...region }))
    reviewStore.setDifferenceFilter('all')
    // 打开评审即记下基线与规则版本；规则改动后重新打开会先重算差异再刷新快照
    if (value.status === 'pending' && !sessionReady.value && !sessionMutation.isPending.value) {
      sessionMutation.mutate()
    }
    if (value.status !== 'pending') sessionReady.value = true
  },
  { immediate: true },
)

// 轮询发现另一页已改规则 / 已建新基线时，本地保留的快照已过期；差异区域以服务端重算结果为准
watch(
  () => run.value?.invalidated,
  (invalidated) => {
    if (invalidated && run.value?.status === 'pending') {
      localRegions.value = run.value.regions.map((region) => ({ ...region }))
    }
  },
)

const activeSnapshot = computed<ReviewSnapshot | null>(
  () => (run.value?.status === 'pending' ? (run.value?.reviewSnapshot ?? lockedSnapshot.value) : null),
)

const visibleRegions = computed(() =>
  localRegions.value.filter(
    (region) =>
      reviewStore.differenceFilter === 'all' || region.severity === reviewStore.differenceFilter,
  ),
)

const suspiciousPixels = computed(() =>
  localRegions.value
    .filter((region) => !region.ignored)
    .reduce((total, region) => total + region.pixels, 0),
)

const rulesVersionLabel = computed(() =>
  run.value ? `规则 v${run.value.regionsRulesVersion ?? 1}` : '',
)

const reviewMutation = useMutation({
  mutationFn: (payload: ReviewForm) =>
    reviewRun(runId.value, {
      ...payload,
      // 后到提交携带打开时锁定的快照，供服务端做乐观并发校验；冲突后仍保留可重试
      snapshot: lockedSnapshot.value ?? undefined,
    }),
  onSuccess: async (updated) => {
    Message.success(updated.review?.decision === 'approved' ? '审批通过，新基线已留痕' : '已驳回归并保留原基线')
    await queryClient.invalidateQueries({ queryKey: ['run', runId.value] })
    await queryClient.invalidateQueries({ queryKey: ['runs'] })
    await queryClient.invalidateQueries({ queryKey: ['baselines'] })
    await queryClient.invalidateQueries({ queryKey: ['dashboard'] })
    await router.push('/approvals')
  },
  onError: async (error: Error & { response?: { status?: number } }) => {
    conflictMessage.value = error.message
    if (error.response?.status === 409) {
      sessionReady.value = false
      await queryClient.invalidateQueries({ queryKey: ['run', runId.value] })
      await queryClient.invalidateQueries({ queryKey: ['runs'] })
      await queryClient.invalidateQueries({ queryKey: ['baselines'] })
      await queryClient.invalidateQueries({ queryKey: ['dashboard'] })
    }
    Message.error(error.message)
  },
})

const reconfirmMutation = useMutation({
  mutationFn: () => reconfirmRun(runId.value, form.reviewer || '林默'),
  onSuccess: async () => {
    Message.success('已按当前规则复核，运行与基线标记保留原版本并退出待复核')
    await queryClient.invalidateQueries({ queryKey: ['run', runId.value] })
    await queryClient.invalidateQueries({ queryKey: ['runs'] })
    await queryClient.invalidateQueries({ queryKey: ['baselines'] })
    await queryClient.invalidateQueries({ queryKey: ['dashboard'] })
  },
  onError: (error: Error) => Message.error(error.message),
})

const resubmitPending = ref(false)

const refreshSession = () => {
  conflictMessage.value = ''
  sessionMutation.mutate()
}

// 冲突后保留全部表单输入，对齐新版本快照后自动重新提交
const alignAndResubmit = () => {
  conflictMessage.value = ''
  resubmitPending.value = true
  sessionMutation.mutate()
}

watch(sessionMutation.isPending, (pending) => {
  if (!pending && resubmitPending.value) {
    resubmitPending.value = false
    if (lockedSnapshot.value) reviewMutation.mutate({ ...form })
  }
})

const toggleIgnored = (target: DifferenceRegion) => {
  const region = localRegions.value.find((item) => item.id === target.id)
  if (region) region.ignored = !region.ignored
}

const handleDifferenceFilter = (value: string | number | boolean) => {
  const allowed = ['all', 'high', 'medium', 'low']
  if (allowed.includes(String(value))) {
    reviewStore.setDifferenceFilter(String(value) as 'all' | 'high' | 'medium' | 'low')
  }
}

const submitReview = () => {
  if (!form.reason.trim()) {
    Message.warning('请填写审批原因')
    return
  }
  if (!lockedSnapshot.value) {
    Message.warning('评审版本尚未对齐，请先按最新规则与基线刷新后重试')
    refreshSession()
    return
  }
  conflictMessage.value = ''
  // 输入原样保留，冲突后用户可直接再次点击提交（服务端会再次按最新版本对账）
  reviewMutation.mutate({ ...form })
}
</script>

<template>
  <a-spin :loading="isLoading" style="width: 100%">
    <template v-if="run">
      <section class="detail-heading">
        <div>
          <a-space>
            <h2>{{ run.name }}</h2>
            <StatusTag :status="run.status" />
            <a-tag v-if="run.needsReview" color="orangered">待复核</a-tag>
            <a-tag v-if="run.invalidated && run.status === 'pending'" color="red">判定已失效</a-tag>
          </a-space>
          <p>{{ run.page }} · {{ run.device }} · {{ run.theme === 'light' ? '浅色主题' : '深色主题' }}</p>
        </div>
        <a-space>
          <a-button @click="router.push('/runs')"><icon-left /> 返回列表</a-button>
          <a-button
            v-if="run.status === 'pending'"
            type="primary"
            :disabled="!lockedSnapshot"
            :loading="reviewMutation.isPending.value"
            @click="submitReview"
          >
            <icon-check /> 提交审批
          </a-button>
        </a-space>
      </section>

      <a-alert
        v-if="run.status === 'pending' && run.invalidated"
        type="error"
        style="margin-bottom: 12px"
      >
        该运行打开评审后规则或基线发生了变化，原判定已失效，差异区域已重算。请重新核对后再提交。
      </a-alert>
      <a-alert
        v-else-if="run.status === 'pending' && !lockedSnapshot"
        type="warning"
        style="margin-bottom: 12px"
      >
        正在按当前忽略规则与基线对齐评审版本，提交按钮将在版本快照就绪后可用。
        <a-button type="text" size="mini" :loading="sessionMutation.isPending.value" @click="refreshSession">立即刷新</a-button>
      </a-alert>
      <a-alert v-if="conflictMessage" type="error" style="margin-bottom: 12px">
        {{ conflictMessage }}
        已保留你的审批输入，
        <a-button
          type="text"
          size="mini"
          :loading="sessionMutation.isPending.value || reviewMutation.isPending.value"
          @click="alignAndResubmit"
        >
          对齐最新版本并重试
        </a-button>
      </a-alert>
      <a-alert v-if="run.needsReview" type="warning" style="margin-bottom: 12px">
        忽略规则在批准后发生改动，原审批与基线版本保留原样并列入待复核。确认无影响后可直接复核通过。
      </a-alert>

      <div class="run-facts">
        <div><span>差异率</span><strong :class="{ danger: run.mismatchRate >= 5 }">{{ run.mismatchRate.toFixed(2) }}%</strong></div>
        <div><span>待判定像素</span><strong>{{ suspiciousPixels.toLocaleString() }}</strong></div>
        <div><span>运行标识</span><strong>{{ run.id }}</strong></div>
        <div>
          <span>构建链路 / 版本对账</span>
          <strong>{{ run.baselineVersion }} → {{ run.currentVersion }} · {{ rulesVersionLabel }}</strong>
        </div>
      </div>

      <div v-if="activeSnapshot" class="version-strip">
        <span>评审快照：基线 <code>{{ activeSnapshot.baselineVersion }}</code></span>
        <span>规则集 <code>v{{ activeSnapshot.rulesVersion }}</code></span>
        <span>打开于 {{ activeSnapshot.openedAt.slice(5, 16).replace('T', ' ') }}</span>
        <span v-if="run.invalidated" style="color: #f53f3f; margin-left: auto">快照已过期，可保留输入直接重试，或对齐最新版本</span>
      </div>

      <div class="review-workspace">
        <div class="comparison-area">
          <div class="compare-toolbar">
            <a-space>
              <span class="toolbar-label">差异筛选</span>
              <a-radio-group
                type="button"
                :model-value="reviewStore.differenceFilter"
                size="small"
                @change="handleDifferenceFilter"
              >
                <a-radio value="all">全部</a-radio>
                <a-radio value="high">高</a-radio>
                <a-radio value="medium">中</a-radio>
                <a-radio value="low">低</a-radio>
              </a-radio-group>
            </a-space>
            <a-space>
              <a-button-group size="small">
                <a-button @click="reviewStore.setZoom(reviewStore.zoom - 10)"><icon-zoom-out /></a-button>
                <a-button>{{ reviewStore.zoom }}%</a-button>
                <a-button @click="reviewStore.setZoom(reviewStore.zoom + 10)"><icon-zoom-in /></a-button>
              </a-button-group>
              <a-button size="small" @click="reviewStore.setZoom(100)"><icon-refresh /> 复位</a-button>
            </a-space>
          </div>
          <div class="canvas-grid">
            <DiffCanvas :run="run" side="baseline" :zoom="reviewStore.zoom" :regions="visibleRegions" />
            <DiffCanvas :run="run" side="current" :zoom="reviewStore.zoom" :regions="visibleRegions" />
          </div>
        </div>

        <aside class="review-panel">
          <div class="panel-title">
            <div>
              <h3>差异区域</h3>
              <span>已按 {{ rulesVersionLabel }} 重算，展示 {{ visibleRegions.length }} 处</span>
            </div>
            <a-tag color="red">{{ localRegions.filter((item) => !item.ignored).length }} 待判定</a-tag>
          </div>
          <div class="region-list">
            <button
              v-for="region in visibleRegions"
              :key="region.id"
              class="region-item"
              :class="{ ignored: region.ignored }"
              :disabled="run.status !== 'pending'"
              @click="toggleIgnored(region)"
            >
              <span class="region-severity" :class="region.severity">{{ region.severity.toUpperCase() }}</span>
              <span class="region-copy">
                <strong>{{ region.kind === 'layout' ? '布局位移' : region.kind === 'color' ? '色彩变化' : region.kind === 'content' ? '内容变更' : '环境噪声' }}</strong>
                <small>区域 {{ region.x }}%, {{ region.y }}% · {{ region.pixels.toLocaleString() }} px<template v-if="region.ruleId"> · {{ region.ruleId }}</template></small>
              </span>
              <span class="ignore-action">{{ region.ignored ? '恢复' : '忽略' }}</span>
            </button>
          </div>

          <a-divider />

          <template v-if="run.needsReview">
            <div class="panel-title">
              <div>
                <h3>规则改动复核</h3>
                <span>原审批与基线保留原样，确认后退出待复核</span>
              </div>
            </div>
            <div style="padding: 16px">
              <a-space direction="vertical" fill>
                <a-alert type="info">
                  该运行批准时依据规则 v{{ run.review?.rulesVersion ?? 1 }}，当前已更新为 {{ rulesVersionLabel }}。
                </a-alert>
                <a-button
                  type="primary"
                  long
                  :loading="reconfirmMutation.isPending.value"
                  @click="reconfirmMutation.mutate()"
                >
                  <icon-check-circle /> 复核通过（保留原基线版本）
                </a-button>
                <router-link to="/baselines">前往基线列表核对版本</router-link>
              </a-space>
            </div>
            <a-divider />
          </template>

          <template v-if="run.status === 'pending'">
            <div class="panel-title">
              <div>
                <h3>评审结论</h3>
                <span>原因、批准人和新版基线会永久留痕</span>
              </div>
            </div>
            <a-form :model="form" layout="vertical" @submit-success="submitReview">
              <a-form-item
                field="category"
                label="变化类型"
                :rules="[{ required: true, message: '请选择变化类型' }]"
              >
                <a-select v-model="form.category">
                  <a-option value="design-change">设计变更</a-option>
                  <a-option value="render-error">渲染异常</a-option>
                  <a-option value="environment-noise">环境噪声</a-option>
                </a-select>
              </a-form-item>
              <a-form-item
                field="decision"
                label="审批结论"
                :rules="[{ required: true, message: '请选择审批结论' }]"
              >
                <a-radio-group v-model="form.decision" type="button">
                  <a-radio value="approved">批准为新基线</a-radio>
                  <a-radio value="rejected">驳回归</a-radio>
                </a-radio-group>
              </a-form-item>
              <a-form-item
                field="reviewer"
                label="批准人"
                :rules="[{ required: true, message: '请填写批准人' }]"
              >
                <a-input v-model="form.reviewer" />
              </a-form-item>
              <a-form-item
                field="reason"
                label="审批原因"
                :rules="[
                  { required: true, message: '请填写审批原因' },
                  { minLength: 8, message: '审批原因至少 8 个字符' },
                ]"
              >
                <a-textarea
                  v-model="form.reason"
                  :auto-size="{ minRows: 4, maxRows: 7 }"
                  placeholder="说明业务需求、设计稿或异常依据；并发冲突后输入会保留，可直接重试"
                />
              </a-form-item>
              <a-alert v-if="form.decision === 'approved'" type="warning" style="margin-bottom: 16px">
                批准后只会新增基线版本，原基线仍可追溯，不会被覆盖；两个标签页同时提交时以最早的有效审批为准。
              </a-alert>
              <a-button
                html-type="submit"
                type="primary"
                long
                :disabled="!lockedSnapshot"
                :loading="reviewMutation.isPending.value"
              >
                确认{{ form.decision === 'approved' ? '批准并创建基线' : '驳回' }}
              </a-button>
            </a-form>
          </template>

          <div v-if="run.review" class="review-record">
            <h4>最近一次审批</h4>
            <dl>
              <dt>结论</dt><dd>{{ run.review.decision === 'approved' ? '已批准' : '已驳回' }}</dd>
              <dt>类型</dt><dd>{{ run.review.category }}</dd>
              <dt>人员</dt><dd>{{ run.review.reviewer }}</dd>
              <dt>规则</dt><dd>v{{ run.review.rulesVersion ?? 1 }}</dd>
              <dt>时间</dt><dd>{{ run.review.reviewedAt.slice(0, 16).replace('T', ' ') }}</dd>
              <dt v-if="run.review.reconfirmedAt">复核</dt>
              <dd v-if="run.review.reconfirmedAt">{{ run.review.reconfirmedBy }} · {{ run.review.reconfirmedAt.slice(5, 16).replace('T', ' ') }}</dd>
            </dl>
            <p>{{ run.review.reason }}</p>
          </div>
        </aside>
      </div>
    </template>
  </a-spin>
</template>
