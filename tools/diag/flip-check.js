'use strict';
/**
 * 朝向翻转的渲染自检。
 *
 * 要守的是：风扇本体可以镜像，但气泡文字和睡觉的 Z 必须保持正向。
 *
 * 为什么不能只看 code：transform 有三层来源（内联 / 动画 / 祖先），
 * 只读 CSS 无法判断最终谁生效。这里用真实浏览器算 computed transform。
 */
const { chromium } = require('playwright-core');
const path = require('path');

const PAGE = path.resolve(__dirname, '..', '..', 'src', 'renderer', 'index.html');

/** 从 matrix 里读出 scaleX */
function scaleXOf(matrixStr) {
  if (!matrixStr || matrixStr === 'none') return 1;
  const m = /matrix\(([^)]+)\)/.exec(matrixStr);
  if (!m) return 1;
  return parseFloat(m[1].split(',')[0]);
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch());
  const page = await browser.newPage({ viewport: { width: 320, height: 320 }, deviceScaleFactor: 2 });
  await page.goto('file:///' + PAGE.split(path.sep).join('/'), { waitUntil: 'load' });
  await page.waitForTimeout(400);

  // 取三处的最终 transform
  const readTransforms = () => page.evaluate(() => {
    const g = (sel) => {
      const el = document.querySelector(sel) || document.getElementById(sel);
      if (!el) return 'MISSING';
      return getComputedStyle(el).transform;
    };
    return {
      body: g('body'),
      pet: g('#pet'),
      flip: g('#bodyFlip'),
      innerBody: g('.body'),
      bubble: g('#bubble'),
      zzz: g('#zzz'),
    };
  });

  const before = await readTransforms();

  // 模拟「朝左」：直接调用渲染入口需要的结构
  await page.evaluate(() => {
    const flip = document.getElementById('bodyFlip');
    if (flip) flip.style.transform = 'scaleX(-1)';
  });
  await page.waitForTimeout(250);
  const facingLeft = await readTransforms();

  // 模拟「贴右边爬」
  await page.evaluate(() => {
    const flip = document.getElementById('bodyFlip');
    if (flip) flip.style.transform = 'scaleX(-1) rotate(6deg)';
  });
  await page.waitForTimeout(250);
  const climbing = await readTransforms();

  const report = {
    初始: {
      body元素的scaleX: scaleXOf(before.body),
      pet容器scaleX: scaleXOf(before.pet),
      翻转层scaleX: scaleXOf(before.flip),
      气泡scaleX: scaleXOf(before.bubble),
      Z的scaleX: scaleXOf(before.zzz),
    },
    朝左: {
      翻转层scaleX: scaleXOf(facingLeft.flip),
      body元素scaleX: scaleXOf(facingLeft.body),
      气泡scaleX: scaleXOf(facingLeft.bubble),
      Z的scaleX: scaleXOf(facingLeft.zzz),
      文字会镜像: scaleXOf(facingLeft.bubble) < 0 || scaleXOf(facingLeft.body) < 0,
    },
    爬墙: {
      翻转层: climbing.flip,
      气泡scaleX: scaleXOf(climbing.bubble),
      文字会镜像: scaleXOf(climbing.bubble) < 0,
    },
  };

  console.log(JSON.stringify(report, null, 2));

  // 截图对比：朝左时气泡文字是否正常
  await page.evaluate(() => {
    document.getElementById('bubble').hidden = false;
    document.getElementById('bubble').textContent = '喝口水吧～';
    document.getElementById('bodyFlip').style.transform = 'scaleX(-1)';
  });
  await page.waitForTimeout(300);
  await page.locator('#pet').screenshot({ path: 'flip-check.png' });
  console.log('截图：flip-check.png');

  await browser.close();
})();
