// Режим «Есть интернет»: телефоны знакомятся через WebSocket-комнату нашего Worker (Cloudflare Workers,
// бесплатно, без карты), звук идёт телефон ↔ хаб напрямую или через ретранслятор TURN (ExpressTURN).
(function (root) {
  // на localhost автотест подставляет локальный Worker (wrangler dev)
  const API = (root.location?.hostname === 'localhost' && root.localStorage?.getItem('wfi_api')) || 'https://wifi-intercom.WORKERS_SUBDOMAIN.workers.dev';

  /** Комната с автопереподключением. onMsg(m) — входящие, onState('open'|'closed'). */
  function room(name, id, onMsg, onState) {
    let ws = null, closed = false;
    const queue = [];
    const open = () => {
      ws = new WebSocket(API.replace(/^http/, 'ws') + '/room/' + name + '?id=' + id);
      ws.onopen = () => { onState?.('open'); for (const s of queue.splice(0)) ws.send(s); };
      ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } onMsg(m); };
      ws.onclose = (e) => {
        onState?.('closed');
        if (!closed && e.code !== 4000) setTimeout(open, 1500); // 4000 — нас заменило новое подключение
      };
    };
    open();
    return {
      send(m) { const s = JSON.stringify(m); if (ws.readyState === 1) ws.send(s); else queue.push(s); },
      close() { closed = true; ws.close(); },
    };
  }

  /** Серверы для обхода сетей: STUN + TURN (логин TURN хранится в секретах Worker, не в коде сайта). */
  async function ice() {
    const r = await fetch(API + '/ice', { cache: 'no-store' });
    if (!r.ok) throw new Error('сервер связи ответил ' + r.status);
    return r.json();
  }

  root.WFI_CLOUD = { room, ice, configured: !API.includes('WORKERS_SUBDOMAIN') };
})(typeof window !== 'undefined' ? window : globalThis);
