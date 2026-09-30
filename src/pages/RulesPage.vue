<script setup lang="ts">
import { reactive, ref } from 'vue'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { Message, Modal } from '@arco-design/web-vue'
import { createRule, deleteRule, getProjects, getRules, toggleRule } from '@/api/http'
import type { IgnoreRule, RuleReconcileSummary } from '@/types'

const queryClient = useQueryClient()
const modalVisible = ref(false)
const form = reactive({
  name: '',
  projectId: 'all',
  selector: '',
  pagePattern: '*',
  devicePattern: '*',
  maxDelta: 10,
  enabled: true,
})

const { data: rules, isLoading } = useQuery({ queryKey: ['rules'], queryFn: getRules })
const { data: projects } = useQuery({ queryKey: ['projects'], queryFn: getProjects })

const refreshRules = async () => {
  await queryClient.invalidateQueries({ queryKey: ['rules'] })
  await queryClient.invalidateQueries({ queryKey: ['runs'] })
  await queryClient.invalidateQueries({ queryKey: ['baselines'] })
  await queryClient.invalidateQueries({ queryKey: ['dashboard'] })
}

const describeReconcile = (reconcile: RuleReconcileSummary) => {
  const parts = [
    `规则集升至 v${reconcile.rulesVersion}`,
    `${reconcile.invalidatedRunIds.length} 条待审批运行差异失效并重算`,
    `${reconcile.rereviewRunIds.length} 条已批准运行列入待复核`,
    `${reconcile.rereviewBaselineIds.length} 个有效基线列入待复核`,
  ]
  return parts.join('，')
}

const createMutation = useMutation({
  mutationFn: createRule,
  onSuccess: async ({ reconcile }) => {
    Message.success({ content: `忽略规则已创建：${describeReconcile(reconcile)}`, duration: 4000 })
    modalVisible.value = false
    Object.assign(form, {
      name: '',
      projectId: 'all',
      selector: '',
      pagePattern: '*',
      devicePattern: '*',
      maxDelta: 10,
      enabled: true,
    })
    await refreshRules()
  },
  onError: (error: Error) => Message.error(error.message),
})

const toggleMutation = useMutation({
  mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => toggleRule(id, enabled),
  onSuccess: async ({ reconcile }) => {
    Message.info({ content: describeReconcile(reconcile), duration: 4000 })
    await refreshRules()
  },
  onError: (error: Error) => Message.error(error.message),
})

const deleteMutation = useMutation({
  mutationFn: deleteRule,
  onSuccess: async ({ reconcile }) => {
    Message.success({ content: `规则已删除：${describeReconcile(reconcile)}`, duration: 4000 })
    await refreshRules()
  },
  onError: (error: Error) => Message.error(error.message),
})

const submitRule = () => {
  if (!form.name.trim() || !form.selector.trim()) {
    Message.warning('规则名称和选择器不能为空')
    return
  }
  createMutation.mutate({ ...form })
}

const confirmDelete = (rule: IgnoreRule) => {
  Modal.warning({
    title: '删除忽略规则',
    content: `删除“${rule.name}”后，作用域内待审批运行将先失效并按新规则集重算差异，已批准运行和有效基线会列入待复核。`,
    hideCancel: false,
    onOk: () => deleteMutation.mutate(rule.id),
  })
}

const projectName = (id: string) =>
  id === 'all' ? '全部项目' : projects.value?.find((project) => project.id === id)?.name ?? id
</script>

<template>
  <section class="page-intro compact">
    <div>
      <h2>差异忽略规则</h2>
      <p>用稳定的 DOM 选择器和限制条件排除时间、水印、随机头像等环境噪声；每次改动都提升规则集版本并触发对账。</p>
    </div>
    <a-button type="primary" @click="modalVisible = true"><icon-plus /> 新建规则</a-button>
  </section>

  <a-alert type="info" style="margin-bottom: 16px">
    规则变更后：作用域内待审批运行的差异判定先失效并按新规则重算，需评审人重新确认；已批准运行和有效基线保留原判定，仅列入待复核。
  </a-alert>

  <a-card class="table-panel" :bordered="false">
    <a-table :data="rules" :loading="isLoading" :pagination="false" row-key="id">
      <template #columns>
        <a-table-column title="规则名称" :width="190">
          <template #cell="{ record }">
            <div class="primary-cell"><strong>{{ record.name }}</strong><span>{{ record.id }} · v{{ record.version }}</span></div>
          </template>
        </a-table-column>
        <a-table-column title="作用范围" :width="150">
          <template #cell="{ record }">{{ projectName(record.projectId) }}</template>
        </a-table-column>
        <a-table-column title="DOM 选择器" :width="230">
          <template #cell="{ record }"><code>{{ record.selector }}</code></template>
        </a-table-column>
        <a-table-column title="页面 / 设备" :width="170">
          <template #cell="{ record }">{{ record.pagePattern }} · {{ record.devicePattern }}</template>
        </a-table-column>
        <a-table-column title="最大色差" :width="100">
          <template #cell="{ record }">Δ {{ record.maxDelta }}</template>
        </a-table-column>
        <a-table-column title="启用" :width="90">
          <template #cell="{ record }">
            <a-switch
              :model-value="record.enabled"
              size="small"
              @change="(value: string | number | boolean) => toggleMutation.mutate({ id: record.id, enabled: Boolean(value) })"
            />
          </template>
        </a-table-column>
        <a-table-column title="操作" :width="90">
          <template #cell="{ record }">
            <a-button type="text" status="danger" size="small" @click="confirmDelete(record)">删除</a-button>
          </template>
        </a-table-column>
      </template>
    </a-table>
  </a-card>

  <a-modal
    v-model:visible="modalVisible"
    title="新建忽略规则"
    :ok-loading="createMutation.isPending.value"
    @ok="submitRule"
  >
    <a-form :model="form" layout="vertical">
      <a-form-item label="规则名称" required>
        <a-input v-model="form.name" placeholder="例如：环境水印" />
      </a-form-item>
      <a-grid :cols="2" :col-gap="16">
        <a-grid-item>
          <a-form-item label="作用项目" required>
            <a-select v-model="form.projectId">
              <a-option value="all">全部项目</a-option>
              <a-option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}</a-option>
            </a-select>
          </a-form-item>
        </a-grid-item>
        <a-grid-item>
          <a-form-item label="最大色差" required>
            <a-input-number v-model="form.maxDelta" :min="0" :max="255" />
          </a-form-item>
        </a-grid-item>
      </a-grid>
      <a-form-item label="DOM 选择器" required>
        <a-input v-model="form.selector" placeholder=".environment-watermark" />
      </a-form-item>
      <a-grid :cols="2" :col-gap="16">
        <a-grid-item>
          <a-form-item label="页面匹配">
            <a-input v-model="form.pagePattern" placeholder="*" />
          </a-form-item>
        </a-grid-item>
        <a-grid-item>
          <a-form-item label="设备匹配">
            <a-input v-model="form.devicePattern" placeholder="*" />
          </a-form-item>
        </a-grid-item>
      </a-grid>
      <a-form-item label="创建后立即启用">
        <a-switch v-model="form.enabled" />
      </a-form-item>
    </a-form>
  </a-modal>
</template>
