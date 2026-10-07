<template>
  <section class="page" data-module="spare">
    <header class="page-head">
      <div>
        <h2>备件台账管理</h2>
        <p class="page-desc">按所属系统与备件状态筛选备件，导出补货清单；同一备件编号只登记一次，领用结果回写设备检修领用台账。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记备品备件</button>
        <button class="btn" type="button" @click="exportRows">导出补货清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label class="filter-item">
        <span>所属系统</span>
        <select v-model="filters['所属系统']">
          <option value="">全部系统</option>
          <option v-for="system in systemOptions" :key="system" :value="system">{{ system }}</option>
        </select>
      </label>
      <label class="filter-item">
        <span>备件状态</span>
        <select v-model="filters['备件状态']">
          <option value="">全部状态</option>
          <option v-for="status in statuses" :key="status" :value="status">{{ status }}</option>
        </select>
      </label>
      <label class="filter-item">
        <span>备件编号 / 名称</span>
        <input v-model="keyword" placeholder="按备件编号或名称检索" />
      </label>
      <button class="btn primary" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)" :class="{ 'row-low': isBelowMinStock(row) }">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>
            {{ row.status }}
            <span v-if="isBelowMinStock(row)" class="tag tag-warn">补货</span>
          </td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">当前筛选条件下没有备件，可调整条件或登记新备件</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条备件记录（筛选结果），其中低于最低储备量 {{ lowCount }} 项</span>
      <span v-if="message" :class="messageOk ? 'success-text' : 'error-text'">{{ message }}</span>
    </footer>

    <!-- 登记弹窗：同一备件编号不允许重复登记 -->
    <div v-if="creating" class="modal-mask" @click.self="creating = false">
      <div class="modal">
        <h3 class="modal-title">登记备品备件</h3>
        <div class="form-grid">
          <label v-for="field in editableFields" :key="field" class="form-item">
            <span>{{ field }}</span>
            <input
              v-model="draft[field]"
              :type="field === '最低储备量' || field === '在库量' ? 'number' : 'text'"
              min="0"
              :placeholder="`请输入${field}`"
            />
          </label>
        </div>
        <p v-if="formError" class="error-text modal-error">{{ formError }}</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="creating = false">取消</button>
          <button class="btn primary" type="button" @click="submitCreate">确认登记</button>
        </div>
      </div>
    </div>

    <!-- 领用弹窗：领用结果回写设备检修领用台账 -->
    <div v-if="requisition" class="modal-mask" @click.self="requisition = null">
      <div class="modal">
        <h3 class="modal-title">办理领用 · {{ String(requisition.row['备件编号']) }}</h3>
        <p class="modal-desc">
          {{ String(requisition.row['备件名称']) }}｜当前在库量
          <strong>{{ requisition.row['在库量'] }}</strong>｜最低储备量
          {{ requisition.row['最低储备量'] }}
        </p>
        <div class="form-grid">
          <label class="form-item">
            <span>领用数量</span>
            <input v-model.number="requisition.quantity" type="number" min="1" :max="Number(requisition.row['在库量'])" />
          </label>
          <label class="form-item">
            <span>检修编号</span>
            <select v-model="requisition.overhaulCode">
              <option value="">请选择检修单</option>
              <option v-for="item in overhaulOptions" :key="item" :value="item">{{ item }}</option>
            </select>
          </label>
          <label class="form-item">
            <span>领用人</span>
            <input v-model="requisition.operator" type="text" />
          </label>
        </div>
        <p v-if="formError" class="error-text modal-error">{{ formError }}</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="requisition = null">取消</button>
          <button class="btn primary" type="button" @click="submitRequisition">确认领用</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  createSpare,
  downloadSpareList,
  isBelowMinStock,
  listEntries,
  moduleMeta,
  requisitionSpare,
  runAction as applyAction,
} from '@/api/local-service'
import { listRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('spare')
const columns = ['备件编号', '备件名称', '规格型号', '所属系统', '存放库位', '最低储备量', '在库量', '责任人员', '备件状态']
const actions = ['登记入库', '办理领用', '报废备件']
const statuses = ['待入库', '在库可用', '已领用', '已报废']
const editableFields = ['备件编号', '备件名称', '规格型号', '所属系统', '存放库位', '最低储备量', '在库量', '责任人员'] as const

const rows = ref<EntryRow[]>([])
const allRowsNow = ref<EntryRow[]>([])
const total = ref(0)
const message = ref('')
const messageOk = ref(false)
const filters = ref<Record<string, string>>({ 所属系统: '', 备件状态: '' })
const keyword = ref('')

const systemOptions = computed(() =>
  [...new Set(allRowsNow.value.map((row) => String(row['所属系统'] ?? '').trim()).filter(Boolean))].sort(),
)
const overhaulOptions = computed(() =>
  listRows('overhaul')
    .filter((row) => ['待开工', '检修中'].includes(String(row.status)))
    .map((row) => String(row['检修编号'] ?? '')),
)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: allRowsNow.value.filter((row) => String(row.status) === status).length,
  })),
)
const lowCount = computed(() => rows.value.filter(isBelowMinStock).length)
const stats = computed(() => [
  { label: '在库可用备件', value: allRowsNow.value.filter((row) => String(row.status) === '在库可用').length },
  { label: '待入库备件', value: allRowsNow.value.filter((row) => String(row.status) === '待入库').length },
  { label: '已领用备件', value: allRowsNow.value.filter((row) => String(row.status) === '已领用').length },
  { label: '低于最低储备量', value: allRowsNow.value.filter(isBelowMinStock).length },
])

// 登记表单
const creating = ref(false)
const emptyDraft = () => ({
  备件编号: '',
  备件名称: '',
  规格型号: '',
  所属系统: '',
  存放库位: '',
  最低储备量: '',
  在库量: '',
  责任人员: '',
})
const draft = ref(emptyDraft())
const formError = ref('')

// 领用表单
const requisition = ref<{ row: EntryRow; quantity: number; overhaulCode: string; operator: string } | null>(null)

function setMessage(text: string, ok = false) {
  message.value = text
  messageOk.value = ok
}

function resetFilters() {
  filters.value = { 所属系统: '', 备件状态: '' }
  keyword.value = ''
  reload()
}

function exportRows() {
  // 导出按当前筛选条件（所属系统、备件状态）走备件专用分段导出，失败时提示并允许重试。
  const activeFilters: Record<string, string> = {
    所属系统: filters.value['所属系统'] ?? '',
    备件状态: filters.value['备件状态'] ?? '',
  }
  const result = downloadSpareList(activeFilters)
  setMessage(result.message, result.ok)
}

function openCreate() {
  draft.value = emptyDraft()
  formError.value = ''
  creating.value = true
}

function submitCreate() {
  formError.value = ''
  const result = createSpare({ ...draft.value })
  if (!result.ok) {
    formError.value = result.message
    return
  }
  creating.value = false
  setMessage(result.message, true)
  reload()
}

function openRequisition(row: EntryRow) {
  formError.value = ''
  requisition.value = {
    row,
    quantity: 1,
    overhaulCode: '',
    operator: '值班管理员',
  }
}

function submitRequisition() {
  if (!requisition.value) {
    return
  }
  const result = requisitionSpare({
    spareId: Number(requisition.value.row.id),
    quantity: Number(requisition.value.quantity),
    overhaulCode: requisition.value.overhaulCode,
    operator: requisition.value.operator,
  })
  if (!result.ok) {
    formError.value = result.message
    return
  }
  requisition.value = null
  setMessage(result.message, true)
  reload()
}

function runAction(action: string, row: EntryRow) {
  message.value = ''
  if (action === '办理领用') {
    openRequisition(row)
    return
  }
  const result = applyAction(meta.key, Number(row.id), action)
  setMessage(result.message, result.ok)
  if (result.ok) {
    reload()
  }
}

function reload() {
  message.value = ''
  try {
    allRowsNow.value = listEntries(meta.key).items
    const activeFilters: Record<string, string> = {}
    if (filters.value['所属系统']?.trim()) {
      activeFilters['所属系统'] = filters.value['所属系统'].trim()
    }
    if (filters.value['备件状态']?.trim()) {
      activeFilters['备件状态'] = filters.value['备件状态'].trim()
    }
    let matched = listEntries(meta.key, activeFilters).items
    const word = keyword.value.trim()
    if (word) {
      matched = matched.filter(
        (row) =>
          String(row['备件编号'] ?? '').includes(word) || String(row['备件名称'] ?? '').includes(word),
      )
    }
    rows.value = matched
    total.value = matched.length
  } catch (error) {
    setMessage(error instanceof Error ? error.message : '备件台账列表读取失败')
  }
}

onMounted(reload)
</script>
