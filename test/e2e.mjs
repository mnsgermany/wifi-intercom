// Сквозной тест в настоящем Chrome с виртуальным микрофоном: хаб + 2 участника, вход без интернета по QR,
// звук напрямую, каналы, текст, чат, вызов, конец пробной. Запуск: node test/e2e.mjs [адрес] [папка для снимков]
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(new URL('../../node_modules/', import.meta.url));
const { chromium } = require('playwright');

const URL0 = process.argv[2] || 'http://localhost:8751/';
const SHOTS = process.argv[3];
const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});
const open = async () => {
  const ctx = await browser.newContext({ permissions: ['microphone', 'camera'], viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log('pageerror', e.message));
  return p;
};
const qr = (p, id) => p.evaluate((id) => document.getElementById(id).dataset.qr || '', id);
const waitQr = async (p, id, not = '') => {
  for (let i = 0; i < 300; i++) { const t = await qr(p, id); if (t && t !== not) return t; await p.waitForTimeout(100); }
  throw new Error('нет QR ' + id);
};

try {
  const host = await open();
  await host.goto(URL0);
  await host.fill('#name', 'Хаб');
  await host.click('#createBtn');
  await host.evaluate(() => window.__wfi.setHostMode('off')); // в песочнице без интернета
  let offer = await waitQr(host, 'joinQr');
  while (!offer.includes('#o=')) { await host.waitForTimeout(200); offer = await qr(host, 'joinQr'); }
  await host.keyboard.press('Escape');
  console.log(`офлайн-QR: ссылка ${offer.length} символов`);

  const users = [];
  for (const name of ['Вася', 'Петя']) {
    const u = await open();
    await u.goto(offer);
    await u.fill('#name', name);
    await u.click('#joinBtn');
    const ans = await waitQr(u, 'answerQr');
    await host.evaluate((t) => window.__wfi.acceptAnswer(t), ans);
    await u.waitForSelector('#main:not([hidden])', { timeout: 15000 });
    offer = await waitQr(host, 'joinQr', offer);
    users.push(u);
  }
  const [A, B] = users, all = [host, A, B];

  // все видят троих и соединены каждый с каждым (A↔B — напрямую, без хаба)
  for (const p of all) await p.waitForFunction(() => window.__wfi.S.roster.length === 3 && [...window.__wfi.S.peers.values()].filter((x) => x.pc.connectionState === 'connected').length === 2, null, { timeout: 20000 });
  console.log('сетка 3×3 соединена');

  const bytesFrom = (p, id) => p.evaluate(async (id) => {
    let b = 0; (await window.__wfi.S.peers.get(id).pc.getStats()).forEach((s) => { if (s.type === 'inbound-rtp' && s.kind === 'audio') b += s.bytesReceived; }); return b;
  }, id);
  const idA = await A.evaluate(() => window.__wfi.S.id);

  // A говорит в «Общий» — слышат все
  const b0 = await bytesFrom(B, idA), h0 = await bytesFrom(host, idA);
  await A.evaluate(() => window.__wfi.setTalking(true));
  await A.waitForTimeout(2000);
  const b1 = await bytesFrom(B, idA), h1 = await bytesFrom(host, idA);
  assert.ok(b1 - b0 > 4000 && h1 - h0 > 4000, `звук идёт: B +${b1 - b0} Б, хаб +${h1 - h0} Б`);
  console.log(`звук A→B напрямую +${b1 - b0} Б за 2 с, A→хаб +${h1 - h0} Б`);
  await B.evaluate(() => window.__wfi.S.roster.find((m) => m.talking)?.name).then((n) => assert.equal(n, 'Вася'));

  if (SHOTS) {
    await A.evaluate(() => window.__wfi.sendHub({ t: 'stt', text: 'Проверка связи, свет на сцену', final: false }));
    await B.waitForTimeout(400);
    await B.screenshot({ path: SHOTS + '/listener.png' });
    await A.screenshot({ path: SHOTS + '/talker.png' });
  }
  await A.evaluate(() => window.__wfi.setTalking(false));

  // задержка по статистике WebRTC
  const lat = await B.evaluate(async (id) => window.__wfi.S.peers.get(id).stats(), idA);
  console.log(`RTT ${lat.rtt?.toFixed(1)} мс, джиттер-буфер ${lat.jb?.toFixed(1)} мс → рот-ухо ≈ ${Math.round(lat.rtt / 2 + lat.jb + 40)} мс`);

  // текст с именем, чат, вызов
  await A.evaluate(() => window.__wfi.sendHub({ t: 'stt', text: 'проверка связи', final: true }));
  await B.waitForFunction(() => document.getElementById('tx').textContent.includes('проверка связи') && document.getElementById('tx').textContent.includes('Вася'));
  await A.evaluate(() => window.__wfi.sendHub({ t: 'chat', text: 'привет 👍 <img src=x onerror=alert(1)>' }));
  await B.waitForFunction(() => document.getElementById('msgs').textContent.includes('привет 👍'));
  assert.equal(await B.evaluate(() => document.querySelectorAll('#msgs img').length), 0, 'чат не вставляет HTML');
  assert.equal(await B.evaluate(() => document.getElementById('unread').textContent), '1');
  await host.evaluate(() => window.__wfi.sendHub({ t: 'call', ch: 'Общий' }));
  await B.waitForSelector('#flash:not([hidden])', { timeout: 3000 });
  console.log('текст, чат, вызов — ок');
  if (SHOTS) { await B.click('#chatHandle'); await B.waitForTimeout(400); await B.screenshot({ path: SHOTS + '/chat.png' }); await B.click('#chatHandle'); }

  // каналы: B слушает только «Звук» → A в «Общий» ему не отдаёт микрофон
  await B.evaluate(() => { document.getElementById('flash').hidden = true; });
  await B.evaluate(() => window.__wfi.sendHub({ t: 'update', listen: ['Звук'] }));
  await A.waitForFunction(() => window.__wfi.S.roster.find((m) => m.name === 'Петя').listen.join() === 'Звук');
  await A.evaluate(() => window.__wfi.setTalking(true));
  const idB = await B.evaluate(() => window.__wfi.S.id), idH = await host.evaluate(() => window.__wfi.S.id);
  const tracks = await A.evaluate(([b, h]) => [window.__wfi.S.peers.get(b).track, window.__wfi.S.peers.get(h).track].map(Boolean), [idB, idH]);
  assert.deepEqual(tracks, [false, true], 'Петя не слышит «Общий», хаб слышит');
  await A.evaluate(() => window.__wfi.setTalking(false));
  console.log('маршрутизация по каналам — ок');

  if (SHOTS) { await host.click('#hostBtn'); await host.waitForTimeout(300); await host.screenshot({ path: SHOTS + '/host.png' }); await host.keyboard.press('Escape'); }

  // конец пробной сессии: у всех окно, связь рвётся
  await host.evaluate(() => { window.__wfi.S.trialEnd = window.__wfi.S.hub.trialEnd = Date.now() - 1; });
  await B.waitForSelector('#endDlg[open]', { timeout: 5000 });
  await host.waitForSelector('#endDlg[open]', { timeout: 5000 });
  console.log('пробные 5 минут: сессия закрывается у всех — ок');
  console.log('E2E OK');
} finally {
  // Chrome с живыми WebRTC-соединениями иногда долго закрывается — не ждём его дольше 5 с
  await Promise.race([browser.close(), new Promise((ok) => setTimeout(ok, 5000))]);
  process.exit(process.exitCode ?? 0);
}
