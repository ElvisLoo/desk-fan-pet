'use strict';
/**
 * achievements.js — 成就系统（纯逻辑，不依赖 DOM / Electron / 文件系统）
 *
 * 为什么需要它：
 *   日记（diary.js）已经在老老实实记「被摸几下、完成几个番茄钟、
 *   连续用了几天」，但用户看不到任何反馈。成就系统把这些真实记录
 *   换成一句话的正反馈，让「坚持用」这件事看得见。
 *
 * 三条设计原则（和 diary.js 一致）：
 *  1. **只用真实数据**：判定只读 diary 已经在记的字段，不引入新数据源。
 *  2. **脏数据不崩**：store 是 null、空对象、字段缺失、类型乱来，一律降级，
 *     绝不因为算成就把宠物本身搞挂。
 *  3. **纯函数**：不写盘、不弹窗、不改入参，只返回「解锁了哪些 / 还差多少」，
 *     UI 想怎么展示（进度条、弹窗、托盘）由调用方决定。
 *
 * 对外 API：
 *   evaluate(store, nowTs) -> { unlocked: [...], locked: [...] }
 */

const diary = require('./diary.js');

/**
 * 成就定义表。
 *
 * 每个成就的 kind 决定用哪种进度来源：
 *   - kind = 'total'  累计某个 diary 字段（跨所有天求和）
 *   - kind = 'streak' 连续使用天数（复用 diary.streakDays）
 *
 * target 是解锁阈值；field 只在 kind='total' 时有意义。
 * 顺序即展示顺序：越靠前越容易拿到，给用户一个平滑的成就感曲线。
 */
const ACHIEVEMENTS = [
  {
    id: 'first-pet',
    name: '初次相遇',
    desc: '第一次被摸了一下',
    icon: '🐾',
    kind: 'total',
    field: 'clicks',
    target: 1,
  },
  {
    id: 'pet-master',
    name: '摸鱼大师',
    desc: '累计被摸 100 次',
    icon: '🐟',
    kind: 'total',
    field: 'clicks',
    target: 100,
  },
  {
    id: 'focus-first',
    name: '专注入门',
    desc: '完成第 1 个番茄钟',
    icon: '🍅',
    kind: 'total',
    field: 'focusDone',
    target: 1,
  },
  {
    id: 'focus-regular',
    name: '专注达人',
    desc: '累计完成 10 个番茄钟',
    icon: '⏱️',
    kind: 'total',
    field: 'focusDone',
    target: 10,
  },
  {
    id: 'focus-fanatic',
    name: '专注狂人',
    desc: '累计完成 50 个番茄钟',
    icon: '🔥',
    kind: 'total',
    field: 'focusDone',
    target: 50,
  },
  {
    id: 'sip-good',
    name: '喝水乖宝',
    desc: '累计响应喝水提醒 20 次',
    icon: '💧',
    kind: 'total',
    field: 'sips',
    target: 20,
  },
  {
    id: 'streak-7',
    name: '常驻桌宠',
    desc: '连续使用 7 天',
    icon: '📅',
    kind: 'streak',
    target: 7,
  },
  {
    id: 'streak-30',
    name: '铁杆粉丝',
    desc: '连续使用 30 天',
    icon: '🏅',
    kind: 'streak',
    target: 30,
  },
];

/**
 * 累计某字段在所有天的总和（基于 cleanDay 收敛，脏数据当 0）。
 */
function totalField(store, field) {
  if (!store || typeof store !== 'object') return 0;
  let sum = 0;
  for (const key of Object.keys(store)) {
    const day = diary.cleanDay(store[key]);
    sum += day[field] || 0;
  }
  return sum;
}

/**
 * 找到累计某字段第一次达到 target 的日期（用于 unlockedAt）。
 * 按日期从早到晚累加，返回命中的 'YYYY-MM-DD'；从未达标返回 undefined。
 */
function firstReachDate(store, field, target) {
  if (!store || typeof store !== 'object') return undefined;
  if (!(target > 0)) return undefined;

  // 只保留合法日期键，并按时间先后排序
  const keys = Object.keys(store)
    .filter((k) => !isNaN(diary.keyToTs(k)))
    .sort();

  let sum = 0;
  for (const k of keys) {
    const day = diary.cleanDay(store[k]);
    sum += day[field] || 0;
    if (sum >= target) return k;
  }
  return undefined;
}

/** 把 progress 夹在 0..1 之间，避免脏数据算出 >1 或负数 */
function clamp01(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

/**
 * 评估当前解锁了哪些成就。
 *
 * @param {object|null} store  diary 的 store，形如 { 'YYYY-MM-DD': dayRecord }
 * @param {number|Date} nowTs  当前时间，streak 类成就以它为基准
 * @returns {{unlocked: Array, locked: Array}}
 *   unlocked: 已解锁，含 unlockedAt（首次达标日期）与满格 progress
 *   locked:   未解锁，含 progress(0..1) 与 target，供前端画进度条
 */
function evaluate(store, nowTs) {
  const unlocked = [];
  const locked = [];

  // store 是 null / 字符串 / 数组等脏输入时，统一按空 store 处理，不崩
  const safeStore = store && typeof store === 'object' && !Array.isArray(store)
    ? store
    : {};

  // streak 类成就共用一次计算，别在循环里反复扫 180 天
  const streak = diary.streakDays(safeStore, nowTs);

  for (const def of ACHIEVEMENTS) {
    let current;
    let reachedAt;

    if (def.kind === 'streak') {
      current = streak;
    } else {
      current = totalField(safeStore, def.field);
      if (current >= def.target) {
        reachedAt = firstReachDate(safeStore, def.field, def.target);
      }
    }

    const done = current >= def.target;
    const progress = clamp01(def.target > 0 ? current / def.target : 0);

    if (done) {
      unlocked.push({
        id: def.id,
        name: def.name,
        desc: def.desc,
        icon: def.icon,
        unlockedAt: def.kind === 'streak' ? diary.dayKey(nowTs) : reachedAt,
        progress: 1,
        current,
        target: def.target,
      });
    } else {
      locked.push({
        id: def.id,
        name: def.name,
        desc: def.desc,
        icon: def.icon,
        progress,
        current,
        target: def.target,
      });
    }
  }

  return { unlocked, locked };
}

module.exports = {
  ACHIEVEMENTS,
  evaluate,
};
