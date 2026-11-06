'use strict';
/**
 * diary.js 的单元测试
 *
 * 守三件事：
 *  1. 按本地日期分桶，跨天不串味
 *  2. 脏数据不崩（文件可能被手工改坏，也可能是旧版本格式）
 *  3. 连续天数与小结文案的边界（今天还没用、中间断一天）
 */
const test = require('node:test');
const assert = require('node:assert');
const D = require('../src/diary.js');

/** 构造某天某时的本地时间戳 */
function ts(y, m, d, hh) {
  return new Date(y, m - 1, d, hh || 12, 0, 0, 0).getTime();
}

test('dayKey 用本地时区，不是 UTC', () => {
  assert.strictEqual(D.dayKey(ts(2026, 11, 6)), '2026-11-06');
  // 深夜 23:30 仍属当天（UTC 已跨日，本地没有）
  assert.strictEqual(D.dayKey(ts(2026, 11, 6, 23)), '2026-11-06');
  // 凌晨 00:30 属新一天
  assert.strictEqual(D.dayKey(new Date(2026, 10, 7, 0, 30).getTime()), '2026-11-07');
});

test('dayKey 对非法输入返回空串', () => {
  for (const v of [null, undefined, NaN, 'x', {}]) {
    assert.strictEqual(D.dayKey(v), '');
  }
});

test('keyToTs 与 dayKey 互为逆运算', () => {
  for (const [y, m, d] of [[2026, 1, 1], [2026, 2, 28], [2026, 12, 31]]) {
    const k = D.dayKey(ts(y, m, d));
    assert.strictEqual(D.dayKey(D.keyToTs(k)), k);
  }
});

test('keyToTs 拒绝非法格式', () => {
  for (const v of ['', '2026-1-1', '2026/01/01', null, 0]) {
    assert.ok(isNaN(D.keyToTs(v)));
  }
});

test('emptyDay 所有字段为 0', () => {
  const d = D.emptyDay();
  for (const k of ['clicks', 'walks', 'slept', 'focusDone', 'focusMs', 'sips']) {
    assert.strictEqual(d[k], 0);
  }
});

test('bump 在当天累加', () => {
  const s = {};
  D.bump(s, ts(2026, 11, 6), 'clicks');
  D.bump(s, ts(2026, 11, 6), 'clicks');
  assert.strictEqual(s['2026-11-06'].clicks, 2);
});

test('bump 不同日期分开记', () => {
  const s = {};
  D.bump(s, ts(2026, 11, 6), 'clicks');
  D.bump(s, ts(2026, 11, 7), 'clicks');
  assert.strictEqual(s['2026-11-06'].clicks, 1);
  assert.strictEqual(s['2026-11-07'].clicks, 1);
});

test('bump 拒绝未知字段', () => {
  const s = {};
  assert.strictEqual(D.bump(s, ts(2026, 11, 6), 'hacked'), null);
  assert.deepStrictEqual(s, {});
});

test('bump 对空 store 或非法时间返回 null', () => {
  assert.strictEqual(D.bump(null, Date.now(), 'clicks'), null);
  assert.strictEqual(D.bump({}, NaN, 'clicks'), null);
});

test('bump 的 amount 支持非 1 增量', () => {
  const s = {};
  D.bump(s, ts(2026, 11, 6), 'focusDone', 3);
  assert.strictEqual(s['2026-11-06'].focusDone, 3);
});

test('addFocusMs 累加专注时长', () => {
  const s = {};
  D.addFocusMs(s, ts(2026, 11, 6), 25 * 60 * 1000);
  D.addFocusMs(s, ts(2026, 11, 6), 25 * 60 * 1000);
  assert.strictEqual(s['2026-11-06'].focusMs, 50 * 60 * 1000);
});

test('addFocusMs 忽略非正数与非法值', () => {
  const s = {};
  D.addFocusMs(s, ts(2026, 11, 6), -5000);
  D.addFocusMs(s, ts(2026, 11, 6), 'abc');
  assert.strictEqual(D.cleanDay(s['2026-11-06']).focusMs, 0);
});

test('cleanDay 收敛脏数据', () => {
  const d = D.cleanDay({ clicks: '5', walks: -3, slept: null, focusDone: 2.7, focusMs: 'abc', sips: 1 });
  assert.strictEqual(d.clicks, 5);
  assert.strictEqual(d.walks, 0, '负数归零');
  assert.strictEqual(d.slept, 0);
  assert.strictEqual(d.focusDone, 3, '四舍五入');
  assert.strictEqual(d.focusMs, 0);
  assert.strictEqual(d.sips, 1);
});

test('cleanDay 对 null/字符串返回空记录', () => {
  for (const v of [null, 'x', 0, undefined]) {
    assert.deepStrictEqual(D.cleanDay(v), D.emptyDay());
  }
});

test('prune 丢掉过期日期', () => {
  const now = ts(2026, 11, 6);
  const s = {
    '2026-11-06': { clicks: 1 },
    '2026-01-01': { clicks: 1 },   // 超过 180 天
  };
  const out = D.prune(s, now, 30);
  assert.deepStrictEqual(Object.keys(out), ['2026-11-06']);
});

test('prune 丢掉格式错误的键', () => {
  const s = { '2026-11-06': { clicks: 1 }, 'bad': { clicks: 1 }, '2026-13-45': { clicks: 1 } };
  const out = D.prune(s, ts(2026, 11, 6), 180);
  assert.deepStrictEqual(Object.keys(out), ['2026-11-06']);
});

test('prune 丢掉全零的一天（否则连续天数会算错）', () => {
  const s = {
    '2026-11-06': { clicks: 1 },
    '2026-11-05': { clicks: 0, walks: 0 },
  };
  const out = D.prune(s, ts(2026, 11, 6), 180);
  assert.deepStrictEqual(Object.keys(out), ['2026-11-06']);
});

test('prune 不修改入参', () => {
  const s = { '2026-11-06': { clicks: 1 }, bad: {} };
  const before = JSON.stringify(s);
  D.prune(s, ts(2026, 11, 6), 180);
  assert.strictEqual(JSON.stringify(s), before);
});

test('summarize 汇总区间内数据', () => {
  const s = {
    '2026-11-04': { clicks: 2, focusDone: 1, focusMs: 1500000, sips: 3 },
    '2026-11-05': { clicks: 5, focusDone: 2, focusMs: 3000000, sips: 1 },
    '2026-11-06': { clicks: 1, focusDone: 0, focusMs: 0, sips: 2 },
    '2026-10-01': { clicks: 99, focusDone: 9, focusMs: 9999, sips: 9 }, // 区间外
  };
  const r = D.summarize(s, ts(2026, 11, 1), ts(2026, 11, 6));
  assert.strictEqual(r.days, 3);
  assert.strictEqual(r.total.clicks, 8);
  assert.strictEqual(r.total.focusDone, 3);
  assert.strictEqual(r.total.sips, 6);
  assert.deepStrictEqual(r.bestDay, { key: '2026-11-05', focusDone: 2, focusMs: 3000000 });
});

test('summarize 空输入返回零值', () => {
  for (const v of [null, {}, 'x']) {
    const r = D.summarize(v, ts(2026, 11, 1), ts(2026, 11, 6));
    assert.strictEqual(r.days, 0);
    assert.strictEqual(r.total.clicks, 0);
    assert.strictEqual(r.bestDay, null);
  }
});

test('summarize 的 bestDay 在没有番茄钟时为 null', () => {
  const s = { '2026-11-06': { clicks: 100, focusDone: 0 } };
  const r = D.summarize(s, ts(2026, 11, 1), ts(2026, 11, 6));
  assert.strictEqual(r.bestDay, null, '只有点击不算「最好的一天」');
});

test('streakDays 从今天往前数', () => {
  const s = {
    '2026-11-06': { clicks: 1 },
    '2026-11-05': { clicks: 1 },
    '2026-11-04': { clicks: 1 },
    '2026-11-02': { clicks: 1 },
  };
  assert.strictEqual(D.streakDays(s, ts(2026, 11, 6)), 3, '11-03 断了');
});

test('streakDays 今天还没用不算断', () => {
  const s = {
    '2026-11-05': { clicks: 1 },
    '2026-11-04': { clicks: 1 },
  };
  assert.strictEqual(D.streakDays(s, ts(2026, 11, 6, 9)), 2);
});

test('streakDays 空数据为 0', () => {
  assert.strictEqual(D.streakDays({}, ts(2026, 11, 6)), 0);
  assert.strictEqual(D.streakDays(null, ts(2026, 11, 6)), 0);
});

test('streakDays 跨月连续不断', () => {
  const s = {
    '2026-12-01': { clicks: 1 },
    '2026-11-30': { clicks: 1 },
    '2026-11-29': { clicks: 1 },
  };
  assert.strictEqual(D.streakDays(s, ts(2026, 12, 1)), 3);
});

test('formatDuration 分级输出', () => {
  assert.strictEqual(D.formatDuration(0), '0 秒');
  assert.strictEqual(D.formatDuration(30 * 1000), '30 秒');
  assert.strictEqual(D.formatDuration(45 * 60 * 1000), '45 分');
  assert.strictEqual(D.formatDuration(2 * 3600 * 1000), '2 小时');
  assert.strictEqual(D.formatDuration((2 * 3600 + 15 * 60) * 1000), '2 小时 15 分');
  assert.strictEqual(D.formatDuration(-100), '0 秒');
});

test('todayLine 有记录时列出做了什么', () => {
  const s = { '2026-11-06': { clicks: 3, focusDone: 2, focusMs: 3000000, sips: 1 } };
  const line = D.todayLine(s, ts(2026, 11, 6));
  assert.ok(line.includes('2 个番茄钟'), line);
  assert.ok(line.includes('50 分'), line);
  assert.ok(line.includes('喝水 1 次'), line);
  assert.ok(line.includes('摸了 3 下'), line);
});

test('todayLine 空记录给一句中性的话', () => {
  const line = D.todayLine({}, ts(2026, 11, 6));
  assert.ok(line.includes('还没'), line);
});

test('weekLine 汇总最近 7 天', () => {
  const s = {
    '2026-11-06': { focusDone: 1, focusMs: 1500000 },
    '2026-11-04': { focusDone: 2, focusMs: 3000000 },
  };
  const line = D.weekLine(s, ts(2026, 11, 6));
  assert.ok(line.includes('3 个番茄钟'), line);
  assert.ok(line.includes('1 小时 15 分'), '超过一小时应换算成小时，实际：' + line);
});

test('weekLine 无记录时明说', () => {
  const line = D.weekLine({}, ts(2026, 11, 6));
  assert.ok(line.includes('没有'), line);
});

test('跨年边界', () => {
  const s = {};
  D.bump(s, ts(2026, 12, 31, 23), 'clicks');
  D.bump(s, ts(2027, 1, 1, 1), 'clicks');
  assert.strictEqual(s['2026-12-31'].clicks, 1);
  assert.strictEqual(s['2027-01-01'].clicks, 1);
  assert.strictEqual(D.streakDays(s, ts(2027, 1, 1)), 2);
});

test('长期使用：180 天数据剪枝后不超期', () => {
  const s = {};
  const now = ts(2026, 11, 6);
  for (let i = 0; i < 300; i++) {
    const t = now - i * D.DAY_MS;
    D.bump(s, t, 'clicks');
  }
  const out = D.prune(s, now, 180);
  assert.ok(Object.keys(out).length <= 181, '实际 ' + Object.keys(out).length);
  const oldest = Object.keys(out).sort()[0];
  assert.ok(D.keyToTs(oldest) >= now - 181 * D.DAY_MS);
});
