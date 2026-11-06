'use strict';
/**
 * edge-hide 的单元测试
 *
 * 这一层最容易出的问题是「闪一下就没了」和「再也弹不出来」，
 * 都是时序问题，必须用假时钟稳定复现。
 */
const test = require('node:test');
const assert = require('node:assert');
const { EdgeHide, SIDE } = require('../src/edge-hide.js');

function rect(x, y, w, h) {
  return { x, y, width: w || 150, height: h || 150 };
}

test('初始状态：不贴边、不收起', () => {
  const e = new EdgeHide();
  assert.strictEqual(e.side, SIDE.NONE);
  assert.strictEqual(e.collapsed, false);
});

test('贴上左边缘后立刻收起', () => {
  const e = new EdgeHide();
  e.attach(SIDE.LEFT);
  assert.strictEqual(e.side, SIDE.LEFT);
  assert.strictEqual(e.collapsed, true);
});

test('detach 后不再贴边', () => {
  const e = new EdgeHide();
  e.attach(SIDE.RIGHT);
  e.detach();
  assert.strictEqual(e.side, SIDE.NONE);
  assert.strictEqual(e.collapsed, false);
});

test('attach 传入非法值等于 detach', () => {
  const e = new EdgeHide();
  e.attach(SIDE.LEFT);
  e.attach('top');
  assert.strictEqual(e.side, SIDE.NONE);
  assert.strictEqual(e.collapsed, false);
});

test('收起时左边缘只露 peekPx', () => {
  const e = new EdgeHide({ peekPx: 6 });
  e.attach(SIDE.LEFT);
  const g = e.collapsedGeometry(rect(0, 300), 1920);
  // 左边缘：窗口左坐标应为负，只露右侧 6px
  assert.strictEqual(g.x, -(150 - 6));
  assert.strictEqual(g.x + g.width, 6, '露出的宽度应等于 peekPx');
});

test('收起时右边缘只露 peekPx', () => {
  const e = new EdgeHide({ peekPx: 6 });
  e.attach(SIDE.RIGHT);
  const g = e.collapsedGeometry(rect(1770, 300), 1920);
  assert.strictEqual(g.x, 1920 - 6);
});

test('展开时回到完全可见位置', () => {
  const e = new EdgeHide();
  e.attach(SIDE.LEFT);
  const g = e.expandedGeometry(rect(0, 300), 1920);
  assert.strictEqual(g.x, 0);
});

test('右边缘展开贴右', () => {
  const e = new EdgeHide();
  e.attach(SIDE.RIGHT);
  const g = e.expandedGeometry(rect(1770, 300), 1920);
  assert.strictEqual(g.x, 1920 - 150);
});

test('左边缘热区判定', () => {
  const e = new EdgeHide({ hotZonePx: 10 });
  e.attach(SIDE.LEFT);
  const r = rect(0, 300);
  assert.ok(e.inHotZone(3, 350, r, 1920), '屏幕左侧 3px 内算热区');
  assert.ok(!e.inHotZone(50, 350, r, 1920), '远处不算');
});

test('右边缘热区判定', () => {
  const e = new EdgeHide({ hotZonePx: 10 });
  e.attach(SIDE.RIGHT);
  const r = rect(1770, 300);
  assert.ok(e.inHotZone(1915, 350, r, 1920));
  assert.ok(!e.inHotZone(1000, 350, r, 1920));
});

test('热区不覆盖整条屏幕边（纵向要落在窗口范围内）', () => {
  const e = new EdgeHide();
  e.attach(SIDE.LEFT);
  const r = rect(0, 300);   // y 300..450
  assert.ok(!e.inHotZone(3, 100, r, 1920), '窗口上方不算热区');
  assert.ok(!e.inHotZone(3, 800, r, 1920), '窗口下方不算热区');
});

test('未贴边时任何位置都不算热区', () => {
  const e = new EdgeHide();
  assert.ok(!e.inHotZone(0, 350, rect(0, 300), 1920));
});

test('鼠标进入立刻展开', () => {
  const e = new EdgeHide();
  e.attach(SIDE.LEFT);
  assert.strictEqual(e.collapsed, true);
  e.enter(1000);
  assert.strictEqual(e.collapsed, false);
  assert.strictEqual(e.tick(1000), false);
});

test('鼠标离开后要等 grace 才收起', () => {
  const e = new EdgeHide({ graceMs: 420 });
  e.attach(SIDE.LEFT);
  e.enter(1000);
  e.leave(2000);

  assert.strictEqual(e.tick(2100), false, '刚离开不该立刻收');
  assert.strictEqual(e.tick(2300), false, '还在 grace 内');
  assert.strictEqual(e.tick(2420), true, '超过 grace 应收起');
});

test('离开后又回来，不收起（grace 被重置）', () => {
  const e = new EdgeHide({ graceMs: 420 });
  e.attach(SIDE.LEFT);
  e.enter(1000);
  e.leave(2000);
  e.tick(2300);          // 还没到 grace
  e.enter(2350);         // 又回来了
  assert.strictEqual(e.tick(3000), false, '回来后不应收起');
});

test('菜单钉住时，鼠标离开也不收', () => {
  const e = new EdgeHide({ graceMs: 100 });
  e.attach(SIDE.LEFT);
  e.enter(1000);
  e.setPinned(true);
  e.leave(1100);
  assert.strictEqual(e.tick(9999), false, '钉住状态下不该收');
});

test('取消钉住后恢复自动收起', () => {
  const e = new EdgeHide({ graceMs: 100 });
  e.attach(SIDE.LEFT);
  e.enter(1000);
  e.setPinned(true);
  e.leave(1100);
  e.tick(1200);
  e.setPinned(false);
  assert.strictEqual(e.tick(1300), true);
});

test('钉住状态会自动展开', () => {
  const e = new EdgeHide();
  e.attach(SIDE.LEFT);
  assert.strictEqual(e.collapsed, true);
  e.setPinned(true);
  assert.strictEqual(e.collapsed, false);
});

test('未贴边时 tick 永远不收起', () => {
  const e = new EdgeHide();
  e.leave(1000);
  assert.strictEqual(e.tick(99999), false);
});

test('收起的几何：展开后恢复原宽度', () => {
  const e = new EdgeHide({ peekPx: 6 });
  e.attach(SIDE.LEFT);
  const c = e.collapsedGeometry(rect(0, 300), 1920);
  const x = e.expandedGeometry(rect(0, 300), 1920);
  assert.strictEqual(c.width, 150);
  assert.strictEqual(x.width, 150);
  assert.notStrictEqual(c.x, x.x);
});

test('snapshot 反映当前状态', () => {
  const e = new EdgeHide();
  e.attach(SIDE.RIGHT);
  e.enter(1);
  const s = e.snapshot();
  assert.strictEqual(s.side, 'right');
  assert.strictEqual(s.collapsed, false);
  assert.strictEqual(s.hovering, true);
});

test('从贴左切换到贴右', () => {
  const e = new EdgeHide({ peekPx: 6 });
  e.attach(SIDE.LEFT);
  e.attach(SIDE.RIGHT);
  assert.strictEqual(e.side, SIDE.RIGHT);
  const g = e.collapsedGeometry(rect(0, 300), 1920);
  assert.strictEqual(g.x, 1920 - 6);
});

/* ---------------- 内容内缩：贴边隐藏不能让宠物整个消失 ---------------- */

test('窗口比宠物宽时，收起后屏幕内留下的那一截是宠物本体', () => {
  // 真实参数：窗口 260 宽，风扇 108 宽居中，两侧各 76 留白
  const e = new EdgeHide({ peekPx: 28, contentInsetPx: 76, contentWidthPx: 108 });
  e.attach(SIDE.LEFT);

  const rect = { x: 0, y: 200, width: 260, height: 340 };
  const g = e.collapsedGeometry(rect, 1280);

  // 宠物在窗口内占 76..184，换算到屏幕坐标：
  const petLeft = g.x + 76;
  const petRight = g.x + 184;

  // 关键断言：屏幕内 0..peek 这一截必须落在宠物身上，
  // 而不是落在窗口的透明留白里 —— 否则看起来就是"整个消失"
  assert.strictEqual(petRight, 28, '宠物右边缘应正好停在 peekPx');
  assert.ok(petLeft < 0, '宠物大部分应在屏幕外');
  assert.ok(petLeft < 0 && petRight === 28,
    '屏幕可见的 0..28 落在宠物区间 (' + petLeft + '..' + petRight + ') 内');
});

test('右边缘收起同样按宠物本体计算', () => {
  const e = new EdgeHide({ peekPx: 28, contentInsetPx: 76, contentWidthPx: 108 });
  e.attach(SIDE.RIGHT);

  const rect = { x: 1000, y: 200, width: 260, height: 340 };
  const g = e.collapsedGeometry(rect, 1280);

  const petLeft = g.x + 76;
  assert.strictEqual(petLeft, 1280 - 28, '右边缘收起后，宠物左边缘应正好停在 sw-peek');
});

test('不传内容宽度时退化为按窗口边界计算（向后兼容）', () => {
  const e = new EdgeHide({ peekPx: 6 });
  e.attach(SIDE.LEFT);
  const g = e.collapsedGeometry({ x: 0, y: 0, width: 150, height: 150 }, 1920);
  assert.strictEqual(g.x + 150, 6, '露出的宽度应等于 peekPx');
});

test('收起后仍有至少 peekPx 宽度可被鼠标命中', () => {
  const e = new EdgeHide({ peekPx: 28, contentInsetPx: 76, contentWidthPx: 108 });
  e.attach(SIDE.LEFT);
  const g = e.collapsedGeometry({ x: 0, y: 200, width: 260, height: 340 }, 1280);
  const visibleWidth = Math.min(g.width, 0 - g.x);
  assert.ok(visibleWidth >= 28, '屏幕内应留有足够命中的宽度，实际 ' + visibleWidth);
});
