import type {
  AppState,
  BatchStatus,
  Incident,
  Mix,
  Order,
  OrderStatus,
  TriggerReason,
} from "./types";

const STORAGE_KEY = "dive-fill-lockout-v1";

// ---------------- 初始演示数据 ----------------

function iso(daysFromNow: number): string {
  const d = new Date("2026-09-18T00:00:00");
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}

export function seedState(): AppState {
  const now = Date.now();
  const batches = [
    { id: "B-AIR", name: "空气气源 #1", mix: "空气" as Mix, status: "open" as BatchStatus },
    { id: "B-EAN", name: "高氧气源 #2", mix: "高氧" as Mix, status: "open" as BatchStatus },
    { id: "B-TMX", name: "Trimix 气源 #3", mix: "Trimix" as Mix, status: "open" as BatchStatus },
  ];
  const mk = (
    partial: Partial<Order> & { id: string; tankNo: string; batchId: string; mix: Mix }
  ): Order => ({
    volume: "12L铝瓶",
    inspectUntil: iso(180),
    residualPressure: 50,
    targetPressure: 200,
    currentPressure: partial.residualPressure ?? 50,
    oxygen: partial.mix === "高氧" ? 32 : partial.mix === "Trimix" ? 18 : 21,
    helium: partial.mix === "Trimix" ? 35 : 0,
    operator: "林深",
    status: "queued",
    pressureLog: [],
    history: [{ t: now, event: "工单已创建并排入待充填队列" }],
    dropStreak: 0,
    leakSimulation: false,
    ...partial,
  });
  const orders: Order[] = [
    mk({
      id: "WO-1001",
      tankNo: "TANK-204",
      batchId: "B-AIR",
      mix: "空气",
      volume: "12L铝瓶",
      residualPressure: 55,
      currentPressure: 55,
      operator: "林深",
    }),
    mk({
      id: "WO-1002",
      tankNo: "TANK-219",
      batchId: "B-EAN",
      mix: "高氧",
      volume: "11L钢瓶",
      oxygen: 32,
      residualPressure: 60,
      currentPressure: 200,
      status: "completed",
      operator: "阿海",
      history: [
        { t: now - 3600_000, event: "工单已创建并排入待充填队列" },
        { t: now - 1800_000, event: "开始充填（气源 高氧气源 #2）" },
        { t: now - 600_000, event: "充填完成，压力 200bar，等待客户签收" },
      ],
    }),
    mk({
      id: "WO-1003",
      tankNo: "TANK-231",
      batchId: "B-EAN",
      mix: "高氧",
      volume: "双瓶组 2×12L",
      oxygen: 36,
      inspectUntil: iso(12),
      operator: "阿海",
    }),
    mk({
      id: "WO-1004",
      tankNo: "TANK-188",
      batchId: "B-TMX",
      mix: "Trimix",
      volume: "11.1L钢瓶",
      oxygen: 18,
      helium: 45,
      operator: "林深",
    }),
    mk({
      id: "WO-1005",
      tankNo: "TANK-240",
      batchId: "B-AIR",
      mix: "空气",
      volume: "12L钢瓶",
      inspectUntil: iso(-4),
      operator: "林深",
    }),
    mk({
      id: "WO-1006",
      tankNo: "TANK-212",
      batchId: "B-TMX",
      mix: "Trimix",
      volume: "12L铝瓶",
      oxygen: 21,
      helium: 30,
      operator: "阿海",
    }),
  ];
  return {
    batches,
    orders,
    incidents: [],
    seq: { order: 1007, incident: 1 },
  };
}

export function loadState(): AppState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as AppState;
  } catch {
    /* 数据损坏时回落到演示数据 */
  }
  return seedState();
}

export function saveState(state: AppState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* 存储不可用时静默 */
  }
}

// ---------------- 工具 ----------------

function log(order: Order, event: string, t = Date.now()): Order {
  return { ...order, history: [...order.history, { t, event }] };
}

// ---------------- 泄漏判定与应急闭锁 ----------------

// 压力连续 3 次下降即判定充填泄漏
export const DROP_LIMIT = 3;

/**
 * 触发应急闭锁（自动泄漏检测 / 手动急停共用同一处置流程）：
 * 1. 立即冻结当前气源批次；
 * 2. 该气源上未开工单停止排班（queued → suspended）；
 * 3. 进行中气瓶全部转待检（filling → held），只保留已记录压力，禁止签收；
 * 4. 同一气源的事故重复触发则重开同一事故，沿用首次检查结果。
 */
export function triggerLockout(
  state: AppState,
  batchId: string,
  reason: TriggerReason,
  t = Date.now()
): AppState {
  const batch = state.batches.find((b) => b.id === batchId);
  if (!batch) return state;

  // 已判定停用（首次检查不合格）的气源不再允许充填触发
  if (batch.status === "condemned") return state;

  // 气源已冻结：登记一次新的触发，若事故曾复位则重开
  const existing = state.incidents.find((i) => i.batchId === batchId);
  let incident: Incident;
  let incidents: Incident[];
  const fillingOrders = state.orders.filter((o) => o.batchId === batchId && o.status === "filling");

  if (existing) {
    incident = {
      ...existing,
      state:
        existing.state === "active" ? "active" : "reopened",
      triggers: [
        ...existing.triggers,
        ...fillingOrders.map((o) => ({
          t,
          reason,
          orderId: o.id,
          pressure: o.currentPressure,
        })),
      ],
      orderIds: Array.from(
        new Set([
          ...existing.orderIds,
          ...state.orders
            .filter(
              (o) =>
                o.batchId === batchId &&
                (o.status === "filling" || o.status === "held" || o.status === "recheck")
            )
            .map((o) => o.id),
        ])
      ),
    };
    incidents = state.incidents.map((i) => (i.id === incident.id ? incident : i));
  } else {
    const id = `INC-${String(state.seq.incident).padStart(3, "0")}`;
    incident = {
      id,
      batchId,
      openedAt: t,
      state: "active",
      triggers: fillingOrders.map((o) => ({
        t,
        reason,
        orderId: o.id,
        pressure: o.currentPressure,
      })),
      resets: [],
      orderIds: state.orders
        .filter((o) => o.batchId === batchId && (o.status === "filling" || o.status === "queued"))
        .map((o) => o.id),
    };
    incidents = [...state.incidents, incident];
  }

  const triggerText =
    reason === "estop"
      ? "操作员手动急停，立即执行应急闭锁"
      : "充填中压力持续下降，自动判定泄漏并应急闭锁";

  const orders = state.orders.map((o) => {
    if (o.batchId !== batchId) return o;
    if (o.status === "filling") {
      const next = {
        ...o,
        status: "held" as OrderStatus,
        leakSimulation: false,
        stopReason: reason,
        frozenPressure: o.currentPressure,
        dropStreak: 0,
      };
      return log(
        next,
        `${triggerText}：气源批次冻结，本瓶转待检，保留压力 ${o.currentPressure}bar，禁止签收`
      );
    }
    if (o.status === "queued") {
      const next = { ...o, status: "suspended" as OrderStatus };
      return log(next, "气源批次应急冻结，未开工单停止排班");
    }
    if (o.status === "recheck") {
      const next = { ...o, status: "held" as OrderStatus };
      return log(next, "事故重开，本瓶重新转待检，保留压力、禁止签收");
    }
    return o;
  });

  const batches = state.batches.map((b) =>
    b.id === batchId
      ? { ...b, status: "frozen" as BatchStatus, frozenAt: b.frozenAt ?? t, incidentId: incident.id }
      : b
  );

  return {
    ...state,
    batches,
    orders,
    incidents,
    seq: existing ? state.seq : { ...state.seq, incident: state.seq.incident + 1 },
  };
}

/**
 * 充填节拍：每个充填中工单采样一次压力。
 * - 正常：压力上升；演练泄漏时压力下降；
 * - 连续下降达到阈值 → 自动触发闭锁；
 * - 达到目标压力 → 完成待签收（冻结批次上不允许出现新的完成单）。
 */
export function tickFilling(state: AppState, t = Date.now()): AppState {
  if (!state.orders.some((o) => o.status === "filling")) return state;

  let next: AppState = { ...state, orders: [...state.orders] };
  const autoLockedBatches = new Set<string>();

  next.orders = next.orders.map((o) => {
    if (o.status !== "filling") return o;
    const batch = next.batches.find((b) => b.id === o.batchId);
    if (!batch || batch.status !== "open") return o;

    const leak = o.leakSimulation;
    const delta = leak ? -(4 + Math.round(Math.random() * 4)) : 5 + Math.round(Math.random() * 3);
    const pressure = Math.max(0, o.currentPressure + delta);
    const dropStreak = delta < 0 ? o.dropStreak + 1 : 0;
    const pressureLog = [
      ...o.pressureLog,
      { t, p: pressure },
    ].slice(-120);

    let updated: Order = { ...o, currentPressure: pressure, pressureLog, dropStreak };
    if (dropStreak >= DROP_LIMIT) {
      autoLockedBatches.add(o.batchId);
    } else if (!leak && pressure >= o.targetPressure) {
      updated = log(
        { ...updated, currentPressure: o.targetPressure, dropStreak: 0 },
        `充填完成，压力 ${o.targetPressure}bar，等待客户签收`
      );
      updated = { ...updated, status: "completed" };
    }
    return updated;
  });

  for (const batchId of autoLockedBatches) {
    next = triggerLockout(next, batchId, "pressure-drop", t);
  }
  return next;
}

// ---------------- 工单操作 ----------------

export function startFilling(state: AppState, orderId: string, t = Date.now()): AppState {
  const order = state.orders.find((o) => o.id === orderId);
  if (!order || order.status !== "queued") return state;
  const batch = state.batches.find((b) => b.id === order.batchId);
  if (!batch || batch.status !== "open") return state;

  const startPressure = order.currentPressure;
  return {
    ...state,
    orders: state.orders.map((o) =>
      o.id === orderId
        ? log(
            {
              ...o,
              status: "filling",
              currentPressure: startPressure,
              pressureLog: [...o.pressureLog, { t, p: startPressure }],
            },
            `开始充填（气源 ${batch.name}）`
          )
        : o
    ),
  };
}

export function toggleLeakSim(state: AppState, orderId: string): AppState {
  return {
    ...state,
    orders: state.orders.map((o) =>
      o.id === orderId && o.status === "filling"
        ? { ...o, leakSimulation: !o.leakSimulation }
        : o
    ),
  };
}

/**
 * 主管完成泄漏检查并复位：
 * - 首次结果永久记录：合格 → 气源复位（已冻结压力保留），held 气瓶转逐瓶重验；
 *   不合格 → 气源停用（不恢复）；
 * - 同一事故重复复位（事故重开后再次检查）→ 沿用首次结果，不可更改。
 */
export function supervisorReset(
  state: AppState,
  incidentId: string,
  input: { inspector: string; note: string; result?: "pass" | "fail" },
  t = Date.now()
): AppState {
  const inc = state.incidents.find((i) => i.id === incidentId);
  if (!inc || inc.state === "reset" || inc.state === "failed") return state;
  const inspector = input.inspector.trim();
  if (!inspector) return state;

  const isRepeat = Boolean(inc.firstFinding);
  const result = isRepeat ? inc.firstFinding!.result : input.result ?? "pass";
  const note = isRepeat
    ? `同一事故重复复位，沿用首次检查结果（${inc.firstFinding!.result === "pass" ? "合格" : "不合格"} · ${inc.firstFinding!.inspector}）`
    : input.note.trim();

  const finding = isRepeat
    ? inc.firstFinding!
    : { inspector, result, note, at: t };

  const incident: Incident = {
    ...inc,
    firstFinding: finding,
    state: result === "pass" ? "reset" : "failed",
    resets: [
      ...inc.resets,
      { t, inspector, result, note, reused: isRepeat },
    ],
  };

  const incidents = state.incidents.map((i) => (i.id === incidentId ? incident : i));

  if (result === "fail") {
    // 不合格：气源保持停用状态，held 气瓶维持待检、不得签收
    const batches = state.batches.map((b) =>
      b.id === inc.batchId
        ? { ...b, status: "condemned" as BatchStatus }
        : b
    );
    const orders = state.orders.map((o) =>
      inc.orderIds.includes(o.id) && o.status === "held"
        ? log(o, `主管泄漏检查不合格（${inspector}）：气源停用，本瓶维持待检、不得签收`)
        : o
    );
    return { ...state, batches, orders, incidents };
  }

  // 合格：气源复位，held 气瓶进入逐瓶重验队列，suspended 工单恢复排班
  const batches = state.batches.map((b) =>
    b.id === inc.batchId ? { ...b, status: "released" as BatchStatus } : b
  );
  const orders = state.orders.map((o) => {
    if (o.batchId !== inc.batchId) return o;
    if (o.status === "held") {
      return log(
        { ...o, status: "recheck" as OrderStatus, frozenPressure: o.frozenPressure ?? o.currentPressure },
        `主管泄漏检查合格并复位（${inspector}），本瓶保留闭锁压力 ${o.frozenPressure ?? o.currentPressure}bar，等待逐瓶重验`
      );
    }
    if (o.status === "suspended") {
      return log({ ...o, status: "queued" as OrderStatus }, "气源已复位，工单恢复排班");
    }
    return o;
  });
  return { ...state, batches, orders, incidents };
}

/** 逐瓶重验：合格 → 回到待充填（基于冻结保留压力重新充填）；不合格 → 停用 */
export function recheckOrder(
  state: AppState,
  orderId: string,
  result: "pass" | "fail",
  t = Date.now()
): AppState {
  const order = state.orders.find((o) => o.id === orderId);
  if (!order || order.status !== "recheck") return state;

  if (result === "fail") {
    return {
      ...state,
      orders: state.orders.map((o) =>
        o.id === orderId ? log({ ...o, status: "rejected" as OrderStatus }, "逐瓶重验不合格，气瓶停用，不得签收") : o
      ),
    };
  }

  const batch = state.batches.find((b) => b.id === order.batchId);
  const pressure = order.frozenPressure ?? order.currentPressure;
  const otherRecheck = state.orders.filter(
    (x) => x.batchId === order.batchId && x.status === "recheck" && x.id !== orderId
  ).length;
  return {
    ...state,
    orders: state.orders.map((o) =>
      o.id === orderId
        ? log(
            { ...o, status: "queued" as OrderStatus, currentPressure: pressure },
            `逐瓶重验合格，按闭锁时保留压力 ${pressure}bar 重新排入待充填队列`
          )
        : o
    ),
    // 该气源上待重验气瓶全部通过后，气源恢复正常
    batches:
      batch && batch.status === "released" && otherRecheck === 0
        ? state.batches.map((b) => (b.id === batch.id ? { ...b, status: "open" as BatchStatus } : b))
        : state.batches,
  };
}

export function signOrder(state: AppState, orderId: string, customer: string, t = Date.now()): AppState {
  const order = state.orders.find((o) => o.id === orderId);
  if (!order || order.status !== "completed") return state;
  const batch = state.batches.find((b) => b.id === order.batchId);
  if (!batch || batch.status === "frozen" || batch.status === "condemned") return state;
  const name = customer.trim();
  if (!name) return state;
  return {
    ...state,
    orders: state.orders.map((o) =>
      o.id === orderId
        ? log({ ...o, status: "signed" as OrderStatus, signedBy: name, signedAt: t }, `客户 ${name} 签收完成`)
        : o
    ),
  };
}

export interface NewOrderInput {
  tankNo: string;
  volume: string;
  inspectUntil: string;
  residualPressure: number;
  targetPressure: number;
  oxygen: number;
  helium: number;
  mix: Mix;
  operator: string;
  batchId: string;
}

export function addOrder(state: AppState, input: NewOrderInput, t = Date.now()): AppState {
  const batch = state.batches.find((b) => b.id === input.batchId);
  if (!batch) return state;
  const id = `WO-${state.seq.order}`;
  // 冻结/停用气源上新建工单不允许排班
  const status: OrderStatus = batch.status === "open" || batch.status === "released" ? "queued" : "suspended";
  const order: Order = {
    id,
    tankNo: input.tankNo,
    volume: input.volume,
    inspectUntil: input.inspectUntil,
    residualPressure: input.residualPressure,
    currentPressure: input.residualPressure,
    targetPressure: input.targetPressure,
    oxygen: input.oxygen,
    helium: input.helium,
    mix: input.mix,
    operator: input.operator,
    batchId: input.batchId,
    status,
    pressureLog: [],
    history: [
      {
        t,
        event:
          status === "suspended"
            ? `工单已创建；气源 ${batch.name} 处于闭锁冻结，停止排班`
            : "工单已创建并排入待充填队列",
      },
    ],
    dropStreak: 0,
    leakSimulation: false,
  };
  return {
    ...state,
    orders: [order, ...state.orders],
    seq: { ...state.seq, order: state.seq.order + 1 },
  };
}

