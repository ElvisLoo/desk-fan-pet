'use strict';
/**
 * diary-store 的单元测试（会真的读写临时文件）
 *
 * 重点验证三件事：
 *  1. 原子写入：写到一半不会留下半个 JSON
 *  2. 节流：连续 100 次 bump 只落盘一次，但内存里是准的
 *  3. 坏文件：解析失败要备份且不崩，下次照常工作
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { DiaryStore } = require('../src/diary-store.js');
const diary = require('../src/diary.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'diary-'));
}

/** 固定时钟，避免测试依赖真实时间 */
function fixedClock(t) {
  return () => t;
}

test('首次加载：文件不存在时返回空对象', () => {
  const dir = tmpDir();
  const st = new DiaryStore(path.join(dir, 'diary.json'), { now: fixedClock(Date.now()) });
  assert.deepStrictEqual(st.load(), {});
  fs.rmSync(dir, { recursive: true, force: true });
});

test('写入后能读回', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'diary.json');
  const now = new Date(2026, 10, 6, 12).getTime();
  const st = new DiaryStore(file, { now: fixedClock(now), flushIntervalMs: 0 });
  st.load();
  st.bump('clicks', 1);
  st.flush();

  const st2 = new DiaryStore(file, { now: fixedClock(now) });
  const data = st2.load();
  assert.strictEqual(data['2026-11-06'].clicks, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('节流：连续写入只在超过间隔后落盘', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'diary.json');
  let now = new Date(2026, 10, 6, 12).getTime();
  const st = new DiaryStore(file, { now: () => now, flushIntervalMs: 5000 });
  st.load();

  for (let i = 0; i < 100; i++) {
    st.bump('clicks', 1);
    now += 10; // 每次间隔 10ms，总共 1 秒，不足以触发
  }
  assert.strictEqual(st.data['2026-11-06'].clicks, 100, '内存里必须是准的');
  assert.ok(!fs.existsSync(file), '还没到落盘时间，文件不该存在');

  now += 6000;
  st.bump('clicks', 1);
  assert.ok(fs.existsSync(file), '超过 5 秒后应落盘');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('flush 幂等：没有改动时跳过写盘', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'diary.json');
  const st = new DiaryStore(file, { now: fixedClock(Date.now()), flushIntervalMs: 0 });
  st.load();
  st.bump('clicks', 1);
  const r1 = st.flush();
  assert.strictEqual(r1.ok, true);
  const r2 = st.flush();
  assert.strictEqual(r2.skipped, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('坏文件被备份且不崩', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'diary.json');
  fs.writeFileSync(file, '{ this is not json', 'utf8');

  const st = new DiaryStore(file, { now: fixedClock(Date.now()) });
  const data = st.load();
  assert.deepStrictEqual(data, {});
  assert.ok(fs.existsSync(file + '.bad'), '应备份坏文件');
  assert.ok(st.lastError, '应记录错误原因');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('文件内容是数组时降级为空', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'diary.json');
  fs.writeFileSync(file, '[1,2,3]', 'utf8');
  const st = new DiaryStore(file, { now: fixedClock(Date.now()) });
  assert.deepStrictEqual(st.load(), {});
  fs.rmSync(dir, { recursive: true, force: true });
});

test('写入是原子的：不留下 .tmp', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'diary.json');
  const st = new DiaryStore(file, { now: fixedClock(Date.now()), flushIntervalMs: 0 });
  st.load();
  st.bump('clicks', 1);
  st.flush();
  assert.ok(fs.existsSync(file));
  assert.ok(!fs.existsSync(file + '.tmp'), '临时文件应被 rename 掉');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('addFocus 累加专注时长', () => {
  const dir = tmpDir();
  const now = new Date(2026, 10, 6, 12).getTime();
  const st = new DiaryStore(path.join(dir, 'diary.json'), { now: fixedClock(now), flushIntervalMs: 0 });
  st.load();
  st.addFocus(25 * 60 * 1000);
  st.addFocus(25 * 60 * 1000);
  assert.strictEqual(st.data['2026-11-06'].focusMs, 50 * 60 * 1000);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('todayLine 反映今日数据', () => {
  const dir = tmpDir();
  const now = new Date(2026, 10, 6, 12).getTime();
  const st = new DiaryStore(path.join(dir, 'diary.json'), { now: fixedClock(now), flushIntervalMs: 0 });
  st.load();
  st.bump('focusDone', 1);
  st.addFocus(25 * 60 * 1000);
  const line = st.todayLine();
  assert.ok(line.includes('1 个番茄钟'), line);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('summary 给出今日 / 本月 / 连续天数', () => {
  const dir = tmpDir();
  const now = new Date(2026, 10, 6, 12).getTime();
  const st = new DiaryStore(path.join(dir, 'diary.json'), { now: fixedClock(now), flushIntervalMs: 0 });
  st.load();
  st.bump('clicks', 3);
  st.bump('focusDone', 2);
  st.addFocus(50 * 60 * 1000);

  const s = st.summary();
  assert.strictEqual(s.today.clicks, 3);
  assert.strictEqual(s.today.focusDone, 2);
  assert.strictEqual(s.month.total.focusDone, 2);
  assert.strictEqual(s.streak, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('加载时自动剪枝过期数据', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'diary.json');
  const now = new Date(2026, 11, 1, 12).getTime();
  fs.writeFileSync(file, JSON.stringify({
    '2026-11-30': { clicks: 1 },
    '2025-01-01': { clicks: 99 },
  }), 'utf8');

  const st = new DiaryStore(file, { now: fixedClock(now) });
  const data = st.load();
  assert.ok(data['2026-11-30'], '近期数据保留');
  assert.ok(!data['2025-01-01'], '过期数据应被剪掉');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('bump 传入非法字段不会破坏已有数据', () => {
  const dir = tmpDir();
  const st = new DiaryStore(path.join(dir, 'diary.json'), { now: fixedClock(Date.now()), flushIntervalMs: 0 });
  st.load();
  st.bump('clicks', 1);
  const before = JSON.stringify(st.data);
  st.bump('notAField', 5);
  assert.strictEqual(JSON.stringify(st.data), before);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('跨天数据互不干扰', () => {
  const dir = tmpDir();
  let now = new Date(2026, 10, 6, 23).getTime();
  const st = new DiaryStore(path.join(dir, 'diary.json'), { now: () => now, flushIntervalMs: 0 });
  st.load();
  st.bump('clicks', 1);
  now += 2 * 60 * 60 * 1000;  // 跨到次日
  st.bump('clicks', 1);

  assert.strictEqual(st.data['2026-11-06'].clicks, 1);
  assert.strictEqual(st.data['2026-11-07'].clicks, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('连续两次实例读写不串味', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'diary.json');
  const now = new Date(2026, 10, 6, 12).getTime();

  const a = new DiaryStore(file, { now: fixedClock(now), flushIntervalMs: 0 });
  a.load();
  a.bump('sips', 2);
  a.flush();

  const b = new DiaryStore(file, { now: fixedClock(now), flushIntervalMs: 0 });
  b.load();
  b.bump('sips', 1);
  b.flush();

  const c = new DiaryStore(file, { now: fixedClock(now) });
  const data = c.load();
  assert.strictEqual(data['2026-11-06'].sips, 3, '两个实例的写入应累加，不是覆盖');
  fs.rmSync(dir, { recursive: true, force: true });
});
