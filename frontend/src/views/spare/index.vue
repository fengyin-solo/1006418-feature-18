<template>
  <section class="page" data-module="spare">
    <header class="page-head">
      <div>
        <h2>备件台账管理</h2>
        <p class="page-desc">
          维护备品备件，围绕备件编号、备件名称、规格型号、所属系统做登记、筛选与状态流转；
          低于最低储备量的备件在页面与导出件中单独成段。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记备品备件</button>
        <button class="btn" type="button" :disabled="exporting" @click="exportRows">
          {{ exporting ? '导出中…' : '导出备件补货清单' }}
        </button>
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
      <span class="legend-item legend-warn">低于最低储备量：{{ lowStockCount }}</span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label class="filter-item">
        <span>所属系统</span>
        <select v-model="filters.所属系统">
          <option value="">全部系统</option>
          <option v-for="system in systemOptions" :key="system" :value="system">{{ system }}</option>
        </select>
      </label>
      <label class="filter-item">
        <span>备件状态</span>
        <select v-model="filters.备件状态">
          <option value="">全部状态</option>
          <option v-for="status in statuses" :key="status" :value="status">{{ status }}</option>
        </select>
      </label>
      <label class="filter-item">
        <span>备件检索</span>
        <input v-model="filters.关键字" placeholder="按编号/名称/规格型号检索" />
      </label>
      <button class="btn" type="submit">查询</button>
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
        <tr v-for="row in rows" :key="String(row.id)" :class="{ 'low-stock': isLow(row) }">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>
            {{ row.status }}
            <span v-if="isLow(row)" class="tag tag-warn">低于最低储备</span>
          </td>
          <td class="row-actions">
            <button
              v-if="String(row.status) === '待入库'"
              class="link"
              type="button"
              @click="openStockIn(row)"
            >
              登记入库
            </button>
            <button
              v-if="String(row.status) !== '已报废'"
              class="link"
              type="button"
              @click="openRequisition(row)"
            >
              办理领用
            </button>
            <button
              v-if="String(row.status) !== '已报废'"
              class="link link-danger"
              type="button"
              @click="runScrap(row)"
            >
              报废备件
            </button>
            <span v-else class="muted-text">—</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">当前筛选条件下没有备件记录，可先登记备品备件</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条备件记录，其中 {{ lowStockCount }} 条低于最低储备量需补货</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-if="successMessage" class="success-text">{{ successMessage }}</span>
    </footer>

    <!-- 登记 / 入库 / 领用共用弹层 -->
    <div v-if="modal.visible" class="modal-mask" @click.self="closeModal">
      <div class="modal">
        <h3 class="modal-title">{{ modal.title }}</h3>

        <template v-if="modal.type === 'create'">
          <div class="form-grid">
            <label v-for="field in createFields" :key="field" class="form-item">
              <span>{{ field }}<em v-if="field === '备件编号' || field === '备件名称'">*</em></span>
              <input
                v-model="createDraft[field]"
                :placeholder="`请输入${field}`"
                @keyup.enter="submitCreate"
              />
            </label>
          </div>
        </template>

        <template v-else-if="modal.type === 'stockIn'">
          <p class="modal-tip">
            备件编号 <strong>{{ modal.row?.['备件编号'] }}</strong>
            （{{ modal.row?.['备件名称'] }}，库位 {{ modal.row?.['存放库位'] || '—' }}）
          </p>
          <label class="form-item">
            <span>入库数量*</span>
            <input v-model="modal.quantity" type="number" min="1" placeholder="请输入入库数量" />
          </label>
        </template>

        <template v-else-if="modal.type === 'requisition'">
          <p class="modal-tip">
            备件编号 <strong>{{ modal.row?.['备件编号'] }}</strong>
            （{{ modal.row?.['备件名称'] }}），当前在库量
            <strong>{{ modal.row?.['在库量'] }}</strong>，最低储备量
            {{ modal.row?.['最低储备量'] }}
          </p>
          <div class="form-grid">
            <label class="form-item">
              <span>领用数量*</span>
              <input v-model="modal.quantity" type="number" min="1" placeholder="请输入领用数量" />
            </label>
            <label class="form-item">
              <span>对应检修编号*</span>
              <select v-model="modal.overhaulCode">
                <option value="">请选择检修记录</option>
                <option v-for="record in overhaulOptions" :key="String(record.id)" :value="String(record['检修编号'])">
                  {{ record['检修编号'] }}｜{{ record['检修设备'] }}（{{ record.status }}）
                </option>
              </select>
            </label>
            <label class="form-item">
              <span>领用人</span>
              <input v-model="modal.receiver" placeholder="默认取备件责任人员" />
            </label>
          </div>
          <p class="modal-note">
            领用后自动扣减在库量，并回写设备检修领用台账与该检修记录的「更换备件」；
            同一备件编号重复领用只更新台账原记录，不重复登记。
          </p>
        </template>

        <p v-if="modal.error" class="error-text">{{ modal.error }}</p>

        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="closeModal">取消</button>
          <button class="btn primary" type="button" @click="submitModal">确定</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  buildSpareExport,
  createSpare,
  isBelowMinimum,
  listOverhaulRecords,
  requisitionSpare,
  scrapSpare,
  SPARE_COLUMNS,
  stockInSpare,
  type SpareDraft,
} from '@/api/spare-service'
import { downloadTextFile, listEntries } from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const columns = [...SPARE_COLUMNS]
const statuses = ['待入库', '在库可用', '已领用', '已报废']
const createFields = ['备件编号', '备件名称', '规格型号', '所属系统', '存放库位', '最低储备量', '责任人员'] as const

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const successMessage = ref('')
const exporting = ref(false)
const filters = reactive<{ 所属系统: string; 备件状态: string; 关键字: string }>({
  所属系统: '',
  备件状态: '',
  关键字: '',
})

const stats = computed(() => [
  { label: '在库可用备件', value: rows.value.filter((row) => String(row.status) === '在库可用').length },
  { label: '已领用备件', value: rows.value.filter((row) => String(row.status) === '已领用').length },
  { label: '待入库备件', value: rows.value.filter((row) => String(row.status) === '待入库').length },
])

const allSpareRows = ref<EntryRow[]>([])

const systemOptions = computed(() => {
  const values = new Set(
    allSpareRows.value.map((row) => String(row.所属系统 ?? '').trim()).filter(Boolean),
  )
  return [...values]
})

const overhaulOptions = ref<EntryRow[]>([])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: allSpareRows.value.filter((row) => String(row.status) === status).length,
  })),
)

const lowStockCount = computed(() => allSpareRows.value.filter(isBelowMinimum).length)

function isLow(row: EntryRow): boolean {
  return isBelowMinimum(row)
}

const emptyDraft = (): SpareDraft => ({
  备件编号: '',
  备件名称: '',
  规格型号: '',
  所属系统: '',
  存放库位: '',
  最低储备量: '',
  责任人员: '',
})

const createDraft = ref<SpareDraft>(emptyDraft())

type ModalState = {
  visible: boolean
  type: 'create' | 'stockIn' | 'requisition'
  title: string
  row: EntryRow | null
  quantity: string
  overhaulCode: string
  receiver: string
  error: string
}

const modal = reactive<ModalState>({
  visible: false,
  type: 'create',
  title: '',
  row: null,
  quantity: '1',
  overhaulCode: '',
  receiver: '',
  error: '',
})

function flashSuccess(message: string) {
  successMessage.value = message
  window.setTimeout(() => {
    successMessage.value = ''
  }, 4000)
}

function resetFilters() {
  filters.所属系统 = ''
  filters.备件状态 = ''
  filters.关键字 = ''
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    allSpareRows.value = listEntries('spare').items
    const system = filters.所属系统.trim()
    const status = filters.备件状态.trim()
    const keyword = filters.关键字.trim()
    rows.value = allSpareRows.value.filter((row) => {
      if (system && !String(row.所属系统 ?? '').includes(system)) {
        return false
      }
      // 状态精确匹配，避免「在库可用」被「在库」之类的输入误命中。
      if (status && String(row.status) !== status) {
        return false
      }
      if (
        keyword &&
        ![row.备件编号, row.备件名称, row.规格型号]
          .some((value) => String(value ?? '').includes(keyword))
      ) {
        return false
      }
      return true
    })
    total.value = rows.value.length
    overhaulOptions.value = listOverhaulRecords()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '备件台账列表读取失败'
  }
}

// 导出失败（无数据/缺列/浏览器下载异常）只提示不动数据，用户可调整条件后直接重新导出。
function exportRows() {
  errorMessage.value = ''
  successMessage.value = ''
  exporting.value = true
  try {
    const { filename, content } = buildSpareExport({ ...filters })
    downloadTextFile(filename, content)
    flashSuccess(`导出成功：${filename}，正常在库与低于最低储备量补货备件已分段列出`)
  } catch (error) {
    errorMessage.value =
      (error instanceof Error ? error.message : '备件补货清单导出失败') + '，可重新导出一次'
  } finally {
    exporting.value = false
  }
}

function openCreate() {
  createDraft.value = emptyDraft()
  Object.assign(modal, {
    visible: true,
    type: 'create',
    title: '登记备品备件',
    row: null,
    quantity: '1',
    overhaulCode: '',
    receiver: '',
    error: '',
  })
}

function openStockIn(row: EntryRow) {
  Object.assign(modal, {
    visible: true,
    type: 'stockIn',
    title: '登记入库',
    row,
    quantity: '1',
    overhaulCode: '',
    receiver: '',
    error: '',
  })
}

function openRequisition(row: EntryRow) {
  Object.assign(modal, {
    visible: true,
    type: 'requisition',
    title: '办理领用并回写检修台账',
    row,
    quantity: '1',
    overhaulCode: '',
    receiver: '',
    error: '',
  })
}

function closeModal() {
  modal.visible = false
  modal.error = ''
}

function submitCreate() {
  const result = createSpare(createDraft.value)
  if (!result.ok) {
    modal.error = result.message
    return
  }
  closeModal()
  reload()
  flashSuccess(result.message)
}

function submitModal() {
  if (!modal.row) {
    return
  }
  const id = Number(modal.row.id)
  const result =
    modal.type === 'stockIn'
      ? stockInSpare(id, modal.quantity)
      : requisitionSpare(id, {
          quantityInput: modal.quantity,
          overhaulCode: modal.overhaulCode,
          receiver: modal.receiver,
        })
  if (!result.ok) {
    modal.error = result.message
    return
  }
  closeModal()
  reload()
  flashSuccess(result.message)
}

function runScrap(row: EntryRow) {
  errorMessage.value = ''
  const result = scrapSpare(Number(row.id))
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
  flashSuccess(result.message)
}

onMounted(reload)
</script>
