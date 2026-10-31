'use strict';
/**
 * 番茄钟计时：边界验证。
 *
 * 关注的是「跨过一次长时间跳跃后，会不会连发一堆提醒」。
 * 场景很现实：合上笔记本 2 小时再打开，如果每次 tick 都判定一次超时，
 * 用户会被连续弹窗轰炸。
 */
const test = require('node:test');
const assert = require('node:assert');
const { PetBrain, MODE } = require('../src/pet-brain');

function makeBrain(now = 1000000) {
  let t = now;
  const b = new PetBrain({
    // 用 clock 注入，所有方法的默认参数都走它。
    // 原来只注入 now（构造期时间戳），各处 `now = Date.now()` 仍读系统时间，
    // 两套来源混用 —— 测试测不到，系统校时后线上会算错。
    clock: () => t,
    focusMs: 25 * 60 * 1000,
    breakMs: 5 * 60 * 1000,
    waterMs: 45 * 60 * 1000,
  });
  b.advance = (ms) => { t += ms; return t; };
  return { brain: b, at: () => t };
}

test('开始专注后剩 25 分钟', () => {
  const { brain, at } = makeBrain();
  brain.startFocus();
  assert.strictEqual(brain.mode, MODE.FOCUS);
  assert.strictEqual(brain.modeRemaining(at()), 25 * 60 * 1000);
});

test('时间推进后剩余量正确递减', () => {
  const { brain, at } = makeBrain();
  brain.startFocus();
  brain.advance(10 * 60 * 1000);
  assert.strictEqual(brain.modeRemaining(at()), 15 * 60 * 1000);
});

test('时间跳跃远超时长时剩余量夹到 0，不出现负数', () => {
  const { brain, at } = makeBrain();
  brain.startFocus();
  brain.advance(3 * 60 * 60 * 1000);   // 合盖 3 小时
  const r = brain.modeRemaining(at());
  assert.strictEqual(r, 0);
  assert.ok(!(r < 0), '不能出现负数，否则界面会显示 -12345');
});

test('休眠唤醒后不会反复触发同一事件', () => {
  // 提醒本身要持续显示（15 秒），所以 act.reminder 非空是对的；
  // 真正要守住的是"事件只发生一次"：focusDone 只加 1，
  // 且喝水提醒不会因为跨了几小时就补发一串。
  const { brain, at } = makeBrain();
  brain.startFocus();
  const before = brain.stats.focusDone;
  brain.advance(3 * 60 * 60 * 1000);

  let lastKind = null;
  const kinds = new Set();
  for (let i = 0; i < 20; i += 1) {
    brain.advance(50);
    const act = brain.tick(50, {}, at());
    if (act && act.reminder) { kinds.add(act.reminder.kind); lastKind = act.reminder.kind; }
  }

  assert.strictEqual(brain.stats.focusDone - before, 1, '专注结束事件只应计一次');
  assert.deepStrictEqual([...kinds], ['focus-done'], '唤醒后不应补发喝水提醒');
  assert.strictEqual(lastKind, 'focus-done');
});

test('休眠很久后喝水提醒只补一次并重新排期', () => {
  const { brain, at } = makeBrain();
  brain.startFocus();
  const before = brain.stats.sips;
  // 跳过专注与休息，直接落到 FREE 态
  brain.advance(31 * 60 * 1000);
  brain.tick(50, {}, at());
  brain.advance(10 * 60 * 1000);
  brain.tick(50, {}, at());
  const sips0 = brain.stats.sips;

  // 再跳 3 小时（远超 45 分钟间隔）
  brain.advance(3 * 60 * 60 * 1000);
  let sips = 0;
  for (let i = 0; i < 30; i += 1) {
    brain.advance(50);
    brain.tick(50, {}, at());
  }
  sips = brain.stats.sips - sips0;
  assert.strictEqual(sips, 1, `3 小时只应补一次提醒，实际 ${sips} 次`);
  assert.ok(sips <= 1);
});

test('剩余 0 之后模式不再停留在 FOCUS', () => {
  const { brain, at } = makeBrain();
  brain.startFocus();
  brain.advance(30 * 60 * 1000);
  brain.tick(50, {}, at());
  assert.notStrictEqual(brain.mode, MODE.FOCUS, '超时后应离开专注态');
});

test('dt 为异常值时不炸', () => {
  const { brain, at } = makeBrain();
  brain.startFocus();
  for (const dt of [0, -1, NaN, Infinity, 1e12]) {
    assert.doesNotThrow(() => brain.tick(dt, {}, at()));
  }
});
