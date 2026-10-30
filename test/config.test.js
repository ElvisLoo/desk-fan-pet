'use strict';
/**
 * 配置持久化：回归测试。
 *
 * 桌面宠物的配置有一个特殊之处：它是"坏了不报错"的软件。
 * 配置文件被手改坏、写盘失败、坐标落到已拔掉的屏幕上，
 * 都不能让它启动不了 —— 用户不会去看日志，只会觉得"这软件坏了"。
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { Config, DEFAULTS, sanitize, clampInt } = require('../src/config');

function tmpFile() {
  return path.join(os.tmpdir(), 'pet-cfg-' + Date.now() + '-' + Math.random().toString(16).slice(2) + '.json');
}

test('首次启动：文件不存在时用默认值，不报错', () => {
  const c = new Config(tmpFile());
  const d = c.load();
  assert.deepStrictEqual(d, DEFAULTS);
});

test('保存后能读回', () => {
  const f = tmpFile();
  const a = new Config(f);
  a.load();
  assert.ok(a.set({ x: 120, y: 340, placed: true }).ok);
  const b = new Config(f);
  b.load();
  assert.strictEqual(b.get('x'), 120);
  assert.strictEqual(b.get('y'), 340);
  assert.strictEqual(b.get('placed'), true);
  fs.unlinkSync(f);
});

test('坏 JSON 不抛错，回退默认值并留一份坏文件', () => {
  const f = tmpFile();
  fs.writeFileSync(f, '{ this is not json');
  const c = new Config(f);
  assert.doesNotThrow(() => c.load());
  assert.deepStrictEqual(c.data, DEFAULTS);
  assert.ok(fs.existsSync(f + '.bad'), '应备份坏文件便于排查');
  fs.unlinkSync(f);
  try { fs.unlinkSync(f + '.bad'); } catch (_) {}
});

test('已知字段之外的键被丢弃', () => {
  const s = sanitize({ x: 1, y: 2, evil: 'x', __proto__: { polluted: true } });
  assert.ok(!('evil' in s));
  assert.strictEqual(s.x, 1);
});

test('数值型配置被夹到合法区间', () => {
  assert.strictEqual(sanitize({ focusMinutes: 9999 }).focusMinutes, 180);
  assert.strictEqual(sanitize({ focusMinutes: -5 }).focusMinutes, 1);
  assert.strictEqual(sanitize({ waterMinutes: -1 }).waterMinutes, 0);
});

test('字符串数字也能转成数字（手改配置常见）', () => {
  assert.strictEqual(sanitize({ focusMinutes: '30' }).focusMinutes, 30);
});

test('非数字回退默认值，不产生 NaN', () => {
  for (const bad of ['abc', null, undefined, {}, [], NaN]) {
    assert.strictEqual(sanitize({ focusMinutes: bad }).focusMinutes, DEFAULTS.focusMinutes);
  }
});

test('布尔字段只接受真正的布尔', () => {
  assert.strictEqual(sanitize({ followCpu: 'false' }).followCpu, DEFAULTS.followCpu);
  assert.strictEqual(sanitize({ followCpu: false }).followCpu, false);
});

test('坐标允许负数（副屏在主屏左侧），但拒绝荒谬值', () => {
  assert.strictEqual(sanitize({ x: -1920 }).x, -1920);
  assert.strictEqual(sanitize({ x: 9e9 }).x, DEFAULTS.x);
  assert.strictEqual(sanitize({ x: Infinity }).x, DEFAULTS.x);
});

test('placed 只认布尔 true', () => {
  assert.strictEqual(sanitize({ placed: 1 }).placed, false);
  assert.strictEqual(sanitize({ placed: 'true' }).placed, false);
  assert.strictEqual(sanitize({ placed: true }).placed, true);
});

test('clampInt 边界', () => {
  assert.strictEqual(clampInt(5, 1, 10, 0), 5);
  assert.strictEqual(clampInt(0, 1, 10, 0), 1);
  assert.strictEqual(clampInt(11, 1, 10, 0), 10);
  assert.strictEqual(clampInt('x', 1, 10, 7), 7);
});

test('写盘用临时文件 + rename，中途失败不留半截 JSON', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'config.js'), 'utf8');
  assert.ok(src.includes('.tmp'), '应写临时文件');
  assert.ok(src.includes('renameSync'), '应原子替换');
});

test('保存失败返回 ok:false 而不是抛错', () => {
  // 用非法文件名触发失败（Windows 下 ":" 不能出现在文件名里）。
  // 不能靠"多级不存在的目录"来制造失败 —— mkdir -p 会自动建出来。
  const bad = path.join(os.tmpdir(), 'pet:invalid:name.json');
  const c = new Config(bad);
  c.data = { ...DEFAULTS, x: 5 };
  const r = c.save();
  assert.strictEqual(r.ok, false);
  assert.ok(typeof r.reason === 'string' && r.reason.length > 0);
  assert.ok(!fs.existsSync(bad), '失败时不应留下文件');
});

test('set 传入非对象不崩', () => {
  const c = new Config(tmpFile());
  assert.strictEqual(c.set(null).ok, false);
  assert.strictEqual(c.set('x').ok, false);
});
