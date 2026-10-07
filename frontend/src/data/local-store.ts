import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'waste-to-energy-plant:entries'
const LEDGER_KEY = 'waste-to-energy-plant:spare-requisition-ledger'
// 备件模型升级过：老版本示例数据没有在库量，靠版本号重新播种相关模块。
const SCHEMA_KEY = 'waste-to-energy-plant:schema-version'
const SCHEMA_VERSION = 2
const RESEEDED_ON_UPGRADE = ['spare', 'overhaul']

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function upgradeIfNeeded(parsed: Record<string, EntryRow[]>): Record<string, EntryRow[]> {
  if (typeof window === 'undefined' || !window.localStorage) {
    return parsed
  }
  const version = Number(window.localStorage.getItem(SCHEMA_KEY) ?? '1')
  if (version >= SCHEMA_VERSION) {
    return parsed
  }
  const merged = { ...parsed }
  for (const key of RESEEDED_ON_UPGRADE) {
    if (SEED_ROWS[key]) {
      merged[key] = clone(SEED_ROWS[key])
    }
  }
  window.localStorage.setItem(SCHEMA_KEY, String(SCHEMA_VERSION))
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(merged))
  return merged
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    window.localStorage.setItem(SCHEMA_KEY, String(SCHEMA_VERSION))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return upgradeIfNeeded({ ...fallback, ...parsed })
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

// 备件领用台账：跨备件台账与设备检修两个模块，独立持久化，重置任一模块都不受影响。
export function readLedger<T>(): T[] {
  if (typeof window === 'undefined' || !window.localStorage) {
    return []
  }
  const raw = window.localStorage.getItem(LEDGER_KEY)
  if (!raw) {
    return []
  }
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch {
    return []
  }
}

export function writeLedger<T>(entries: T[]): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(LEDGER_KEY, JSON.stringify(entries))
  }
}
