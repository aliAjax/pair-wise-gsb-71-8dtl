<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { Message } from '@arco-design/web-vue'
import type { AxiosError } from 'axios'
import DiffCanvas from '@/components/DiffCanvas.vue'
import StatusTag from '@/components/StatusTag.vue'
import { getRun, openReviewSession, resolveRereview, reviewRun } from '@/api/http'
import { useReviewStore } from '@/stores/review'
import type {
  ConflictResponse,
  DifferenceRegion,
  ReviewCategory,
  ReviewSessionContext,
  ReviewSubmitPayload,
} from '@/types'

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
/** 打开评审时记下的依据版本，提交时作为乐观锁 */
const session = ref<ReviewSessionContext | null>(null)
const sessionLoading = ref(false)
/** 提交冲突后的提示，表单输入全部保留 */
const conflict = ref<ConflictResponse | null>(null)

const form = reactive<ReviewForm>({
  category: 'design-change',
  decision: 'approved',
  reviewer: '林默',
  reason: '',
})

const { data: run, isLoading } = useQuery({
  queryKey: computed(() => ['run', runId.value]),
  queryFn: () => getRun(runId.value),
})

const beginReviewSession = async () => {
  sessionLoading.value = true
  try {
    session.value = await openReviewSession(runId.value)
    if (run.value?.diffState === 'stale') {
      await queryClient.invalidateQueries({ queryKey: ['run', runId.value] })
      await queryClient.invalidateQueries({ queryKey: ['runs'] })
      await queryClient.invalidateQueries({ queryKey: ['dashboard'] })
    }
  } catch (error) {
    Message.error(error instanceof Error ? error.message : '评审会话建立失败')
  } finally {
    sessionLoading.value = false
  }
}

watch(
  runId,
  () => {
    session.value = null
    conflict.value = null
  },
  { immediate: true },
)

watch(
  run,
  (value) => {
    if (value) localRegions.value = value.regions.map((region) => ({ ...region }))
    reviewStore.setDifferenceFilter('all')
    // 打开评审即向服务端记下当前基线版本与规则版本
    if (value && value.status === 'pending' && !session.value) {
      void beginReviewSession()
    }
  },
  { immediate: true },
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

const resolveRereviewMutation = useMutation({
  mutationFn: () => resolveRereview({ runIds: [runId.value] }),
  onSuccess: async () => {
    Message.success('已确认复核，原审批与基线保持不变')
    await queryClient.invalidateQueries({ queryKey: ['run', runId.value] })
    await queryClient.invalidateQueries({ queryKey: ['runs'] })
    await queryClient.invalidateQueries({ queryKey: ['baselines'] })
    await queryClient.invalidateQueries({ queryKey: ['dashboard'] })
  },
  onError: (error: Error) => Message.error(error.message),
})

const submitReview = (payload: ReviewSubmitPayload) =>
  reviewRun(runId.value, payload)

const reviewMutation = useMutation({
  mutationFn: submitReview,
  onSuccess: async (updated) => {
    Message.success(updated.review?.decision === 'approved' ? '审批通过，新基线已留痕' : '已驳回归并保留原基线')
    session.value = null
    conflict.value = null
    await queryClient.invalidateQueries({ queryKey: ['run', runId.value] })
    await queryClient.invalidateQueries({ queryKey: ['runs'] })
    await queryClient.invalidateQueries({ queryKey: ['baselines'] })
    await queryClient.invalidateQueries({ queryKey: ['dashboard'] })
    await router.push('/approvals')
  },
  onError: (error: AxiosError<ConflictResponse>) => {
    const body = error.response?.data
    if (body && ['RUN_DECIDED', 'RULES_CHANGED', 'BASELINE_CHANGED'].includes(body.code)) {
      conflict.value = body
      Message.warning('提交未生效，输入已保留，可按最新版本重试')
    } else {
      Message.error(error.message)
    }
  },
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

const doSubmit = () => {
  if (!form.reason.trim()) {
    Message.warning('请填写审批原因')
    return
  }
  if (!session.value) {
    Message.warning('评审依据版本尚未就绪，请稍后重试')
    return
  }
  conflict.value = null
  reviewMutation.mutate({
    ...form,
    expectedBaselineVersion: session.value.baselineVersion,
    expectedRulesVersion: session.value.rulesVersion,
  })
}

// 规则版本冲突：重新打开评审取得最新依据，差异区域已是按新规则重算的结果，表单保留
const retryWithLatest = async () => {
  conflict.value = null
  session.value = null
  await queryClient.invalidateQueries({ queryKey: ['run', runId.value] })
  await queryClient.invalidateQueries({ queryKey: ['runs'] })
  await queryClient.invalidateQueries({ queryKey: ['baselines'] })
  await beginReviewSession()
  Message.info('已切换到最新规则与差异区域，请复核后再次提交')
}

const conflictTitle = computed(() => {
  switch (conflict.value?.code) {
    case 'RUN_DECIDED':
      return '该运行已被另一个标签页处理'
    case 'RULES_CHANGED':
      return '忽略规则在评审期间发生变更'
    case 'BASELINE_CHANGED':
      return '有效基线已被更新'
    default:
      return ''
  }
})
</script>

<template>
  <a-spin :loading="isLoading" style="width: 100%">
    <template v-if="run">
      <section class="detail-heading">
        <div>
          <a-space>
            <h2>{{ run.name }}</h2>
            <StatusTag :status="run.status" :stale="run.diffState === 'stale'" :rereview="Boolean(run.rereview && !run.rereview.resolved)" />
          </a-space>
          <p>{{ run.page }} · {{ run.device }} · {{ run.theme === 'light' ? '浅色主题' : '深色主题' }}</p>
        </div>
        <a-space>
          <a-button @click="router.push('/runs')"><icon-left /> 返回列表</a-button>
          <a-button
            v-if="run.status === 'pending'"
            type="primary"
            :loading="reviewMutation.isPending.value || sessionLoading"
            @click="doSubmit"
          >
            <icon-check /> 提交审批
          </a-button>
        </a-space>
      </section>

      <a-alert
        v-if="run.diffState === 'stale' && run.status === 'pending'"
        type="warning"
        style="margin-bottom: 12px"
      >
        忽略规则已变更（当前 v{{ run.rulesVersion }}），差异区域已按新规则重算并失效，请重新核对忽略标记后再审批。
      </a-alert>
      <a-alert
        v-else-if="run.status === 'approved' && run.rereview && !run.rereview.resolved"
        type="warning"
        style="margin-bottom: 12px"
      >
        <template #title>规则变更后待复核：本运行的原审批与基线版本保留原样</template>
        规则集 v{{ run.rereview.fromRulesVersion }} → v{{ run.rereview.rulesVersion }}，原审批（{{ run.review?.reviewer }}）仍有效；确认新规则下无需改判后可解除复核。
        <template #action>
          <a-button size="small" type="primary" :loading="resolveRereviewMutation.isPending.value" @click="resolveRereviewMutation.mutate()">
            确认复核
          </a-button>
        </template>
      </a-alert>
      <a-alert
        v-if="conflict"
        type="error"
        style="margin-bottom: 12px"
      >
        <template #title>{{ conflictTitle }}</template>
        {{ conflict.message }}
        <div v-if="conflict.code === 'RULES_CHANGED'" style="margin-top: 6px">
          <a-button size="small" type="primary" @click="retryWithLatest">按最新规则重试</a-button>
        </div>
        <div v-else-if="conflict.code === 'BASELINE_CHANGED'" style="margin-top: 6px">
          <a-button size="small" type="primary" @click="retryWithLatest">基于最新基线重试</a-button>
        </div>
      </a-alert>

      <div class="run-facts">
        <div><span>差异率</span><strong :class="{ danger: run.mismatchRate >= 5 }">{{ run.mismatchRate.toFixed(2) }}%</strong></div>
        <div><span>待判定像素</span><strong>{{ suspiciousPixels.toLocaleString() }}</strong></div>
        <div><span>运行标识</span><strong>{{ run.id }}</strong></div>
        <div><span>构建链路</span><strong>{{ run.baselineVersion }} → {{ run.currentVersion }}</strong></div>
      </div>
      <div class="run-facts version-facts">
        <div>
          <span>评审依据基线</span>
          <strong>{{ session?.baselineVersion ?? run.baselineVersion }}</strong>
        </div>
        <div>
          <span>差异依据规则集</span>
          <strong :class="{ danger: run.diffState === 'stale' }">v{{ session?.rulesVersion ?? run.rulesVersion }}</strong>
        </div>
        <div>
          <span>差异区域状态</span>
          <strong>{{ run.diffState === 'stale' ? '已失效（按新规则重算）' : '与规则集一致' }}</strong>
        </div>
        <div>
          <span>会话建立时间</span>
          <strong>{{ session ? session.openedAt.slice(5, 16).replace('T', ' ') : '—' }}</strong>
        </div>
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
              <span>已按当前筛选展示 {{ visibleRegions.length }} 处 · 规则集 v{{ run.rulesVersion }}</span>
            </div>
            <a-tag :color="run.diffState === 'stale' ? 'orangered' : 'red'">
              {{ run.diffState === 'stale' ? '已失效待确认' : `${localRegions.filter((item) => !item.ignored).length} 待判定` }}
            </a-tag>
          </div>
          <div class="region-list">
            <button
              v-for="region in visibleRegions"
              :key="region.id"
              class="region-item"
              :class="{ ignored: region.ignored }"
              @click="toggleIgnored(region)"
            >
              <span class="region-severity" :class="region.severity">{{ region.severity.toUpperCase() }}</span>
              <span class="region-copy">
                <strong>{{ region.kind === 'layout' ? '布局位移' : region.kind === 'color' ? '色彩变化' : region.kind === 'content' ? '内容变更' : '环境噪声' }}</strong>
                <small>
                  区域 {{ region.x }}%, {{ region.y }}% · {{ region.pixels.toLocaleString() }} px
                  <template v-if="region.ruleId"> · {{ region.ruleId }}@v{{ region.ruleVersion }}</template>
                </small>
              </span>
              <span class="ignore-action">{{ region.ignored ? '恢复' : '忽略' }}</span>
            </button>
          </div>

          <a-divider />

          <div class="panel-title">
            <div>
              <h3>评审结论</h3>
              <span>原因、批准人、依据版本和新版基线会永久留痕</span>
            </div>
          </div>
          <a-form v-if="run.status === 'pending'" :model="form" layout="vertical" @submit-success="doSubmit">
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
                placeholder="说明业务需求、设计稿或异常依据"
              />
            </a-form-item>
            <a-alert v-if="form.decision === 'approved'" type="warning" style="margin-bottom: 16px">
              批准基于基线 {{ session?.baselineVersion ?? run.baselineVersion }} 与规则集 v{{ session?.rulesVersion ?? run.rulesVersion }}；只会新增基线版本，原基线停用留痕，不会被覆盖。
            </a-alert>
            <a-button html-type="submit" type="primary" long :loading="reviewMutation.isPending.value || sessionLoading">
              确认{{ form.decision === 'approved' ? '批准并创建基线' : '驳回' }}
            </a-button>
          </a-form>
          <a-alert v-else type="info" class="decided-alert">
            该运行已{{ run.status === 'approved' ? '批准' : run.status === 'rejected' ? '驳回' : '合并' }}，评审表单已锁定；如需改判请发起新的回归运行。
          </a-alert>

          <div v-if="run.review" class="review-record">
            <h4>最近一次审批</h4>
            <dl>
              <dt>结论</dt><dd>{{ run.review.decision === 'approved' ? '已批准' : '已驳回' }}</dd>
              <dt>类型</dt><dd>{{ run.review.category }}</dd>
              <dt>人员</dt><dd>{{ run.review.reviewer }}</dd>
              <dt>依据</dt><dd>{{ run.review.baselineVersion }} · 规则 v{{ run.review.rulesVersion }}</dd>
              <dt>时间</dt><dd>{{ run.review.reviewedAt.slice(0, 16).replace('T', ' ') }}</dd>
            </dl>
            <p>{{ run.review.reason }}</p>
          </div>
        </aside>
      </div>
    </template>
  </a-spin>
</template>
