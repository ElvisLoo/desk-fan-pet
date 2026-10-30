'use strict';
/**
 * 稳定性回归：托盘常驻类应用的失败模式几乎都在「静默」上。
 *
 * 桌面宠物用户的预期是「它一直在」。所以任何让它变透明、变空白、
 * 或者点了没反应的问题，都比普通应用更致命 —— 因为没有窗口可以关，
 * 用户甚至不知道该重启。
 *
 * Electron 需要真实运行时，这里用静态约束锁定必须存在的兜底。
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const MAIN = path.join(__dirname, '..', 'src', 'main.js');
const src = fs.readFileSync(MAIN, 'utf8');

test('渲染进程崩溃后自动恢复', () => {
  assert.ok(src.includes("'render-process-gone'"), '应监听渲染进程退出');
  assert.ok(src.includes('win.reload()'), '应重新加载页面');
  assert.ok(src.includes('MAX_CRASH_RELOAD'), '应有恢复次数上限');
});

test('恢复次数有上限，不会打成无限重启', () => {
  assert.ok(/crashCount\s*>=\s*MAX_CRASH_RELOAD/.test(src), '超限应停止恢复');
  assert.ok(/crashCount\s*\+=\s*1/.test(src), '应累加计数');
});

test('恢复前检查窗口仍然存在', () => {
  const seg = src.slice(src.indexOf("'render-process-gone'"));
  const body = seg.slice(0, 900);
  assert.ok(body.includes('isDestroyed()'), 'reload 前应确认窗口未销毁');
});

test('页面加载失败有日志，不静默', () => {
  assert.ok(src.includes("'did-fail-load'"), '应监听加载失败');
});

test('进程级异常兜底', () => {
  assert.ok(src.includes("process.on('uncaughtException'"), '应有 uncaughtException');
  assert.ok(src.includes("process.on('unhandledRejection'"), '应有 unhandledRejection');
});

test('启动链失败不静默退出', () => {
  assert.ok(/\.catch\(\(err\)\s*=>/.test(src), 'whenReady 后应接 catch');
  assert.ok(src.includes('app.exit(1)'), '启动失败应明确退出');
});

test('热键注册结果被检查，失败有可见反馈', () => {
  assert.ok(/const hotkeyOk\s*=\s*globalShortcut\.register/.test(src), '应保存注册结果');
  assert.ok(/if\s*\(!hotkeyOk\)/.test(src), '失败时应走分支');
  assert.ok(src.includes('setToolTip'), '失败时应改变托盘提示');
});
