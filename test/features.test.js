'use strict';
/**
 * 新增功能单测：番茄钟 / 喝水提醒 / 负载转速。
 * 这三块的共同风险是「时间判断写错」——早一秒晚一秒用户都能感知到。
 */
const test = require('node:test');
const assert = require('node:assert');
const { PetBrain, STATE, MODE } = require('../src/pet-brain');

const ENV = { screenW: 1920, screenH: 1080, petW: 150, petH: 150 };
const brain = (opts) => new PetBrain({ now: 0, ...opts });

// ---------------- 番茄钟 ----------------

test('默认处于自由模式，没有倒计时', () => {
  const b = brain();
  assert.equal(b.mode, MODE.FREE);
  assert.equal(b.modeRemaining(1000), 0);
});

test('开始专注后倒计时正确递减', () => {
  const b = brain({ focusMs: 60000 });
  b.startFocus(1000);
  assert.equal(b.mode, MODE.FOCUS);
  assert.equal(b.modeRemaining(1000), 60000);
  assert.equal(b.modeRemaining(31000), 30000);
  assert.equal(b.modeRemaining(61000), 0);
});

test('专注到点自动进入休息，并记一次完成', () => {
  const b = brain({ focusMs: 60000, breakMs: 10000 });
  b.startFocus(0);
  b.tick(100, ENV, 30000);
  assert.equal(b.mode, MODE.FOCUS, '没到点不应切换');
  b.tick(100, ENV, 61000);
  assert.equal(b.mode, MODE.BREAK);
  assert.equal(b.stats.focusDone, 1);
  assert.equal(b.reminder.kind, 'focus-done');
});

test('休息到点回到自由模式', () => {
  const b = brain({ focusMs: 1000, breakMs: 5000 });
  b.startFocus(0);
  b.tick(100, ENV, 2000);          // → break
  assert.equal(b.mode, MODE.BREAK);
  b.tick(100, ENV, 8000);          // 休息结束
  assert.equal(b.mode, MODE.FREE);
  assert.equal(b.reminder.kind, 'break-done');
});

test('提前停止专注：回到自由模式且不计完成', () => {
  const b = brain({ focusMs: 60000 });
  b.startFocus(0);
  b.stopFocus(5000);
  assert.equal(b.mode, MODE.FREE);
  assert.equal(b.stats.focusDone, 0);
});

test('专注期间不会自己走开、也不会睡着', () => {
  const b = brain({ focusMs: 3600000, walkIntervalMs: 100, sleepAfterMs: 200 });
  b.startFocus(0);
  for (let t = 100; t < 5000; t += 100) b.tick(100, ENV, t);
  assert.equal(b.state, STATE.IDLE, '专注时应保持原位，不能乱走');
  assert.notEqual(b.state, STATE.SLEEP, '专注时不该睡');
});

test('专注起点晚于 tick 时不会误触发', () => {
  const b = brain({ focusMs: 10000 });
  b.startFocus(50000);
  b.tick(100, ENV, 50000);
  assert.equal(b.mode, MODE.FOCUS);
  assert.ok(b.modeRemaining(50000) === 10000);
});

// ---------------- 喝水提醒 ----------------

test('到点提醒喝水，并计入统计', () => {
  const b = brain({ sipIntervalMs: 60000, sipRemindMs: 10000 });
  b.tick(100, ENV, 30000);
  assert.equal(b.reminder, null, '没到点不应提醒');
  b.tick(100, ENV, 61000);
  assert.equal(b.reminder.kind, 'sip');
  assert.equal(b.stats.sips, 1);
});

test('喝水提醒到期自动收起', () => {
  const b = brain({ sipIntervalMs: 60000, sipRemindMs: 5000 });
  b.tick(100, ENV, 61000);
  assert.equal(b.reminder.kind, 'sip');
  b.tick(100, ENV, 61000 + 6000);
  assert.equal(b.reminder, null, '过了提醒时长应收起');
});

test('点一下会收起提醒（用户看到了）', () => {
  const b = brain({ sipIntervalMs: 60000 });
  b.tick(100, ENV, 61000);
  assert.ok(b.reminder);
  b.click(62000);
  assert.equal(b.reminder, null);
});

test('休息期间不叠加喝水提醒', () => {
  const b = brain({ focusMs: 1000, breakMs: 120000, sipIntervalMs: 500 });
  b.startFocus(0);
  b.tick(100, ENV, 2000);   // 进入 break
  assert.equal(b.mode, MODE.BREAK);
  b.tick(100, ENV, 3000);
  assert.ok(!b.reminder || b.reminder.kind !== 'sip', '休息中不应额外催喝水');
});

test('提醒不会连续刷屏：每轮只触发一次', () => {
  const b = brain({ sipIntervalMs: 60000, sipRemindMs: 20000 });
  let count = 0;
  let last = null;
  for (let t = 0; t < 120000; t += 100) {
    b.tick(100, ENV, t);
    const k = b.reminder ? b.reminder.kind : null;
    if (k === 'sip' && last !== 'sip') count++;
    last = k;
  }
  assert.ok(count >= 1 && count <= 3, `两分钟内应提醒 1–2 次，实际 ${count}`);
});

// ---------------- 负载 → 转速 ----------------

test('负载 0 时也有基础转速（看得见在转）', () => {
  const b = brain();
  b.setLoad(0, 1000);
  assert.ok(b.spin > 0.2 && b.spin < 0.4, `空载转速应在 0.25 附近，实际 ${b.spin}`);
});

test('负载越高转得越快', () => {
  const low = brain(); low.setLoad(0.1, 2000);
  const high = brain(); high.setLoad(0.95, 2000);
  assert.ok(high.spin > low.spin, '高负载应比低负载转得快');
  assert.ok(high.spin <= 1.0);
});

test('转速平滑过渡，不会突跳', () => {
  const b = brain();
  b.spin = 0.25;
  b.setLoad(1.0, 16);   // 一帧
  assert.ok(b.spin < 0.6, `一帧内不应跳到满速，实际 ${b.spin}`);
  for (let i = 0; i < 60; i++) b.setLoad(1.0, 16);
  assert.ok(b.spin > 0.9, '持续满载后应接近满速');
});

test('非法负载值被忽略，不会把转速搞成 NaN', () => {
  const b = brain();
  const before = b.spin;
  b.setLoad(NaN, 16);
  b.setLoad(undefined, 16);
  b.setLoad(Infinity, 16);
  assert.ok(Number.isFinite(b.spin), 'spin 必须保持有限值');
  assert.ok(b.spin >= 0 && b.spin <= 1);
});

test('隐藏状态下不更新转速（省电）', () => {
  const b = brain();
  b.setHidden(true, 100);
  const before = b.spin;
  b.tick(1000, ENV, 5000);
  assert.equal(b.spin, before);
});

test('每帧动作里带上当前提醒，供 UI 直接渲染', () => {
  const b = brain({ sipIntervalMs: 60000 });
  const act = b.tick(100, ENV, 61000);
  assert.ok(act.reminder);
  assert.equal(act.reminder.kind, 'sip');
});
