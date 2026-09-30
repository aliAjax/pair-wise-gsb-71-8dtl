<script setup lang="ts">
import { computed, ref } from 'vue'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { Message } from '@arco-design/web-vue'
import { getRuns, mergeRuns } from '@/api/http'
import StatusTag from '@/components/StatusTag.vue'
import type { ScreenshotRun } from '@/types'

const queryClient = useQueryClient()
const selectedKeys = ref<string[]>([])

const { data: runs, isLoading } = useQuery({
  queryKey: ['runs', 'approvals'],
  queryFn: () => getRuns(),
  refetchInterval: 4000,
})

const pendingRuns = computed(() => (runs.value ?? []).filter((run) => run.status === 'pending'))
const reviewRuns = computed(() => (runs.value ?? []).filter((run) => run.needsReview))

const mergeMutation = useMutation({
  mutationFn: mergeRuns,
  onSuccess: async () => {
    Message.success('重复运行已合并，并保留每次执行来源')
    selectedKeys.value = []
    await queryClient.invalidateQueries({ queryKey: ['runs'] })
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
      <p>审批人不能直接覆盖基线；批准、驳回和忽略都必须留下可审计原因。</p>
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
      <span>高风险运行</span>
      <strong class="danger">{{ pendingRuns.filter((run) => run.mismatchRate >= 5).length }}</strong>
    </div>
    <div>
      <span>规则改动待复核</span>
      <strong :class="{ danger: reviewRuns.length > 0 }">{{ reviewRuns.length }}</strong>
    </div>
    <div>
      <span>判定已失效待重评</span>
      <strong class="danger">{{ pendingRuns.filter((run) => run.invalidated).length }}</strong>
    </div>
  </div>

  <a-alert
    v-if="reviewRuns.length"
    type="warning"
    style="margin-bottom: 16px"
  >
    有 {{ reviewRuns.length }} 条已批准运行受规则改动影响，原审批与基线版本保留原样并列入待复核，请逐条确认。
  </a-alert>

  <a-card v-if="reviewRuns.length" class="table-panel" :bordered="false" style="margin-bottom: 16px">
    <template #title>待复核（已批准运行 / 有效基线）</template>
    <a-table :data="reviewRuns" :pagination="false" row-key="id">
      <template #columns>
        <a-table-column title="运行记录" :width="260">
          <template #cell="{ record }">
            <div class="primary-cell">
              <router-link :to="`/runs/${record.id}`">{{ record.page }}</router-link>
              <span>{{ record.name }} · {{ record.id }}</span>
            </div>
          </template>
        </a-table-column>
        <a-table-column title="批准时规则" :width="130">
          <template #cell="{ record }"><code>v{{ record.review?.rulesVersion ?? 1 }}</code></template>
        </a-table-column>
        <a-table-column title="当前规则" :width="120">
          <template #cell="{ record }"><code>v{{ record.regionsRulesVersion }}</code></template>
        </a-table-column>
        <a-table-column title="批准人" :width="100">
          <template #cell="{ record }">{{ record.review?.reviewer }}</template>
        </a-table-column>
        <a-table-column title="状态" :width="100">
          <template #cell>
            <a-tag color="orangered">待复核</a-tag>
          </template>
        </a-table-column>
        <a-table-column title="操作" :width="120">
          <template #cell="{ record }"><router-link :to="`/runs/${record.id}`">前往复核</router-link></template>
        </a-table-column>
      </template>
    </a-table>
  </a-card>

  <a-card class="table-panel" :bordered="false">
    <template #title>待审批运行</template>
    <a-table
      v-model:selected-keys="selectedKeys"
      :data="pendingRuns"
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
        <a-table-column title="差异区域" :width="150">
          <template #cell="{ record }">{{ unignoredCount(record) }} 处待判定</template>
        </a-table-column>
        <a-table-column title="规则版本" :width="100">
          <template #cell="{ record }"><code>v{{ record.regionsRulesVersion }}</code></template>
        </a-table-column>
        <a-table-column title="构建" data-index="build" :width="180" />
        <a-table-column title="提交时间" :width="150">
          <template #cell="{ record }">{{ record.capturedAt.slice(5, 16).replace('T', ' ') }}</template>
        </a-table-column>
        <a-table-column title="状态" :width="120">
          <template #cell="{ record }">
            <a-space direction="vertical" :size="2">
              <StatusTag :status="record.status" />
              <a-tag v-if="record.invalidated" color="red" size="small">判定已失效</a-tag>
            </a-space>
          </template>
        </a-table-column>
        <a-table-column title="操作" :width="100" fixed="right">
          <template #cell="{ record }"><router-link :to="`/runs/${record.id}`">{{ record.invalidated ? '重新评审' : '开始评审' }}</router-link></template>
        </a-table-column>
      </template>
    </a-table>
  </a-card>
</template>
