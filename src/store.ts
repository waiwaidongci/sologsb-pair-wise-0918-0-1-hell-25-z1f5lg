import type {
  AuditEntry,
  Batch,
  FillMode,
  Incident,
  Order,
  OrderStatus,
  State,
} from "./types";

// ---------- 工具 ----------

let seq = 0;
export function uid(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq}${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}

export function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function fmtTime(t: number): string {
  const d = new Date(t);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function fmtDateTime(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

/** 距检验有效期天数（负数为已过期） */
export function daysUntil(iso: string): number {
  const end = new Date(iso + "T23:59:59").getTime();
  return Math.ceil((end - Date.now()) / 86400000);
}

export function mixHint(mode: FillMode, o2: number, he: number): string {
  const n2 = Math.max(0, 100 - o2 - he);
  if (mode === "空气") return `空气配比基准：O₂ 21% / N₂ 79%，当前填写 O₂ ${o2}%`;
  if (mode === "高氧")
    return `EAN${o2}：O₂ ${o2}% / N₂ ${n2}%，注意氧暴露极限与氧清洗`;
  return `Trimix ${o2}/${he}：O₂ ${o2}% / He ${he}% / N₂ ${n2}%，按最大深度核 MOD`;
}

// ---------- 初始演示数据 ----------

const now = Date.now();
const day = 86400000;

function iso(offsetDays: number): string {
  const d = new Date(now + offsetDays * day);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const seedBatch1: Batch = {
  id: "BAT-AIR-01",
  name: "BAT-AIR-20260918-A",
  kind: "空气",
  o2: 21,
  he: 0,
  status: "active",
  createdAt: now - 6 * day,
};

const seedBatch2: Batch = {
  id: "BAT-EAN-01",
  name: "BAT-EAN32-20260918-B",
  kind: "高氧",
  o2: 32,
  he: 0,
  status: "active",
  createdAt: now - 2 * day,
};

const seedBatch3: Batch = {
  id: "BAT-TRI-01",
  name: "BAT-TMX2135-20260917-C",
  kind: "Trimix",
  o2: 21,
  he: 35,
  status: "active",
  createdAt: now - 3 * day,
};

function mkOrder(
  p: Partial<Order> & Pick<Order, "id" | "tankNo" | "volume" | "fillMode">
): Order {
  return {
    inspectUntil: iso(120),
    residual: 30,
    target: 200,
    o2: 21,
    he: 0,
    operator: "阿文",
    batchId: null,
    status: "queued",
    pressure: p.residual ?? 30,
    pressureLog: [],
    dropStreak: 0,
    frozenAt: null,
    incidents: [],
    reverifies: {},
    signoff: null,
    createdAt: now - day,
    ...p,
  };
}

const seedOrders: Order[] = [
  mkOrder({
    id: "WO-204",
    tankNo: "TANK-204",
    volume: "12L 铝瓶",
    inspectUntil: iso(12),
    residual: 55,
    pressure: 55,
    fillMode: "空气",
    o2: 21,
    batchId: seedBatch1.id,
  }),
  mkOrder({
    id: "WO-219",
    tankNo: "TANK-219",
    volume: "11L 钢瓶",
    inspectUntil: iso(90),
    residual: 40,
    fillMode: "高氧",
    o2: 32,
    batchId: seedBatch2.id,
    status: "filled",
    pressure: 200,
    pressureLog: [
      { t: now - 3 * 3600000, bar: 40 },
      { t: now - 2 * 3600000, bar: 120 },
      { t: now - 3600000, bar: 200 },
    ],
  }),
  mkOrder({
    id: "WO-231",
    tankNo: "TANK-231",
    volume: "双瓶组 2×12L",
    inspectUntil: iso(9),
    residual: 20,
    pressure: 20,
    fillMode: "Trimix",
    o2: 21,
    he: 35,
    batchId: seedBatch3.id,
  }),
  mkOrder({
    id: "WO-245",
    tankNo: "TANK-245",
    volume: "15L 钢瓶",
    inspectUntil: iso(-4),
    residual: 0,
    pressure: 0,
    fillMode: "空气",
    o2: 21,
    batchId: seedBatch1.id,
  }),
  mkOrder({
    id: "WO-207",
    tankNo: "TANK-207",
    volume: "12L 铝瓶",
    inspectUntil: iso(200),
    residual: 60,
    fillMode: "空气",
    o2: 21,
    operator: "老周",
    status: "signed",
    pressure: 210,
    target: 210,
    batchId: seedBatch1.id,
    pressureLog: [
      { t: now - 5 * day, bar: 60 },
      { t: now - 5 * day + 1800000, bar: 140 },
      { t: now - 5 * day + 3600000, bar: 210 },
    ],
    signoff: { by: "客户 陈先生", at: now - 4 * day },
  }),
];

const seedAudit: AuditEntry[] = [
  {
    id: "A-SEED-1",
    t: now - 5 * day,
    kind: "success",
    text: "TANK-207 充填完成并由客户签收（210 bar）",
    tankNo: "TANK-207",
  },
  {
    id: "A-SEED-2",
    t: now - 3 * 3600000,
    kind: "success",
    text: "TANK-219 高氧充填至 200 bar，等待签收",
    tankNo: "TANK-219",
  },
  {
    id: "A-SEED-3",
    t: now - day,
    kind: "info",
    text: "气源批次 BAT-AIR-20260918-A 建档并投入使用",
  },
];

export const initialState: State = {
  batches: [seedBatch1, seedBatch2, seedBatch3],
  orders: seedOrders,
  incidents: [],
  audit: seedAudit,
  simLeak: {},
};

// ---------- Actions ----------

export type Action =
  | { type: "TICK"; now: number }
  | { type: "TOGGLE_SIM_LEAK"; orderId: string }
  | { type: "ESTOP"; now: number }
  | {
      type: "NEW_ORDER";
      now: number;
      data: {
        tankNo: string;
        volume: string;
        inspectUntil: string;
        residual: number;
        target: number;
        o2: number;
        he: number;
        fillMode: FillMode;
        operator: string;
      };
    }
  | {
      type: "NEW_BATCH";
      now: number;
      data: { name: string; kind: FillMode; o2: number; he: number };
    }
  | { type: "START_FILL"; orderId: string; now: number }
  | { type: "SIGNOFF"; orderId: string; by: string; now: number }
  | {
      type: "REVERIFY";
      orderId: string;
      incidentId: string;
      pass: boolean;
      supervisor: string;
      note: string;
      now: number;
    }
  | {
      type: "RESET_INCIDENT";
      incidentId: string;
      supervisor: string;
      note: string;
      leakFound: boolean;
      now: number;
    }
  | { type: "RESET_DEMO" };

// ---------- 闭锁判定 ----------

export function openIncident(state: State): Incident | undefined {
  return state.incidents.find((i) => i.status === "lockout");
}

export function isLocked(state: State, batchId: string | null): boolean {
  if (!batchId) return false;
  return state.incidents.some(
    (i) => i.status === "lockout" && i.batchIds.includes(batchId)
  );
}

// ---------- Reducer ----------

function pushAudit(
  list: AuditEntry[],
  kind: AuditEntry["kind"],
  text: string,
  tankNo?: string,
  t = Date.now()
): AuditEntry[] {
  return [{ id: uid("A"), t, kind, text, tankNo }, ...list].slice(0, 400);
}

/**
 * 触发应急闭锁：冻结指定气源批次、充填中工单转待检，
 * 仅保留其最后已记录压力；其余批次/工单不受影响。
 * 若同气源此前已有事故（即便已关闭后复发），重开为同一事故：
 * 首次泄漏检查结果与逐瓶首次重验结果继续沿用，不得改判。
 */
function triggerLockout(
  state: State,
  batchIds: string[],
  reason: Incident["reason"],
  detail: string,
  now: number
): Incident {
  const ids = Array.from(new Set(batchIds));
  const affected = state.orders
    .filter((o) => o.batchId && ids.includes(o.batchId) && o.status === "filling")
    .map((o) => o.id);

  // 同气源的最近一起事故视为同一事故复发
  const prior = state.incidents.find((i) =>
    i.batchIds.some((bid) => ids.includes(bid))
  );

  let incident: Incident;
  if (prior) {
    // 重开既有事故：resetResult 与各瓶 reverifies 原样保留
    incident = prior;
    prior.status = "lockout";
    prior.closedAt = null;
    ids.forEach((id) => {
      if (!prior.batchIds.includes(id)) prior.batchIds.push(id);
    });
    prior.detail = detail;
  } else {
    incident = {
      id: uid("INC"),
      reason,
      detail,
      batchIds: ids,
      affectedOrderIds: [],
      startedAt: now,
      status: "lockout",
      resetResult: null,
      resetCount: 0,
      closedAt: null,
    };
    state.incidents.unshift(incident);
  }

  state.batches.forEach((b) => {
    if (ids.includes(b.id)) b.status = "frozen";
  });

  state.orders.forEach((o) => {
    if (affected.includes(o.id)) {
      o.status = "inspection";
      o.frozenAt = now;
      // 每次复发冻结都追加事故标记，用于识别重复波及
      o.incidents.push(incident.id);
      if (!incident.affectedOrderIds.includes(o.id)) {
        incident.affectedOrderIds.push(o.id);
      }
      // 只保留已记录压力：pressure 与 pressureLog 不再改写
    }
  });

  // 停止演示泄漏，避免复位前重复跳变
  ids.forEach((bid) => {
    state.orders
      .filter((o) => o.batchId === bid)
      .forEach((o) => {
        delete state.simLeak[o.id];
        if (!affected.includes(o.id)) o.dropStreak = 0;
      });
  });

  if (prior) {
    state.incidents = [
      prior,
      ...state.incidents.filter((i) => i.id !== prior.id),
    ];
  }

  const tankNos = state.orders
    .filter((o) => affected.includes(o.id))
    .map((o) => o.tankNo)
    .join("、");

  state.audit = pushAudit(
    state.audit,
    "danger",
    `${prior ? `事故 ${prior.id.slice(-5).toUpperCase()} 复发闭锁` : "应急闭锁"}（${
      reason === "leak" ? "压力持续下降" : "手动急停"
    }）：冻结气源 ${ids
      .map((id) => state.batches.find((b) => b.id === id)?.name ?? id)
      .join("、")}；${
      tankNos ? `在充瓶 ${tankNos} 转待检，` : ""
    }未开工单停止排班，禁止签收${
      prior ? "；重复复位将沿用首次泄漏检查结果" : ""
    }`,
    undefined,
    now
  );

  return incident;
}

export function reducer(prev: State, action: Action): State {
  switch (action.type) {
    case "RESET_DEMO":
      return structuredClone(initialState);

    case "TOGGLE_SIM_LEAK": {
      const state = structuredClone(prev);
      const order = state.orders.find((o) => o.id === action.orderId);
      if (!order || order.status !== "filling") return prev;
      if (state.simLeak[order.id]) {
        delete state.simLeak[order.id];
        order.dropStreak = 0;
        state.audit = pushAudit(
          state.audit,
          "info",
          `${order.tankNo} 取消模拟泄漏`,
          order.tankNo
        );
      } else {
        state.simLeak[order.id] = true;
        state.audit = pushAudit(
          state.audit,
          "warn",
          `${order.tankNo} 开启模拟泄漏（连续 3 次压力下降将自动闭锁）`,
          order.tankNo
        );
      }
      return state;
    }

    case "START_FILL": {
      const state = structuredClone(prev);
      const order = state.orders.find((o) => o.id === action.orderId);
      if (!order || order.status !== "queued" || !order.batchId) return prev;
      const batch = state.batches.find((b) => b.id === order.batchId);
      // 仅冻结气源的未开工单停止排班；其他气源批次不受事故株连
      if (!batch || isLocked(state, batch.id)) return prev;
      if (daysUntil(order.inspectUntil) < 0) return prev; // 过期瓶不得开工
      order.status = "filling";
      order.pressure = order.residual;
      order.pressureLog = [{ t: action.now, bar: order.residual }];
      state.audit = pushAudit(
        state.audit,
        "info",
        `${order.tankNo} 开始${order.fillMode}充填（气源 ${batch.name}），起始 ${order.residual} bar`,
        order.tankNo,
        action.now
      );
      return state;
    }

    case "TICK": {
      const filling = prev.orders.filter((o) => o.status === "filling");
      if (filling.length === 0) return prev;
      const state = structuredClone(prev);
      const leakBatchIds = new Set<string>();

      state.orders.forEach((o) => {
        if (o.status !== "filling" || !o.batchId) return;
        if (state.simLeak[o.id]) {
          // 压力持续下降
          const next = Math.max(0, o.pressure - 6);
          o.pressure = next;
          o.pressureLog.push({ t: action.now, bar: next });
          o.dropStreak += 1;
          if (o.dropStreak >= 3) {
            leakBatchIds.add(o.batchId);
            o.dropStreak = 0;
          }
        } else {
          o.dropStreak = 0;
          if (o.pressure >= o.target) return;
          const next = Math.min(o.target, o.pressure + 8);
          o.pressure = next;
          o.pressureLog.push({ t: action.now, bar: next });
          if (next >= o.target) {
            o.status = "filled";
            state.audit = pushAudit(
              state.audit,
              "success",
              `${o.tankNo} 充填达到目标 ${o.target} bar，等待签收`,
              o.tankNo,
              action.now
            );
          }
        }
      });

      if (leakBatchIds.size > 0) {
        triggerLockout(
          state,
          [...leakBatchIds],
          "leak",
          "充填压力连续 3 个采样点持续下降，判定为充填泄漏",
          action.now
        );
      }
      return state;
    }

    case "ESTOP": {
      const state = structuredClone(prev);
      const filling = state.orders.filter((o) => o.status === "filling");
      if (filling.length === 0) return prev;
      triggerLockout(
        state,
        filling.map((o) => o.batchId as string),
        "estop",
        "操作员按下手动急停按钮",
        action.now
      );
      return state;
    }

    case "NEW_ORDER": {
      const state = structuredClone(prev);
      const d = action.data;
      // 按充填方式为新单推荐可用气源
      const batch = state.batches.find(
        (b) => b.status === "active" && b.kind === d.fillMode
      );
      const order: Order = {
        id: uid("WO"),
        tankNo: d.tankNo,
        volume: d.volume,
        inspectUntil: d.inspectUntil,
        residual: d.residual,
        target: d.target,
        o2: d.o2,
        he: d.he,
        fillMode: d.fillMode,
        operator: d.operator,
        batchId: batch?.id ?? null,
        status: "queued",
        pressure: d.residual,
        pressureLog: [],
        dropStreak: 0,
        frozenAt: null,
        incidents: [],
        reverifies: {},
        signoff: null,
        createdAt: action.now,
      };
      state.orders.unshift(order);
      state.audit = pushAudit(
        state.audit,
        "info",
        `新工单 ${d.tankNo}（${d.fillMode}，残压 ${d.residual} bar）排入待充填队列${
          batch ? `，气源 ${batch.name}` : "，暂无匹配气源"
        }`,
        d.tankNo,
        action.now
      );
      return state;
    }

    case "NEW_BATCH": {
      const state = structuredClone(prev);
      const b: Batch = {
        id: uid("BAT"),
        name: action.data.name,
        kind: action.data.kind,
        o2: action.data.o2,
        he: action.data.he,
        status: "active",
        createdAt: action.now,
      };
      state.batches.unshift(b);
      state.audit = pushAudit(
        state.audit,
        "info",
        `气源批次 ${b.name}（${b.kind} O₂ ${b.o2}%${
          b.he ? ` / He ${b.he}%` : ""
        }）建档`,
        undefined,
        action.now
      );
      return state;
    }

    case "SIGNOFF": {
      const state = structuredClone(prev);
      const order = state.orders.find((o) => o.id === action.orderId);
      if (!order || order.status !== "filled") return prev;
      // 该瓶所属气源处于闭锁冻结时不得签收
      if (isLocked(state, order.batchId)) return prev;
      order.status = "signed";
      order.signoff = { by: action.by, at: action.now };
      state.audit = pushAudit(
        state.audit,
        "success",
        `${order.tankNo} 完成签收（${order.pressure} bar，签收人 ${action.by}）`,
        order.tankNo,
        action.now
      );
      return state;
    }

    case "REVERIFY": {
      const state = structuredClone(prev);
      const order = state.orders.find((o) => o.id === action.orderId);
      const incident = state.incidents.find((i) => i.id === action.incidentId);
      if (!order || !incident || incident.status !== "lockout") return prev;
      // 主管先完成泄漏检查并复位后，才允许逐瓶重验
      if (!incident.resetResult || incident.resetResult.leakFound) return prev;

      if (!order.reverifies[incident.id]) {
        // 记录首次结论；同一事故之后重复复位/复发，原样沿用，不允许改判
        order.reverifies[incident.id] = {
          pass: action.pass,
          supervisor: action.supervisor,
          note: action.note,
          at: action.now,
        };
      }
      const r = order.reverifies[incident.id];
      if (r.pass) {
        // 合格：逐瓶重验通过，工单回队列重验后恢复（从已记录残压重新充填）
        order.status = "queued";
        order.frozenAt = null;
        order.dropStreak = 0;
        state.audit = pushAudit(
          state.audit,
          "success",
          `${order.tankNo} 逐瓶重验合格（${r.supervisor}）：${
            r.note || "无备注"
          }，回待充填队列恢复`,
          order.tankNo,
          action.now
        );
      } else {
        // 不合格：转隔离，不得恢复充填与签收
        order.status = "quarantined";
        order.frozenAt = null;
        state.audit = pushAudit(
          state.audit,
          "danger",
          `${order.tankNo} 逐瓶重验不合格（${r.supervisor}）：${
            r.note || "无备注"
          }，气瓶隔离，禁止充填与签收`,
          order.tankNo,
          action.now
        );
      }
      maybeCloseIncident(state, incident, action.now);
      return state;
    }

    case "RESET_INCIDENT": {
      const state = structuredClone(prev);
      const incident = state.incidents.find((i) => i.id === action.incidentId);
      if (!incident || incident.status !== "lockout") return prev;
      if (!action.supervisor.trim()) return prev;

      if (!incident.resetResult) {
        // 首次泄漏检查结果固化
        incident.resetResult = {
          leakFound: action.leakFound,
          supervisor: action.supervisor,
          note: action.note,
          at: action.now,
        };
      }
      // 重复复位沿用首次结果（含首次主管与备注）
      const r = incident.resetResult;
      incident.resetCount += 1;
      const repeated = incident.resetCount > 1;

      if (r.leakFound) {
        state.audit = pushAudit(
          state.audit,
          "warn",
          `事故 ${incident.id.slice(-5).toUpperCase()} 第 ${
            incident.resetCount
          } 次复位（主管 ${r.supervisor}）：泄漏检查发现泄漏，气源批次${
            repeated ? "维持冻结，沿用首次检查结果" : "保持冻结，排除泄漏后请再次申请复位"
          }`,
          undefined,
          action.now
        );
        return state;
      }

      // 检查合格：解除气源冻结
      state.batches.forEach((b) => {
        if (incident.batchIds.includes(b.id)) b.status = "active";
      });

      // 重复复位：已重验过的气瓶自动沿用首次逐瓶结论，不再要求重验
      if (repeated) {
        state.orders.forEach((o) => {
          const rv = o.reverifies[incident.id];
          if (
            rv &&
            o.status === "inspection" &&
            o.incidents.filter((x) => x === incident.id).length >= 2
          ) {
            if (rv.pass) o.status = "queued";
            else o.status = "quarantined";
            o.frozenAt = null;
          }
        });
      }

      state.audit = pushAudit(
        state.audit,
        "success",
        `事故 ${incident.id.slice(-5).toUpperCase()} 第 ${
          incident.resetCount
        } 次复位（主管 ${r.supervisor}）：泄漏检查合格，气源解冻${
          repeated
            ? "，沿用首次检查结果；已重验气瓶自动沿用首次结论"
            : "，请对受影响气瓶逐瓶重验"
        }`,
        undefined,
        action.now
      );

      maybeCloseIncident(state, incident, action.now);
      return state;
    }

    default:
      return prev;
  }
}

/**
 * 事故关闭条件：主管完成泄漏检查并复位（合格、气源解冻），
 * 且受影响气瓶全部完成逐瓶重验（合格回队列 / 不合格隔离）。
 */
function maybeCloseIncident(state: State, incident: Incident, now: number): void {
  if (!incident.resetResult || incident.resetResult.leakFound) return;
  const batchFrozen = state.batches.some(
    (b) => incident.batchIds.includes(b.id) && b.status === "frozen"
  );
  if (batchFrozen) return;
  const pending = state.orders.some(
    (o) =>
      incident.affectedOrderIds.includes(o.id) && o.status === "inspection"
  );
  if (!pending) {
    incident.status = "closed";
    incident.closedAt = now;
    state.audit = pushAudit(
      state.audit,
      "success",
      `事故 ${incident.id.slice(-5).toUpperCase()} 受影响气瓶全部完成逐瓶重验，事故关闭，作业恢复正常`,
      undefined,
      now
    );
  }
}

// ---------- 派生数据 ----------

export function selectStats(state: State) {
  const queued = state.orders.filter(
    (o) => o.status === "queued" || o.status === "filling"
  ).length;
  const expired = state.orders.filter(
    (o) =>
      o.status !== "signed" &&
      o.status !== "quarantined" &&
      daysUntil(o.inspectUntil) <= 15
  ).length;
  const active = state.orders.filter((o) => o.status !== "signed");
  const avgO2 = active.length
    ? Math.round(active.reduce((s, o) => s + o.o2, 0) / active.length)
    : 0;
  const signed = state.orders.filter((o) => o.status === "signed").length;
  return { queued, expired, avgO2, signed };
}

export type { OrderStatus };
