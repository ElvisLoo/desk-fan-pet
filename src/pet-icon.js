'use strict';
/**
 * 风扇宠物图标：一台长了眼睛的小风扇。
 *
 * 代码逐像素画，不依赖图片文件 —— 托盘要 16px、窗口要 256px，
 * 按尺寸重画才不糊，也不会出现「打包后图标丢了」。
 */
const { nativeImage } = require('electron');

const BG = [250, 204, 21];      // 明黄
const BG2 = [245, 158, 11];     // 深黄
const BLADE = [255, 255, 255];
const HUB = [120, 113, 108];
const EYE = [60, 55, 50];
const CAGE = [87, 83, 78];

const inCircle = (x, y, cx, cy, r) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;

/** 圆角矩形 */
function inRound(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/**
 * @param {number} size
 * @returns {Electron.NativeImage}
 */
function draw(size) {
  const buf = Buffer.alloc(size * size * 4, 0);
  const SS = 4;
  const cx = 0.5, cy = 0.47;
  const R = 0.33;               // 风扇外框
  const bladeR = 0.245;         // 扇叶半径
  const hubR = 0.055;
  const detail = size > 24;

  function colorAt(x, y) {
    // 底：圆角方块渐变
    if (!inRound(x, y, 0.03, 0.03, 0.97, 0.97, 0.24)) return null;
    const t = Math.min(1, Math.max(0, (y - 0.03) / 0.94));
    const bgc = [
      Math.round(BG[0] + (BG2[0] - BG[0]) * t),
      Math.round(BG[1] + (BG2[1] - BG[1]) * t),
      Math.round(BG[2] + (BG2[2] - BG[2]) * t),
    ];

    const dx = x - cx, dy = y - cy;
    const dist = Math.hypot(dx, dy);
    const ang = Math.atan2(dy, dx);

    // 扇叶：4 片，用角度扇区近似的螺旋
    if (dist < bladeR && dist > hubR) {
      const sector = Math.PI / 2;
      const local = ((ang % sector) + sector) % sector;
      // 每片叶子占前 60%，留出间隙
      if (local < sector * 0.62) {
        // 叶子随半径略收窄，形成扇叶感
        const narrow = Math.sin((local / (sector * 0.62)) * Math.PI);
        if (narrow > 0.28) return BLADE;
      }
    }

    // 中心轴
    if (dist <= hubR) return HUB;

    // 外圈
    if (dist <= R && dist > R - 0.035) return CAGE;

    // 支架
    if (y > 0.80 && Math.abs(x - cx) < 0.055) return CAGE;
    if (y > 0.855 && inRound(x, y, 0.30, 0.845, 0.70, 0.915, 0.035)) return CAGE;

    // 眼睛（画在中心轴上，让它像个小脸）
    if (detail) {
      if (inCircle(x, y, cx - 0.026, cy - 0.006, 0.016) || inCircle(x, y, cx + 0.026, cy - 0.006, 0.016)) return EYE;
    } else if (size > 18) {
      if (Math.abs(x - (cx - 0.025)) < 0.012 && Math.abs(y - (cy - 0.006)) < 0.012) return EYE;
      if (Math.abs(x - (cx + 0.025)) < 0.012 && Math.abs(y - (cy - 0.006)) < 0.012) return EYE;
    }

    return bgc;
  }

  const n = SS * SS;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const nx = (x + (sx + 0.5) / SS) / size;
          const ny = (y + (sy + 0.5) / SS) / size;
          const c = colorAt(nx, ny);
          if (c) { r += c[0]; g += c[1]; b += c[2]; hits++; }
        }
      }
      const i = (y * size + x) * 4;
      if (!hits) { buf[i + 3] = 0; continue; }
      // nativeImage 的 bitmap 是 BGRA
      buf[i] = Math.round(b / n);
      buf[i + 1] = Math.round(g / n);
      buf[i + 2] = Math.round(r / n);
      buf[i + 3] = Math.round(255 * (hits / n));
    }
  }
  return nativeImage.createFromBuffer(buf, { width: size, height: size, scaleFactor: 1 });
}

function createPetIcon(size = 64) {
  let img = draw(size);
  if (!img || img.isEmpty()) img = draw(32);
  return img;
}

module.exports = { draw, createPetIcon };
