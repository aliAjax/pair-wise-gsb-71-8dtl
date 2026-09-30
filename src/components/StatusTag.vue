<script setup lang="ts">
import { computed } from 'vue'
import type { RunStatus } from '@/types'

const props = defineProps<{
  status: RunStatus
  stale?: boolean
  rereview?: boolean
}>()

const statusMap: Record<RunStatus, { color: string; label: string }> = {
  pending: { color: 'orange', label: '待审批' },
  approved: { color: 'green', label: '已批准' },
  rejected: { color: 'red', label: '已驳回' },
  merged: { color: 'arcoblue', label: '已合并' },
}

const value = computed(() => statusMap[props.status])
</script>

<template>
  <a-space :size="4" wrap>
    <a-tag :color="value.color" bordered>{{ value.label }}</a-tag>
    <a-tag v-if="stale" color="orangered" bordered>差异失效</a-tag>
    <a-tag v-else-if="rereview" color="gold" bordered>待复核</a-tag>
  </a-space>
</template>
