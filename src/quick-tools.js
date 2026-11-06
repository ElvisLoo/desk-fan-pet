'use strict';
/**
 * quick-tools.js — 四叶草菜单背后的四个小功能（纯逻辑）
 *
 *   ① 清理内存    读系统内存占用，给出可回收量，执行优化
 *   ② AI 小助手   与 OpenAI 兼容端点对话，带本地降级
 *   ③ 番茄钟      专注 / 短休 / 长休三态循环
 *   ④ 今日运势    由日期确定性生成，同一天永远是同一份
 *
 * 这一层不碰 Electron API：读内存由调用方注入 snapshot 函数，
 * 网络请求由调用方注入 fetch 实现，方便在测试里替换成假数据。
 */

/* ============================================================
 * ① 内存清理
 * ============================================================ */

/**
 * 把字节数格式化成好读的字符串
 */
function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)) + ' ' + units[i];
}

/**
 * 评估内存状况
 * @param {{total:number, free:number}} snap  来自 os.totalmem / os.freemem
 * @returns {{total:number, free:number, used:number, usedPct:number,
 *            level:'ok'|'warn'|'high', canFree:number, advice:string}}
 */
function analyzeMemory(snap) {
  const total = Number(snap && snap.total) || 0;
  const free = Math.max(0, Number(snap && snap.free) || 0);
  if (!total) {
    return { total: 0, free: 0, used: 0, usedPct: 0, level: 'ok', canFree: 0, advice: '读不到内存信息' };
  }
  const used = Math.max(0, total - free);
  const usedPct = used / total;

  // 阈值取 70% / 85%：低于 70% 时清理没有实际收益，只会让数字好看
  const level = usedPct >= 0.85 ? 'high' : usedPct >= 0.7 ? 'warn' : 'ok';

  // 可回收量是个估计：Windows 下工作集里有一部分是能换出的，
  // 不会真的全部释放。这里按「已用超出 60% 的部分」估，避免给出虚假承诺。
  const targetFree = total * 0.4;
  const canFree = Math.max(0, Math.round(targetFree - free));

  let advice;
  if (level === 'ok') advice = '内存够用，不用清';
  else if (level === 'warn') advice = '有点紧了，可以清一下';
  else advice = '内存吃紧，建议清理';

  return { total, free, used, usedPct, level, canFree, advice };
}

/* ============================================================
 * ② AI 小助手
 * ============================================================ */

const DEFAULT_SYSTEM = '你是桌面上一只风扇宠物，说话简短、口语化，每次回复不超过 60 字。';

/**
 * 构造 OpenAI 兼容的请求体
 */
function buildChatRequest(cfg, history, userText) {
  const model = String((cfg && cfg.model) || 'deepseek-chat');
  const sys = String((cfg && cfg.system) || DEFAULT_SYSTEM);
  const msgs = [{ role: 'system', content: sys }];

  const hist = Array.isArray(history) ? history.slice(-10) : [];
  for (const h of hist) {
    if (!h || !h.text) continue;
    msgs.push({ role: h.role === 'user' ? 'user' : 'assistant', content: String(h.text).slice(0, 2000) });
  }
  msgs.push({ role: 'user', content: String(userText || '').slice(0, 2000) });

  return {
    model,
    messages: msgs,
    temperature: Number.isFinite(Number(cfg && cfg.temperature)) ? Number(cfg.temperature) : 0.7,
    max_tokens: Number.isFinite(Number(cfg && cfg.maxTokens)) ? Number(cfg.maxTokens) : 300,
    stream: false,
  };
}

/** 从响应 JSON 里取回复文本，兼容几种常见结构 */
function extractReply(json) {
  if (!json) return '';
  const choice = json.choices && json.choices[0];
  if (choice) {
    if (choice.message && typeof choice.message.content === 'string') return choice.message.content.trim();
    if (typeof choice.text === 'string') return choice.text.trim();
  }
  // 有些自建网关直接返回 { content: '...' } 或 { reply: '...' }
  if (typeof json.content === 'string') return json.content.trim();
  if (typeof json.reply === 'string') return json.reply.trim();
  return '';
}

/**
 * 没配 Key 时的本地回答。
 * 不做假智能 —— 只回答它能确定的东西，其余坦白说需要联网模型。
 */
function localReply(userText) {
  const q = String(userText || '').trim();
  if (!q) return '你想聊点什么？';

  if (/你好|hi|hello|在吗/i.test(q)) return '在的，风扇转着呢。';

  const timeMatch = q.match(/几点|时间/);
  if (timeMatch) {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return '现在 ' + p(d.getHours()) + ':' + p(d.getMinutes()) + '。';
  }

  if (/内存|卡不卡/.test(q)) return '点左边那个叶子，能看到内存占用。';
  if (/番茄|专注/.test(q)) return '番茄钟在下面那个叶子，25 分钟一轮。';
  if (/运势|运程/.test(q)) return '运势在右边叶子，每天都不一样。';

  return '这事得接上模型才能答。设置里填个 API 地址就行。';
}

/* ============================================================
 * ③ 番茄钟
 * ============================================================ */

const PHASE = { IDLE: 'idle', FOCUS: 'focus', SHORT: 'short', LONG: 'long' };

const POMODORO_DEFAULTS = {
  focusMs: 25 * 60 * 1000,
  shortMs: 5 * 60 * 1000,
  longMs: 15 * 60 * 1000,
  roundsBeforeLong: 4,
};

class Pomodoro {
  constructor(opts = {}) {
    this.opts = { ...POMODORO_DEFAULTS, ...opts };
    this.phase = PHASE.IDLE;
    this.remainMs = 0;
    this.round = 0;          // 已完成的专注轮数
    this.running = false;
    this._endAt = 0;
    this._now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  }

  /** 开始下一段（空闲时从专注开始） */
  start(nowTs) {
    const now = Number.isFinite(nowTs) ? nowTs : this._now();
    if (this.phase === PHASE.IDLE) {
      this.phase = PHASE.FOCUS;
      this.remainMs = this.opts.focusMs;
    }
    // 上一段到点后 remainMs 被清零，这里按当前阶段重新填上时长，
    // 否则「休息结束 → 开始下一段专注」永远起不来
    if (this.remainMs <= 0) this.remainMs = this._durationOf(this.phase);
    if (this.remainMs <= 0) return this.snapshot();
    this._endAt = now + this.remainMs;
    this.running = true;
    return this.snapshot();
  }

  /** 某个阶段的标准时长 */
  _durationOf(phase) {
    if (phase === PHASE.FOCUS) return this.opts.focusMs;
    if (phase === PHASE.SHORT) return this.opts.shortMs;
    if (phase === PHASE.LONG) return this.opts.longMs;
    return 0;
  }

  pause(nowTs) {
    const now = Number.isFinite(nowTs) ? nowTs : this._now();
    if (!this.running) return this.snapshot();
    this.remainMs = Math.max(0, this._endAt - now);
    this.running = false;
    return this.snapshot();
  }

  /** 跳过当前段，直接进下一段 */
  skip(nowTs) {
    const now = Number.isFinite(nowTs) ? nowTs : this._now();
    this._advance(now);
    this._endAt = now + this.remainMs;
    this.running = this.remainMs > 0;
    return this.snapshot();
  }

  reset() {
    this.phase = PHASE.IDLE;
    this.remainMs = 0;
    this.running = false;
    this._endAt = 0;
    return this.snapshot();
  }

  _advance(now) {
    if (this.phase === PHASE.FOCUS) {
      this.round++;
      // 每 4 轮进一次长休
      if (this.round % this.opts.roundsBeforeLong === 0) {
        this.phase = PHASE.LONG;
        this.remainMs = this.opts.longMs;
      } else {
        this.phase = PHASE.SHORT;
        this.remainMs = this.opts.shortMs;
      }
    } else {
      // 休息结束回到专注，不自动开始下一轮
      this.phase = PHASE.FOCUS;
      this.remainMs = this.opts.focusMs;
    }
  }

  /**
   * 推进。返回是否刚刚发生阶段切换（调用方据此弹提示）。
   */
  tick(nowTs) {
    const now = Number.isFinite(nowTs) ? nowTs : this._now();
    if (!this.running) return { changed: false };

    const left = this._endAt - now;
    if (left > 0) {
      this.remainMs = left;
      return { changed: false };
    }
    // 到点：切下一段，但停下来等用户确认，不自动连播
    const finished = this.phase;
    this._advance(now);
    // remainMs 保留下一段的完整时长，供 UI 直接显示；
    // start() 会据此起跑，不需要再判断"是否已清零"
    this.running = false;
    return { changed: true, finished };
  }

  /** mm:ss */
  label(nowTs) {
    const now = Number.isFinite(nowTs) ? nowTs : this._now();
    const left = this.running ? Math.max(0, this._endAt - now) : Math.max(0, this.remainMs);
    const total = Math.ceil(left / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  phaseName() {
    return { idle: '待开始', focus: '专注', short: '短休息', long: '长休息' }[this.phase] || '';
  }

  snapshot() {
    return {
      phase: this.phase,
      name: this.phaseName(),
      running: this.running,
      remainMs: Math.max(0, this.remainMs),
      label: this.label(),
      round: this.round,
    };
  }
}

/* ============================================================
 * ④ 今日运势
 * ============================================================ */

// 不写「大吉/凶」这种评价性结论，只给打工场景友好的措辞
const LUCK_LEVELS = [
  { key: 'great', name: '顺', desc: '今天适合推进难啃的活' },
  { key: 'good', name: '稳', desc: '按部就班就好，别硬冲' },
  { key: 'fair', name: '平', desc: '平常心，按时下班' },
  { key: 'meh', name: '缓', desc: '适合整理、复盘，不适合开会' },
];

const LUCK_ACTIONS = [
  '适合谈需求', '适合写文档', '适合清 backlog', '适合提加薪',
  '适合早退', '适合摸鱼十分钟', '适合把会议推掉', '适合优化脚本',
  '适合喝杯热水', '适合整理桌面',
];

const LUCK_AVOID = [
  '别在会上拍板', '别碰祖传代码', '别接临时需求', '别回长消息',
  '别熬到十点后', '别替人背锅', '别开新分支', '别改线上配置',
];

const LUCK_COLORS = ['暖橙', '米白', '雾蓝', '豆绿', '砖红', '灰紫'];
const LUCK_NUMBERS = [1, 3, 5, 7, 9, 11, 13, 21];

/** 简单的确定性哈希：同一天同一输入永远得到同一个数 */
function hashSeed(str) {
  let h = 2166136261;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 用种子做伪随机（mulberry32），保证可复现 */
function seededPick(seed, arr) {
  const x = Math.sin(seed) * 10000;
  const f = x - Math.floor(x);
  return arr[Math.floor(f * arr.length) % arr.length];
}

/**
 * 今日运势：纯函数，同一天永远同一份
 * @param {number|Date} date
 * @param {string} salt 可选，加入用户标识可让每人不同
 */
function dailyFortune(date, salt) {
  const d = date instanceof Date ? date : new Date(Number(date) || Date.now());
  if (isNaN(d.getTime())) return dailyFortune(new Date(), salt);

  const p = (n) => String(n).padStart(2, '0');
  const key = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  const base = hashSeed(key + '|' + String(salt || ''));

  const level = LUCK_LEVELS[base % LUCK_LEVELS.length];
  const action = seededPick(base + 1, LUCK_ACTIONS);
  const avoid = seededPick(base + 2, LUCK_AVOID);
  const color = seededPick(base + 3, LUCK_COLORS);
  const number = LUCK_NUMBERS[base % LUCK_NUMBERS.length];

  // 幸运时段：上班时间里的两小时窗，纯装饰
  const startH = 9 + (base % 8);
  const range = p(startH) + ':00–' + p(Math.min(23, startH + 2)) + ':00';

  return {
    key,
    level: level.key,
    label: level.name,
    desc: level.desc,
    action,
    avoid,
    color,
    number,
    range,
  };
}

module.exports = {
  formatBytes,
  analyzeMemory,
  buildChatRequest,
  extractReply,
  localReply,
  DEFAULT_SYSTEM,
  Pomodoro,
  PHASE,
  POMODORO_DEFAULTS,
  dailyFortune,
  LUCK_LEVELS,
  hashSeed,
};
