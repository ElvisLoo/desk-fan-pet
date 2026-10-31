'use strict';
/**
 * 系统状态采集
 *
 * 桌面宠物要能长期留在桌面上，光卖萌不够 —— 它得有用。
 * 最常见的问题是「我看它干嘛」，答案是：它替你看电脑。
 *
 * 三类状态，都是每分钟真会用到的：
 *   - 电量：笔记本拔了电源没注意，突然关机丢东西
 *   - 内存：开太多标签页/容器后卡顿，但任务管理器懒得开
 *   - CPU：风扇狂转、系统发烫时的第一手信号
 *
 * 设计原则：
 *   1. 采集要便宜。轮询本身不能成为负担，所以 CPU 用差分而非瞬时值，
 *      内存只读一次 os 接口，不做任何字符串格式化。
 *   2. 采集失败不算错误。某些平台拿不到电池信息（台式机没有），
 *      那是正常的，返回 null 而不是抛异常。
 *   3. 可注入。核心逻辑不直接调 os，方便测试各种边界。
 */

/** 状态等级：决定宠物怎么表现 */
const LEVEL = {
  OK: 'ok',           // 一切正常
  WARN: 'warn',       // 需要留意（内存偏紧、电量中等）
  CRIT: 'crit',       // 需要处理（电量告急、内存吃紧）
};

/**
 * 把电量百分比映射成等级。
 * 阈值选择：20% 以下系统通常开始提示，但用户在 30% 就该知道。
 */
function batteryLevel(percent, charging) {
  if (percent === null || percent === undefined) return null;
  if (charging) return LEVEL.OK;
  if (percent <= 10) return LEVEL.CRIT;
  if (percent <= 30) return LEVEL.WARN;
  return LEVEL.OK;
}

/**
 * 内存压力。
 * 用「已用比例」而不是「剩余绝对值」：8G 和 32G 的机器，
 * "剩 2G" 的含义完全不同。
 */
function memoryLevel(usedRatio) {
  if (!Number.isFinite(usedRatio)) return LEVEL.OK;
  if (usedRatio >= 0.92) return LEVEL.CRIT;
  if (usedRatio >= 0.80) return LEVEL.WARN;
  return LEVEL.OK;
}

/** CPU 压力：持续高负载才值得提醒，瞬时飙高不算 */
function cpuLevel(usage) {
  if (!Number.isFinite(usage)) return LEVEL.OK;
  if (usage >= 0.95) return LEVEL.CRIT;
  if (usage >= 0.80) return LEVEL.WARN;
  return LEVEL.OK;
}

/** 三个等级取最严重的 */
function worstLevel(...levels) {
  const order = { [LEVEL.OK]: 0, [LEVEL.WARN]: 1, [LEVEL.CRIT]: 2 };
  let worst = LEVEL.OK;
  for (const lv of levels) {
    if (!lv) continue;
    if (order[lv] > order[worst]) worst = lv;
  }
  return worst;
}

/**
 * 单个状态项的展示文案。
 * 返回 null 表示"没有这项数据"，界面就不显示 —— 
 * 台式机没有电池，不该显示一个空电池图标。
 */
function describeBattery(info) {
  if (!info || !Number.isFinite(info.percent)) return null;
  const pct = Math.round(info.percent);
  if (info.charging) return { text: `充电 ${pct}%`, level: LEVEL.OK };
  const level = batteryLevel(pct, false);
  // 剩余时间只在放电时有效，充电时系统给的值没意义
  const mins = Number.isFinite(info.minutesLeft) && info.minutesLeft > 0
    ? Math.round(info.minutesLeft) : null;
  const tail = mins !== null && mins <= 90 ? ` · ${mins}分` : '';
  return { text: `电量 ${pct}%${tail}`, level };
}

function describeMemory(info) {
  if (!info || !Number.isFinite(info.usedRatio)) return null;
  const pct = Math.round(info.usedRatio * 100);
  const level = memoryLevel(info.usedRatio);
  const usedGb = Number.isFinite(info.usedGb) ? info.usedGb.toFixed(1) : null;
  const totalGb = Number.isFinite(info.totalGb) ? Math.round(info.totalGb) : null;
  const detail = usedGb && totalGb ? ` · ${usedGb}/${totalGb}G` : '';
  return { text: `内存 ${pct}%${detail}`, level };
}

function describeCpu(usage) {
  if (!Number.isFinite(usage)) return null;
  const pct = Math.round(usage * 100);
  return { text: `CPU ${pct}%`, level: cpuLevel(usage) };
}

/**
 * 汇总成一份"宠物该知道的状态"。
 * 这是主进程每 2 秒调一次的东西，返回给渲染层。
 */
function summarize({ battery, memory, cpu }) {
  const items = [];
  const b = describeBattery(battery);
  if (b) items.push({ kind: 'battery', ...b });
  const m = describeMemory(memory);
  if (m) items.push({ kind: 'memory', ...m });
  const c = describeCpu(cpu);
  if (c) items.push({ kind: 'cpu', ...c });

  return {
    items,
    level: worstLevel(...items.map((i) => i.level)),
    // 供渲染层决定要不要弹气泡
    alerts: items.filter((i) => i.level !== LEVEL.OK),
  };
}

/**
 * 带滞后的 CPU 采样器。
 * 单次采样波动大（打开一个网页就飙到 90%），
 * 用滑动平均避免宠物疯狂报警。
 */
class CpuAverager {
  constructor({ windowSize = 5 } = {}) {
    this.windowSize = windowSize;
    this.samples = [];
  }

  push(usage) {
    if (!Number.isFinite(usage)) return this.average();
    this.samples.push(usage);
    if (this.samples.length > this.windowSize) this.samples.shift();
    return this.average();
  }

  average() {
    if (!this.samples.length) return 0;
    return this.samples.reduce((a, b) => a + b, 0) / this.samples.length;
  }
}

/**
 * 警报去抖：同一个状态在短时间内只提醒一次。
 * 内存 85% 会持续很久，每秒提醒一次等于骚扰。
 */
class AlertGate {
  constructor({ cooldownMs = 10 * 60 * 1000, now = () => Date.now() } = {}) {
    this.cooldownMs = cooldownMs;
    this.now = now;
    this.lastFired = new Map();
  }

  /** 返回本次应该触发的警报（可能为空） */
  filter(alerts) {
    const out = [];
    const t = this.now();
    for (const a of alerts || []) {
      if (!a || !a.kind) continue;
      // 按 kind+level 分桶：电量从 warn 升级到 crit 应该重新提醒
      const key = `${a.kind}:${a.level}`;
      // 没记录过 = 首次出现。必须用 undefined 判断而不是 `|| 0`：
      // 时间戳可能小于 cooldownMs（测试用逻辑时钟、或系统刚启动），
      // 那样 `t - 0 >= cooldown` 恒为假，首次警报永远发不出来。
      const last = this.lastFired.get(key);
      if (last === undefined || t - last >= this.cooldownMs) {
        this.lastFired.set(key, t);
        out.push(a);
      }
    }
    return out;
  }

  reset() {
    this.lastFired.clear();
  }
}

module.exports = {
  LEVEL,
  batteryLevel,
  memoryLevel,
  cpuLevel,
  worstLevel,
  describeBattery,
  describeMemory,
  describeCpu,
  summarize,
  CpuAverager,
  AlertGate,
};
