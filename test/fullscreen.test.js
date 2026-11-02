'use strict';
/**
 * 全屏检测：回归测试。
 *
 * 原来用「工作区高度 ≈ 屏幕高度」近似全屏。
 * 任务栏设为「自动隐藏」时这个等式恒成立 ——
 * 宠物会一直隐身，而用户完全不知道为什么，界面上也没有任何提示。
 */
const test = require('node:test');
const assert = require('node:assert');
const F = require('../src/fullscreen');

test('任务栏常驻时，工作区比屏幕矮', () => {
  assert.strictEqual(
    F.isFullscreenByWorkArea({ workH: 1040, screenH: 1080, taskbarAutohide: false }),
    false
  );
});

test('任务栏自动隐藏时不能判为全屏（关键修复）', () => {
  // 此时 workH === screenH，旧逻辑会误判为全屏
  assert.strictEqual(
    F.isFullscreenByWorkArea({ workH: 1080, screenH: 1080, taskbarAutohide: true }),
    false
  );
});

test('真全屏（任务栏常驻时工作区被占满）仍能识别', () => {
  assert.strictEqual(
    F.isFullscreenByWorkArea({ workH: 1080, screenH: 1080, taskbarAutohide: false }),
    true
  );
});

test('非法输入返回 false，不误判', () => {
  assert.strictEqual(F.isFullscreenByWorkArea({}), false);
  assert.strictEqual(F.isFullscreenByWorkArea(null), false);
  assert.strictEqual(F.isFullscreenByWorkArea({ workH: NaN, screenH: 1080 }), false);
});

// ---- 矩形覆盖判断 ----

const scr = { x: 0, y: 0, width: 1920, height: 1080 };

test('完全覆盖屏幕', () => {
  assert.strictEqual(F.coversScreen({ left: 0, top: 0, right: 1920, bottom: 1080 }, scr), true);
});

test('允许 1~2px 误差（部分全屏窗口有边框）', () => {
  assert.strictEqual(F.coversScreen({ left: -1, top: -1, right: 1921, bottom: 1081 }, scr), true);
  assert.strictEqual(F.coversScreen({ left: 1, top: 1, right: 1919, bottom: 1079 }, scr), true);
});

test('明显小于屏幕的窗口不算全屏', () => {
  assert.strictEqual(F.coversScreen({ left: 100, top: 100, right: 1000, bottom: 700 }, scr), false);
});

test('只覆盖一半不算全屏', () => {
  assert.strictEqual(F.coversScreen({ left: 0, top: 0, right: 960, bottom: 1080 }, scr), false);
});

test('副屏坐标（负起点）也能正确判断', () => {
  const second = { x: -1920, y: 0, width: 1920, height: 1080 };
  assert.strictEqual(
    F.coversScreen({ left: -1920, top: 0, right: 0, bottom: 1080 }, second),
    true
  );
});

test('null 输入不崩', () => {
  assert.strictEqual(F.coversScreen(null, scr), false);
  assert.strictEqual(F.coversScreen({ left: 0, top: 0, right: 1, bottom: 1 }, null), false);
});

// ---- 平台函数 ----

test('非 Windows 平台不做原生查询', function () {
  if (process.platform === 'win32') return;  // 该平台下跳过
  assert.strictEqual(F.queryForegroundFullscreen(), null);
  assert.strictEqual(F.isTaskbarAutohide(), false);
});

test('原生查询失败时返回 null 而不是抛异常', () => {
  assert.doesNotThrow(() => F.queryForegroundFullscreen());
  const r = F.queryForegroundFullscreen();
  assert.ok(r === null || (typeof r === 'object' && 'left' in r));
});
