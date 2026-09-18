import { useEffect, useMemo, useReducer, useState } from "react";
import type { Dispatch } from "react";
import "./styles.css";
import type {
  Batch,
  Incident,
  Order,
  OrderStatus,
  State,
} from "./types";
import type { Action } from "./store";
import {
  daysUntil,
  fmtDateTime,
  fmtTime,
  initialState,
  isLocked,
  openIncident,
  mixHint,
  reducer,
  selectStats,
} from "./store";

type StoreDispatch = Dispatch<Action>;

const project = {
  sourceNo: 5,
  id: "hxyfront-62010",
  port: 62010,
  title: "潜水气瓶充填记录",
  prompt:
    "气源批次 · 待充填队列 · 混合气比例提示 · 检验过期提醒 · 完成签收 · 单瓶历史 · 充填泄漏应急闭锁",
  metrics: ["待充填", "过期提醒", "平均氧含量", "签收单"],
  filters: ["全部", "空气", "高氧", "Trimix", "待检验"],
};

const STORAGE_KEY = "dive-fill-state-v1";

function loadState(): State {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as State;
      if (parsed && Array.isArray(parsed.orders) && Array.isArray(parsed.batches)) {
        return parsed;
      }
    }
  } catch {
    /* 忽略损坏缓存 */
  }
  return structuredClone(initialState);
}

// ---------- 小组件 ----------

const BADGE_CLASS: Record<OrderStatus, string> = {
  queued: "badge badge-queued",
  filling: "badge badge-filling",
  inspection: "badge badge-inspection",
  quarantined: "badge badge-quarantined",
  filled: "badge badge-filled",
  signed: "badge badge-signed",
};

const STATUS_TEXT: Record<OrderStatus, string> = {
  queued: "待充填",
  filling: "充填中",
  inspection: "待检",
  quarantined: "隔离",
  filled: "待签收",
  signed: "已签收",
};

function ExpiryTag({ iso }: { iso: string }) {
  const d = daysUntil(iso);
  if (d < 0) return <span className="tag tag-danger">检验已过期 {-d} 天</span>;
  if (d <= 15) return <span className="tag tag-warn">检验期剩余 {d} 天</span>;
  return <span className="tag tag-ok">检验有效（剩 {d} 天）</span>;
}

function PressureBar({ order }: { order: Order }) {
  const pct = Math.min(100, Math.round((order.pressure / Math.max(1, order.target)) * 100));
  const cls =
    order.status === "inspection"
      ? "bar bar-inspection"
      : order.status === "quarantined"
      ? "bar bar-quarantine"
      : "bar";
  return (
    <div className="pressure">
      <div className="pressure-head">
        <span>
          已记录压力 <b>{order.pressure}</b> / 目标 {order.target} bar
        </span>
        {order.status === "filling" && <span className="live-dot">实时</span>}
        {order.status === "inspection" && (
          <span className="lock-note">压力已冻结保留 · 禁止改写</span>
        )}
      </div>
      <div className="bar-track">
        <div className={cls} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// ---------- 应急闭锁面板（主管泄漏检查与复位） ----------

function IncidentPanel({
  state,
  incident,
  dispatch,
}: {
  state: State;
  incident: Incident;
  dispatch: StoreDispatch;
}) {
  const [supervisor, setSupervisor] = useState("");
  const [note, setNote] = useState("");

  const frozenBatches = state.batches.filter((b) =>
    incident.batchIds.includes(b.id)
  );
  const affected = state.orders.filter((o) =>
    incident.affectedOrderIds.includes(o.id)
  );
  const pending = affected.filter((o) => o.status === "inspection");
  const first = incident.resetResult;

  const reset = (leakFound: boolean) => {
    if (!supervisor.trim() && !first) return;
    dispatch({
      type: "RESET_INCIDENT",
      incidentId: incident.id,
      supervisor: supervisor.trim() || (first?.supervisor ?? ""),
      note,
      leakFound,
      now: Date.now(),
    });
    setNote("");
    setSupervisor("");
  };

  return (
    <section className="lockout" role="alert">
      <div className="lockout-head">
        <div>
          <p className="lockout-kicker">
            <span className="siren" /> 充填泄漏应急闭锁中 · 事故号{" "}
            {incident.id.slice(-6).toUpperCase()}
            {incident.resetCount > 0 && (
              <em>（已复位 {incident.resetCount} 次）</em>
            )}
          </p>
          <h2>
            {incident.reason === "leak" ? "充填压力持续下降" : "手动急停"}触发 ·
            气源批次已冻结
          </h2>
          <p className="lockout-detail">{incident.detail}</p>
        </div>
        <div className="lockout-meta">
          <div>
            <small>触发时间</small>
            <strong>{fmtDateTime(incident.startedAt)}</strong>
          </div>
          <div>
            <small>受影响气瓶</small>
            <strong>
              {affected.length} 只 · 待重验 {pending.length}
            </strong>
          </div>
        </div>
      </div>

      <ul className="lockout-rules">
        <li>冻结气源：{frozenBatches.map((b) => b.name).join("、")}</li>
        <li>在充气瓶 {affected.map((o) => o.tankNo).join("、") || "无"} 已转「待检」，仅保留已记录压力，禁止改写</li>
        <li>该气源未开工单停止排班、待签收工单不得签收；其他气源批次作业不受影响</li>
      </ul>

      <div className="reset-box">
        <h3>主管泄漏检查与复位</h3>
        {first ? (
          <div className="first-result">
            <span className={first.leakFound ? "tag tag-danger" : "tag tag-ok"}>
              首次检查：{first.leakFound ? "发现泄漏" : "检查合格"}
            </span>
            <span>
              主管 {first.supervisor} · {fmtDateTime(first.at)}
              {first.note ? ` · ${first.note}` : ""}
            </span>
            <p>
              同一事故重复复位沿用首次结果；逐瓶重验也沿用各瓶首次结论，不得改判。
              气源合格解冻后，工单须逐瓶重验通过才可恢复。
            </p>
            <div className="reset-actions">
              <button className="primary" onClick={() => reset(first.leakFound)}>
                再次复位（沿用首次结果：{first.leakFound ? "发现泄漏" : "检查合格"}）
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="reset-form">
              <label>
                <span>主管签名</span>
                <input
                  value={supervisor}
                  onChange={(e) => setSupervisor(e.target.value)}
                  placeholder="值班主管姓名"
                />
              </label>
              <label className="reset-note">
                <span>检查备注（管路 / 接头 / 阀密封）</span>
                <input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="记录泄漏检查情况"
                />
              </label>
            </div>
            <div className="reset-actions">
              <button
                className="primary"
                disabled={!supervisor.trim()}
                onClick={() => reset(false)}
              >
                检查合格 · 解冻复位
              </button>
              <button
                className="danger-btn"
                disabled={!supervisor.trim()}
                onClick={() => reset(true)}
              >
                发现泄漏 · 保持冻结
              </button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

// ---------- 逐瓶重验卡片操作 ----------

function ReverifyBox({
  order,
  incident,
  dispatch,
}: {
  order: Order;
  incident: Incident;
  dispatch: StoreDispatch;
}) {
  const [supervisor, setSupervisor] = useState("");
  const [note, setNote] = useState("");
  const existing = order.reverifies[incident.id];
  const repeat = (order.incidents.filter((x) => x === incident.id).length ?? 1) > 1;

  if (existing) {
    return (
      <div className="reverify">
        <span className={existing.pass ? "tag tag-ok" : "tag tag-danger"}>
          首次重验：{existing.pass ? "合格 · 已回队列恢复" : "不合格 · 已隔离"}
        </span>
        <span className="reverify-meta">
          {existing.supervisor} · {fmtDateTime(existing.at)}
          {existing.note ? ` · ${existing.note}` : ""}
        </span>
        {repeat && <em className="reuse-note">同一事故重复闭锁，沿用首次重验结果</em>}
      </div>
    );
  }

  const submit = (pass: boolean) => {
    if (!supervisor.trim()) return;
    dispatch({
      type: "REVERIFY",
      orderId: order.id,
      incidentId: incident.id,
      pass,
      supervisor: supervisor.trim(),
      note: note.trim(),
      now: Date.now(),
    });
  };

  return (
    <div className="reverify">
      <div className="reset-form">
        <label>
          <span>重验主管</span>
          <input
            value={supervisor}
            onChange={(e) => setSupervisor(e.target.value)}
            placeholder="逐瓶重验主管"
          />
        </label>
        <label className="reset-note">
          <span>重验备注（瓶阀 / O 圈 / 气密）</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="重验情况" />
        </label>
      </div>
      <div className="reset-actions">
        <button className="primary" disabled={!supervisor.trim()} onClick={() => submit(true)}>
          重验合格 · 回队列恢复
        </button>
        <button className="danger-btn" disabled={!supervisor.trim()} onClick={() => submit(false)}>
          重验不合格 · 隔离
        </button>
      </div>
    </div>
  );
}

// ---------- 工单卡片 ----------

function OrderCard({
  order,
  state,
  dispatch,
  onHistory,
}: {
  order: Order;
  state: State;
  dispatch: StoreDispatch;
  onHistory: (tank: string) => void;
}) {
  const [signBy, setSignBy] = useState("");
  const incident = order.incidents.length
    ? state.incidents.find((i) => i.id === order.incidents[order.incidents.length - 1])
    : undefined;
  const batch = state.batches.find((b) => b.id === order.batchId);
  const batchLockout = isLocked(state, order.batchId);
  const expired = daysUntil(order.inspectUntil) < 0;

  return (
    <article className={`order-card status-${order.status}`}>
      <header>
        <div>
          <h3>
            <button className="tank-link" onClick={() => onHistory(order.tankNo)}>
              {order.tankNo}
            </button>
          </h3>
          <p>
            {order.id} · {order.volume} · {order.fillMode}
            {order.fillMode !== "空气" && `（O₂ ${order.o2}%${order.he ? ` / He ${order.he}%` : ""}）`}
          </p>
        </div>
        <span className={BADGE_CLASS[order.status]}>{STATUS_TEXT[order.status]}</span>
      </header>

      <div className="order-tags">
        <ExpiryTag iso={order.inspectUntil} />
        <span className="tag tag-muted">
          气源 {batch ? batch.name : "未分配"}
          {batch?.status === "frozen" && <b className="frozen-mark"> · 已冻结</b>}
        </span>
        <span className="tag tag-muted">操作员 {order.operator}</span>
      </div>

      <PressureBar order={order} />

      {order.status === "queued" && (
        <div className="card-actions">
          <button
            className="primary"
            disabled={batchLockout || !batch || expired}
            onClick={() => dispatch({ type: "START_FILL", orderId: order.id, now: Date.now() })}
          >
            开始充填
          </button>
          {batchLockout && (
            <span className="lock-note">气源冻结 · 该工单停止排班</span>
          )}
          {!batchLockout && !batch && (
            <span className="lock-note">未分配可用气源</span>
          )}
          {expired && <span className="lock-note">检验过期，禁止开工</span>}
        </div>
      )}

      {order.status === "filling" && (
        <div className="card-actions">
          <button
            className={state.simLeak[order.id] ? "danger-btn" : "warn-btn"}
            onClick={() => dispatch({ type: "TOGGLE_SIM_LEAK", orderId: order.id })}
          >
            {state.simLeak[order.id]
              ? "停止模拟泄漏"
              : "模拟泄漏（压力持续下降）"}
          </button>
          <span className="lock-note">压力连续下降 3 个采样点将自动闭锁；也可使用顶部急停</span>
        </div>
      )}

      {order.status === "inspection" && incident && (
        <div className="inspect-box">
          <p className="inspect-head">
            闭锁事故 {incident.id.slice(-6).toUpperCase()} ·
            冻结于 {fmtDateTime(order.frozenAt ?? incident.startedAt)} ·
            残压记录 {order.pressure} bar 仅保留
          </p>
          {incident.resetResult?.leakFound ? (
            <p className="lock-note">
              主管首次检查发现泄漏，气源维持冻结；排除泄漏并再次复位后才能逐瓶重验。
            </p>
          ) : incident.resetResult ? (
            <ReverifyBox order={order} incident={incident} dispatch={dispatch} />
          ) : (
            <p className="lock-note">等待主管完成泄漏检查并复位后，方可逐瓶重验恢复。</p>
          )}
        </div>
      )}

      {order.status === "quarantined" && (
        <p className="quarantine-note">
          重验不合格已隔离，禁止充填与签收；请送检处理。
        </p>
      )}

      {order.status === "filled" && (
        <div className="card-actions signoff">
          <input
            value={signBy}
            onChange={(e) => setSignBy(e.target.value)}
            placeholder="签收人（客户 / 领用人）"
            disabled={batchLockout}
          />
          <button
            className="primary"
            disabled={batchLockout || !signBy.trim()}
            onClick={() =>
              dispatch({ type: "SIGNOFF", orderId: order.id, by: signBy.trim(), now: Date.now() })
            }
          >
            完成签收
          </button>
          {batchLockout && <span className="lock-note">气源闭锁冻结，不得签收</span>}
        </div>
      )}

      {order.status === "signed" && order.signoff && (
        <p className="signed-note">
          已于 {fmtDateTime(order.signoff.at)} 由 {order.signoff.by} 签收
        </p>
      )}
    </article>
  );
}

// ---------- 单瓶历史弹窗 ----------

function HistoryModal({
  tank,
  state,
  onClose,
}: {
  tank: string;
  state: State;
  onClose: () => void;
}) {
  const orders = state.orders.filter((o) => o.tankNo === tank);
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>{tankNoSafe(tank)} 单瓶历史</h2>
          <button onClick={onClose}>关闭</button>
        </header>
        <div className="history-list">
          {orders.map((o) => {
            const batch = state.batches.find((b) => b.id === o.batchId);
            return (
              <section key={o.id} className="history-item">
                <h4>
                  工单 {o.id} · {STATUS_TEXT[o.status]} · {o.fillMode} · 气源{" "}
                  {batch?.name ?? "未分配"}
                </h4>
                <p className="history-meta">
                  {o.volume} · 检验有效期 {o.inspectUntil} · 残压 {o.residual} bar / 目标{" "}
                  {o.target} bar · 操作员 {o.operator}
                </p>
                <div className="timeline">
                  {o.pressureLog.map((p, idx) => (
                    <div key={idx} className="timeline-row">
                      <span>{fmtTime(p.t)}</span>
                      <span>已记录压力 {p.bar} bar</span>
                    </div>
                  ))}
                  {Object.values(o.reverifies).map((r, i) => (
                    <div key={i} className="timeline-row">
                      <span>{fmtTime(r.at)}</span>
                      <span className={r.pass ? "" : "text-danger"}>
                        逐瓶重验{r.pass ? "合格" : "不合格"}（{r.supervisor}
                        {r.note ? ` · ${r.note}` : ""}）
                      </span>
                    </div>
                  ))}
                  {o.signoff && (
                    <div className="timeline-row">
                      <span>{fmtTime(o.signoff.at)}</span>
                      <span>{o.signoff.by} 签收</span>
                    </div>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function tankNoSafe(t: string) {
  return t;
}

// ---------- 新增工单表单 ----------

const MODE_DEFAULTS: Record<string, { o2: number; he: number }> = {
  空气: { o2: 21, he: 0 },
  高氧: { o2: 32, he: 0 },
  Trimix: { o2: 21, he: 35 },
};

function NewOrderForm({ dispatch }: { dispatch: StoreDispatch }) {
  const todayIso = useMemo(() => {
    const d = new Date(Date.now() + 120 * 86400000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
      d.getDate()
    ).padStart(2, "0")}`;
  }, []);
  const [f, setF] = useState({
    tankNo: "",
    volume: "12L 铝瓶",
    inspectUntil: todayIso,
    residual: 40,
    target: 200,
    o2: 21,
    he: 0,
    fillMode: "空气" as Order["fillMode"],
    operator: "阿文",
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) =>
    setF((s) => ({ ...s, [k]: v }));

  const changeMode = (mode: Order["fillMode"]) => {
    const d = MODE_DEFAULTS[mode];
    setF((s) => ({ ...s, fillMode: mode, o2: d.o2, he: d.he }));
  };

  const submit = () => {
    if (!f.tankNo.trim() || !f.inspectUntil) return;
    dispatch({ type: "NEW_ORDER", now: Date.now(), data: { ...f, tankNo: f.tankNo.trim() } });
    setF((s) => ({ ...s, tankNo: "" }));
  };

  return (
    <div className="field-grid">
      <label>
        <span>气瓶编号</span>
        <input value={f.tankNo} onChange={(e) => set("tankNo", e.target.value)} placeholder="如 TANK-301" />
      </label>
      <label>
        <span>容积</span>
        <input value={f.volume} onChange={(e) => set("volume", e.target.value)} />
      </label>
      <label>
        <span>检验有效期</span>
        <input
          type="date"
          value={f.inspectUntil}
          onChange={(e) => set("inspectUntil", e.target.value)}
        />
      </label>
      <label>
        <span>充填方式</span>
        <select
          value={f.fillMode}
          onChange={(e) => changeMode(e.target.value as Order["fillMode"])}
        >
          <option>空气</option>
          <option>高氧</option>
          <option>Trimix</option>
        </select>
      </label>
      <label>
        <span>残压 (bar)</span>
        <input
          type="number"
          value={f.residual}
          onChange={(e) => set("residual", Number(e.target.value))}
        />
      </label>
      <label>
        <span>目标压力 (bar)</span>
        <input
          type="number"
          value={f.target}
          onChange={(e) => set("target", Number(e.target.value))}
        />
      </label>
      <label>
        <span>氧含量 (%)</span>
        <input type="number" value={f.o2} onChange={(e) => set("o2", Number(e.target.value))} />
      </label>
      <label>
        <span>氦含量 (%)</span>
        <input type="number" value={f.he} onChange={(e) => set("he", Number(e.target.value))} />
      </label>
      <label>
        <span>操作员</span>
        <input value={f.operator} onChange={(e) => set("operator", e.target.value)} />
      </label>
      <div className="form-actions">
        <p className="mix-hint">{mixHint(f.fillMode, f.o2, f.he)}</p>
        <button className="primary" disabled={!f.tankNo.trim()} onClick={submit}>
          排入待充填队列
        </button>
      </div>
    </div>
  );
}

// ---------- 气源批次面板 ----------

function BatchPanel({
  state,
  dispatch,
}: {
  state: State;
  dispatch: StoreDispatch;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<Batch["kind"]>("空气");
  const [o2, setO2] = useState(21);
  const [he, setHe] = useState(0);

  const add = () => {
    if (!name.trim()) return;
    dispatch({
      type: "NEW_BATCH",
      now: Date.now(),
      data: { name: name.trim(), kind, o2, he },
    });
    setName("");
  };

  return (
    <div className="batch-panel">
      <div className="batch-list">
        {state.batches.map((b) => (
          <div key={b.id} className={`batch-item ${b.status === "frozen" ? "frozen" : ""}`}>
            <div>
              <strong>{b.name}</strong>
              <p>
                {b.kind} · O₂ {b.o2}%{b.he ? ` / He ${b.he}%` : ""}
              </p>
            </div>
            <span className={`tag ${b.status === "frozen" ? "tag-danger" : "tag-ok"}`}>
              {b.status === "frozen" ? "冻结" : "可用"}
            </span>
          </div>
        ))}
      </div>
      <div className="batch-new">
        <h3>新增气源批次</h3>
        <label>
          <span>批次编号</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如 BAT-AIR-20260918-D" />
        </label>
        <div className="batch-new-row">
          <label>
            <span>类型</span>
            <select value={kind} onChange={(e) => setKind(e.target.value as Batch["kind"])}>
              <option>空气</option>
              <option>高氧</option>
              <option>Trimix</option>
            </select>
          </label>
          <label>
            <span>O₂ %</span>
            <input type="number" value={o2} onChange={(e) => setO2(Number(e.target.value))} />
          </label>
          <label>
            <span>He %</span>
            <input type="number" value={he} onChange={(e) => setHe(Number(e.target.value))} />
          </label>
        </div>
        <button className="primary" disabled={!name.trim()} onClick={add}>
          建档并投入
        </button>
      </div>
    </div>
  );
}

// ---------- 主应用 ----------

function App() {
  const [state, dispatch] = useReducer(reducer, undefined, loadState);
  const [filter, setFilter] = useState("全部");
  const [historyTank, setHistoryTank] = useState<string | null>(null);

  // 持久化：气源、工单、事故与历史记录刷新后一致
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [state]);

  // 充填压力采样（1.5s）：上升或持续下降，连续 3 次下降自动闭锁
  useEffect(() => {
    const timer = setInterval(() => {
      dispatch({ type: "TICK", now: Date.now() });
    }, 1500);
    return () => clearInterval(timer);
  }, []);

  const incident = openIncident(state);
  const stats = selectStats(state);
  const fillingCount = state.orders.filter((o) => o.status === "filling").length;

  const visibleOrders = useMemo(() => {
    const sorted = [...state.orders].sort((a, b) => b.createdAt - a.createdAt);
    if (filter === "待检验")
      return sorted.filter((o) => o.status === "inspection" || o.status === "quarantined");
    if (filter === "全部") return sorted;
    return sorted.filter((o) => o.fillMode === filter);
  }, [state.orders, filter]);

  return (
    <main className="app">
      <section className="hero">
        <p>
          {project.id} · 源提示词{project.sourceNo} · Port {project.port}
        </p>
        <h1>{project.title}</h1>
        <span>{project.prompt}</span>
      </section>

      <section className={`emergency-bar ${incident ? "active" : ""}`}>
        <div>
          <strong>充填应急控制</strong>
          <span>
            {incident
              ? "闭锁中：气源冻结 · 停止排班 · 禁止签收 · 压力只保留"
              : fillingCount > 0
              ? `当前 ${fillingCount} 只气瓶充填中，压力异常时立即急停`
              : "无进行中充填任务"}
          </span>
        </div>
        <div className="emergency-actions">
          <button
            className="estop"
            disabled={fillingCount === 0}
            onClick={() => dispatch({ type: "ESTOP", now: Date.now() })}
          >
            ⛔ 手动急停
          </button>
          <button className="ghost" onClick={() => dispatch({ type: "RESET_DEMO" })}>
            重置演示数据
          </button>
        </div>
      </section>

      <section className="metrics">
        {project.metrics.map((metric, index) => (
          <article key={metric}>
            <small>{metric}</small>
            <strong>{[stats.queued, stats.expired, `${stats.avgO2}%`, stats.signed][index]}</strong>
          </article>
        ))}
      </section>

      {incident && <IncidentPanel state={state} incident={incident} dispatch={dispatch} />}

      <section className="workspace">
        <aside className="panel">
          <h2>气源批次</h2>
          <BatchPanel state={state} dispatch={dispatch} />
        </aside>

        <section className="panel form-panel">
          <div className="heading">
            <div>
              <p>专业字段</p>
              <h2>新增充填工单</h2>
            </div>
          </div>
          <NewOrderForm dispatch={dispatch} />
        </section>
      </section>

      <section className="panel">
        <div className="heading">
          <div>
            <p>充填工作台</p>
            <h2>工单队列</h2>
          </div>
        </div>
        <div className="chips filter-chips">
          {project.filters.map((item) => (
            <button
              key={item}
              className={filter === item ? "chip-on" : ""}
              onClick={() => setFilter(item)}
            >
              {item}
            </button>
          ))}
        </div>
        <div className="order-grid">
          {visibleOrders.map((o) => (
            <OrderCard
              key={o.id}
              order={o}
              state={state}
              dispatch={dispatch}
              onHistory={setHistoryTank}
            />
          ))}
          {visibleOrders.length === 0 && <p className="empty">该分类下暂无工单。</p>}
        </div>
      </section>

      <section className="panel">
        <div className="heading">
          <div>
            <p>安全追溯</p>
            <h2>操作与闭锁历史</h2>
          </div>
        </div>
        <div className="audit-list">
          {state.audit.slice(0, 12).map((a) => (
            <div key={a.id} className={`audit-row audit-${a.kind}`}>
              <span className="audit-time">{fmtTime(a.t)}</span>
              <span>{a.text}</span>
            </div>
          ))}
        </div>
      </section>

      {historyTank && (
        <HistoryModal tank={historyTank} state={state} onClose={() => setHistoryTank(null)} />
      )}
    </main>
  );
}

export default App;
