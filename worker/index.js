// Облачный посредник Wi-Fi Intercom (Cloudflare Worker, бесплатный план).
//  /sfu/...      → прокси к Cloudflare Realtime SFU: секрет приложения живёт только здесь.
//  /room/<имя>   → WebSocket-комната (Durable Object): служебные сообщения хаба (кто в эфире, чат, текст).
// Звук идёт через SFU, через комнату — только короткие JSON.

const SFU = 'https://rtc.live.cloudflare.com/v1/apps/';
const ALLOWED = /^sessions\/new$|^sessions\/[\w-]{8,64}\/(tracks\/new|tracks\/close|renegotiate)$/;
const ORIGINS = ['https://mnsgermany.github.io', 'http://localhost:8751'];

const cors = (origin) => ({
  'Access-Control-Allow-Origin': ORIGINS.includes(origin) ? origin : ORIGINS[0],
  'Access-Control-Allow-Methods': 'POST, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
});

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin') || '';
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors(origin) });
    // shortcut: проверка Origin отсекает чужие сайты, но не скрипты вне браузера — лимит трафика 1000 ГБ это переживёт
    if (origin && !ORIGINS.includes(origin)) return new Response('forbidden', { status: 403 });

    const room = url.pathname.match(/^\/room\/([a-z0-9]{8,64})$/);
    if (room) {
      if (req.headers.get('Upgrade') !== 'websocket') return new Response('websocket only', { status: 426 });
      return env.ROOM.get(env.ROOM.idFromName(room[1])).fetch(req);
    }

    const sfu = url.pathname.match(/^\/sfu\/(.+)$/);
    if (sfu && ALLOWED.test(sfu[1]) && (req.method === 'POST' || req.method === 'PUT')) {
      const body = req.method === 'POST' && sfu[1] === 'sessions/new' ? undefined : await req.text();
      if (body && body.length > 200000) return new Response('too big', { status: 413, headers: cors(origin) });
      const r = await fetch(SFU + env.SFU_APP_ID + '/' + sfu[1], {
        method: req.method,
        headers: { Authorization: 'Bearer ' + env.SFU_APP_SECRET, 'Content-Type': 'application/json' },
        body,
      });
      return new Response(r.body, { status: r.status, headers: { ...cors(origin), 'Content-Type': 'application/json' } });
    }
    return new Response('not found', { status: 404, headers: cors(origin) });
  },
};

// Комната: каждое соединение помечено id участника. {to:id} — только ему, без to — всем остальным.
export class Room {
  constructor(state) { this.state = state; }

  async fetch(req) {
    const id = new URL(req.url).searchParams.get('id') || '';
    if (!/^[0-9a-f]{10}$/.test(id)) return new Response('bad id', { status: 400 });
    for (const old of this.state.getWebSockets(id)) try { old.close(4000, 'replaced'); } catch { /* уже */ }
    const [client, server] = Object.values(new WebSocketPair());
    this.state.acceptWebSocket(server, [id]); // hibernation: не платим за простой
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, raw) {
    if (typeof raw !== 'string' || raw.length > 8000) return;
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== 'object') return;
    m.from = this.state.getTags(ws)[0];
    const to = typeof m.to === 'string' ? m.to : null;
    const out = JSON.stringify(m);
    for (const s of to ? this.state.getWebSockets(to) : this.state.getWebSockets()) {
      if (s !== ws) try { s.send(out); } catch { /* закрыт */ }
    }
  }

  webSocketClose(ws) { this.left(ws); }
  webSocketError(ws) { this.left(ws); }

  left(ws) {
    const from = this.state.getTags(ws)[0];
    if (this.state.getWebSockets(from).some((s) => s !== ws)) return; // переподключился — не ушёл
    const out = JSON.stringify({ t: 'left', from });
    for (const s of this.state.getWebSockets()) if (s !== ws) try { s.send(out); } catch { /* закрыт */ }
  }
}
