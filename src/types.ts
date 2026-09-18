// 潜水气瓶充填 —— 领域模型（气源批次 / 工单 / 泄漏事故）

export type OrderStatus =
  | "queued" // 待充填（已排班，未开工）
  | "suspended" // 气源冻结，未开工单停止排班
  | "filling" // 充填进行中
  | "held" // 应急闭锁后转待检（只保留已记录压力，禁止签收）
  | "recheck" // 主管复位合格，等待逐瓶重验
  | "completed" // 充填完成待签收
  | "signed" // 已签收
  | "rejected"; // 重验不合格，停用

export type BatchStatus =
  | "open" // 正常供气
  | "frozen" // 泄漏事故应急冻结
  | "released" // 主管泄漏检查合格并复位
  | "condemned"; // 首次检查不合格，气源停用

export type Mix = "空气" | "高氧" | "Trimix";

export type TriggerReason = "pressure-drop" | "estop";

export interface PressurePoint {
  t: number;
  p: number; // bar
}

export interface HistoryEntry {
  t: number;
  event: string;
}

export interface GasBatch {
  id: string;
  name: string;
  mix: Mix;
  status: BatchStatus;
  frozenAt?: number;
  incidentId?: string; // 当前/最近关联的泄漏事故
}

export interface Order {
  id: string;
  tankNo: string;
  volume: string;
  inspectUntil: string; // ISO 日期，检验有效期
  residualPressure: number; // 残压 bar
  targetPressure: number; // 目标压力 bar
  currentPressure: number; // 最近记录压力 bar
  oxygen: number; // 氧含量 %
  helium: number; // 氦含量 %
  mix: Mix;
  operator: string;
  batchId: string;
  status: OrderStatus;
  pressureLog: PressurePoint[];
  history: HistoryEntry[];
  dropStreak: number; // 压力连续下降计数（泄漏判定）
  leakSimulation: boolean; // 演练开关：模拟充填中泄漏
  frozenPressure?: number; // 闭锁瞬间冻结保留的压力
  stopReason?: TriggerReason;
  signedBy?: string;
  signedAt?: number;
}

export interface IncidentTrigger {
  t: number;
  reason: TriggerReason;
  orderId: string;
  pressure: number;
}

export interface Finding {
  inspector: string;
  result: "pass" | "fail";
  note: string;
  at: number;
}

export interface ResetRecord {
  t: number;
  inspector: string;
  result: "pass" | "fail";
  note: string;
  reused: boolean; // true = 同一事故重复复位，沿用首次结果
}

export type IncidentState = "active" | "reset" | "reopened" | "failed";

export interface Incident {
  id: string;
  batchId: string;
  orderIds: string[]; // 受影响工单（冻结时在该气源上的全部工单）
  openedAt: number;
  triggers: IncidentTrigger[];
  firstFinding?: Finding; // 首次泄漏检查结果，永久不可修改
  resets: ResetRecord[];
  state: IncidentState;
}

export interface AppState {
  batches: GasBatch[];
  orders: Order[];
  incidents: Incident[];
  seq: { order: number; incident: number };
}

export const STATUS_LABEL: Record<OrderStatus, string> = {
  queued: "待充填",
  suspended: "停止排班",
  filling: "充填中",
  held: "待检·闭锁",
  recheck: "待重验",
  completed: "待签收",
  signed: "已签收",
  rejected: "重验停用",
};

export const BATCH_STATUS_LABEL: Record<BatchStatus, string> = {
  open: "正常",
  frozen: "已冻结",
  released: "已复位",
  condemned: "停用",
};
