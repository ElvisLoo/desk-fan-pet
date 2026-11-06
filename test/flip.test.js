'use strict';
/**
 * 朝向翻转的回归测试。
 *
 * 曾经的问题：朝向逻辑写的是
 *     document.body.style.transform = 'scaleX(-1)'
 * 整页一起镜像，气泡里的「喝口水吧～」和睡觉的 z 全变成反字。
 *
 * 现在要求：
 *   1. 翻转只作用在 #bodyFlip（风扇本体外层）
 *   2. 气泡和 Z 必须在翻转层之外
 *   3. 翻转层不能是 .body 本身 —— .body 上有 breathe/jump 动画，
 *      动画的 transform 会覆盖内联样式，翻不动
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const JS = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'pet.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'pet.css'), 'utf8');

test('不得翻转 body 元素（会把气泡文字一起镜像）', () => {
  assert.ok(!/document\.body\.style\.transform\s*=/.test(JS),
    'pet.js 里不应再出现 document.body.style.transform，' +
    '那会把气泡和 Z 一起翻成镜像字');
});

test('不得翻转 #pet 容器', () => {
  assert.ok(!/getElementById\(['"]pet['"]\)\.style\.transform/.test(JS),
    '翻转 #pet 会连气泡一起翻');
  assert.ok(!/querySelector\(['"]\.pet['"]\)\.style\.transform/.test(JS));
});

test('翻转作用在 #bodyFlip 上', () => {
  assert.ok(JS.includes("getElementById('bodyFlip')"),
    'pet.js 应通过 #bodyFlip 控制朝向');
  assert.ok(/#bodyFlip/.test(HTML) || /id="bodyFlip"/.test(HTML),
    'index.html 里应有 id="bodyFlip" 的容器');
});

test('气泡与 Z 不是翻转层的子节点', () => {
  // 用缩进结构判断太脆，这里直接检查 #bodyFlip 的起止区间内有没有 bubble / zzz。
  // 翻转层是 <div class="body-flip" id="bodyFlip"> ... </div>，
  // 靠 div 配对找出它的闭合位置。
  const openAt = HTML.indexOf('<div class="body-flip"');
  assert.ok(openAt > 0, '找不到翻转层的开标签');

  // 从开标签的 '>' 之后开始，按 div 配对找到闭合的 </div>
  const afterOpen = HTML.indexOf('>', openAt) + 1;
  const re = /<div| <\/div>/g;
  // 用更宽松的匹配：<div 与 </div>
  const re2 = /<div|<\/div>/g;
  re2.lastIndex = afterOpen;
  let depth = 1;
  let closeAt = -1;
  let m;
  while ((m = re2.exec(HTML)) !== null) {
    if (m[0] === '</div>') {
      depth--;
      if (depth === 0) { closeAt = m.index; break; }
    } else {
      depth++;
    }
  }
  assert.ok(closeAt > openAt, '无法确定翻转层边界');

  const inner = HTML.slice(afterOpen, closeAt);
  assert.ok(!/id="bubble"/.test(inner), '气泡不能在翻转层内部（会被镜像）');
  assert.ok(!/id="zzz"/.test(inner), '睡觉的 Z 不能在翻转层内部');

  // 同时确认它们确实存在于页面里（不是被误删）
  assert.ok(/id="bubble"/.test(HTML));
  assert.ok(/id="zzz"/.test(HTML));
});

test('翻转层不承载动画（否则 transform 被 keyframes 覆盖）', () => {
  // .body-flip 的样式块里不应有 animation
  const idx = CSS.indexOf('.body-flip');
  assert.ok(idx > 0, 'pet.css 应有 .body-flip 规则');
  const block = CSS.slice(idx, CSS.indexOf('}', idx) + 1);
  assert.ok(!/animation\s*:/.test(block),
    '.body-flip 上不能有 animation，翻转变换会被动画覆盖');
});

test('内层 .body 的动画仍然保留', () => {
  assert.ok(/\.body\s*\{[^}]*animation\s*:/.test(CSS),
    '呼吸动画应留在 .body 上');
  assert.ok(CSS.includes('@keyframes breathe'));
  assert.ok(CSS.includes('@keyframes jump'));
});
