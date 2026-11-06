'use strict';
/**
 * diary.js — 每日小记（纯逻辑，不依赖 DOM / Electron / 文件系统）
 *
 * 为什么需要它：
 *   宠物身上的番茄钟、喝水提醒、专注次数都已经在算了，但只在内存里，
 *   关掉就归零。用户用了三周，问「我到底专注了多少次」答不上来。
 *
 * 三条设计原则：
 *  1. **按本地日期分桶**，不按 UTC：用户眼里的「今天」是自己时区的今天。
 *  2. **只留 180 天**：再久的数据没人看，反而让文件越来越大、读取变慢。
 *  3. **写坏不崩**：文件损坏、字段缺失、类型不对，一律降级为空记，
 *     绝不因为统计把宠物本身搞挂。
 */

const KEEP_DAYS = 180;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 本地时区的 YYYY-MM-DD */
function dayKey(ts) {
  // null / '' / 布尔都会被 Number() 悄悄转成 0 或 1，落进 1970 年。
  // 这里显式挡掉，只接受真正的时间戳或 Date。
  if (ts === null || ts === undefined || typeof ts === 'boolean') return '';
  if (typeof ts === 'string' && ts.trim() === '') return '';
  const n = ts instanceof Date ? ts.getTime() : Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '';
  const d = new Date(n);
  if (isNaN(d.getTime())) return '';
  const p = (n) => (n < 10 ? '0' : '') + n;
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/** 'YYYY-MM-DD' -> 当天 0 点时间戳；非法返回 NaN */
function keyToTs(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
  if (!m) return NaN;
  const y = +m[1], mo = +m[2], day = +m[3];
  if (mo < 1 || mo > 12 || day < 1 || day > 31) return NaN;
  const d = new Date(y, mo - 1, day, 0, 0, 0, 0);
  if (isNaN(d.getTime())) return NaN;
  // Date 会把 2 月 30 日进位成 3 月 2 日，必须回读校验
  if (d.getFullYear() !== y || d.getMonth() !== mo - 1 || d.getDate() !== day) return NaN;
  return d.getTime();
}

/** 一天的空记录 */
function emptyDay() {
  return {
    clicks: 0,      // 被摸了几下
    walks: 0,       // 自己走了几次
    slept: 0,       // 睡着几次
    focusDone: 0,   // 完成几个番茄钟
    focusMs: 0,     // 专注总时长（毫秒）
    sips: 0,        // 提醒喝水几次
  };
}

/** 把任意脏数据收敛成合法的一天记录 */
function cleanDay(rec) {
  const out = emptyDay();
  if (!rec || typeof rec !== 'object') return out;
  for (const k of Object.keys(out)) {
    const n = Number(rec[k]);
    out[k] = Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
  }
  return out;
}

/**
 * 在指定日期上累加一次事件
 * @param {object} store  { 'YYYY-MM-DD': dayRecord }
 * @param {number} ts     事件发生时间
 * @param {string} field  字段名（clicks/walks/slept/focusDone/sips）
 * @param {number} amount 增量，默认 1
 * @returns {object|null} 累加后的当天记录；非法入参返回 null
 */
function bump(store, ts, field, amount) {
  if (!store || typeof store !== 'object') return null;
  const key = dayKey(ts);
  if (!key) return null;

  const day = cleanDay(store[key]);
  const add = Number.isFinite(Number(amount)) ? Number(amount) : 1;
  if (!(field in day)) return null;

  day[field] = Math.max(0, Math.round(day[field] + add));
  store[key] = day;
  return day;
}

/** 累加专注时长（毫秒） */
function addFocusMs(store, ts, ms) {
  if (!store || typeof store !== 'object') return null;
  const key = dayKey(ts);
  if (!key) return null;
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return cleanDay(store[key]);
  const day = cleanDay(store[key]);
  day.focusMs = Math.round(day.focusMs + n);
  store[key] = day;
  return day;
}

/**
 * 裁掉过期日期与坏键，返回新对象（不改入参）
 */
function prune(store, nowTs, keepDays) {
  const keep = Number.isFinite(Number(keepDays)) ? Number(keepDays) : KEEP_DAYS;
  const out = {};
  if (!store || typeof store !== 'object') return out;

  const cutoffKey = dayKey(Number(nowTs) - keep * DAY_MS);
  const cutoff = keyToTs(cutoffKey);

  for (const [k, v] of Object.entries(store)) {
    const t = keyToTs(k);
    if (isNaN(t)) continue;                       // 键格式不对
    if (!isNaN(cutoff) && t < cutoff) continue;   // 太老
    const day = cleanDay(v);
    // 全零的一天没有保留价值，留着只会让「连续天数」算错
    const hasData = Object.values(day).some((n) => n > 0);
    if (hasData) out[k] = day;
  }
  return out;
}

/**
 * 汇总一段时间的日记
 * @returns {{days:number, activeDays:number, total:object, bestDay:object|null}}
 */
function summarize(store, fromTs, toTs) {
  const total = emptyDay();
  const result = { days: 0, activeDays: 0, total, bestDay: null, streak: 0 };
  if (!store || typeof store !== 'object') return result;

  const from = dayKey(fromTs);
  const to = dayKey(toTs);

  for (const [k, v] of Object.entries(store)) {
    if (!from || !to || k < from || k > to) continue;
    const day = cleanDay(v);
    result.days++;
    const active = day.clicks > 0 || day.focusDone > 0 || day.sips > 0 || day.walks > 0;
    if (active) result.activeDays++;

    for (const f of Object.keys(total)) total[f] += day[f];

    // 「最好的一天」按完成番茄钟数排，其次按专注时长
    if (!result.bestDay ||
        day.focusDone > result.bestDay.focusDone ||
        (day.focusDone === result.bestDay.focusDone && day.focusMs > result.bestDay.focusMs)) {
      if (day.focusDone > 0) {
        result.bestDay = { key: k, focusDone: day.focusDone, focusMs: day.focusMs };
      }
    }
  }

  result.streak = streakDays(store, toTs);
  return result;
}

/**
 * 连续使用天数：从今天（或昨天）往前数，哪天完全没记录就断。
 * 今天还没用过不算断，从昨天开始数即可。
 */
function streakDays(store, nowTs) {
  if (!store || typeof store !== 'object') return 0;
  let cur = new Date(Number(nowTs));
  if (isNaN(cur.getTime())) return 0;

  const dayHasData = (d) => {
    const rec = store[dayKey(d.getTime())];
    if (!rec) return false;
    const day = cleanDay(rec);
    return Object.values(day).some((n) => n > 0);
  };

  if (!dayHasData(cur)) {
    cur = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() - 1);
  }

  let n = 0;
  for (let i = 0; i < KEEP_DAYS + 1; i++) {
    if (!dayHasData(cur)) break;
    n++;
    cur = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() - 1);
  }
  return n;
}

/** 毫秒 -> "2 小时 15 分" / "45 分" / "30 秒" */
function formatDuration(ms) {
  const total = Math.max(0, Math.floor(Number(ms) / 1000) || 0);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0 && m > 0) return h + ' 小时 ' + m + ' 分';
  if (h > 0) return h + ' 小时';
  if (m > 0) return m + ' 分';
  return total + ' 秒';
}

/**
 * 生成给人看的今日小结，一两句话。
 * 刻意不说「你今天效率很高」这种评价，只陈述做了什么。
 */
function todayLine(store, nowTs) {
  const key = dayKey(nowTs);
  const day = cleanDay(store && store[key]);
  const bits = [];

  if (day.focusDone > 0) {
    bits.push('专注 ' + day.focusDone + ' 个番茄钟（' + formatDuration(day.focusMs) + '）');
  }
  if (day.sips > 0) bits.push('提醒喝水 ' + day.sips + ' 次');
  if (day.clicks > 0) bits.push('被摸了 ' + day.clicks + ' 下');
  if (day.walks > 0) bits.push('自己走了 ' + day.walks + ' 趟');

  if (!bits.length) return '今天还没怎么用它。';
  return '今天' + bits.join('，') + '。';
}

/** 生成一周小结 */
function weekLine(store, nowTs) {
  const now = new Date(Number(nowTs));
  if (isNaN(now.getTime())) return '';
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
  const s = summarize(store, monday.getTime(), nowTs);

  if (s.total.focusDone === 0 && s.total.sips === 0) {
    return '最近 7 天没有专注记录。';
  }
  const parts = [];
  if (s.total.focusDone > 0) parts.push('完成 ' + s.total.focusDone + ' 个番茄钟');
  if (s.total.focusMs > 0) parts.push('累计专注 ' + formatDuration(s.total.focusMs));
  if (s.total.sips > 0) parts.push('喝水提醒 ' + s.total.sips + ' 次');
  let line = '最近 7 天：' + parts.join('，') + '。';
  if (s.streak > 1) line += '已连续用 ' + s.streak + ' 天。';
  return line;
}

module.exports = {
  KEEP_DAYS,
  DAY_MS,
  dayKey,
  keyToTs,
  emptyDay,
  cleanDay,
  bump,
  addFocusMs,
  prune,
  summarize,
  streakDays,
  formatDuration,
  todayLine,
  weekLine,
};
