import {
  listRequisitions,
  listRows,
  resetRequisitions,
  resetRows,
  saveRequisitions,
  saveRows,
} from '@/data/local-store'
import type { ActionResult, EntryRow, RequisitionRow } from '@/data/types'

// 备件台账页面表头（含在库量），导出件逐字复用，保证页面与导出件列一致。
export const SPARE_COLUMNS = [
  '备件编号',
  '备件名称',
  '规格型号',
  '所属系统',
  '存放库位',
  '最低储备量',
  '在库量',
  '责任人员',
  '备件状态',
] as const

// 导出件每一段都必须具备的列：规格型号、存放库位、最低储备量是月底补货要核对的，缺列直接判失败。
const REQUIRED_EXPORT_COLUMNS = ['规格型号', '存放库位', '最低储备量']

const SPARE_KEY = 'spare'
const OVERHAUL_KEY = 'overhaul'

function nowText(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  )
}

function toNumber(value: unknown): number {
  const n = Number(String(value ?? '').trim())
  return Number.isFinite(n) ? n : 0
}

function spareRows(): EntryRow[] {
  return listRows(SPARE_KEY)
}

function findSpare(rows: EntryRow[], id: number): EntryRow | undefined {
  return rows.find((row) => Number(row.id) === id)
}

export type SpareDraft = {
  备件编号: string
  备件名称: string
  规格型号: string
  所属系统: string
  存放库位: string
  最低储备量: string
  责任人员: string
}

/** 登记新备件：同一备件编号不允许重复登记，只认一条。 */
export function createSpare(draft: SpareDraft): ActionResult {
  const code = draft.备件编号.trim()
  if (!code) {
    return { ok: false, message: '备件编号不能为空，无法登记' }
  }
  const rows = spareRows()
  const duplicated = rows.find((row) => String(row.备件编号 ?? '').trim() === code)
  if (duplicated) {
    return {
      ok: false,
      message: `备件编号 ${code} 已登记（库位 ${duplicated.存放库位 ?? '—'}），同一备件编号不允许重复登记`,
    }
  }
  if (!draft.备件名称.trim()) {
    return { ok: false, message: '备件名称不能为空，无法登记' }
  }
  const nextId = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  const row: EntryRow = {
    id: nextId,
    status: '待入库',
    pending: true,
    abnormal: false,
    备件编号: code,
    备件名称: draft.备件名称.trim(),
    规格型号: draft.规格型号.trim(),
    所属系统: draft.所属系统.trim(),
    存放库位: draft.存放库位.trim(),
    最低储备量: draft.最低储备量.trim() || '0',
    在库量: '0',
    责任人员: draft.责任人员.trim(),
    // 「备件状态」是业务字段，和流转用的 status 必须同步，页面与导出件才不会出现两个状态。
    备件状态: '待入库',
  }
  saveRows(SPARE_KEY, [...rows, row])
  return { ok: true, message: `备件 ${code} 登记成功，当前状态「待入库」，登记入库后转为在库可用` }
}

/** 登记入库：待入库的备件按数量入一次库。 */
export function stockInSpare(id: number, quantityInput: string): ActionResult {
  const quantity = toNumber(quantityInput)
  if (quantity <= 0) {
    return { ok: false, message: '入库数量必须是大于 0 的数字' }
  }
  const rows = spareRows()
  const row = findSpare(rows, id)
  if (!row) {
    return { ok: false, message: `没有找到编号为 ${id} 的备品备件` }
  }
  if (String(row.status) !== '待入库') {
    return { ok: false, message: `备件 ${row.备件编号} 当前是「${row.status}」，只有待入库备件可以登记入库` }
  }
  const next = [...rows]
  next[rows.indexOf(row)] = {
    ...row,
    status: '在库可用',
    在库量: String(quantity),
    pending: true,
    abnormal: false,
    备件状态: '在库可用',
  }
  saveRows(SPARE_KEY, next)
  return { ok: true, message: `备件 ${row.备件编号} 已入库 ${quantity} 件，当前状态「在库可用」` }
}

/**
 * 办理领用：扣减在库量、写领用台账（同一备件编号只记一次，再次领用更新原记录）、
 * 回写设备检修记录「更换备件」，保证检修台账能和备件在库量对上。
 */
export function requisitionSpare(
  id: number,
  payload: { quantityInput: string; overhaulCode: string; receiver: string },
): ActionResult {
  const quantity = toNumber(payload.quantityInput)
  const overhaulCode = payload.overhaulCode.trim()
  if (quantity <= 0) {
    return { ok: false, message: '领用数量必须是大于 0 的数字' }
  }
  if (!overhaulCode) {
    return { ok: false, message: '请选择领用对应的检修编号，否则无法回写设备检修领用台账' }
  }

  const rows = spareRows()
  const row = findSpare(rows, id)
  if (!row) {
    return { ok: false, message: `没有找到编号为 ${id} 的备品备件` }
  }
  if (String(row.status) === '已报废') {
    return { ok: false, message: `备件 ${row.备件编号} 已报废，不能办理领用` }
  }
  const stock = toNumber(row.在库量)
  if (stock < quantity) {
    return { ok: false, message: `备件 ${row.备件编号} 在库量仅 ${stock} 件，不够领用 ${quantity} 件` }
  }

  const remain = stock - quantity
  const code = String(row.备件编号 ?? '')

  // 1. 备件在库量扣减，扣到 0 转为「已领用」，未扣完仍在库。
  const nextRows = [...rows]
  const nextStatus = remain === 0 ? '已领用' : '在库可用'
  nextRows[rows.indexOf(row)] = {
    ...row,
    status: nextStatus,
    在库量: String(remain),
    pending: remain > 0,
    abnormal: false,
    备件状态: nextStatus,
  }

  // 2. 领用台账按备件编号去重：已有就更新原行，不新增；没有才新增。
  const ledger = listRequisitions()
  const existIndex = ledger.findIndex((item) => item.备件编号 === code)
  const ledgerRow: RequisitionRow = {
    id: existIndex >= 0 ? ledger[existIndex].id : (ledger[ledger.length - 1]?.id ?? 0) + 1,
    备件编号: code,
    备件名称: String(row.备件名称 ?? ''),
    规格型号: String(row.规格型号 ?? ''),
    所属系统: String(row.所属系统 ?? ''),
    检修编号: overhaulCode,
    领用数量: quantity,
    领用后在库量: remain,
    领用人: payload.receiver.trim() || String(row.责任人员 ?? ''),
    领用时间: nowText(),
  }
  const nextLedger =
    existIndex >= 0
      ? ledger.map((item, index) => (index === existIndex ? ledgerRow : item))
      : [...ledger, ledgerRow]

  // 3. 回写检修记录「更换备件」，同一备件编号只占一段，文本带领后在库量，两边可逐项核对。
  const overhaulRows = listRows(OVERHAUL_KEY)
  const target = overhaulRows.find((record) => String(record.检修编号 ?? '') === overhaulCode)
  if (!target) {
    return { ok: false, message: `没有找到检修编号 ${overhaulCode}，领用未回写，请重新选择检修记录` }
  }
  const stamp = `${code} ×${quantity}（领后在库${remain}）`
  const existingParts = String(target.更换备件 ?? '')
    .split('；')
    .map((item) => item.trim())
    .filter((item) => item !== '' && item !== '—' && !item.startsWith(`${code} `))
  existingParts.push(stamp)
  const nextOverhaul = overhaulRows.map((record) =>
    String(record.检修编号 ?? '') === overhaulCode
      ? { ...record, 更换备件: existingParts.join('；') }
      : record,
  )

  saveRows(SPARE_KEY, nextRows)
  saveRequisitions(nextLedger)
  saveRows(OVERHAUL_KEY, nextOverhaul)
  return {
    ok: true,
    message: `备件 ${code} 已领用 ${quantity} 件，领后在库 ${remain} 件，已回写检修单 ${overhaulCode} 与领用台账`,
  }
}

/** 报废备件：已报废不可重复报废。 */
export function scrapSpare(id: number): ActionResult {
  const rows = spareRows()
  const row = findSpare(rows, id)
  if (!row) {
    return { ok: false, message: `没有找到编号为 ${id} 的备品备件` }
  }
  if (String(row.status) === '已报废') {
    return { ok: false, message: `备件 ${row.备件编号} 已经是「已报废」，不用重复操作` }
  }
  const next = [...rows]
  next[rows.indexOf(row)] = { ...row, status: '已报废', 在库量: '0', pending: false, 备件状态: '已报废' }
  saveRows(SPARE_KEY, next)
  return { ok: true, message: `备件 ${row.备件编号} 已报废，在库量清零` }
}

/** 低于最低储备量：只看还在周转的备件，已报废不进补货清单。 */
export function isBelowMinimum(row: EntryRow): boolean {
  if (String(row.status) === '已报废') {
    return false
  }
  return toNumber(row.在库量) < toNumber(row.最低储备量)
}

export function listRequisitionRows(): RequisitionRow[] {
  return listRequisitions()
}

export function listOverhaulRecords(): EntryRow[] {
  return listRows(OVERHAUL_KEY)
}

export function resetSpareData(): void {
  resetRows(SPARE_KEY)
  resetRows(OVERHAUL_KEY)
  resetRequisitions()
}

function csvCell(value: unknown): string {
  const text = String(value ?? '').trim()
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

/**
 * 导出筛选结果：正常在库与低于最低储备量的补货备件分两段，互不相混。
 * 关键列缺失、无数据、下载环节异常都抛错，由页面提示失败并允许重新导出。
 */
export function buildSpareExport(filters: {
  所属系统: string
  备件状态: string
  关键字: string
}): { filename: string; content: string } {
  const rows = spareRows()
  let matched = rows
  const system = filters.所属系统.trim()
  const status = filters.备件状态.trim()
  const keyword = filters.关键字.trim()
  if (system) {
    matched = matched.filter((row) => String(row.所属系统 ?? '').includes(system))
  }
  if (status) {
    matched = matched.filter((row) => String(row.status) === status)
  }
  if (keyword) {
    matched = matched.filter(
      (row) =>
        String(row.备件编号 ?? '').includes(keyword) ||
        String(row.备件名称 ?? '').includes(keyword) ||
        String(row.规格型号 ?? '').includes(keyword),
    )
  }
  if (matched.length === 0) {
    throw new Error('当前筛选条件下没有可导出的备件记录，请调整所属系统或备件状态后重新导出')
  }

  // 缺列校验：任何一行缺关键列都判失败，避免导出件拿出去才发现对不上。
  matched.forEach((row) => {
    const missing = REQUIRED_EXPORT_COLUMNS.filter((column) => {
      const value = row[column]
      return value === undefined || value === null || String(value).trim() === ''
    })
    if (missing.length > 0) {
      throw new Error(
        `备件 ${row.备件编号 ?? row.id} 缺少「${missing.join('、')}」，导出件列不完整，已终止导出，请补全后重新导出`,
      )
    }
  })

  const normal = matched.filter((row) => !isBelowMinimum(row))
  const replenish = matched.filter(isBelowMinimum)
  if (replenish.length === 0) {
    throw new Error('筛选结果中没有低于最低储备量的备件，无法生成补货清单段，请调整条件后重新导出')
  }

  const header = ['备件编号', ...SPARE_COLUMNS.slice(1), '当前状态']
  const lines: string[] = []
  lines.push('# 备件台账导出清单')
  lines.push(
    `# 筛选条件：所属系统=${system || '全部'}，备件状态=${status || '全部'}${keyword ? `，关键字=${keyword}` : ''}，导出时间=${nowText()}`,
  )
  lines.push('')

  const writeSection = (title: string, sectionRows: EntryRow[], emptyText: string) => {
    lines.push(`## ${title}（${sectionRows.length}项）`)
    lines.push(header.map(csvCell).join(','))
    if (sectionRows.length === 0) {
      lines.push(emptyText)
    } else {
      for (const row of sectionRows) {
        lines.push(
          [
            ...SPARE_COLUMNS.map((column) => csvCell(row[column])),
            csvCell(row.status),
          ].join(','),
        )
      }
    }
    lines.push('')
  }

  writeSection('一、正常在库备件', normal, '（本段暂无备件）')
  writeSection('二、低于最低储备量补货清单', replenish, '（本段暂无备件）')

  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const filename = `备件台账补货清单-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.csv`
  return { filename, content: `﻿${lines.join('\r\n')}` }
}
