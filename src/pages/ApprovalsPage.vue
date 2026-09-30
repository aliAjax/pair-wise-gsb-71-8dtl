<script setup lang="ts">
import { computed, ref } from 'vue'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { Message } from '@arco-design/web-vue'
import { getRuns, mergeRuns, resolveRereview } from '@/api/http'
import StatusTag from '@/components/StatusTag.vue'
import type { ScreenshotRun } from '@/types'

const queryClient = useQueryClient()
const selectedKeys = ref<string[]>([])

const { data: runs, isLoading } = useQuery({
  queryKey: ['runs', { status: 'pending' }],
  queryFn: () => getRuns({ status: 'pending' }),
})

const { data: approvedRuns, isLoading: approvedLoading } = useQuery({
  queryKey: ['runs', { status: 'approved' }],
  queryFn: () => getRuns({ status: 'approved' }),
})

const pendingRuns = computed(() => runs.value ?? [])
const staleRuns = computed(() => pendingRuns.value.filter((run) => run.diffState === 'stale'))
const freshRuns = computed(() => pendingRuns.value.filter((run) => run.diffState !== 'stale'))
const rereviewRuns = computed(
  () =>
    (approvedRuns.value ?? []).filter((run) => run.rereview && !run.rereview.resolved) ?? [],
)

const mergeMutation = useMutation({
  mutationFn: mergeRuns,
  onSuccess: async () => {
    Message.success('重复运行已合并，并保留每次执行来源')
    selectedKeys.value = []
    await queryClient.invalidateQueries({ queryKey: ['runs'] })
  },
  onError: (error: Error) => Message.error(error.message),
})

const resolveMutation = useMutation({
  mutationFn: (ids: string[]) => resolveRereview({ runIds: ids }),
  onSuccess: async () => {
    Message.success('已确认复核，原审批与基线保留不变')
    await queryClient.invalidateQueries({ queryKey: ['runs'] })
    await queryClient.invalidateQueries({ queryKey: ['baselines'] })
    await queryClient.invalidateQueries({ queryKey: ['dashboard'] })
  },
  onError: (error: Error) => Message.error(error.message),
})

const unignoredCount = (run: ScreenshotRun) =>
  run.regions.filter((region) => !region.ignored).length
</script>

<template>
  <section class="page-intro compact">
    <div>
      <h2>待审批队列</h2>
      <p>审批人不能直接覆盖基线；批准、驳回和忽略都必须留下可审计原因，同批截图只有最早的有效审批能创建基线。</p>
    </div>
    <a-space>
      <a-button :disabled="selectedKeys.length < 2" @click="mergeMutation.mutate(selectedKeys)">
        <icon-merge /> 合并重复运行
      </a-button>
      <a-button type="primary" :disabled="selectedKeys.length === 0" @click="selectedKeys = []">
        清除选择
      </a-button>
    </a-space>
  </section>

  <div class="queue-summary">
    <div>
      <span>当前待审批</span>
      <strong>{{ pendingRuns.length }}</strong>
    </div>
    <div>
      <span>规则变更后失效</span>
      <strong :class="{ danger: staleRuns.length > 0 }">{{ staleRuns.length }}</strong>
    </div>
    <div>
      <span>已批准待复核</span>
      <strong :class="{ danger: rereviewRuns.length > 0 }">{{ rereviewRuns.length }}</strong>
    </div>
    <div>
      <span>高风险运行</span>
      <strong class="danger">{{ pendingRuns.filter((run) => run.mismatchRate >= 5).length }}</strong>
    </div>
  </div>

  <div class="queue-section">
    <h3>
      差异失效 · 待按新规则确认
      <small>规则改动后待审批运行先失效并已重算差异区域，评审人重新核对后方可审批</small>
    </h3>
    <a-card class="table-panel" :bordered="false">
      <a-table :data="staleRuns" :loading="isLoading" :pagination="false" row-key="id">
        <template #columns>
          <a-table-column title="优先队列" :width="260">
            <template #cell="{ record }">
              <div class="primary-cell">
                <router-link :to="`/runs/${record.id}`">{{ record.page }}</router-link>
                <span>{{ record.name }} · {{ record.id }}</span>
              </div>
            </template>
          </a-table-column>
          <a-table-column title="风险" :width="130">
            <template #cell="{ record }">
              <a-tag :color="record.mismatchRate >= 5 ? 'red' : record.mismatchRate >= 2 ? 'orange' : 'gray'">
                {{ record.mismatchRate.toFixed(2) }}%
              </a-tag>
            </template>
          </a-table-column>
          <a-table-column title="差异区域" :width="160">
            <template #cell="{ record }">{{ unignoredCount(record) }} 处待判定 · 规则 v{{ record.rulesVersion }}</template>
          </a-table-column>
          <a-table-column title="提交时间" :width="150">
            <template #cell="{ record }">{{ record.capturedAt.slice(5, 16).replace('T', ' ') }}</template>
          </a-table-column>
          <a-table-column title="状态" :width="120">
            <template #cell="{ record }"><StatusTag :status="record.status" stale /></template>
          </a-table-column>
          <a-table-column title="操作" :width="100" fixed="right">
            <template #cell="{ record }"><router-link :to="`/runs/${record.id}`">重新核对</router-link></template>
          </a-table-column>
        </template>
      </a-table>
    </a-card>
  </div>

  <div class="queue-section">
    <h3>
      待审批运行
      <small>打开评审时会记下基线与规则版本，提交时做乐观锁校验</small>
    </h3>
    <a-card class="table-panel" :bordered="false">
      <a-table
        v-model:selected-keys="selectedKeys"
        :data="freshRuns"
        :loading="isLoading"
        :pagination="false"
        row-key="id"
        :row-selection="{ type: 'checkbox', showCheckedAll: true }"
      >
        <template #columns>
          <a-table-column title="优先队列" :width="260">
            <template #cell="{ record }">
              <div class="primary-cell">
                <router-link :to="`/runs/${record.id}`">{{ record.page }}</router-link>
                <span>{{ record.name }} · {{ record.id }}</span>
              </div>
            </template>
          </a-table-column>
          <a-table-column title="风险" :width="130">
            <template #cell="{ record }">
              <a-tag :color="record.mismatchRate >= 5 ? 'red' : record.mismatchRate >= 2 ? 'orange' : 'gray'">
                {{ record.mismatchRate.toFixed(2) }}%
              </a-tag>
            </template>
          </a-table-column>
          <a-table-column title="差异区域" :width="170">
            <template #cell="{ record }">{{ unignoredCount(record) }} 处待判定 · 规则 v{{ record.rulesVersion }}</template>
          </a-table-column>
          <a-table-column title="构建" data-index="build" :width="180" />
          <a-table-column title="提交时间" :width="150">
            <template #cell="{ record }">{{ record.capturedAt.slice(5, 16).replace('T', ' ') }}</template>
          </a-table-column>
          <a-table-column title="状态" :width="100">
            <template #cell="{ record }"><StatusTag :status="record.status" /></template>
          </a-table-column>
          <a-table-column title="操作" :width="100" fixed="right">
            <template #cell="{ record }"><router-link :to="`/runs/${record.id}`">开始评审</router-link></template>
          </a-table-column>
        </template>
      </a-table>
    </a-card>
  </div>

  <div class="queue-section">
    <h3>
      已批准 · 规则变更后待复核
      <small>原审批结论与基线版本保留原样，仅因规则集变化列入复核</small>
    </h3>
    <a-card class="table-panel" :bordered="false">
      <a-table :data="rereviewRuns" :loading="approvedLoading" :pagination="false" row-key="id">
        <template #columns>
          <a-table-column title="运行" :width="260">
            <template #cell="{ record }">
              <div class="primary-cell">
                <router-link :to="`/runs/${record.id}`">{{ record.page }}</router-link>
                <span>{{ record.name }} · {{ record.id }}</span>
              </div>
            </template>
          </a-table-column>
          <a-table-column title="原基线版本" :width="180">
            <template #cell="{ record }"><code>{{ record.review?.baselineVersion }}</code></template>
          </a-table-column>
          <a-table-column title="原审批" :width="160">
            <template #cell="{ record }">
              <div class="primary-cell">
                <strong>{{ record.review?.reviewer }}</strong>
                <span>规则 v{{ record.review?.rulesVersion }} → v{{ record.rereview?.rulesVersion }}</span>
              </div>
            </template>
          </a-table-column>
          <a-table-column title="状态" :width="120">
            <template #cell="{ record }">
              <StatusTag :status="record.status" rereview />
            </template>
          </a-table-column>
          <a-table-column title="操作" :width="180" fixed="right">
            <template #cell="{ record }">
              <a-space>
                <router-link :to="`/runs/${record.id}`">查看判定</router-link>
                <a-button
                  type="text"
                  size="small"
                  status="success"
                  :loading="resolveMutation.isPending.value"
                  @click="resolveMutation.mutate([record.id])"
                >
                  确认无需改判
                </a-button>
              </a-space>
            </template>
          </a-table-column>
        </template>
      </a-table>
    </a-card>
  </div>
</template>
