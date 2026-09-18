import { useEffect, useMemo, useRef, useState } from "react";
import "./styles.css";
import type {
  AppState,
  Incident,
  Mix,
  Order,
} from "./types";
import { BATCH_STATUS_LABEL, STATUS_LABEL } from "./types";
import {
  addOrder,
  DROP_LIMIT,
  loadState,
  recheckOrder,
  saveState,
  seedState,
  signOrder,
  startFilling,
  supervisorReset,
  tickFilling,
  toggleLeakSim,
  triggerLockout,
} from "./store";

const MIXES: Mix[] = ["空气", "高氧", "Trimix"];
const FILTERS = ["全部", "空气", "高氧", "Trimix", "待检验"] as const;
type Filter = (typeof FILTERS)[number];

function fmtTime(t: number): string {
  return new Date(t).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function daysUntil(iso: string): number {
  const d = new Date(iso + "T00:00:00").getTime() - new Date("2026-09-18T00:00:00").getTime();
  return Math.round(d / 86400000);
}

function mixHint(o: Pick<Order, "mix" | "oxygen" | "helium">): string {
  if (o.mix === "空气") return "空气充填：氧含量按 20.9% 基准核对";
  if (o.mix === "高氧")
    return o.oxygen >= 36
      ? `EAN${o.oxygen}：高氧，注意 >40% 需清洁设备与氧气加注规程`
      : `EAN${o.oxygen}：高氧混合气，充填前确认最大作业深度 MOD`;
  return `Trimix ${o.oxygen}/${o.helium}：用氦分压核对配比，降低氮醉与氧分压风险`;
}

const STATUS_CLASS: Record<string, string> = {
  queued: "tag tag-queued",
  suspended: "tag tag-suspended",
  filling: "tag tag-filling",
  held: "tag tag-held",
  recheck: "tag tag-recheck",
  completed: "tag tag-completed",
  signed: "tag tag-signed",
  rejected: "tag tag-rejected",
};

// ---------------- 压力曲线 ----------------

function Sparkline({ order }: { order: Order }) {
  const pts = order.pressureLog;
  if (pts.length < 2) return <p className="muted">暂无压力采样</p>;
  const w = 260;
  const h = 56;
  const maxP = Math.max(...pts.map((p) => p.p), order.targetPressure) + 6;
  const minP = Math.max(0, Math.min(...pts.map((p) => p.p)) - 6);
  const span = Math.max(1, maxP - minP);
  const d = pts
    .map((p, i) => {
      const x = (i / (pts.length - 1)) * w;
      const y = h - ((p.p - minP) / span) * h;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const targetY = h - ((order.targetPressure - minP) / span) * h;
  const danger = order.leakSimulation || order.dropStreak > 0;
  return (
    <svg className={`spark ${danger ? "spark-danger" : ""}`} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <line x1="0" y1={targetY} x2={w} y2={targetY} className="target-line" />
      <path d={d} fill="none" />
    </svg>
  );
}

// ---------------- 主管泄漏检查 / 复位 ----------------

function SupervisorPanel({
  state,
  incident,
  onReset,
}: {
  state: AppState;
  incident: Incident;
  onReset: (i: { inspector: string; note: string; result: "pass" | "fail" }) => void;
}) {
  const batch = state.batches.find((b) => b.id === incident.batchId);
  const [inspector, setInspector] = useState("");
  const [result, setResult] = useState<"pass" | "fail">("pass");
  const [note, setNote] = useState("");
  const reused = Boolean(incident.firstFinding);
  const f = incident.firstFinding;

  return (
    <div className="supervisor">
      <div className="supervisor-head">
        <h3>主管泄漏检查与复位</h3>
        <p>
          事故 {incident.id} · 气源「{batch?.name}」 · 触发 {incident.triggers.length} 次
        </p>
      </div>
      <div className="trigger-list">
        {incident.triggers.map((tr, idx) => (
          <div key={idx} className="trigger-row">
            <span>{fmtTime(tr.t)}</span>
            <b>{tr.reason === "estop" ? "手动急停" : "压力持续下降"}</b>
            <span>
              {tr.orderId} · 保留压力 {tr.pressure}bar
            </span>
          </div>
        ))}
      </div>

      {reused && f ? (
        <div className={`finding finding-${f.result}`}>
          <strong>
            本事故首次检查结果：{f.result === "pass" ? "合格" : "不合格"}（{f.inspector} · {fmtTime(f.at)}）
          </strong>
          <p>同一事故重复复位，沿用首次结果，本次提交不得修改检查结论。</p>
          {f.note && <p className="finding-note">{f.note}</p>}
        </div>
      ) : (
        <div className="finding-form">
          <label>
            <span>检查结论</span>
            <div className="seg">
              <button
                type="button"
                className={result === "pass" ? "seg-on seg-pass" : ""}
                onClick={() => setResult("pass")}
              >
                合格复位
              </button>
              <button
                type="button"
                className={result === "fail" ? "seg-on seg-fail" : ""}
                onClick={() => setResult("fail")}
              >
                不合格·停用气源
              </button>
            </div>
          </label>
          <label>
            <span>检查说明（可选）</span>
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="如：更换管接头并复装、保压 5min 无压降" />
          </label>
        </div>
      )}

      <label>
        <span>主管签名</span>
        <input value={inspector} onChange={(e) => setInspector(e.target.value)} placeholder="输入主管姓名后提交复位" />
      </label>
      <button
        className={reused || result === "pass" ? "primary" : "danger-btn"}
        disabled={!inspector.trim()}
        onClick={() => onReset({ inspector, note, result })}
      >
        {reused ? `确认复位（沿用首次结果：${f!.result === "pass" ? "合格" : "不合格"}）` : "提交泄漏检查并复位"}
      </button>

      {incident.resets.length > 0 && (
        <div className="reset-history">
          <p className="muted">复位记录</p>
          {incident.resets.map((r, i) => (
            <div key={i} className="reset-row">
              <span>{fmtTime(r.t)}</span>
              <b className={r.result === "pass" ? "pass-text" : "fail-text"}>
                {r.result === "pass" ? "合格" : "不合格"}
              </b>
              <span>
                {r.inspector}
                {r.reused ? " · 沿用首次结果" : ""}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------- 新增工单 ----------------

function NewOrderForm({
  state,
  onCreate,
}: {
  state: AppState;
  onCreate: (input: {
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
  }) => void;
}) {
  const [tankNo, setTankNo] = useState("");
  const [volume, setVolume] = useState("12L铝瓶");
  const [inspectUntil, setInspectUntil] = useState("2027-09-01");
  const [residual, setResidual] = useState(50);
  const [target, setTarget] = useState(200);
  const [mix, setMix] = useState<Mix>("空气");
  const [oxygen, setOxygen] = useState(21);
  const [helium, setHelium] = useState(0);
  const [operator, setOperator] = useState("林深");
  const [batchId, setBatchId] = useState(state.batches[0]?.id ?? "");

  const valid = tankNo.trim().length > 0 && target > residual;

  return (
    <div className="field-grid">
      <label>
        <span>气瓶编号</span>
        <input value={tankNo} onChange={(e) => setTankNo(e.target.value)} placeholder="如 TANK-245" />
      </label>
      <label>
        <span>容积 / 瓶型</span>
        <input value={volume} onChange={(e) => setVolume(e.target.value)} />
      </label>
      <label>
        <span>检验有效期</span>
        <input type="date" value={inspectUntil} onChange={(e) => setInspectUntil(e.target.value)} />
      </label>
      <label>
        <span>气源批次</span>
        <select value={batchId} onChange={(e) => setBatchId(e.target.value)}>
          {state.batches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}（{BATCH_STATUS_LABEL[b.status]}）
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>残压 bar</span>
        <input type="number" value={residual} min={0} onChange={(e) => setResidual(Number(e.target.value))} />
      </label>
      <label>
        <span>目标压力 bar</span>
        <input type="number" value={target} min={1} onChange={(e) => setTarget(Number(e.target.value))} />
      </label>
      <label>
        <span>充填方式</span>
        <select
          value={mix}
          onChange={(e) => {
            const m = e.target.value as Mix;
            setMix(m);
            if (m === "空气") {
              setOxygen(21);
              setHelium(0);
            } else if (m === "高氧") {
              setOxygen(32);
              setHelium(0);
            } else {
              setOxygen(18);
              setHelium(35);
            }
          }}
        >
          {MIXES.map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
      </label>
      <label>
        <span>氧含量 %</span>
        <input type="number" value={oxygen} min={0} max={100} onChange={(e) => setOxygen(Number(e.target.value))} />
      </label>
      <label>
        <span>氦含量 %</span>
        <input type="number" value={helium} min={0} max={100} onChange={(e) => setHelium(Number(e.target.value))} />
      </label>
      <label>
        <span>操作员</span>
        <input value={operator} onChange={(e) => setOperator(e.target.value)} />
      </label>
      <button
        className="primary form-submit"
        disabled={!valid}
        onClick={() =>
          onCreate({
            tankNo: tankNo.trim(),
            volume,
            inspectUntil,
            residualPressure: residual,
            targetPressure: target,
            oxygen,
            helium,
            mix,
            operator,
            batchId,
          })
        }
      >
        保存记录并入队
      </button>
    </div>
  );
}

// ---------------- 工单卡片 ----------------

function OrderCard({
  state,
  order,
  onStart,
  onEStop,
  onLeakToggle,
  onRecheck,
  onSign,
}: {
  state: AppState;
  order: Order;
  onStart: (id: string) => void;
  onEStop: (id: string) => void;
  onLeakToggle: (id: string) => void;
  onRecheck: (id: string, result: "pass" | "fail") => void;
  onSign: (id: string, customer: string) => void;
}) {
  const batch = state.batches.find((b) => b.id === order.batchId);
  const frozen = batch && (batch.status === "frozen" || batch.status === "condemned");
  const [customer, setCustomer] = useState("");
  const [open, setOpen] = useState(false);
  const expDays = daysUntil(order.inspectUntil);
  const expired = expDays < 0;
  const expiring = expDays >= 0 && expDays <= 30;

  return (
    <article className={`order-card ${frozen && order.status !== "signed" ? "order-locked" : ""} ${order.status === "filling" ? "order-filling" : ""}`}>
      <div className="order-main">
        <div className="order-title">
          <h3>{order.tankNo}</h3>
          <span className={STATUS_CLASS[order.status]}>{STATUS_LABEL[order.status]}</span>
          {(expired || expiring) && (
            <span className={`tag ${expired ? "tag-expired" : "tag-expiring"}`}>
              {expired ? `检验已过期 ${-expDays} 天` : `检验期剩余 ${expDays} 天`}
            </span>
          )}
        </div>
        <p className="order-meta">
          {order.id} · {order.volume} · {order.mix}（O₂ {order.oxygen}%{order.mix === "Trimix" ? ` / He ${order.helium}%` : ""}）
          · 操作员 {order.operator} · 气源 {batch?.name}
        </p>
        <p className="mix-hint">{mixHint(order)}</p>

        <div className="pressure-row">
          <div>
            <small>残压 / 目标</small>
            <strong>
              {order.residualPressure} / {order.targetPressure} bar
            </strong>
          </div>
          <div>
            <small>当前记录压力{order.status === "held" || order.status === "recheck" ? "（闭锁保留值，禁止修改）" : ""}</small>
            <strong className={order.stopReason ? "frozen-pressure" : ""}>{order.currentPressure} bar</strong>
          </div>
          {(order.status === "filling" || order.status === "held" || order.status === "recheck") && (
            <div className="spark-wrap">
              <Sparkline order={order} />
            </div>
          )}
        </div>

        {order.status === "filling" && order.dropStreak > 0 && (
          <p className="alarm-inline">
            压力连续下降 {order.dropStreak}/{DROP_LIMIT} 次，达到阈值将自动闭锁
          </p>
        )}

        <div className="order-actions">
          {order.status === "queued" && (
            <button className="primary" disabled={frozen || expired} onClick={() => onStart(order.id)}>
              {frozen ? "气源冻结·禁止开工" : expired ? "检验过期·禁止充填" : "开始充填"}
            </button>
          )}
          {order.status === "suspended" && <span className="muted">气源闭锁中，等待主管复位后恢复排班</span>}
          {order.status === "filling" && (
            <>
              <button
                className={order.leakSimulation ? "leak-on" : "ghost-btn"}
                onClick={() => onLeakToggle(order.id)}
              >
                {order.leakSimulation ? "停止泄漏演练" : "演练：模拟充填泄漏"}
              </button>
              <button className="danger-btn" onClick={() => onEStop(order.id)}>
                ⛔ 手动急停
              </button>
            </>
          )}
          {order.status === "held" && (
            <span className="muted lock-note">
              已转待检：仅保留闭锁时压力 {order.frozenPressure ?? order.currentPressure}bar，
              不得调整、不得签收，等待主管检查复位
            </span>
          )}
          {order.status === "recheck" && (
            <>
              <button className="primary" onClick={() => onRecheck(order.id, "pass")}>
                逐瓶重验合格·恢复
              </button>
              <button className="danger-btn" onClick={() => onRecheck(order.id, "fail")}>
                重验不合格·停用
              </button>
            </>
          )}
          {order.status === "completed" && (
            <>
              <input
                className="sign-input"
                value={customer}
                onChange={(e) => setCustomer(e.target.value)}
                placeholder="客户签名"
                disabled={Boolean(frozen)}
              />
              <button className="primary" disabled={!customer.trim() || Boolean(frozen)} onClick={() => onSign(order.id, customer)}>
                {frozen ? "气源闭锁·禁止签收" : "签收"}
              </button>
            </>
          )}
          {order.status === "signed" && (
            <span className="muted">
              {order.signedBy} 已于 {order.signedAt ? fmtTime(order.signedAt) : ""} 签收
            </span>
          )}
          {order.status === "rejected" && <span className="fail-text">重验不合格，气瓶停用</span>}
          <button className="ghost-btn history-toggle" onClick={() => setOpen((v) => !v)}>
            {open ? "收起历史" : "单瓶历史"}
          </button>
        </div>
      </div>

      {open && (
        <div className="history-panel">
          {[...order.history].reverse().map((h, i) => (
            <div key={i} className="history-row">
              <span>{fmtTime(h.t)}</span>
              <p>{h.event}</p>
            </div>
          ))}
          {order.pressureLog.length > 0 && (
            <details className="pressure-log">
              <summary>压力采样记录（{order.pressureLog.length}）</summary>
              <div className="log-grid">
                {order.pressureLog.map((p, i) => (
                  <span key={i}>
                    {fmtTime(p.t)} — {p.p}bar
                  </span>
                ))}
              </div>
            </details>
          )}
        </div>
      )}
    </article>
  );
}

// ---------------- 主应用 ----------------

function App() {
  const [state, setState] = useState<AppState>(loadState);
  const [filter, setFilter] = useState<Filter>("全部");
  const stateRef = useRef(state);
  stateRef.current = state;

  // 每秒采样充填压力；持续下降自动闭锁
  useEffect(() => {
    const timer = setInterval(() => {
      const next = tickFilling(stateRef.current);
      if (next !== stateRef.current) setState(next);
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // 气源、工单、事故历史统一持久化，刷新后一致
  useEffect(() => {
    saveState(state);
  }, [state]);

  const activeIncidents = state.incidents.filter((i) => i.state === "active" || i.state === "reopened");
  const [activeIncidentId, setActiveIncidentId] = useState<string | null>(null);
  const activeIncident =
    activeIncidents.find((i) => i.id === activeIncidentId) ?? activeIncidents[0] ?? null;

  const fillingOrders = state.orders.filter((o) => o.status === "filling");

  const estopAll = () => {
    let next = state;
    const batches = new Set(fillingOrders.map((o) => o.batchId));
    batches.forEach((bid) => {
      next = triggerLockout(next, bid, "estop");
    });
    setState(next);
  };

  const filtered = useMemo(() => {
    return state.orders.filter((o) => {
      if (filter === "全部") return true;
      if (filter === "待检验")
        return ["held", "recheck", "rejected"].includes(o.status) || daysUntil(o.inspectUntil) <= 30;
      return o.mix === filter;
    });
  }, [state.orders, filter]);

  const pendingCount = state.orders.filter((o) => ["queued", "suspended", "filling", "recheck", "held"].includes(o.status)).length;
  const expiredCount = state.orders.filter((o) => daysUntil(o.inspectUntil) < 0 && o.status !== "signed" && o.status !== "rejected").length;
  const activeMixOrders = state.orders.filter((o) => o.status !== "rejected");
  const avgO2 =
    activeMixOrders.length === 0
      ? 0
      : Math.round((activeMixOrders.reduce((s, o) => s + o.oxygen, 0) / activeMixOrders.length) * 10) / 10;
  const signedCount = state.orders.filter((o) => o.status === "signed").length;

  const resetIncident = (id: string, input: { inspector: string; note: string; result: "pass" | "fail" }) => {
    setState((s) => supervisorReset(s, id, input));
  };

  return (
    <main className="app">
      <section className="hero">
        <p>hxyfront-62010 · 源提示词5 · Port 62010</p>
        <h1>潜水气瓶充填记录</h1>
        <span>
          记录气瓶编号、容积、检验有效期、残压/目标压力、氧氦含量、充填方式与操作员；支持待充填队列、混合气比例提示、
          检验过期提醒、完成签收与单瓶历史。充填中压力持续下降或手动急停时立即执行泄漏应急闭锁：冻结气源批次、
          未开工单停止排班、在充气瓶转待检，只保留已记录压力、禁止签收；主管完成泄漏检查复位后逐瓶重验恢复，
          同一事故重复复位沿用首次结果，全部记录本地持久化、刷新后一致。
        </span>
      </section>

      <section className="metrics">
        <article>
          <small>待处理气瓶</small>
          <strong>{pendingCount}</strong>
        </article>
        <article>
          <small>检验过期提醒</small>
          <strong className={expiredCount > 0 ? "metric-warn" : ""}>{expiredCount}</strong>
        </article>
        <article>
          <small>平均氧含量</small>
          <strong>{avgO2}%</strong>
        </article>
        <article>
          <small>已签收单</small>
          <strong>{signedCount}</strong>
        </article>
      </section>

      {/* 应急闭锁横幅 */}
      <section className={`lockout-banner ${activeIncident ? "banner-active" : "banner-ok"}`}>
        <div className="banner-status">
          <span className="banner-icon">{activeIncident ? "⛔" : "✅"}</span>
          <div>
            <h2>{activeIncident ? "充填泄漏应急闭锁已触发" : "充填系统运行正常"}</h2>
            <p>
              {activeIncident
                ? `事故 ${activeIncident.id}${activeIncidents.length > 1 ? `（共 ${activeIncidents.length} 起活动事故）` : ""}：气源已冻结，未开工单停止排班，在充气瓶全部转待检，禁止任何签收与压力修改。`
                : "压力持续下降自动检测 + 手动急停双重保护；触发后立即冻结当前气源批次。"}
            </p>
          </div>
        </div>
        <div className="banner-actions">
          <button className="danger-btn" disabled={fillingOrders.length === 0} onClick={estopAll}>
            全站手动急停（{fillingOrders.length} 瓶充填中）
          </button>
          <button className="ghost-btn" onClick={() => { if (confirm("重置为演示数据？当前记录将被清除。")) setState(seedState()); }}>
            重置演示数据
          </button>
        </div>
      </section>

      {activeIncident && (
        <section className="panel lockout-panel">
          {activeIncidents.length > 1 && (
            <div className="incident-tabs">
              {activeIncidents.map((inc) => (
                <button
                  key={inc.id}
                  className={inc.id === activeIncident.id ? "danger-btn" : "ghost-btn"}
                  onClick={() => setActiveIncidentId(inc.id)}
                >
                  事故 {inc.id}
                </button>
              ))}
            </div>
          )}
          <SupervisorPanel
            state={state}
            incident={activeIncident}
            onReset={(i) => resetIncident(activeIncident.id, i)}
          />
        </section>
      )}

      {/* 气源批次 */}
      <section className="panel">
        <div className="heading">
          <div>
            <p>气源批次</p>
            <h2>充气站状态（闭锁最小化：仅冻结当前气源）</h2>
          </div>
        </div>
        <div className="batch-grid">
          {state.batches.map((b) => {
            const inc = state.incidents.find((i) => i.id === b.incidentId);
            const counts: Record<string, number> = {};
            state.orders.filter((o) => o.batchId === b.id).forEach((o) => {
              counts[o.status] = (counts[o.status] ?? 0) + 1;
            });
            return (
              <article key={b.id} className={`batch-card batch-${b.status}`}>
                <div className="batch-head">
                  <h3>{b.name}</h3>
                  <span className={`batch-tag batch-tag-${b.status}`}>{BATCH_STATUS_LABEL[b.status]}</span>
                </div>
                <p className="muted">{b.mix} · {b.id}</p>
                <div className="batch-counts">
                  {(["filling", "held", "recheck", "suspended", "queued", "completed", "signed"] as const).map((s) =>
                    counts[s] ? (
                      <span key={s} className="mini-count">
                        {STATUS_LABEL[s]} {counts[s]}
                      </span>
                    ) : null
                  )}
                </div>
                {inc && (
                  <p className="batch-incident">
                    事故 {inc.id}
                    {inc.firstFinding
                      ? ` · 首次检查${inc.firstFinding.result === "pass" ? "合格" : "不合格"}`
                      : " · 待主管检查"}
                    {inc.state === "reopened" ? " · 已重开（沿用首次结果）" : ""}
                  </p>
                )}
              </article>
            );
          })}
        </div>
      </section>

      <section className="workspace">
        <aside className="panel">
          <h2>充填分类</h2>
          <div className="chips">
            {FILTERS.map((f) => (
              <button key={f} className={filter === f ? "chip-on" : ""} onClick={() => setFilter(f)}>
                {f}
              </button>
            ))}
          </div>
          <div className="rules">
            <h3>闭锁规则</h3>
            <ul>
              <li>充填中压力连续下降 {DROP_LIMIT} 次 → 自动判定泄漏、立即闭锁</li>
              <li>手动急停 → 立即闭锁当前气源批次</li>
              <li>未开工单停止排班，在充气瓶转待检</li>
              <li>待检气瓶仅保留已记录压力，禁止签收</li>
              <li>主管检查合格复位后方可逐瓶重验</li>
              <li>同事故重复复位沿用首次检查结果</li>
            </ul>
          </div>
        </aside>

        <section className="panel form-panel">
          <div className="heading">
            <div>
              <p>专业字段</p>
              <h2>新增充填记录</h2>
            </div>
          </div>
          <NewOrderForm
            state={state}
            onCreate={(input) => setState((s) => addOrder(s, input))}
          />
        </section>
      </section>

      <section className="panel">
        <div className="heading">
          <div>
            <p>工单队列</p>
            <h2>气瓶充填工作台（{filtered.length}）</h2>
          </div>
        </div>
        <div className="records orders">
          {filtered.map((o) => (
            <OrderCard
              key={o.id}
              state={state}
              order={o}
              onStart={(id) => setState((s) => startFilling(s, id))}
              onEStop={(id) => {
                const order = s0(state, id);
                if (order) setState((s) => triggerLockout(s, order.batchId, "estop"));
              }}
              onLeakToggle={(id) => setState((s) => toggleLeakSim(s, id))}
              onRecheck={(id, result) => setState((s) => recheckOrder(s, id, result))}
              onSign={(id, customer) => setState((s) => signOrder(s, id, customer))}
            />
          ))}
          {filtered.length === 0 && <p className="muted">当前分类下没有工单。</p>}
        </div>
      </section>

      <section className="panel">
        <div className="heading">
          <div>
            <p>泄漏事故历史</p>
            <h2>应急闭锁与复位记录（{state.incidents.length}）</h2>
          </div>
        </div>
        {state.incidents.length === 0 ? (
          <p className="muted">暂无泄漏事故。可在任一「充填中」工单上使用「演练：模拟充填泄漏」或「手动急停」触发。</p>
        ) : (
          <div className="incident-log">
            {[...state.incidents].reverse().map((inc) => {
              const batch = state.batches.find((b) => b.id === inc.batchId);
              const stateLabel =
                inc.state === "active"
                  ? "闭锁中·待检查"
                  : inc.state === "reopened"
                    ? "事故重开·沿用首次结果"
                    : inc.state === "reset"
                      ? "已复位"
                      : "检查不合格·气源停用";
              return (
                <details key={inc.id} className="incident-item">
                  <summary>
                    <b>{inc.id}</b>
                    <span>{batch?.name}</span>
                    <span>{fmtTime(inc.openedAt)}</span>
                    <span className={`inc-state inc-state-${inc.state}`}>{stateLabel}</span>
                  </summary>
                  <div className="incident-body">
                    <p className="muted">
                      首次检查：
                      {inc.firstFinding
                        ? `${inc.firstFinding.result === "pass" ? "合格" : "不合格"} · ${inc.firstFinding.inspector} · ${fmtTime(inc.firstFinding.at)}${inc.firstFinding.note ? ` · ${inc.firstFinding.note}` : ""}`
                        : "尚未完成"}
                    </p>
                    <div className="trigger-list">
                      {inc.triggers.map((tr, i) => (
                        <div key={i} className="trigger-row">
                          <span>{fmtTime(tr.t)}</span>
                          <b>{tr.reason === "estop" ? "手动急停" : "压力持续下降自动闭锁"}</b>
                          <span>
                            {tr.orderId} · {tr.pressure}bar
                          </span>
                        </div>
                      ))}
                    </div>
                    {inc.resets.map((r, i) => (
                      <div key={i} className="reset-row">
                        <span>{fmtTime(r.t)}</span>
                        <b className={r.result === "pass" ? "pass-text" : "fail-text"}>
                          {r.result === "pass" ? "复位合格" : "检查不合格"}
                        </b>
                        <span>
                          {r.inspector}{r.reused ? " · 沿用首次结果" : ""}
                          {r.note ? ` · ${r.note}` : ""}
                        </span>
                      </div>
                    ))}
                  </div>
                </details>
              );
            })}
          </div>
        )}
      </section>
    </main>
  );
}

function s0(state: AppState, id: string): Order | undefined {
  return state.orders.find((o) => o.id === id);
}

export default App;
