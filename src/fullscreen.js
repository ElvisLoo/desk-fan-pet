'use strict';
/**
 * 全屏检测
 *
 * 原来用「任务栏被占满」近似判断全屏：
 *   isFullscreen = workArea.height >= screen.height - 2
 *
 * 这个近似在一种常见配置下会永久误判：任务栏设为「自动隐藏」。
 * 此时 workArea 恒等于屏幕高度，于是程序认为「一直在全屏」，
 * 宠物永远隐身 —— 而用户完全不知道为什么，托盘里也看不出来。
 *
 * 这里改用真正的前台窗口检测（Win32），失败时退回旧的近似，
 * 并把判定结果暴露出来，方便排查。
 */
const { execFileSync } = require('child_process');

/**
 * 平台无关的全屏判定（纯函数，便于测试）。
 * @param {{workH:number, screenH:number, taskbarAutohide:boolean}} env
 */
function isFullscreenByWorkArea(env) {
  const { workH, screenH, taskbarAutohide } = env || {};
  if (!Number.isFinite(workH) || !Number.isFinite(screenH)) return false;
  if (taskbarAutohide) {
    // 任务栏自动隐藏时 workArea == screen，这个方法完全失效。
    // 直接返回 false，宁可不隐藏宠物，也不要让它莫名消失。
    return false;
  }
  return workH >= screenH - 2;
}

/**
 * Windows：查前台窗口是否覆盖整块屏幕。
 * 失败返回 null（调用方退回近似判断）。
 */
function queryForegroundFullscreen() {
  if (process.platform !== 'win32') return null;
  try {
    const ps = [
      '$sig = @"',
      'using System;',
      'using System.Runtime.InteropServices;',
      'public class FG {',
      '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
      '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);',
      '  [DllImport("user32.dll")] public static extern IntPtr GetDesktopWindow();',
      '  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }',
      '  public static string Check() {',
      '    var h = GetForegroundWindow();',
      '    if (h == IntPtr.Zero || h == GetDesktopWindow()) return "0,0,0,0";',
      '    RECT r; GetWindowRect(h, out r);',
      '    return r.L + "," + r.T + "," + r.R + "," + r.B;',
      '  }',
      '}',
      '"@',
      'Add-Type -TypeDefinition $sig -ErrorAction Stop',
      '[FG]::Check()',
    ].join('\n');
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      encoding: 'utf8', windowsHide: true, timeout: 4000,
    }).trim();
    const parts = out.split(',').map((s) => Number(s.trim()));
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
    return { left: parts[0], top: parts[1], right: parts[2], bottom: parts[3] };
  } catch (_) {
    return null;
  }
}

/**
 * 判断给定窗口矩形是否覆盖了某块屏幕。
 * 允许 2px 误差：某些全屏窗口会有 1px 边框。
 */
function coversScreen(rect, screenBounds, tolerance = 2) {
  if (!rect || !screenBounds) return false;
  const t = tolerance;
  return rect.left <= screenBounds.x + t
    && rect.top <= screenBounds.y + t
    && rect.right >= screenBounds.x + screenBounds.width - t
    && rect.bottom >= screenBounds.y + screenBounds.height - t;
}

/** 任务栏是否设为自动隐藏（Windows 读注册表，其它平台返回 false） */
function isTaskbarAutohide() {
  if (process.platform !== 'win32') return false;
  try {
    const out = execFileSync('reg', ['query',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StuckRects3',
      '/v', 'Settings'], { encoding: 'utf8', windowsHide: true, timeout: 3000 });
    // Settings 是二进制，第 9 个字节（0x08）的 bit0 表示自动隐藏
    const m = out.match(/Settings\s+REG_BINARY\s+([0-9A-Fa-f]+)/);
    if (!m) return false;
    const hex = m[1];
    if (hex.length < 20) return false;
    const flags = parseInt(hex.substr(16, 2), 16);
    return (flags & 0x01) === 1;
  } catch (_) {
    return false;
  }
}

module.exports = {
  isFullscreenByWorkArea,
  queryForegroundFullscreen,
  coversScreen,
  isTaskbarAutohide,
};
