// Посредник Wi-Fi Intercom (Cloudflare Workers, бесплатный план, без карты).
//  /room/<имя>  → WebSocket-комната (Durable Object): телефоны обмениваются рукопожатием с хабом.
//  /ice         → STUN + TURN для обхода сетей; логин TURN — в секретах Worker (TURN_URLS, TURN_USER, TURN_PASS).
// Звук через Worker не идёт.
const ORIGINS = ['https://mnsgermany.github.io', 'http://localhost:8751'];

const cors = (origin) => ({
  'Access-Control-Allow-Origin': ORIGINS.includes(origin) ? origin : ORIGINS[0],
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
});

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin') || '';
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors(origin) });
    // shortcut: проверка Origin отсекает чужие сайты, но не скрипты вне браузера; логин TURN всё равно виден браузеру
    if (origin && !ORIGINS.includes(origin)) return new Response('forbidden', { status: 403 });

    const room = url.pathname.match(/^\/room\/([a-z0-9]{8,64})$/);
    if (room) {
      if (req.headers.get('Upgrade') !== 'websocket') return new Response('websocket only', { status: 426 });
      return env.ROOM.get(env.ROOM.idFromName(room[1])).fetch(req);
    }

    if (url.pathname === '/ice' && req.method === 'GET') {
      const list = [{ urls: 'stun:stun.cloudflare.com:3478' }];
      if (env.TURN_URLS && env.TURN_USER) {
        list.push({ urls: env.TURN_URLS.split(',').map((u) => u.trim()), username: env.TURN_USER, credential: env.TURN_PASS });
      }
      return new Response(JSON.stringify(list), { headers: { ...cors(origin), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
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
