'use strict';
/**
 * 系统状态采集：边界测试。
 *
 * 这类代码最容易出错的地方不是"正常时算得对不对"，
 * 而是台式机没电池、系统接口返回 undefined、
 * 以及"内存 85% 持续十分钟"这种该不该反复提醒的场景。
 */
const test = require('node:test');
const assert = require('node:assert');
const S = require('../src/system-status');

// ---- 电量 ----

test('充电时永远是 OK，哪怕只剩 1%', () => {
  assert.strictEqual(S.batteryLevel(1, true), S.LEVEL.OK);
  assert.strictEqual(S.batteryLevel(50, true), S.LEVEL.OK);
});

test('放电时按阈值分级', () => {
  assert.strictEqual(S.batteryLevel(80, false), S.LEVEL.OK);
  assert.strictEqual(S.batteryLevel(31, false), S.LEVEL.OK);
  assert.strictEqual(S.batteryLevel(30, false), S.LEVEL.WARN);
  assert.strictEqual(S.batteryLevel(11, false), S.LEVEL.WARN);
  assert.strictEqual(S.batteryLevel(10, false), S.LEVEL.CRIT);
  assert.strictEqual(S.batteryLevel(0, false), S.LEVEL.CRIT);
});

test('没有电池数据时返回 null 而不是崩溃', () => {
  assert.strictEqual(S.batteryLevel(null, false), null);
  assert.strictEqual(S.batteryLevel(undefined, false), null);
  assert.strictEqual(S.describeBattery(null), null);
  assert.strictEqual(S.describeBattery({}), null);
});

test('电量文案带剩余时间，只在放电且剩余不长时显示', () => {
  const d = S.describeBattery({ percent: 45, charging: false, minutesLeft: 60 });
  assert.ok(d.text.includes('45%'));
  assert.ok(d.text.includes('60分'));

  // 剩余很久就不显示，避免信息噪音
  const far = S.describeBattery({ percent: 90, charging: false, minutesLeft: 600 });
  assert.ok(!far.text.includes('分'));
});

test('充电时显示充电状态，不显示剩余时间', () => {
  const d = S.describeBattery({ percent: 30, charging: true, minutesLeft: 20 });
  assert.ok(d.text.includes('充电'));
  assert.ok(!d.text.includes('20分'), '充电时剩余分钟数没有意义');
});

// ---- 内存 ----

test('内存按已用比例分级', () => {
  assert.strictEqual(S.memoryLevel(0.5), S.LEVEL.OK);
  assert.strictEqual(S.memoryLevel(0.79), S.LEVEL.OK);
  assert.strictEqual(S.memoryLevel(0.80), S.LEVEL.WARN);
  assert.strictEqual(S.memoryLevel(0.91), S.LEVEL.WARN);
  assert.strictEqual(S.memoryLevel(0.92), S.LEVEL.CRIT);
  assert.strictEqual(S.memoryLevel(1.0), S.LEVEL.CRIT);
});

test('内存值为非法时不报警', () => {
  assert.strictEqual(S.memoryLevel(NaN), S.LEVEL.OK);
  assert.strictEqual(S.memoryLevel(undefined), S.LEVEL.OK);
  assert.strictEqual(S.describeMemory(null), null);
});

test('内存文案带具体用量', () => {
  const d = S.describeMemory({ usedRatio: 0.5, usedGb: 8, totalGb: 16 });
  assert.ok(d.text.includes('50%'));
  assert.ok(d.text.includes('8.0/16G'));
  assert.strictEqual(d.level, S.LEVEL.OK);
});

// ---- CPU ----

test('CPU 阈值', () => {
  assert.strictEqual(S.cpuLevel(0.3), S.LEVEL.OK);
  assert.strictEqual(S.cpuLevel(0.80), S.LEVEL.WARN);
  assert.strictEqual(S.cpuLevel(0.95), S.LEVEL.CRIT);
  assert.strictEqual(S.cpuLevel(NaN), S.LEVEL.OK);
});

// ---- 汇总 ----

test('汇总取最严重的等级', () => {
  const r = S.summarize({
    battery: { percent: 15, charging: false },   // warn
    memory: { usedRatio: 0.95, usedGb: 15, totalGb: 16 },  // crit
    cpu: 0.2,                                    // ok
  });
  assert.strictEqual(r.level, S.LEVEL.CRIT);
  assert.strictEqual(r.items.length, 3);
});

test('全部正常时 level 为 ok 且没有警报', () => {
  const r = S.summarize({
    battery: { percent: 80, charging: false },
    memory: { usedRatio: 0.4, usedGb: 6, totalGb: 16 },
    cpu: 0.1,
  });
  assert.strictEqual(r.level, S.LEVEL.OK);
  assert.deepStrictEqual(r.alerts, []);
});

test('台式机没电池时只显示内存和 CPU', () => {
  const r = S.summarize({
    battery: null,
    memory: { usedRatio: 0.5, usedGb: 8, totalGb: 16 },
    cpu: 0.2,
  });
  assert.strictEqual(r.items.length, 2);
  assert.ok(!r.items.some((i) => i.kind === 'battery'));
});

test('完全没有数据时不崩', () => {
  assert.doesNotThrow(() => S.summarize({}));
  const r = S.summarize({});
  assert.strictEqual(r.items.length, 0);
  assert.strictEqual(r.level, S.LEVEL.OK);
});

// ---- CPU 平滑 ----

test('CPU 平滑：单次尖峰被摊薄', () => {
  const a = new S.CpuAverager({ windowSize: 5 });
  a.push(0.1); a.push(0.1); a.push(0.1); a.push(0.1);
  a.push(1.0);  // 一次尖峰
  const avg = a.average();
  assert.ok(avg < 0.35, `均值应被摊薄，实际 ${avg}`);
});

test('CPU 平滑：窗口滑动，旧值会过期', () => {
  const a = new S.CpuAverager({ windowSize: 3 });
  a.push(1.0); a.push(1.0); a.push(1.0);
  assert.ok(a.average() > 0.9);
  for (let i = 0; i < 3; i += 1) a.push(0);
  assert.ok(a.average() < 0.1, '旧的高值应被挤出窗口');
});

test('CPU 平滑：非法输入不影响累计', () => {
  const a = new S.CpuAverager({ windowSize: 3 });
  a.push(0.5);
  a.push(NaN);
  a.push(undefined);
  assert.ok(Math.abs(a.average() - 0.5) < 1e-9);
});

test('CPU 平滑：空样本返回 0', () => {
  assert.strictEqual(new S.CpuAverager().average(), 0);
});

// ---- 警报去抖 ----

test('同一个警报在冷却期内只触发一次', () => {
  let t = 1000;
  const gate = new S.AlertGate({ cooldownMs: 60000, now: () => t });
  const alerts = [{ kind: 'memory', level: 'warn', text: '内存 85%' }];

  assert.strictEqual(gate.filter(alerts).length, 1, '第一次应触发');
  t += 1000;
  assert.strictEqual(gate.filter(alerts).length, 0, '1 秒后不应重复');
  t += 30000;
  assert.strictEqual(gate.filter(alerts).length, 0, '30 秒后仍不该重复');
  t += 40000;
  assert.strictEqual(gate.filter(alerts).length, 1, '超过冷却期后应再次触发');
});

test('等级升级会重新提醒', () => {
  let t = 1000;
  const gate = new S.AlertGate({ cooldownMs: 60000, now: () => t });
  gate.filter([{ kind: 'battery', level: 'warn' }]);
  t += 1000;
  // 电量从 warn 掉到 crit，这是新信息，必须提醒
  const out = gate.filter([{ kind: 'battery', level: 'crit' }]);
  assert.strictEqual(out.length, 1);
});

test('不同种类的警报互不影响', () => {
  let t = 1000;
  const gate = new S.AlertGate({ cooldownMs: 60000, now: () => t });
  gate.filter([{ kind: 'memory', level: 'warn' }]);
  const out = gate.filter([{ kind: 'battery', level: 'warn' }]);
  assert.strictEqual(out.length, 1);
});

test('脏警报输入不崩', () => {
  const gate = new S.AlertGate();
  assert.doesNotThrow(() => gate.filter(null));
  assert.doesNotThrow(() => gate.filter([null, {}, 'x']));
  assert.strictEqual(gate.filter([null, {}]).length, 0);
});

test('reset 后可以立刻重新提醒', () => {
  const gate = new S.AlertGate({ cooldownMs: 999999 });
  gate.filter([{ kind: 'cpu', level: 'warn' }]);
  assert.strictEqual(gate.filter([{ kind: 'cpu', level: 'warn' }]).length, 0);
  gate.reset();
  assert.strictEqual(gate.filter([{ kind: 'cpu', level: 'warn' }]).length, 1);
});
