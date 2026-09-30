<script setup lang="ts">
import { computed, ref } from 'vue'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { Message } from '@arco-design/web-vue'
import { getBaselines, getProjects, resolveRereview } from '@/api/http'

const queryClient = useQueryClient()
const projectId = ref('')
const { data: projects } = useQuery({ queryKey: ['projects'], queryFn: getProjects })
const { data: baselines, isLoading } = useQuery({
  queryKey: ['baselines', projectId],
  queryFn: () => getBaselines(projectId.value || undefined),
})

const resolveMutation = useMutation({
  mutationFn: (ids: string[]) => resolveRereview({ baselineIds: ids }),
  onSuccess: async () => {
    Message.success('基线复核已确认，版本保持原样')
    await queryClient.invalidateQueries({ queryKey: ['baselines'] })
    await queryClient.invalidateQueries({ queryKey: ['dashboard'] })
  },
  onError: (error: Error) => Message.error(error.message),
})

const pendingRereview = computed(
  () => (baselines.value ?? []).filter((baseline) => baseline.rereview && !baseline.rereview.resolved),
)

const projectName = (id: string) => projects.value?.find((project) => project.id === id)?.name ?? id
</script>

<template>
  <section class="page-intro compact">
    <div>
      <h2>历史基线与批准证据</h2>
      <p>每次批准生成不可覆盖的新版本，记录批准人、原因、关联运行、规则版本和启用状态；规则改动只列复核，不改原版本。</p>
    </div>
    <a-select v-model="projectId" allow-clear placeholder="全部项目" style="width: 220px">
      <a-option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}</a-option>
    </a-select>
  </section>

  <a-alert
    v-if="pendingRereview.length > 0"
    type="warning"
    style="margin-bottom: 16px"
  >
    {{ pendingRereview.length }} 个有效基线因忽略规则变更列入待复核，基线文件与版本号保留原样；确认新规则下仍有效后可解除标记。
  </a-alert>

  <div class="baseline-layout">
    <a-card class="table-panel" :bordered="false">
      <a-table :data="baselines" :loading="isLoading" :pagination="false" row-key="id">
        <template #columns>
          <a-table-column title="项目 / 页面" :width="210">
            <template #cell="{ record }">
              <div class="primary-cell">
                <strong>{{ record.page }}</strong>
                <span>{{ projectName(record.projectId) }}</span>
              </div>
            </template>
          </a-table-column>
          <a-table-column title="基线版本" :width="170">
            <template #cell="{ record }"><code>{{ record.version }}</code></template>
          </a-table-column>
          <a-table-column title="规则版本" :width="90">
            <template #cell="{ record }">v{{ record.rulesVersion }}</template>
          </a-table-column>
          <a-table-column title="设备 / 主题" :width="160">
            <template #cell="{ record }">{{ record.device }} · {{ record.theme === 'light' ? '浅色' : '深色' }}</template>
          </a-table-column>
          <a-table-column title="批准人" data-index="approvedBy" :width="90" />
          <a-table-column title="批准时间" :width="140">
            <template #cell="{ record }">{{ record.approvedAt.slice(0, 16).replace('T', ' ') }}</template>
          </a-table-column>
          <a-table-column title="状态" :width="110">
            <template #cell="{ record }">
              <a-space direction="vertical" :size="2">
                <a-tag :color="record.active ? 'green' : 'gray'">{{ record.active ? '有效' : '已停用' }}</a-tag>
                <a-tag v-if="record.rereview && !record.rereview.resolved" color="gold">待复核</a-tag>
              </a-space>
            </template>
          </a-table-column>
          <a-table-column title="操作" :width="150">
            <template #cell="{ record }">
              <a-space direction="vertical" :size="2">
                <router-link :to="`/runs/${record.runId}`">追溯运行</router-link>
                <a-button
                  v-if="record.rereview && !record.rereview.resolved"
                  type="text"
                  size="mini"
                  status="success"
                  :loading="resolveMutation.isPending.value"
                  @click="resolveMutation.mutate([record.id])"
                >
                  确认复核
                </a-button>
              </a-space>
            </template>
          </a-table-column>
        </template>
      </a-table>
    </a-card>

    <aside class="history-panel">
      <div class="panel-title">
        <div>
          <h3>基线变更时间线</h3>
          <span>仅展示最近批准记录</span>
        </div>
      </div>
      <a-timeline>
        <a-timeline-item
          v-for="baseline in baselines?.slice(0, 5)"
          :key="baseline.id"
          :dot-color="baseline.active ? 'green' : 'gray'"
        >
          <strong>{{ baseline.page }} · {{ baseline.version }}</strong>
          <p>{{ baseline.reason }}</p>
          <small>
            {{ baseline.approvedBy }} · {{ baseline.approvedAt.slice(0, 16).replace('T', ' ') }} · 规则 v{{ baseline.rulesVersion }}
            <template v-if="baseline.rereview && !baseline.rereview.resolved"> · 待复核</template>
          </small>
        </a-timeline-item>
      </a-timeline>
    </aside>
  </div>
</template>
