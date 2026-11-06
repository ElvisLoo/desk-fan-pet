'use strict';
/**
 * edge-hide.js — 贴边收起 / 悬停唤出（纯逻辑，不依赖 DOM / Electron）
 *
 * 行为约定：
 *  1. 拖到屏幕左右边缘（或拖过去后松手）→ 宠物缩进边缘，只留一条窄边；
 *  2. 鼠标碰到那条窄边 → 立刻弹出；
 *  3. 鼠标离开 → 等 graceMs 再收回（留出移动过程，否则会来回闪）；
 *  4. 展开菜单（四叶草）时，不因鼠标移开而收回 —— 否则菜单根本点不到。
 *
 * 为什么要单独成模块：这一层全是状态与时序，最容易出「闪一下就不见」
 * 或「再也弹不出来」这类问题，必须能用假时钟稳定复现。
 */

const SIDE = { NONE: 'none', LEFT: 'left', RIGHT: 'right' };

const DEFAULTS = {
  // 收起后露在屏幕内的宠物宽度（像素）：够窄不挡事，又够宽能看见、能碰到
  peekPx: 28,
  // 窗口边缘到宠物实际内容的距离。窗口通常比宠物宽（透明留白），
  // 若按窗口边界推，露出来的会是那片空白 —— 看起来就像"消失了"。
  contentInsetPx: 0,
  // 宠物实际内容宽度；0 表示占满窗口
  contentWidthPx: 0,
  // 鼠标离开多久后收回。太短会「点不到」，太长会「一直挡着」
  graceMs: 420,
  // 悬停判定区：碰到距边缘这么近就算 hover
  hotZonePx: 10,
};

class EdgeHide {
  constructor(opts = {}) {
    this.opts = { ...DEFAULTS, ...opts };
    this.side = SIDE.NONE;      // 贴在哪边
    this.collapsed = false;     // 是否处于收起状态
    this.hovering = false;      // 鼠标是否在热区/面板内
    this.pinnedOpen = false;    // 菜单展开时钉住，不自动收起
    this.lastLeaveAt = 0;       // 上次离开时间，用于 grace 计时
    this._now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  }

  /** 贴边：side 为 'left' | 'right' | 'none' */
  attach(side) {
    if (side !== SIDE.LEFT && side !== SIDE.RIGHT) {
      this.side = SIDE.NONE;
      this.collapsed = false;
      return;
    }
    this.side = side;
    this.collapsed = true;   // 一贴上就收起来
    this.hovering = false;
    this.pinnedOpen = false;
  }

  /** 离开边缘（用户把宠物拖走了） */
  detach() {
    this.side = SIDE.NONE;
    this.collapsed = false;
    this.hovering = false;
    this.pinnedOpen = false;
  }

  /**
   * 判断某个鼠标位置是否在唤出热区里。
   * @param {number} mx 鼠标 X（屏幕坐标）
   * @param {number} my 鼠标 Y
   * @param {{x:number,y:number,width:number,height:number}} rect 窗口当前矩形
   */
  inHotZone(mx, my, rect, screenW) {
    if (this.side === SIDE.NONE) return false;
    const { hotZonePx } = this.opts;
    const sw = Number.isFinite(screenW) ? screenW : (rect.x + rect.width);

    // 纵向要落在窗口高度范围内，否则整条屏幕边都算热区了
    if (my < rect.y - 2 || my > rect.y + rect.height + 2) return false;

    if (this.side === SIDE.LEFT) return mx <= hotZonePx;
    return mx >= sw - hotZonePx;
  }

  /** 鼠标进入（热区或面板） */
  enter(nowTs) {
    this.hovering = true;
    this.collapsed = false;
    this.lastLeaveAt = 0;
    return this.collapsed;
  }

  /** 鼠标离开 */
  leave(nowTs) {
    this.hovering = false;
    this.lastLeaveAt = Number.isFinite(nowTs) ? nowTs : this._now();
  }

  /** 菜单展开时钉住，不随鼠标离开收起 */
  setPinned(open) {
    this.pinnedOpen = !!open;
    if (this.pinnedOpen) this.collapsed = false;
  }

  /**
   * 每帧调用，决定当前是否应该收起。
   * @returns {boolean} 是否处于收起状态
   */
  tick(nowTs) {
    const now = Number.isFinite(nowTs) ? nowTs : this._now();
    if (this.side === SIDE.NONE) {
      this.collapsed = false;
      return false;
    }
    if (this.pinnedOpen) {
      this.collapsed = false;
      return false;
    }
    if (this.hovering) {
      this.collapsed = false;
      return false;
    }
    // 鼠标已离开：等够 grace 才收，避免移动途中闪回
    if (this.lastLeaveAt && now - this.lastLeaveAt >= this.opts.graceMs) {
      this.collapsed = true;
    }
    return this.collapsed;
  }

  /**
   * 收起状态下窗口应放在哪里、用多宽。
   * 收起时只留 peekPx 露在屏幕内，其余推出屏幕外。
   * @returns {{x:number, width:number}}
   */
  collapsedGeometry(rect, screenW) {
    const sw = Number.isFinite(screenW) ? screenW : (rect.x + rect.width);
    if (!this.collapsed || this.side === SIDE.NONE) {
      return { x: rect.x, width: rect.width };
    }
    // 关键：按「宠物内容的边界」定位，而不是按窗口边界。
    // 窗口往往比宠物宽（两侧是透明留白），若按窗口推，
    // 露在屏幕上的会是那片留白，宠物本体整个跑到屏幕外，
    // 用户看到的就是「贴边消失」而不是「贴边隐藏」。
    const inset = this.opts.contentInsetPx;
    const cw = this.opts.contentWidthPx > 0 ? this.opts.contentWidthPx : rect.width;

    if (this.side === SIDE.LEFT) {
      // 让宠物右边缘正好落在 peekPx 处
      return { x: -(inset + cw - this.opts.peekPx), width: rect.width };
    }
    // 让宠物左边缘正好落在 sw - peekPx 处
    return { x: sw - this.opts.peekPx - inset, width: rect.width };
  }

  /** 展开时应该回到的位置 */
  expandedGeometry(rect, screenW) {
    const sw = Number.isFinite(screenW) ? screenW : (rect.x + rect.width);
    if (this.side === SIDE.LEFT) return { x: 0, width: rect.width };
    if (this.side === SIDE.RIGHT) return { x: sw - rect.width, width: rect.width };
    return { x: rect.x, width: rect.width };
  }

  snapshot() {
    return {
      side: this.side,
      collapsed: this.collapsed,
      hovering: this.hovering,
      pinnedOpen: this.pinnedOpen,
    };
  }
}

module.exports = { EdgeHide, SIDE, DEFAULTS };
