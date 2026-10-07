/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

// 备件领用台账：备件办理领用后写入，供设备检修那边核对更换备件与在库量。
export type RequisitionEntry = {
  id: number
  检修编号: string
  检修设备: string
  备件编号: string
  备件名称: string
  规格型号: string
  领用数量: number
  领前在库量: number
  领后在库量: number
  领用人: string
  领用时间: string
}

// 台账与备件台账当前在库量核对后的一行。
export type RequisitionLedgerRow = RequisitionEntry & {
  累计领用数量: number
  当前在库量: number
  核对一致: boolean
}
