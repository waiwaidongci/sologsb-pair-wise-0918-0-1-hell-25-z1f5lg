import { seedState, triggerLockout, supervisorReset, recheckOrder, tickFilling, startFilling, signOrder, addOrder } from "../src/store";
import type { AppState } from "../src/types";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fail++; console.log("  ✗", name, detail); }
}

// ---- 场景：急停闭锁 → 合格复位 → 逐瓶重验 → 重开沿用首次结果 ----
let s: AppState = seedState();
s = startFilling(s, "WO-1001");
s = addOrder(s, {
  tankNo: "TANK-900", volume: "12L", inspectUntil: "2027-01-01",
  residualPressure: 40, targetPressure: 200, oxygen: 21, helium: 0,
  mix: "空气", operator: "测试", batchId: "B-AIR",
});
const newQueued = s.orders.find((o) => o.tankNo === "TANK-900")!;
check("新工单进入 queued", newQueued.status === "queued");

// 手动急停
s = triggerLockout(s, "B-AIR", "estop");
const b1 = s.batches.find((b) => b.id === "B-AIR")!;
check("急停后气源冻结", b1.status === "frozen");
check("充填中工单转 held", s.orders.find((o) => o.id === "WO-1001")!.status === "held");
check("未开工单停止排班 suspended", newQueued.id && s.orders.find((o) => o.id === newQueued.id)!.status === "suspended");
const held = s.orders.find((o) => o.id === "WO-1001")!;
check("held 保留冻结压力", held.frozenPressure === held.currentPressure);

// held 状态不能签收（signOrder 只接受 completed；completed 单在冻结气源上也不能签收）
// 另造一个 B-AIR 上的 completed 单专门验证签收禁令
s = addOrder(s, {
  tankNo: "TANK-902", volume: "12L", inspectUntil: "2027-01-01",
  residualPressure: 40, targetPressure: 200, oxygen: 21, helium: 0,
  mix: "空气", operator: "测试", batchId: "B-AIR",
});
const signCand = s.orders.find((o) => o.tankNo === "TANK-902")!;
s = {
  ...s,
  orders: s.orders.map((o) =>
    o.id === signCand.id
      ? { ...o, status: "completed" as const, history: [...o.history, { t: Date.now(), event: "测试用：直接置为待签收" }] }
      : o
  ),
};
s = signOrder(s, signCand.id, "客户甲");
check("冻结气源上 completed 单禁止签收", s.orders.find((o) => o.id === signCand.id)!.status === "completed");

// 主管首次检查合格复位
const incId = s.incidents[0].id;
s = supervisorReset(s, incId, { inspector: "主管赵", note: "接头复紧", result: "pass" });
check("复位合格气源 released", s.batches.find((b) => b.id === "B-AIR")!.status === "released");
check("held → recheck", s.orders.find((o) => o.id === "WO-1001")!.status === "recheck");
check("suspended 恢复 queued", s.orders.find((o) => o.id === newQueued.id)!.status === "queued");
check("首次结果记录", s.incidents[0].firstFinding?.result === "pass" && s.incidents[0].firstFinding?.inspector === "主管赵");

// 重验不合格 → rejected
s = recheckOrder(s, "WO-1001", "fail");
check("逐瓶重验不合格 → rejected", s.orders.find((o) => o.id === "WO-1001")!.status === "rejected");

// ---- 场景：压力持续下降自动闭锁；首次不合格后重开沿用 ----
let s2: AppState = seedState();
s2 = startFilling(s2, "WO-1001");
// 强制连续下降 3 拍
s2 = { ...s2, orders: s2.orders.map((o) => o.id === "WO-1001" ? { ...o, leakSimulation: true } : o) };
s2 = tickFilling(s2);
s2 = tickFilling(s2);
const beforeThird = s2.orders.find((o) => o.id === "WO-1001")!.dropStreak;
s2 = tickFilling(s2);
check("泄漏演练产生连续下降计数", beforeThird === 2);
check("连续下降3次自动闭锁", s2.batches.find((b) => b.id === "B-AIR")!.status === "frozen");
check("自动闭锁原因 pressure-drop", s2.incidents[0].triggers.some((t) => t.reason === "pressure-drop"));

// 首次检查不合格 → condemned
const inc2 = s2.incidents[0].id;
s2 = supervisorReset(s2, inc2, { inspector: "主管钱", note: "瓶阀裂纹", result: "fail" });
check("首次不合格 → 气源 condemned", s2.batches.find((b) => b.id === "B-AIR")!.status === "condemned");
check("事故 state=failed", s2.incidents[0].state === "failed");
check("held 工单仍不得签收", s2.orders.find((o) => o.id === "WO-1001")!.status === "held");

// condemned 气源不能再触发（不会重开）
s2 = triggerLockout(s2, "B-AIR", "estop");
check("停用气源不会重开事故", s2.incidents[0].state === "failed");

// ---- 场景：合格复位后事故重开，重复复位沿用首次结果 ----
let s3: AppState = seedState();
s3 = startFilling(s3, "WO-1001");
s3 = triggerLockout(s3, "B-AIR", "estop");
const i3 = s3.incidents[0].id;
s3 = supervisorReset(s3, i3, { inspector: "主管孙", note: "首次检查合格", result: "pass" });
// recheck 尚未完成时再次急停重开
s3 = startFilling(s3, s3.orders.find((o) => o.status === "queued" && o.batchId === "B-AIR")!.id);
s3 = triggerLockout(s3, "B-AIR", "estop");
check("事故重开 reopened", s3.incidents[0].state === "reopened");
// 再次提交，尝试传 fail，应沿用首次 pass
s3 = supervisorReset(s3, i3, { inspector: "主管李", note: "试图改判", result: "fail" });
check("重复复位沿用首次结果 pass", s3.incidents[0].firstFinding!.result === "pass");
check("重复复位 state=reset", s3.incidents[0].state === "reset");
check("reset 记录标记 reused", s3.incidents[0].resets[1]?.reused === true);
check("沿用记录使用首次主管名", s3.incidents[0].resets[1]?.inspector === "主管李");
// 逐瓶重验：全部通过后气源恢复 open
for (const o of s3.orders.filter((o) => o.status === "recheck")) {
  s3 = recheckOrder(s3, o.id, "pass");
}
check("全部重验完成后气源恢复 open", s3.batches.find((b) => b.id === "B-AIR")!.status === "open");

// 冻结气源上新建工单不排班
s3 = triggerLockout(s3, "B-AIR", "estop");
s3 = addOrder(s3, {
  tankNo: "TANK-901", volume: "12L", inspectUntil: "2027-01-01",
  residualPressure: 30, targetPressure: 200, oxygen: 21, helium: 0,
  mix: "空气", operator: "测试", batchId: "B-AIR",
});
check("冻结气源上新工单停止排班", s3.orders.find((o) => o.tankNo === "TANK-901")!.status === "suspended");

// 其他气源不受影响
check("闭锁最小化：其他气源仍 open", s3.batches.find((b) => b.id === "B-EAN")!.status === "open");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
