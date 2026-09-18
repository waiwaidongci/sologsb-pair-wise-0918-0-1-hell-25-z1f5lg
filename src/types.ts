// 潜水气瓶充填 —— 领域模型

export type FillMode = "空气" | "高氧" | "Trimix";

/** queued 待充填 / filling 充填中 / inspection 待检 / quarantined 隔离 / filled 待签收 / signed 已签收 */
export type OrderStatus =
  | "queued"
  | "filling"
  | "inspection"
  | "quarantined"
  | "filled"
  | "signed";

export const STATUS_LABEL: Record<OrderStatus, string> = {
  queued: "待充填",
  filling: "充填中",
  inspection: "待检",
  quarantined: "隔离",
  filled: "待签收",
  signed: "已签收",
};

export type BatchStatus = "active" | "frozen";

export interface Batch {
  id: string;
  /** 批次编号，如 BAT-AIR-0918 */
  name: string;
  kind: FillMode;
  o2: number;
  he: number;
  status: BatchStatus;
  createdAt: number;
}

export interface PressurePoint {
  t: number;
  bar: number;
}

export interface ReverifyResult {
  /** 首次重验结论，重复复位时原样沿用，不允许改判 */
  pass: boolean;
  supervisor: string;
  note: string;
  at: number;
}

export interface ResetResult {
  /** 首次泄漏检查结论，重复复位时原样沿用 */
  leakFound: boolean;
  supervisor: string;
  note: string;
  at: number;
}

export interface Order {
  id: string;
  tankNo: string;
  volume: string;
  inspectUntil: string; // ISO yyyy-mm-dd
  residual: number;
  target: number;
  o2: number;
  he: number;
  fillMode: FillMode;
  operator: string;
  batchId: string | null;
  status: OrderStatus;
  /** 当前/最后一次已记录压力，闭锁时只保留不修改 */
  pressure: number;
  pressureLog: PressurePoint[];
  /** 连续下降采样计数，达到 3 次自动闭锁 */
  dropStreak: number;
  frozenAt: number | null;
  /** 波及过的事故 */
  incidents: string[];
  /** incidentId -> 首次逐瓶重验结果 */
  reverifies: Record<string, ReverifyResult>;
  signoff: { by: string; at: number } | null;
  createdAt: number;
}

export interface Incident {
  id: string;
  reason: "leak" | "estop";
  detail: string;
  /** 被冻结的气源批次 */
  batchIds: string[];
  /** 受影响、必须逐瓶重验的工单 */
  affectedOrderIds: string[];
  startedAt: number;
  status: "lockout" | "closed";
  resetResult: ResetResult | null;
  /** 复位次数；>=2 即为重复复位，沿用首次结果 */
  resetCount: number;
  closedAt: number | null;
}

export type AuditKind = "info" | "danger" | "warn" | "success";

export interface AuditEntry {
  id: string;
  t: number;
  kind: AuditKind;
  text: string;
  tankNo?: string;
}

export interface State {
  batches: Batch[];
  orders: Order[];
  incidents: Incident[];
  audit: AuditEntry[];
  /** 演示用：模拟某瓶正在泄漏（压力持续下降） */
  simLeak: Record<string, boolean>;
}
