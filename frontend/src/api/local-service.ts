import { MODULE_BY_KEY } from '@/data/modules'
import {
  allRows,
  listRows,
  readLedger,
  resetRows,
  saveRows,
  writeLedger,
} from '@/data/local-store'
import type {
  ActionResult,
  EntryRow,
  ModuleMeta,
  OverviewResult,
  PageResult,
  RequisitionEntry,
  RequisitionLedgerRow,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  // 备件表里「备件状态」是给台账和导出看的字段，必须与流转状态保持逐字一致。
  if (key === 'spare' && '备件状态' in updated) {
    updated.备件状态 = target
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

// ---------------------------------------------------------------------------
// 备件台账：登记去重、筛选导出（补货清单分段）、领用回写检修领用台账、台账核对
// ---------------------------------------------------------------------------

const SPARE_KEY = 'spare'
const OVERHAUL_KEY = 'overhaul'
const SPARE_CODE_FIELD = '备件编号'
const STOCK_FIELD = '在库量'
const MIN_STOCK_FIELD = '最低储备量'
// 导出件里必须与页面逐字一致的列，缺一列就按导出失败处理。
const SPARE_EXPORT_COLUMNS = [
  '备件编号',
  '备件名称',
  '规格型号',
  '所属系统',
  '存放库位',
  '最低储备量',
  '在库量',
  '责任人员',
  '备件状态',
]

export function toQuantity(value: unknown): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0
  }
  const parsed = Number(String(value ?? '').trim())
  return Number.isFinite(parsed) ? parsed : 0
}

export function isBelowMinStock(row: EntryRow): boolean {
  return toQuantity(row[STOCK_FIELD]) < toQuantity(row[MIN_STOCK_FIELD])
}

export type SpareDraft = {
  备件编号: string
  备件名称: string
  规格型号: string
  所属系统: string
  存放库位: string
  最低储备量: string
  在库量: string
  责任人员: string
}

export function createSpare(draft: SpareDraft): ActionResult {
  const code = draft[SPARE_CODE_FIELD].trim()
  if (!code) {
    return { ok: false, message: '登记失败：备件编号不能为空' }
  }
  for (const field of ['备件名称', '规格型号', '所属系统', '存放库位'] as const) {
    if (!draft[field].trim()) {
      return { ok: false, message: `登记失败：${field}不能为空` }
    }
  }
  const minStock = toQuantity(draft[MIN_STOCK_FIELD])
  const stock = toQuantity(draft[STOCK_FIELD])
  if (minStock < 0 || stock < 0) {
    return { ok: false, message: '登记失败：最低储备量与在库量不能为负数' }
  }
  const rows = listRows(SPARE_KEY)
  // 同一备件编号不允许重复登记，只记一次。
  if (rows.some((row) => String(row[SPARE_CODE_FIELD] ?? '').trim() === code)) {
    return { ok: false, message: `登记失败：备件编号 ${code} 已登记，不允许重复登记` }
  }
  const id = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  const stockStatus = stock > 0 ? '在库可用' : '待入库'
  const row: EntryRow = {
    id,
    status: stockStatus,
    pending: stock > 0,
    abnormal: stock < minStock,
    备件编号: code,
    备件名称: draft.备件名称.trim(),
    规格型号: draft.规格型号.trim(),
    所属系统: draft.所属系统.trim(),
    存放库位: draft.存放库位.trim(),
    最低储备量: minStock,
    在库量: stock,
    责任人员: draft.责任人员.trim() || '未指定',
    备件状态: stockStatus,
  }
  saveRows(SPARE_KEY, [...rows, row])
  return { ok: true, message: `备件 ${code} 登记成功，当前在库量 ${stock}` }
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined || value === '' ? '—' : String(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export type SpareExportResult = {
  ok: boolean
  message: string
  filename?: string
  content?: string
}

// 按所属系统、备件状态等条件筛出的结果导出；低于最低储备量的单独成段，不与正常在库混排。
export function exportSpareList(filters: Record<string, string> = {}): SpareExportResult {
  const meta = moduleMeta(SPARE_KEY)
  const rows = filterRows(listRows(SPARE_KEY), filters)
  if (rows.length === 0) {
    return { ok: false, message: '导出失败：当前筛选条件下没有可导出的备件，请调整条件后重新导出' }
  }
  const missing = SPARE_EXPORT_COLUMNS.filter((column) => !meta.fields.includes(column))
  if (missing.length > 0) {
    return { ok: false, message: `导出失败：导出件缺少 ${missing.join('、')} 列，请检查字段配置后重新导出` }
  }
  const now = new Date()
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(
    now.getDate(),
  ).padStart(2, '0')}`
  const filename = `备件补货清单-${stamp}.csv`

  const header = ['序号', ...SPARE_EXPORT_COLUMNS]
  const toLine = (index: number, row: EntryRow) =>
    [index, ...SPARE_EXPORT_COLUMNS.map((column) => row[column])].map(csvCell).join(',')

  const replenishing = rows.filter(isBelowMinStock)
  const normal = rows.filter((row) => !isBelowMinStock(row))

  const lines: string[] = []
  lines.push(`备件补货清单（导出时间：${now.toLocaleString()}）`)
  lines.push(
    `筛选条件：所属系统=${filters['所属系统']?.trim() || '全部'}；备件状态=${
      filters['备件状态']?.trim() || '全部'
    }`,
  )
  lines.push('')
  lines.push('【一、正常在库备件】')
  lines.push(header.map(csvCell).join(','))
  normal.forEach((row, index) => lines.push(toLine(index + 1, row)))
  lines.push('')
  lines.push(`【二、低于最低储备量补货清单（共 ${replenishing.length} 项）】`)
  lines.push(header.map(csvCell).join(','))
  replenishing.forEach((row, index) => lines.push(toLine(index + 1, row)))

  const content = `\uFEFF${lines.join('\r\n')}`

  // 导出后自检：表头缺列或行数对不上都算失败，页面给出提示并允许重新导出。
  const dataLineCount = normal.length + replenishing.length
  if (
    !content.includes('规格型号') ||
    !content.includes('存放库位') ||
    !content.includes('最低储备量') ||
    dataLineCount !== rows.length
  ) {
    return { ok: false, message: '导出失败：导出件列不完整，请重新导出一次' }
  }
  return { ok: true, message: `导出成功：正常在库 ${normal.length} 项，补货清单 ${replenishing.length} 项`, filename, content }
}

export function downloadSpareList(
  filters: Record<string, string> = {},
): SpareExportResult {
  const result = exportSpareList(filters)
  if (!result.ok || !result.content || !result.filename) {
    return result
  }
  try {
    const blob = new Blob([result.content], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = result.filename
    document.body.appendChild(anchor)
    anchor.click()
    document.body.removeChild(anchor)
    URL.revokeObjectURL(url)
  } catch {
    return { ok: false, message: '导出失败：文件未能生成，请重新导出一次' }
  }
  return result
}

export type RequisitionDraft = {
  spareId: number
  quantity: number
  overhaulCode: string
  operator: string
}

// 办理领用：扣减在库量，并把这笔领用回写到设备检修的领用台账与检修记录。
export function requisitionSpare(draft: RequisitionDraft): ActionResult {
  const quantity = Math.floor(Number(draft.quantity))
  const overhaulCode = draft.overhaulCode.trim()
  if (!overhaulCode) {
    return { ok: false, message: '领用失败：请填写对应的检修编号' }
  }
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return { ok: false, message: '领用失败：领用数量必须是大于 0 的整数' }
  }
  const spareRows = listRows(SPARE_KEY)
  const spareIndex = spareRows.findIndex((row) => Number(row.id) === Number(draft.spareId))
  if (spareIndex < 0) {
    return { ok: false, message: '领用失败：没有找到该备件' }
  }
  const spare = spareRows[spareIndex]
  const code = String(spare[SPARE_CODE_FIELD] ?? '')
  if (String(spare.status) !== '在库可用') {
    return { ok: false, message: `领用失败：备件 ${code} 当前状态为「${spare.status}」，不能领用` }
  }
  const before = toQuantity(spare[STOCK_FIELD])
  if (quantity > before) {
    return { ok: false, message: `领用失败：备件 ${code} 在库量仅 ${before}，不足领用 ${quantity}` }
  }

  const overhaulRows = listRows(OVERHAUL_KEY)
  const overhaul = overhaulRows.find((row) => String(row['检修编号'] ?? '').trim() === overhaulCode)
  if (!overhaul) {
    return { ok: false, message: `领用失败：检修编号 ${overhaulCode} 不存在，请核对后重试` }
  }

  const after = before - quantity
  const nextSpare: EntryRow = {
    ...spare,
    在库量: after,
    status: after === 0 ? '已领用' : '在库可用',
    pending: after > 0,
    abnormal: after < toQuantity(spare[MIN_STOCK_FIELD]),
    备件状态: after === 0 ? '已领用' : '在库可用',
  }
  const nextSpareRows = [...spareRows]
  nextSpareRows[spareIndex] = nextSpare
  saveRows(SPARE_KEY, nextSpareRows)

  const ledger = readLedger<RequisitionEntry>()
  const ledgerId = ledger.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1
  ledger.push({
    id: ledgerId,
    检修编号: overhaulCode,
    检修设备: String(overhaul['检修设备'] ?? ''),
    备件编号: code,
    备件名称: String(spare['备件名称'] ?? ''),
    规格型号: String(spare['规格型号'] ?? ''),
    领用数量: quantity,
    领前在库量: before,
    领后在库量: after,
    领用人: draft.operator.trim() || '值班管理员',
    领用时间: new Date().toLocaleString(),
  })
  writeLedger(ledger)

  // 回写检修记录的更换备件：同一备件编号在同一张检修单里只记一次。
  const replaced = String(overhaul['更换备件'] ?? '')
    .split(/[、,，\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
  if (!replaced.includes(code)) {
    replaced.push(code)
  }
  const overhaulIndex = overhaulRows.findIndex((row) => Number(row.id) === Number(overhaul.id))
  const nextOverhaulRows = [...overhaulRows]
  nextOverhaulRows[overhaulIndex] = { ...overhaul, 更换备件: replaced.join('、') }
  saveRows(OVERHAUL_KEY, nextOverhaulRows)

  return { ok: true, message: `领用成功：备件 ${code} 领用 ${quantity} 件，领后在库量 ${after}，已回写检修单 ${overhaulCode}` }
}

// 设备检修侧的领用台账：按检修编号+备件编号归并，同一备件编号只记一次；
// 用最新一次领后的在库量和备件台账当前在库量逐笔核对。
export function listRequisitionLedger(overhaulCode = ''): RequisitionLedgerRow[] {
  const ledger = readLedger<RequisitionEntry>()
  const spareRows = listRows(SPARE_KEY)
  const stockByCode = new Map(
    spareRows.map((row) => [String(row[SPARE_CODE_FIELD] ?? ''), toQuantity(row[STOCK_FIELD])]),
  )
  const grouped = new Map<string, RequisitionLedgerRow>()
  for (const entry of ledger) {
    if (overhaulCode.trim() && entry.检修编号 !== overhaulCode.trim()) {
      continue
    }
    const key = `${entry.检修编号}@@${entry.备件编号}`
    const existing = grouped.get(key)
    const currentStock = stockByCode.get(entry.备件编号) ?? 0
    if (existing) {
      existing.累计领用数量 += entry.领用数量
      existing.领后在库量 = entry.领后在库量
      existing.领用时间 = entry.领用时间
      existing.领用人 = entry.领用人
      existing.当前在库量 = currentStock
      existing.核对一致 = entry.领后在库量 === currentStock
    } else {
      grouped.set(key, {
        ...entry,
        累计领用数量: entry.领用数量,
        当前在库量: currentStock,
        核对一致: entry.领后在库量 === currentStock,
      })
    }
  }
  return [...grouped.values()].sort((a, b) => b.领用时间.localeCompare(a.领用时间))
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
