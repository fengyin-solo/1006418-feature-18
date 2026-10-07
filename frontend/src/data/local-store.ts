import { SEED_REQUISITIONS, SEED_ROWS } from './seed'
import type { EntryRow, RequisitionRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
// v2：备件台账增加在库量、领用数量等字段，旧版本缓存结构不再兼容，直接重新播种。
const STORAGE_KEY = 'waste-to-energy-plant:entries:v2'
const REQUISITION_KEY = 'waste-to-energy-plant:requisitions:v1'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}

// 备件领用台账独立存储：由备件办理领用动作回写，设备检修页面直接读取。
export function listRequisitions(): RequisitionRow[] {
  if (typeof window === 'undefined' || !window.localStorage) {
    return clone(SEED_REQUISITIONS)
  }
  const raw = window.localStorage.getItem(REQUISITION_KEY)
  if (!raw) {
    const fallback = clone(SEED_REQUISITIONS)
    window.localStorage.setItem(REQUISITION_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as RequisitionRow[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    const fallback = clone(SEED_REQUISITIONS)
    window.localStorage.setItem(REQUISITION_KEY, JSON.stringify(fallback))
    return fallback
  }
}

export function saveRequisitions(rows: RequisitionRow[]): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(REQUISITION_KEY, JSON.stringify(rows))
  }
}

export function resetRequisitions(): RequisitionRow[] {
  const rows = clone(SEED_REQUISITIONS)
  saveRequisitions(rows)
  return rows
}
