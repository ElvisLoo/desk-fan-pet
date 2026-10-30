'use strict';
/**
 * 边缘攀爬单测。
 * 风险点：坐标算错会挂到屏幕外、贴边判定过宽会让宠物乱吸附、爬上去下不来。
 */
const test = require('node:test');
const assert = require('node:assert');
const { PetBrain, STATE, EDGE } = require('../src/pet-brain');

const ENV = { screenW: 1920, screenH: 1080, petW: 150, petH: 150 };
const brain = (opts) => new PetBrain({ now: 0, ...opts });

test('拖到左边缘会贴上', () => {
  const b = brain({ edgeSnapPx: 40 });
  b.dragStart(0);
  b.dragEnd(0.01, 0.5, 100, ENV);
  assert.equal(b.edge, EDGE.LEFT);
  assert.equal(b.state, STATE.CLIMB);
  assert.equal(b.x, 0, '贴上后应吸到最左');
});

test('拖到右边缘会贴上', () => {
  const b = brain({ edgeSnapPx: 40 });
  b.dragStart(0);
  b.dragEnd(0.99, 0.5, 100, ENV);
  assert.equal(b.edge, EDGE.RIGHT);
  assert.equal(b.x, 1);
});

test('拖到屏幕中间不吸附', () => {
  const b = brain({ edgeSnapPx: 20 });
  b.dragStart(0);
  b.dragEnd(0.5, 0.5, 100, ENV);
  assert.equal(b.edge, EDGE.NONE);
  assert.equal(b.state, STATE.IDLE);
});

test('贴边距离按像素算，而不是按比例', () => {
  // 1920 宽下 0.02 只有 35px 左右；snap 设 10 就不该吸附
  const b = brain({ edgeSnapPx: 10 });
  b.dragStart(0);
  b.dragEnd(0.02, 0.5, 100, ENV);
  assert.equal(b.edge, EDGE.NONE, '35px 距离超过 10px 阈值，不该吸附');
});

test('攀爬时 y 坐标逐帧变化，且不越界', () => {
  const b = brain({ edgeSnapPx: 40, climbSpeedPxPerSec: 100, climbIdleMs: 60000 });
  b.dragStart(0);
  b.dragEnd(0, 0.5, 0, ENV);
  let ys = [];
  for (let t = 100; t <= 3000; t += 100) {
    b.tick(100, ENV, t);
    ys.push(b.y);
    assert.ok(b.y >= 0 && b.y <= 1, `y=${b.y} 越界`);
  }
  const moved = ys.some((y) => Math.abs(y - ys[0]) > 0.001);
  assert.ok(moved, '贴在边上应该一直在爬');
});

test('爬到顶端会掉头往下', () => {
  const b = brain({ edgeSnapPx: 40, climbSpeedPxPerSec: 5000, climbIdleMs: 600000 });
  b.dragStart(0);
  b.dragEnd(0, 0.5, 0, ENV);
  let dirChanged = false;
  for (let t = 100; t <= 5000; t += 100) {
    const before = b.climbDir;
    b.tick(100, ENV, t);
    if (b.climbDir !== before) dirChanged = true;
  }
  assert.ok(dirChanged, '撞到边界应掉头');
});

test('爬一会儿会自己下来', () => {
  const b = brain({ edgeSnapPx: 40, climbIdleMs: 1000 });
  b.dragStart(0);
  b.dragEnd(0, 0.5, 0, ENV);
  assert.equal(b.edge, EDGE.LEFT);
  b.tick(100, ENV, 1500);
  assert.equal(b.edge, EDGE.NONE, '超过 climbIdleMs 应自动脱离');
  assert.equal(b.state, STATE.IDLE);
});

test('点一下会让它从边缘下来', () => {
  const b = brain({ edgeSnapPx: 40 });
  b.dragStart(0);
  b.dragEnd(0, 0.5, 100, ENV);
  assert.equal(b.edge, EDGE.LEFT);
  b.click(200);
  assert.equal(b.edge, EDGE.NONE);
  assert.ok(b.x > 0, '离开边缘时应往中间挪一点');
});

test('脱离边缘后不会立刻又被吸附', () => {
  const b = brain({ edgeSnapPx: 40 });
  b.dragStart(0);
  b.dragEnd(0, 0.5, 100, ENV);
  b.detachFromEdge(200);
  // 模拟拖放结束时的吸附判断
  const again = b.attachToEdge(ENV, 300);
  assert.equal(again, false, '离开时留的间隙应大于吸附阈值');
});

test('攀爬时不会自己走开', () => {
  const b = brain({ edgeSnapPx: 40, walkIntervalMs: 10, climbIdleMs: 600000 });
  b.dragStart(0);
  b.dragEnd(0, 0.5, 0, ENV);
  for (let t = 100; t <= 2000; t += 100) b.tick(100, ENV, t);
  assert.equal(b.edge, EDGE.LEFT, '应一直贴在边上');
  assert.notEqual(b.state, STATE.WALK);
});

test('隐藏状态下不攀爬', () => {
  const b = brain({ edgeSnapPx: 40, climbIdleMs: 600000 });
  b.dragStart(0);
  b.dragEnd(0, 0.5, 0, ENV);
  b.setHidden(true, 100);
  const y0 = b.y;
  b.tick(1000, ENV, 2000);
  assert.equal(b.y, y0, '隐藏时不应移动');
});

test('贴边状态下坐标换算仍在屏幕内', () => {
  const b = brain({ edgeSnapPx: 40 });
  b.dragStart(0);
  b.dragEnd(0, 0.5, 0, ENV);
  for (let t = 100; t <= 3000; t += 100) {
    b.tick(100, ENV, t);
    const p = b.toPixels(ENV);
    assert.ok(p.x >= 0 && p.x + 150 <= ENV.screenW, `x=${p.x} 放不下`);
    assert.ok(p.y >= 0 && p.y + 150 <= ENV.screenH, `y=${p.y} 放不下`);
  }
});
