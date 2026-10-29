'use strict';
/**
 * 风扇宠物的「大脑」：纯状态机，不碰任何 DOM 或 Electron API。
 *
 * 为什么单独拆出来：
 *   桌面宠物的主要 bug 都出在「状态乱跳」——比如一边被拖动一边自己走、
 *   或者全屏时还在跑动画。这些用 UI 调试极慢，抽成纯函数就能写测试锁死。
 */

/** 宠物状态 */
const STATE = {
  IDLE: 'idle',       // 待机：轻轻喘气
  WALK: 'walk',       // 自己在桌面上走
  DRAG: 'drag',       // 被拖拽
  SLEEP: 'sleep',     // 长时间没人理
  EXCITED: 'excited', // 被点击/喂食
  HIDDEN: 'hidden',   // 全屏应用时不打扰
};

/** 可调参数（面试/办公场景默认偏安静） */
const DEFAULT_OPTS = {
  walkIntervalMs: 12000,   // 多久自己走一次
  sleepAfterMs: 180000,    // 3 分钟没交互就睡
  excitedMs: 1600,         // 兴奋状态持续
  moveSpeedPxPerSec: 26,   // 走路速度
  edgeMarginPx: 8,         // 离屏幕边缘留白
};

/**
 * 宠物的大脑。
 *
 * 坐标用「屏幕可用区域」的相对位置（0..1），这样换显示器 / 改分辨率
 * 也不会跑到屏幕外 —— 这是桌面宠物最常见的翻车点。
 */
class PetBrain {
  /**
   * @param {object} [opts]
   * @param {number} [opts.now] 初始时间戳。
   *   必须可注入：构造时用 Date.now()，而 tick() 用调用方传的 now，
   *   两者一旦不同源（比如测试用虚拟时钟），
   *   状态判定会算出差几十年的间隔，睡着/走路全部失效。
   */
  constructor(opts = {}) {
    this.opts = { ...DEFAULT_OPTS, ...opts };
    this.state = STATE.IDLE;
    this.x = 0.5;              // 0..1，相对可用区域
    this.y = 0.75;
    this.facing = 1;           // 1 朝右，-1 朝左
    const t0 = Number.isFinite(opts.now) ? opts.now : Date.now();
    this.lastInteractAt = t0;
    this.stateSince = t0;
    this.targetX = null;       // 走路目标
    this.mood = 70;            // 0..100，影响表情
    this.stats = { clicks: 0, walks: 0, slept: 0 };
  }

  /** 切状态，并记录进入时间 */
  setState(s, now = Date.now()) {
    if (this.state === s) return;
    if (s === STATE.SLEEP) this.stats.slept++;
    this.state = s;
    this.stateSince = now;
    if (s === STATE.WALK) this.stats.walks++;
  }

  touch(now = Date.now()) {
    this.lastInteractAt = now;
    if (this.state === STATE.SLEEP) this.setState(STATE.IDLE, now);
  }

  click(now = Date.now()) {
    this.touch(now);
    this.stats.clicks++;
    this.mood = Math.min(100, this.mood + 4);
    this.setState(STATE.EXCITED, now);
  }

  /** 拖拽开始 / 结束 */
  dragStart(now = Date.now()) {
    this.touch(now);
    this.setState(STATE.DRAG, now);
  }

  dragEnd(x, y, now = Date.now()) {
    this.x = clamp01(x);
    this.y = clamp01(y);
    this.setState(STATE.IDLE, now);
  }

  /** 全屏应用时隐藏，避免挡住演示 */
  setHidden(hidden, now = Date.now()) {
    if (hidden) this.setState(STATE.HIDDEN, now);
    else this.setState(STATE.IDLE, now);
  }

  /**
   * 推进一帧。返回本帧需要做的动作，调用方据此移动窗口 / 重绘。
   * @param {number} dtMs 距上一帧的毫秒数
   * @param {object} env 环境：{screenW, screenH, petW, petH}
   */
  tick(dtMs, env = {}, now = Date.now()) {
    const act = { moveTo: null, state: this.state };
    if (this.state === STATE.HIDDEN) return act;

    // 长时间无交互 → 睡
    if (this.state !== STATE.SLEEP && this.state !== STATE.DRAG
        && now - this.lastInteractAt > this.opts.sleepAfterMs) {
      this.setState(STATE.SLEEP, now);
      act.state = this.state;
      return act;
    }

    // 兴奋到时间 → 回待机
    if (this.state === STATE.EXCITED && now - this.stateSince > this.opts.excitedMs) {
      this.setState(STATE.IDLE, now);
      act.state = this.state;
      return act;
    }

    if (this.state === STATE.DRAG || this.state === STATE.SLEEP) return act;

    // 待机久了 → 挑个目标走一走
    if (this.state === STATE.IDLE && now - this.stateSince > this.opts.walkIntervalMs) {
      this.targetX = 0.15 + Math.random() * 0.7;
      this.facing = this.targetX > this.x ? 1 : -1;
      this.setState(STATE.WALK, now);
      act.state = this.state;
      return act;
    }

    // 走路：线性逼近目标
    if (this.state === STATE.WALK && this.targetX != null) {
      const dx = this.targetX - this.x;
      const step = (this.opts.moveSpeedPxPerSec * dtMs) / 1000 / Math.max(1, env.screenW || 1920);
      if (Math.abs(dx) <= step) {
        this.x = this.targetX;
        this.targetX = null;
        this.setState(STATE.IDLE, now);
      } else {
        this.x += Math.sign(dx) * step;
      }
      this.x = clamp01(this.x);
      this.y = clamp(this.y, 0.08, 0.92);
      act.state = this.state;
      act.moveTo = this.toPixels(env);
    }
    return act;
  }

  /** 相对坐标 → 屏幕像素（左上角） */
  toPixels(env = {}) {
    const sw = env.screenW || 1920;
    const sh = env.screenH || 1080;
    const pw = env.petW || 140;
    const ph = env.petH || 140;
    const m = this.opts.edgeMarginPx;
    const x = Math.round(this.x * (sw - pw - m * 2)) + m;
    const y = Math.round(this.y * (sh - ph - m * 2)) + m;
    return { x, y };
  }
}

function clamp01(v) { return clamp(v, 0, 1); }
function clamp(v, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

module.exports = { PetBrain, STATE, DEFAULT_OPTS, clamp, clamp01 };
