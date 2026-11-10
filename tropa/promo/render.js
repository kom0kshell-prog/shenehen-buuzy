// Рендер ролика: node promo/render.js  → promo/tropa-promo.mp4
// Нужны playwright (с Chromium) и ffmpeg. Кадры снимаются покадрово, поэтому результат детерминирован.
const { chromium } = require('playwright');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const FPS = 30, SECONDS = 36.2;
const frames = path.join(__dirname, 'frames');

(async () => {
  fs.rmSync(frames, { recursive: true, force: true });
  fs.mkdirSync(frames);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
  await page.goto('file://' + path.join(__dirname, 'promo.html') + '?capture');
  await page.waitForLoadState('networkidle');
  const total = Math.round(FPS * SECONDS);
  for (let i = 0; i < total; i++) {
    await page.evaluate((ms) => document.getAnimations().forEach((a) => { a.pause(); a.currentTime = ms; }), (i / FPS) * 1000);
    await page.screenshot({ path: path.join(frames, String(i).padStart(5, '0') + '.jpg'), type: 'jpeg', quality: 93 });
  }
  await browser.close();
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-framerate', String(FPS), '-i', path.join(frames, '%05d.jpg'),
    '-c:v', 'libx264', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path.join(__dirname, 'tropa-promo.mp4')]);
  fs.rmSync(frames, { recursive: true, force: true });
  console.log('Готово: promo/tropa-promo.mp4');
})();
