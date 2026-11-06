'use strict';
/**
 * quick-tools 的单元测试
 *
 * 四个小功能都是纯逻辑，重点守住：
 *   - 内存阈值不被写成「随便清一下都显示省了多少」
 *   - AI 没配 Key 时不假装智能
 *   - 番茄钟不会自动连播、长休在第 4 轮
 *   - 运势同一天永远同一份
 */
const test = require('node:test');
const assert = require('node:assert');
const Q = require('../src/quick-tools.js');

/* ---------------- 内存 ---------------- */

test('formatBytes 分级显示', () => {
  assert.strictEqual(Q.formatBytes(0), '0 B');
  assert.strictEqual(Q.formatBytes(-1), '0 B');
  assert.strictEqual(Q.formatBytes(512), '512 B');
  assert.strictEqual(Q.formatBytes(1024), '1.00 KB');
  assert.strictEqual(Q.formatBytes(1024 * 1024 * 5), '5.00 MB');
  assert.strictEqual(Q.formatBytes(1024 ** 3 * 16), '16.0 GB');
});

test('analyzeMemory 计算已用与占比', () => {
  const r = Q.analyzeMemory({ total: 16 * 1024 ** 3, free: 4 * 1024 ** 3 });
  assert.strictEqual(r.total, 16 * 1024 ** 3);
  assert.strictEqual(r.used, 12 * 1024 ** 3);
  assert.ok(Math.abs(r.usedPct - 0.75) < 1e-9);
});

test('内存充足时不给「可以清」的虚假承诺', () => {
  const r = Q.analyzeMemory({ total: 16 * 1024 ** 3, free: 12 * 1024 ** 3 });
  assert.strictEqual(r.level, 'ok');
  assert.strictEqual(r.canFree, 0);
  assert.ok(r.advice.includes('不用清'));
});

test('内存紧张时给出警告等级', () => {
  const total = 16 * 1024 ** 3;
  const warn = Q.analyzeMemory({ total, free: total * 0.25 });  // 75% 已用
  assert.strictEqual(warn.level, 'warn');
  const high = Q.analyzeMemory({ total, free: total * 0.1 });   // 90% 已用
  assert.strictEqual(high.level, 'high');
  assert.ok(high.canFree > 0);
});

test('analyzeMemory 对缺失数据不崩', () => {
  for (const v of [null, undefined, {}, { total: 0 }, 'x']) {
    const r = Q.analyzeMemory(v);
    assert.strictEqual(r.usedPct, 0);
    assert.ok(typeof r.advice === 'string');
  }
});

/* ---------------- AI 助手 ---------------- */

test('buildChatRequest 组装 OpenAI 兼容结构', () => {
  const req = Q.buildChatRequest(
    { model: 'deepseek-chat' },
    [{ role: 'user', text: '你好' }, { role: 'assistant', text: '在的' }],
    '今天好困'
  );
  assert.strictEqual(req.model, 'deepseek-chat');
  assert.strictEqual(req.messages[0].role, 'system');
  assert.strictEqual(req.messages.length, 4);
  assert.strictEqual(req.messages[3].content, '今天好困');
  assert.strictEqual(req.stream, false);
});

test('buildChatRequest 只带最近 10 轮历史', () => {
  const hist = [];
  for (let i = 0; i < 30; i++) hist.push({ role: 'user', text: 'q' + i });
  const req = Q.buildChatRequest({}, hist, 'now');
  // system + 10 轮历史 + 当前 1 条
  assert.strictEqual(req.messages.length, 12);
  assert.strictEqual(req.messages[1].content, 'q20');
});

test('buildChatRequest 对超长输入截断', () => {
  const req = Q.buildChatRequest({}, [], 'x'.repeat(5000));
  assert.ok(req.messages[1].content.length <= 2000);
});

test('extractReply 兼容三种响应结构', () => {
  assert.strictEqual(Q.extractReply({ choices: [{ message: { content: ' A ' } }] }), 'A');
  assert.strictEqual(Q.extractReply({ choices: [{ text: 'B' }] }), 'B');
  assert.strictEqual(Q.extractReply({ content: 'C' }), 'C');
  assert.strictEqual(Q.extractReply({ reply: 'D' }), 'D');
  assert.strictEqual(Q.extractReply(null), '');
  assert.strictEqual(Q.extractReply({}), '');
});

test('没配 Key 时本地回答不假装智能', () => {
  const r = Q.localReply('帮我写一段 Python');
  assert.ok(r.includes('模型'), '应坦白需要接模型，实际：' + r);
});

test('本地回答能处理简单问题', () => {
  assert.ok(Q.localReply('你好').length > 0);
  assert.ok(Q.localReply('现在几点').includes(':'));
  assert.ok(Q.localReply('内存怎么样').includes('叶子'));
});

test('本地回答对空输入给引导', () => {
  assert.ok(Q.localReply('').length > 0);
  assert.ok(Q.localReply(null).length > 0);
});

/* ---------------- 番茄钟 ---------------- */

test('番茄钟初始空闲', () => {
  const p = new Q.Pomodoro();
  assert.strictEqual(p.phase, 'idle');
  assert.strictEqual(p.running, false);
});

test('start 进入专注并开始倒计时', () => {
  const p = new Q.Pomodoro({ focusMs: 25 * 60 * 1000 });
  p.start(0);
  assert.strictEqual(p.phase, 'focus');
  assert.strictEqual(p.running, true);
  assert.strictEqual(p.label(0), '25:00');
});

test('倒计时随时间减少', () => {
  const p = new Q.Pomodoro({ focusMs: 60 * 1000 });
  p.start(0);
  assert.strictEqual(p.label(30 * 1000), '00:30');
  assert.strictEqual(p.label(59 * 1000), '00:01');
});

test('pause 保留剩余时间', () => {
  const p = new Q.Pomodoro({ focusMs: 60 * 1000 });
  p.start(0);
  p.pause(20 * 1000);
  assert.strictEqual(p.running, false);
  assert.strictEqual(p.label(999 * 1000), '00:40', '暂停后时间不再走');
});

test('专注结束进入短休，且不自动开始', () => {
  const p = new Q.Pomodoro({ focusMs: 1000, shortMs: 5000 });
  p.start(0);
  const r = p.tick(1500);
  assert.strictEqual(r.changed, true);
  assert.strictEqual(r.finished, 'focus');
  assert.strictEqual(p.phase, 'short');
  assert.strictEqual(p.running, false, '到点要停下等用户确认，不连播');
});

test('第 4 轮专注结束后进入长休', () => {
  const p = new Q.Pomodoro({ focusMs: 1000, shortMs: 1000, longMs: 9000, roundsBeforeLong: 4 });

  // 完整跑 4 个「专注 → 休息」循环，第 4 次专注结束时该进长休
  for (let i = 1; i <= 4; i++) {
    assert.strictEqual(p.phase, i === 1 ? 'idle' : 'focus', '第 ' + i + ' 轮应从专注开始，实际 ' + p.phase);
    p.start(0);
    assert.strictEqual(p.phase, 'focus');
    p.tick(2000);
    assert.strictEqual(p.round, i);
    if (i < 4) {
      assert.strictEqual(p.phase, 'short', '第 ' + i + ' 轮后应是短休，实际 ' + p.phase);
      p.start(0);
      p.tick(2000);   // 结束短休，回到专注
    }
  }
  assert.strictEqual(p.phase, 'long', '第 4 轮后应进长休，实际 ' + p.phase);
  assert.strictEqual(p.remainMs, 9000);
});

test('休息结束后回到专注', () => {
  const p = new Q.Pomodoro({ focusMs: 1000, shortMs: 500 });
  p.start(0);
  p.tick(2000);        // 专注 -> 短休
  p.start(0);
  p.tick(1000);        // 短休 -> 专注
  assert.strictEqual(p.phase, 'focus');
});

test('skip 直接跳到下一段', () => {
  const p = new Q.Pomodoro({ focusMs: 1000, shortMs: 500 });
  p.start(0);
  p.skip(100);
  assert.strictEqual(p.phase, 'short');
});

test('reset 回到空闲', () => {
  const p = new Q.Pomodoro();
  p.start(0);
  p.reset();
  assert.strictEqual(p.phase, 'idle');
  assert.strictEqual(p.running, false);
});

test('剩余时间不会变负', () => {
  const p = new Q.Pomodoro({ focusMs: 1000 });
  p.start(0);
  p.remainMs = 0;
  assert.ok(p.label(99999) === '00:00');
});

test('phaseName 给出中文名', () => {
  const p = new Q.Pomodoro();
  assert.strictEqual(p.phaseName(), '待开始');
  p.start(0);
  assert.strictEqual(p.phaseName(), '专注');
});

test('snapshot 字段完整', () => {
  const p = new Q.Pomodoro();
  const s = p.snapshot();
  for (const k of ['phase', 'name', 'running', 'remainMs', 'label', 'round']) {
    assert.ok(k in s, '缺少字段 ' + k);
  }
});

/* ---------------- 今日运势 ---------------- */

test('同一天永远得到同一份运势', () => {
  const d = new Date(2026, 10, 6, 9);
  const a = Q.dailyFortune(d);
  const b = Q.dailyFortune(new Date(2026, 10, 6, 23));
  assert.deepStrictEqual(a, b, '同一天不同时刻应完全一致');
});

test('不同日期运势会变', () => {
  const a = Q.dailyFortune(new Date(2026, 10, 6));
  const b = Q.dailyFortune(new Date(2026, 10, 7));
  assert.notDeepStrictEqual(a, b);
});

test('加 salt 后不同人不同', () => {
  const d = new Date(2026, 10, 6);
  const a = Q.dailyFortune(d, 'alice');
  const b = Q.dailyFortune(d, 'bob');
  assert.notDeepStrictEqual(a, b);
});

test('运势字段完整且取值合理', () => {
  const f = Q.dailyFortune(new Date(2026, 10, 6));
  for (const k of ['key', 'level', 'label', 'desc', 'action', 'avoid', 'color', 'number', 'range']) {
    assert.ok(k in f, '缺少字段 ' + k);
  }
  assert.ok(['great', 'good', 'fair', 'meh'].includes(f.level));
  assert.ok(f.label.length <= 2, '标签要短，实际 ' + f.label);
  assert.ok(f.number >= 1 && f.number <= 31);
  assert.ok(/^\d{2}:\d{2}–\d{2}:\d{2}$/.test(f.range), '时段格式：' + f.range);
});

test('运势措辞不含凶吉之类的评价', () => {
  for (let i = 0; i < 30; i++) {
    const f = Q.dailyFortune(new Date(2026, 10, 1 + i));
    assert.ok(!/凶|大吉|煞/.test(f.label + f.desc), '不该出现评价性词：' + f.label + f.desc);
  }
});

test('非法日期退化为今天而不是崩', () => {
  for (const v of [null, undefined, NaN, 'x', {}]) {
    const f = Q.dailyFortune(v);
    assert.ok(f.key, '应返回可用结果');
  }
});

test('hashSeed 稳定且区分大小写', () => {
  assert.strictEqual(Q.hashSeed('abc'), Q.hashSeed('abc'));
  assert.notStrictEqual(Q.hashSeed('abc'), Q.hashSeed('ABC'));
});

test('连续 30 天的运势有变化（不是恒定值）', () => {
  const set = new Set();
  for (let i = 0; i < 30; i++) {
    const f = Q.dailyFortune(new Date(2026, 10, 1 + i));
    set.add(f.level + f.action + f.avoid);
  }
  assert.ok(set.size >= 8, '30 天里应有足够变化，实际只有 ' + set.size + ' 种');
});
