'use strict';
/**
 * achievements.js 的单元测试
 *
 * 守四件事：
 *  1. 脏数据不崩：null、空对象、字段缺失、类型乱来一律降级
 *  2. 解锁判定基于 diary 真实字段，阈值刚好命中的边界要对
 *  3. progress 是 0..1 的比例，供前端画进度条
 *  4. 已解锁成就带 unlockedAt（首次达标的日期）
 */
const test = require('node:test');
const assert = require('node:assert');
const D = require('../src/diary.js');
const A = require('../src/achievements.js');

/** 构造某天某时的本地时间戳 */
function ts(y, m, d, hh) {
  return new Date(y, m - 1, d, hh || 12, 0, 0, 0).getTime();
}

/** 拿某个成就对象（在 unlocked 或 locked 里都行） */
function pick(result, id) {
  return result.unlocked.find((a) => a.id === id) ||
    result.locked.find((a) => a.id === id);
}

/** 造一个连续 n 天都有记录的 store，最后一天是 (y,m,d) */
function streakStore(y, m, d, n, field = 'clicks') {
  const s = {};
  for (let i = 0; i < n; i++) {
    const t = ts(y, m, d) - i * D.DAY_MS;
    const k = D.dayKey(t);
    s[k] = { ...D.emptyDay(), [field]: 1 };
  }
  return s;
}

const NOW = ts(2026, 11, 6);

test('成就定义表至少 8 个，且 id 唯一', () => {
  assert.ok(A.ACHIEVEMENTS.length >= 8, '实际 ' + A.ACHIEVEMENTS.length);
  const ids = new Set(A.ACHIEVEMENTS.map((a) => a.id));
  assert.strictEqual(ids.size, A.ACHIEVEMENTS.length, 'id 不能重复');
  // 每个成就都必须有给人看的字段
  for (const a of A.ACHIEVEMENTS) {
    assert.ok(a.name, a.id + ' 缺 name');
    assert.ok(a.desc, a.id + ' 缺 desc');
    assert.ok(a.icon, a.id + ' 缺 icon');
    assert.ok(a.target > 0, a.id + ' 缺 target');
  }
});

test('空 store：全部 locked，无 unlocked，不崩', () => {
  const r = A.evaluate({}, NOW);
  assert.strictEqual(r.unlocked.length, 0);
  assert.strictEqual(r.locked.length, A.ACHIEVEMENTS.length);
  for (const a of r.locked) {
    assert.strictEqual(a.progress, 0, a.id + ' 空数据进度应为 0');
    assert.strictEqual(a.current, 0);
  }
});

test('null / 脏数据 store 不崩', () => {
  for (const bad of [null, undefined, 'x', 42, [], [{ clicks: 1 }]]) {
    const r = A.evaluate(bad, NOW);
    assert.strictEqual(r.unlocked.length, 0, '脏输入 ' + JSON.stringify(bad) + ' 不应解锁任何成就');
    assert.strictEqual(r.locked.length, A.ACHIEVEMENTS.length);
  }
});

test('store 里的脏字段被 cleanDay 收敛，不崩', () => {
  const s = {
    '2026-11-06': { clicks: 'abc', focusDone: -5, sips: null, walks: {} },
  };
  const r = A.evaluate(s, NOW);
  assert.strictEqual(pick(r, 'first-pet').current, 0, '非法 clicks 应按 0 算');
  assert.strictEqual(pick(r, 'focus-first').current, 0, '负数 focusDone 应按 0 算');
  assert.strictEqual(r.unlocked.length, 0);
});

test('含非法日期键的脏 store 也不崩（累计口径与 diary.summarize 一致）', () => {
  const s = {
    '2026-11-06': { clicks: 1 },
    'bad-key': { clicks: 1 },   // 键格式不对，summarize 也会 cleanDay 后计入总数
  };
  const r = A.evaluate(s, NOW);
  assert.ok(r.unlocked.find((x) => x.id === 'first-pet'), '合法那天仍应解锁');
  assert.strictEqual(pick(r, 'first-pet').current, 2);
});

test('clicks=1 解锁「初次相遇」，带 unlockedAt', () => {
  const s = { '2026-11-06': { ...D.emptyDay(), clicks: 1 } };
  const r = A.evaluate(s, NOW);
  const a = pick(r, 'first-pet');
  assert.ok(r.unlocked.includes(a), '初次相遇应已解锁');
  assert.strictEqual(a.progress, 1);
  assert.strictEqual(a.unlockedAt, '2026-11-06');
  // 摸鱼大师此时还没到
  assert.ok(!r.unlocked.find((x) => x.id === 'pet-master'));
});

test('clicks 刚好 100 才解锁摸鱼大师，99 不解锁', () => {
  const s99 = { '2026-11-06': { ...D.emptyDay(), clicks: 99 } };
  const r99 = A.evaluate(s99, NOW);
  assert.ok(!r99.unlocked.find((x) => x.id === 'pet-master'));
  assert.strictEqual(pick(r99, 'pet-master').current, 99);

  const s100 = { '2026-11-06': { ...D.emptyDay(), clicks: 100 } };
  const r100 = A.evaluate(s100, NOW);
  const a = pick(r100, 'pet-master');
  assert.ok(r100.unlocked.includes(a));
  assert.strictEqual(a.unlockedAt, '2026-11-06');
});

test('focusDone 达阈值解锁对应专注成就', () => {
  const s = { '2026-11-06': { ...D.emptyDay(), focusDone: 10 } };
  const r = A.evaluate(s, NOW);
  assert.ok(r.unlocked.find((x) => x.id === 'focus-first'), '专注入门应解锁');
  assert.ok(r.unlocked.find((x) => x.id === 'focus-regular'), '专注达人应解锁');
  assert.ok(!r.unlocked.find((x) => x.id === 'focus-fanatic'), '专注狂人未到');
  assert.strictEqual(pick(r, 'focus-fanatic').progress, 10 / 50);
});

test('focusDone 分散多天会累计', () => {
  const s = {
    '2026-11-05': { ...D.emptyDay(), focusDone: 3 },
    '2026-11-06': { ...D.emptyDay(), focusDone: 7 },
  };
  const r = A.evaluate(s, NOW);
  assert.ok(r.unlocked.find((x) => x.id === 'focus-regular'), '3+7=10 应解锁');
});

test('sips 累计 20 解锁喝水乖宝', () => {
  const s = { '2026-11-06': { ...D.emptyDay(), sips: 20 } };
  const r = A.evaluate(s, NOW);
  assert.ok(r.unlocked.find((x) => x.id === 'sip-good'));
});

test('progress 是 0..1 的比例（clicks=50/100 ≈ 0.5）', () => {
  const s = { '2026-11-06': { ...D.emptyDay(), clicks: 50 } };
  const r = A.evaluate(s, NOW);
  const a = pick(r, 'pet-master');
  assert.strictEqual(a.progress, 0.5);
  assert.strictEqual(a.target, 100);
  assert.strictEqual(a.current, 50);
});

test('progress 超过阈值时夹在 1，不会爆表', () => {
  const s = { '2026-11-06': { ...D.emptyDay(), clicks: 1000 } };
  const r = A.evaluate(s, NOW);
  assert.strictEqual(pick(r, 'pet-master').progress, 1);
});

test('连续 7 天解锁「常驻桌宠」，断一天不解锁', () => {
  const ok = A.evaluate(streakStore(2026, 11, 6, 7), NOW);
  assert.ok(ok.unlocked.find((x) => x.id === 'streak-7'), '连续 7 天应解锁');
  assert.ok(!ok.unlocked.find((x) => x.id === 'streak-30'), '铁杆粉丝未到');
  assert.strictEqual(pick(ok, 'streak-7').progress, 1);

  // 只有 6 天连续
  const short = A.evaluate(streakStore(2026, 11, 6, 6), NOW);
  assert.ok(!short.unlocked.find((x) => x.id === 'streak-7'));
  assert.strictEqual(pick(short, 'streak-7').current, 6);
  assert.strictEqual(pick(short, 'streak-7').progress, 6 / 7);
});

test('连续 30 天解锁「铁杆粉丝」', () => {
  const s = streakStore(2026, 11, 6, 30);
  const r = A.evaluate(s, NOW);
  const a = pick(r, 'streak-30');
  assert.ok(r.unlocked.includes(a));
  assert.strictEqual(a.progress, 1);
});

test('streak 成就尊重「今天还没用不算断」的语义', () => {
  // 最后一次记录在 11-05，今天 11-06 还没动，连续天数应照 11-05 往前数
  const s = streakStore(2026, 11, 5, 7);
  const r = A.evaluate(s, NOW);
  assert.ok(r.unlocked.find((x) => x.id === 'streak-7'), '实际连续 7 天，今天未用不算断');
});

test('unlockedAt 是首次达标的日期，不是最后一天', () => {
  // 11-01 完成 1 个番茄钟，11-06 才完成到 10 个
  const s = {
    '2026-11-01': { ...D.emptyDay(), focusDone: 1 },
    '2026-11-06': { ...D.emptyDay(), focusDone: 9 },
  };
  const r = A.evaluate(s, NOW);
  assert.strictEqual(pick(r, 'focus-first').unlockedAt, '2026-11-01', '入门应记首日');
  assert.strictEqual(pick(r, 'focus-regular').unlockedAt, '2026-11-06', '达人应记达标日');
});

test('evaluate 不修改入参 store', () => {
  const s = { '2026-11-06': { ...D.emptyDay(), clicks: 3 } };
  const before = JSON.stringify(s);
  A.evaluate(s, NOW);
  assert.strictEqual(JSON.stringify(s), before);
});

test('非法 nowTs 时不崩，streak 按 0 处理', () => {
  const s = streakStore(2026, 11, 6, 7);
  for (const bad of [NaN, undefined, 'x', 0, -5]) {
    const r = A.evaluate(s, bad);
    assert.ok(!r.unlocked.find((x) => x.id === 'streak-7'), '非法时间不应解锁连续成就');
    // 累计类成就不受 nowTs 影响，仍正常解锁
    assert.ok(r.unlocked.find((x) => x.id === 'first-pet'));
  }
});

test('用 diary.bump 真实累加出来的数据也能正确判定', () => {
  // 不手工拼 store，走 diary 的正常写入路径
  const s = {};
  for (let i = 0; i < 8; i++) D.bump(s, NOW - i * D.DAY_MS, 'clicks');
  const r = A.evaluate(s, NOW);
  assert.ok(r.unlocked.find((x) => x.id === 'first-pet'));
  assert.ok(r.unlocked.find((x) => x.id === 'streak-7'));
  assert.strictEqual(pick(r, 'pet-master').current, 8);
});
