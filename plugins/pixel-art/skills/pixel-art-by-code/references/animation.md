# 像素动画：时序与公式

像素动画不用手画每一帧，也不用关键帧工具。每一帧都由同一个绘制函数加参数生成，参数随时间用公式计算。这样帧与帧之间不会走样，要改节奏时只需改公式里的数字。

## 1. 基本做法

```js
// 一帧 = 同一个 sprite() + 不同参数
const frames = [];
for (let i = 0; i < 8; i++) {
  const t = i / 8;                                   // 0..1，一个循环
  frames.push(sprite('neutral', {
    squash: t > 0.25 && t < 0.65 ? 1 : 0,            // 呼吸：身体变宽 1 px、下沉
    bob: Math.round(Math.sin(t * Math.PI * 2 - 1)),  // 天线：比身体慢半拍
    blink: i === 6,                                  // 循环里眨一次眼
  }));
}
P.gif('idle.gif', frames, { fps: 6, scale: 6 });     // 看动画
P.strip(frames).save('idle_strip.png', { scale: 6 }); // 并排看每一帧，检查跳帧
```

在游戏或视频里用时，帧号按 `Math.floor(t * fps) % 帧数` 计算，`t` 是经过的秒数。

**让结果可以复现**：用固定步长（例如每秒 60 步）推进时间，随机数用带种子的生成器（如 mulberry32）。不要用 `Math.random()` 或当前时间。这样同样的输入，每次都得到同样的帧，方便对比和回归测试。

## 2. 时序参考

| 动作 | 帧数 / 帧率 | 说明 |
|---|---|---|
| 待机（呼吸） | 2~8 帧，4~6 fps | 身体宽 1 px 并下沉 1 px；头发、天线、耳朵晚一两帧 |
| 眨眼 | 每 2~5 秒一次，持续约 0.1 秒 | 间隔要随机，太规律会显得机械 |
| 说话口型 | 每个音节切换一次，张嘴保持约 0.14 秒 | 2~4 种嘴型轮换，比只有开和合两种更生动 |
| 立绘的小动画 | 6 fps，2~4 帧循环 | 汗滴起伏 1 px、眼泪伸缩、发光闪烁 |
| 走路 | 4~8 帧，8~12 fps | 身体在着地帧下沉 1 px |
| 跳跃 | 按重力逐帧计算 | 起跳前挤压，空中拉长，落地再挤压 |
| 震动、受击 | 0.3~0.6 秒 | 偏移量用哈希噪声，见第 3 节，幅度逐渐衰减 |
| 弹出、放大 | 0.2~0.3 秒 | 用 outBack 缓动，会略微超出再回来 |

## 3. 公式

```js
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ease = {
  outCubic: (t) => 1 - Math.pow(1 - t, 3),                    // 快出慢停
  inCubic: (t) => t * t * t,                                  // 慢起快收
  outBack: (t) => 1 + 2.70158 * Math.pow(t - 1, 3) + 1.70158 * Math.pow(t - 1, 2),   // 冲过头再回来
  outBounce: (t) => {                                         // 落地弹跳
    const n = 7.5625, d = 2.75;
    if (t < 1 / d) return n * t * t;
    if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
    if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
    return n * (t -= 2.625 / d) * t + 0.984375;
  },
};

// 跳一下：a = 从开始算起的秒数，最高 18 px，持续 0.4 秒
const jumpY = (a) => (a < 0.4 ? -Math.round(Math.sin((a / 0.4) * Math.PI) * 18) : 0);

// 弹出：0.2 秒内从下方 26 px 处弹到原位
const popY = (a) => -Math.round(26 * ease.outBack(clamp(a / 0.2, 0, 1)));

// 呼吸、漂浮：1 px 的正弦起伏
const bobY = (T, phase) => Math.round(Math.sin(T * 2.2 + phase));

// 可复现的“随机”震动：同一帧号永远得到同样的偏移
const hash = (x) => {
  x |= 0;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return (x ^ (x >>> 16)) >>> 0;
};
const noise = (frame, salt) => hash(frame * 73856093 ^ salt * 19349663) / 4294967296;   // 0..1
const shakeX = (frame, amp) => Math.round((noise(frame, 1) * 2 - 1) * amp);

// 眨眼计时：到点后眨 0.11 秒，再随机等 2.2~5.2 秒
function updateBlink(c, t, frame) {
  if (t >= c.blinkAt) {
    c.blinkUntil = t + 0.11;
    c.blinkAt = t + 2.2 + noise(frame, c.id) * 3;
  }
  return t < c.blinkUntil;
}
```

## 4. 让动作好看的手法

- **整像素**：位置一律取整。像素画里亚像素移动只会让轮廓抖动。要表现慢速运动，就隔几帧才移动 1 px。
- **挤压与拉伸**：只改 1 px 就有效果，例如身体变宽 1 px、变矮 1 px。改动太多会显得变形。
- **跟随动作**：头发、耳朵、天线、尾巴比身体晚一两帧到位，动作就有了重量感。
- **预备动作**：大动作之前先往反方向动一点，例如起跳前先下蹲。
- **残影帧**：极快的动作（挥手、甩头）中间插一帧拉长或模糊的形状，比真实地画出中间位置更有力。
- **检查跳帧**：把所有帧排成条带并排看（`P.strip`），任何不该变化的像素（比如脚的位置）突然跳动，一眼就能看出来。
