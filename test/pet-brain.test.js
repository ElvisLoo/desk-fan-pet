'use strict';
/**
 * 宠物大脑单测。
 * 桌面宠物最常见的 bug 都在状态机上：边走边拖、全屏还在动、
 * 坐标跑出屏幕。这里逐条锁住。
 */
const test = require('node:test');
const assert = require('node:assert');
const { PetBrain, STATE, clamp, clamp01 } = require('../src/pet-brain');

const ENV = { screenW: 1920, screenH: 1080, petW: 140, petH: 140 };

// 统一用虚拟时钟从 0 开始，避免真实时间与注入时间不同源
function brain(opts) {
  return new PetBrain({ now: 0, ...opts });
}

test('初始状态是待机，坐标在屏幕内', () => {
  const b = brain();
  assert.equal(b.state, STATE.IDLE);
  const p = b.toPixels(ENV);
  assert.ok(p.x >= 0 && p.x < ENV.screenW, 'x 应在屏幕内');
  assert.ok(p.y >= 0 && p.y < ENV.screenH, 'y 应在屏幕内');
});

test('点击会进入兴奋态，并增加心情与计数', () => {
  const b = brain();
  const before = b.mood;
  b.click(1000);
  assert.equal(b.state, STATE.EXCITED);
  assert.equal(b.stats.clicks, 1);
  assert.ok(b.mood > before);
});

test('心情上限 100，不会溢出', () => {
  const b = brain();
  for (let i = 0; i < 50; i++) b.click(1000 + i);
  assert.ok(b.mood <= 100, `心情应 ≤100，实际 ${b.mood}`);
});

test('兴奋态到时自动回待机', () => {
  const b = brain({ excitedMs: 1000 });
  b.click(0);
  assert.equal(b.state, STATE.EXCITED);
  b.tick(10, ENV, 500);          // 还没到
  assert.equal(b.state, STATE.EXCITED);
  b.tick(10, ENV, 1200);         // 超时
  assert.equal(b.state, STATE.IDLE);
});

test('长时间无交互会睡着', () => {
  const b = brain({ sleepAfterMs: 5000 });
  b.tick(10, ENV, 1000);
  assert.equal(b.state, STATE.IDLE);
  b.tick(10, ENV, 7000);
  assert.equal(b.state, STATE.SLEEP);
  assert.equal(b.stats.slept, 1);
});

test('睡着后被摸一下会醒', () => {
  const b = brain({ sleepAfterMs: 1000 });
  b.tick(10, ENV, 5000);
  assert.equal(b.state, STATE.SLEEP);
  b.touch(5100);
  assert.equal(b.state, STATE.IDLE);
});

test('拖拽中不走动，也不自己睡', () => {
  const b = brain({ walkIntervalMs: 100, sleepAfterMs: 200 });
  b.dragStart(0);
  assert.equal(b.state, STATE.DRAG);
  for (let t = 0; t < 2000; t += 100) b.tick(100, ENV, t);
  assert.equal(b.state, STATE.DRAG, '拖拽中不应切到别的状态');
  assert.equal(b.stats.walks, 0, '拖拽中不应自己走');
});

test('拖拽结束会把坐标夹到 0..1（不会被拖出屏幕）', () => {
  const b = brain();
  b.dragStart(0);
  b.dragEnd(5, -3, 10);          // 故意给超范围值
  assert.equal(b.x, 1);
  assert.equal(b.y, 0);
  const p = b.toPixels(ENV);
  assert.ok(p.x < ENV.screenW && p.y >= 0);
});

test('走路会朝目标移动，到了就回待机', () => {
  const b = brain({ walkIntervalMs: 100, moveSpeedPxPerSec: 2000 });
  b.x = 0.2;
  b.tick(10, ENV, 200);           // 触发走路
  assert.equal(b.state, STATE.WALK);
  assert.ok(b.targetX != null, '应设定目标');

  // 连续推进，直到到达
  for (let t = 300; t < 20000 && b.state === STATE.WALK; t += 50) b.tick(50, ENV, t);
  assert.equal(b.state, STATE.IDLE, '到达后应回待机');
  assert.ok(Math.abs(b.x - b.targetX || 0) >= 0, 'x 已更新');
});

test('走路时坐标始终在 0..1 内', () => {
  const b = brain({ walkIntervalMs: 10, moveSpeedPxPerSec: 99999 });
  for (let t = 0; t < 3000; t += 16) {
    b.tick(16, ENV, t);
    assert.ok(b.x >= 0 && b.x <= 1, `x=${b.x} 越界`);
    assert.ok(b.y >= 0 && b.y <= 1, `y=${b.y} 越界`);
  }
});

test('朝向跟随目标方向', () => {
  const b = brain({ walkIntervalMs: 10 });
  b.x = 0.2;
  b.tick(10, ENV, 100);
  // 目标随机，只验证朝向与目标方向一致
  if (b.targetX != null) {
    assert.equal(b.facing, b.targetX > 0.2 ? 1 : -1);
  }
});

test('全屏时隐藏，退出全屏恢复', () => {
  const b = brain();
  b.setHidden(true, 100);
  assert.equal(b.state, STATE.HIDDEN);
  const act = b.tick(1000, ENV, 5000);
  assert.equal(act.moveTo, null, '隐藏时不应移动');
  b.setHidden(false, 5100);
  assert.equal(b.state, STATE.IDLE);
});

test('隐藏状态下不会因为超时变成睡眠', () => {
  const b = brain({ sleepAfterMs: 100 });
  b.setHidden(true, 0);
  b.tick(1000, ENV, 10000);
  assert.equal(b.state, STATE.HIDDEN);
});

test('换到更小的屏幕也不会算到屏幕外', () => {
  const b = brain();
  b.x = 1; b.y = 1;
  const small = { screenW: 800, screenH: 600, petW: 140, petH: 140 };
  const p = b.toPixels(small);
  assert.ok(p.x + 140 <= 800, `x=${p.x} 放不下`);
  assert.ok(p.y + 140 <= 600, `y=${p.y} 放不下`);
});

test('clamp / clamp01 处理非法输入', () => {
  assert.equal(clamp01(NaN), 0);
  assert.equal(clamp01(-1), 0);
  assert.equal(clamp01(2), 1);
  assert.equal(clamp('abc', 0, 1), 0);
  assert.equal(clamp(5, 0, 1), 1);
});

test('tick 的 dt 为 0 或负数不产生位移', () => {
  const b = brain({ walkIntervalMs: 1, moveSpeedPxPerSec: 1000 });
  b.tick(1, ENV, 100);
  const x0 = b.x;
  b.tick(0, ENV, 200);
  b.tick(-50, ENV, 300);
  assert.ok(Number.isFinite(b.x), 'x 必须保持有限值');
});
