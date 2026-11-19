// Wi-Fi Intercom: экраны, хаб/участник, PTT/VAD, каналы, текст, чат, вызов, пробная сессия.
(function () {
  const { Peer, Hub, COLORS, addrs } = window.WFI_NET;
  const BOOT = window.WFI_BOOT, CLOUD = window.WFI_CLOUD, AUDIO = window.WFI_AUDIO, STT = window.WFI_STT, LIC = window.WFI_LICENSE;
  const $ = (id) => document.getElementById(id);
  const DEFAULT_CH = ['Общий', 'Звук', 'Свет', 'Сцена', 'Режиссёр'];
  const VER = '1.1.0'; // = VERSION в sw.js
  const ALL = '*';
  const EMOJI = '👍👌🙏✅❌⚠️🔥⏱️🎤🎧🔊🔇💡🎬📢🚪😀😂😅😎🤔😬🙄😴❤️👏🤝✋👀💪☕🍕🚀'.match(/\p{Extended_Pictographic}️?/gu);
  const rid = () => [...crypto.getRandomValues(new Uint8Array(5))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const base = () => location.origin + location.pathname;

  // ---------- настройки ----------
  const PREF_KEY = 'wfi_profile';
  const prefs = Object.assign(
    { name: '', role: 'Звук', mode: 'ptt', ns: 'rnnoise', band: true, gateDb: -50, showText: true, stt: true, vol: 1, listen: null, talk: null },
    (() => { try { return JSON.parse(localStorage.getItem(PREF_KEY)) || {}; } catch { return {}; } })(),
  );
  const savePrefs = () => { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch { /* приватный режим */ } };

  // ---------- состояние ----------
  const S = {
    id: rid(), host: false, hub: null, hostId: null, peers: new Map(), roster: [], channels: DEFAULT_CH,
    mic: null, talking: false, sfu: null, ws: null, pulled: new Map(), cloudTracks: new Map(), pttDown: false, trialEnd: null, mq: null, room: null, pending: null,
    hostMode: 'on', join: null, stt: null, sttStopT: 0, over: false, licEmail: null,
  };
  const me = () => S.roster.find((m) => m.id === S.id);

  // ---------- экраны и диалоги ----------
  function show(id) { for (const s of document.querySelectorAll('.screen')) s.hidden = s.id !== id; }
  document.addEventListener('click', (e) => { if (e.target.matches('[data-close]')) e.target.closest('dialog').close(); });
  const err = (t) => { $('startErr').textContent = t; };

  function drawQr(canvas, text) {
    const q = qrcode(0, 'L');
    q.addData(text, 'Byte');
    q.make();
    canvas.dataset.qr = text; // для автотеста без камеры
    const n = q.getModuleCount(), cell = Math.max(3, Math.floor(600 / n));
    canvas.width = canvas.height = n * cell;
    const g = canvas.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, n * cell, n * cell); g.fillStyle = '#000';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) g.fillRect(c * cell, r * cell, cell, cell);
  }

  // ---------- сканер QR ----------
  let camStream = null;
  async function scan(title) {
    $('scanTitle').textContent = title;
    const dlg = $('scanDlg'), video = $('cam');
    camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    video.srcObject = camStream;
    await video.play();
    dlg.showModal();
    const cv = document.createElement('canvas'), g = cv.getContext('2d', { willReadFrequently: true });
    return new Promise((resolve) => {
      const stop = (v) => { camStream?.getTracks().forEach((t) => t.stop()); camStream = null; if (dlg.open) dlg.close(); resolve(v); };
      dlg.onclose = () => stop(null);
      const tick = () => {
        if (!camStream) return;
        if (video.videoWidth) {
          cv.width = video.videoWidth; cv.height = video.videoHeight;
          g.drawImage(video, 0, 0);
          const code = jsQR(g.getImageData(0, 0, cv.width, cv.height).data, cv.width, cv.height, { inversionAttempts: 'dontInvert' });
          if (code?.data) return stop(code.data);
        }
        requestAnimationFrame(tick);
      };
      tick();
    });
  }

  // ---------- микрофон ----------
  async function startMic() {
    const old = S.mic;
    S.mic = await AUDIO.start(prefs, onLevel);
    old?.stop();
    routeAudio();
  }

  function onLevel({ db, voice }) {
    const pct = Math.max(0, Math.min(100, (db + 90) * (100 / 80)));
    $('lvl').style.width = pct + '%';
    const ring = $('ring');
    ring.style.opacity = db > prefs.gateDb ? 1 : 0.15;
    ring.style.setProperty('--s', 1 + Math.max(0, db + 60) / 300);
    if (prefs.mode === 'vad') setTalking(voice && !S.vadMuted);
  }

  // Звук. Облако: микрофон уходит в SFU, только пока говорю; чужие голоса глушим по каналам.
  // Без интернета — «звезда»: участник шлёт хабу, хаб раскладывает говорящих по 3 слотам каждого слушателя.
  const hears = (L, sp) => !!L && !!sp && L.id !== sp.id && (sp.talk === ALL || L.listen.includes(sp.talk));
  const trackOf = (id) => (id === S.id ? S.mic?.track : S.peers.get(id)?.remote || S.cloudTracks.get(id)) || null;

  function routeAudio() {
    const my = me();
    const mic = S.talking ? S.mic?.track ?? null : null;
    S.sfu?.setTrack(mic).catch(() => {});
    if (!S.host) S.peers.get(S.hostId)?.setTrack(mic);
    for (const el of $('remote').children) { // a_<id> — голос конкретного человека; a_slotN — уже отобран хабом
      const id = el.id.slice(2);
      if (!id.startsWith('slot')) el.muted = !hears(my, S.roster.find((x) => x.id === id));
    }
    if (!S.host) return;
    const talkers = S.roster.filter((m) => m.talking);
    for (const [id, p] of S.peers) {
      const L = S.roster.find((x) => x.id === id);
      const list = talkers.filter((t) => hears(L, t));
      p.slots?.forEach((s, i) => s.sender.replaceTrack(list[i] ? trackOf(list[i].id) : null).catch(() => {}));
    }
  }

  function setTalking(on) {
    on = !!on && !S.over;
    if (S.talking === on) return;
    S.talking = on;
    routeAudio();
    sendHub({ t: 'talk', on });
    $('ptt').classList.toggle('live', on);
    if (S.stt) {
      clearTimeout(S.sttStopT);
      if (on) S.stt.start(); else S.sttStopT = setTimeout(() => S.stt.stop(), 1200); // дать дослать последнюю фразу
    }
  }

  function playRemote(track, peer) {
    let el = document.getElementById('a_' + peer.id);
    if (!el) {
      el = document.createElement('audio');
      el.id = 'a_' + peer.id; el.autoplay = true; el.playsInline = true;
      $('remote').appendChild(el);
    }
    el.srcObject = new MediaStream([track]);
    el.volume = prefs.vol;
    el.play().catch(() => banner('Нажми на экран, чтобы включить звук.', true));
  }

  // ---------- связь с хабом ----------
  function sendHub(m) {
    if (S.host) S.hub?.onMessage(S.id, m);
    else if (S.ws) S.ws.send(Object.assign({}, m, { to: S.hostId }));
    else S.peers.get(S.hostId)?.send(m);
  }

  // ---------- диагностика связи: видно, на каком шаге застряло ----------
  const ICE_RU = { new: 'жду ответа', checking: 'ищу путь между телефонами…', connected: 'есть ✓', completed: 'есть ✓',
    failed: 'не удалось', disconnected: 'обрыв, пробую снова…', closed: 'закрыто' };
  function step(text) {
    const t = new Date().toLocaleTimeString('ru-RU');
    const box = S.join?.kind === 'off' ? $('answerState') : $('startErr');
    box.textContent = text;
    (S.log = S.log || []).push(t + ' ' + text);
  }
  function addrInfo(p) {
    return `мои адреса: ${addrs(p.pc.localDescription?.sdp)}; у собеседника: ${addrs(p.pc.remoteDescription?.sdp)}`;
  }
  const FAIL_TIP = 'Телефоны не видят друг друга в этой сети. Проверь, что все в ОДНОЙ Wi-Fi (не гостевой — там часто «изоляция клиентов»), или подключи всех к раздаче с телефона хаба.';

  function onState(p, st) {
    if (S.entered && st !== 'failed') return;
    if (!S.host && p.id === S.hostId) {
      step(`Связь с хабом: ${ICE_RU[st] || st}. ${addrInfo(p)}` + (st === 'failed' ? '\n' + FAIL_TIP : ''));
    } else if (S.host) {
      const who = S.roster.find((m) => m.id === p.id)?.name || 'Новый участник';
      banner(`${who}: связь ${ICE_RU[st] || st}` + (st === 'failed' ? `. ${addrInfo(p)}. ${FAIL_TIP}` : ''), st === 'failed');
    }
  }

  function peerOpts(id, initiator, boot) {
    return {
      initiator, boot, onState, slots: S.host ? 3 : 0,
      onTrack: (track, p, slot) => playRemote(track, slot == null ? p : { id: 'slot' + slot }),
      onMsg: (m, p) => { if (S.host) S.hub.onMessage(p.id, m); else if (p.id === S.hostId) onHub(m); },
      onOpen: (p) => {
        if (S.host) S.hub.attach(p.id, (m) => p.send(m));
        else if (p.id === S.hostId) enterMain();
        routeAudio();
      },
      onClose: (p) => {
        if (S.peers.get(p.id) === p) S.peers.delete(p.id);
        document.getElementById('a_' + p.id)?.remove();
        if (S.host) S.hub.detach(p.id);
        else if (p.id === S.hostId && !S.over) banner('Хаб отключился — связи нет. Подойди ближе к Wi-Fi или войди заново.', true);
      },
    };
  }

  // Облако: забираем голоса новых участников, отпускаем ушедших. Неудачные — повтор раз в 5 с.
  function pullCloud() {
    if (!S.sfu) return;
    for (const [id] of S.pulled) {
      if (S.roster.some((m) => m.id === id)) continue;
      S.pulled.delete(id); S.cloudTracks.delete(id);
      S.sfu.drop(id).catch(() => {});
      document.getElementById('a_' + id)?.remove();
    }
    const want = S.roster.filter((m) => m.id !== S.id && m.sfu && S.pulled.get(m.id) !== m.sfu);
    if (!want.length) return;
    want.forEach((m) => S.pulled.set(m.id, m.sfu));
    const forget = (m) => S.pulled.get(m.id) === m.sfu && S.pulled.delete(m.id);
    S.sfu.pull(want.map((m) => ({ id: m.id, session: m.sfu })))
      .then((ok) => ok.forEach((v, i) => !v && forget(want[i])), () => want.forEach(forget));
  }

  async function startCloudAudio() {
    S.sfu = await CLOUD.sfu((track, id) => {
      if (!id) return;
      S.cloudTracks.set(id, track);
      playRemote(track, { id });
      routeAudio();
    }, (st) => { if (st === 'failed' || st === 'disconnected') banner('Связь с облаком: ' + (ICE_RU[st] || st)); });
    routeAudio();
    S.sfu.connected.then(() => { sendHub({ t: 'update', sfu: S.sfu.sessionId }); pullCloud(); }, (e) => banner(e.message, true));
    setInterval(pullCloud, 5000);
  }

  function onHub(m) {
    switch (m.t) {
      case 'welcome':
        break;
      case 'roster': {
        S.roster = m.members; S.channels = m.channels; S.hostId = m.host; S.trialEnd = m.trialEnd;
        pullCloud();
        for (const [id, p] of S.peers) if (!S.roster.some((x) => x.id === id) && !(S.host && id === S.pending?.id)) p.close();
        const my = me();
        if (my) { // каналы могли переименовать — чиним свой выбор
          const ok = (c) => S.channels.includes(c);
          const listen = my.listen.filter(ok);
          const talk = my.talk === ALL || ok(my.talk) ? my.talk : S.channels[0];
          if (listen.length !== my.listen.length || talk !== my.talk) updateMe({ listen: listen.length ? listen : [S.channels[0]], talk });
        }
        routeAudio();
        renderChans(); renderPeople(); renderTrial();
        break;
      }
      case 'talk': {
        const x = S.roster.find((r) => r.id === m.id);
        if (x) { x.talking = m.on; x.talk = m.ch; }
        txTalk(m.id, m.on);
        routeAudio();
        renderPeople();
        break;
      }
      case 'stt': txText(m.id, m.text, m.final); break;
      case 'chat': addChat(m); break;
      case 'call': {
        const my = me();
        if (m.id !== S.id && my && (m.ch === ALL || my.listen.includes(m.ch))) callAlert(m);
        break;
      }
      case 'end': finish(m.reason); break;
    }
  }

  function updateMe(patch) {
    Object.assign(prefs, patch); savePrefs();
    sendHub(Object.assign({ t: 'update' }, patch));
  }

  function hello() {
    const listen = (prefs.listen || DEFAULT_CH).filter((c) => S.channels.includes(c));
    sendHub({ t: 'hello', name: prefs.name, role: prefs.role, sfu: S.sfu?.sessionId || '', listen: listen.length ? listen : [S.channels[0]],
      talk: prefs.talk && (prefs.talk === ALL || S.channels.includes(prefs.talk)) ? prefs.talk : S.channels[0] });
  }

  // ---------- хаб: создание сессии ----------
  async function createSession() {
    if (!readProfile()) return;
    try { await startMic(); } catch (e) { return err('Нет доступа к микрофону: ' + e.message); }
    S.host = true; S.hostId = S.id;
    S.licEmail = await LIC.licensed();
    S.trialEnd = S.licEmail ? null : Date.now() + LIC.TRIAL * 1000;
    S.hub = new Hub({ hostId: S.id, channels: DEFAULT_CH, trialEnd: S.trialEnd });
    S.hub.attach(S.id, (m) => queueMicrotask(() => onHub(m)));
    hello();
    enterMain();
    $('hostBtn').hidden = false;
    $('statusPill').textContent = 'Хаб'; $('statusPill').classList.add('hub');
    await setHostMode('on');
    openHost();
  }

  async function setHostMode(mode) {
    S.hostMode = mode;
    $('modeOn').classList.toggle('on', mode === 'on');
    $('modeOff').classList.toggle('on', mode === 'off');
    $('scanAnsBtn').hidden = mode !== 'on' ? false : true;
    $('joinHint').textContent = 'Готовлю QR…';
    if (mode === 'on') {
      try {
        if (!S.ws) {
          if (!CLOUD.configured) throw new Error('облако не настроено');
          if (!S.sfu) await startCloudAudio();
          S.roomName = rid() + rid(); // имя комнаты в облаке знают только те, у кого QR
          S.ws = CLOUD.room(S.roomName, S.id, onCloudHub);
          S.onlineUrl = base() + '#c=' + (await BOOT.pack({ r: S.roomName, h: S.id }));
        }
        if (S.hostMode !== 'on') return; // пока ждали брокер, переключили на «без интернета»
        S.joinUrl = S.onlineUrl;
        drawQr($('joinQr'), S.joinUrl);
        $('joinHint').textContent = 'Наведи камеру телефона на QR → откроется ссылка → «Войти в сессию». Звук идёт через облако: работает в любой сети, где есть интернет.';
      } catch {
        if (S.hostMode !== 'on') return;
        $('joinHint').textContent = (CLOUD.configured ? 'Нет связи с облаком' : 'Облачный режим ещё не подключён') + ' — переключаю на вход без интернета.';
        return setHostMode('off');
      }
    } else if (S.pending?.offerUrl) {
      showOffer(S.pending.offerUrl);
    } else if (!S.pending) {
      await newPending();
    }
  }

  function showOffer(url) {
    if (S.hostMode !== 'off') return;
    S.joinUrl = url;
    drawQr($('joinQr'), url);
    $('joinHint').textContent = '1) Входящий наводит камеру на этот QR. 2) Он покажет свой QR — нажми «Сканировать ответ».';
  }

  // Хаб в облаке: сообщения участников приходят через комнату, ответы уходят адресно.
  function onCloudHub(m) {
    const id = m.from;
    if (!/^[0-9a-f]{10}$/.test(id || '') || S.over) return;
    if (m.t === 'left') return S.hub.detach(id);
    if (!S.hub.links.has(id)) S.hub.attach(id, (x) => S.ws.send(Object.assign({}, x, { to: id })));
    S.hub.onMessage(id, m);
  }

  // Офлайн: хаб заранее готовит предложение для следующего входящего и показывает его в QR.
  async function newPending() {
    const p = new Peer('pending', peerOpts('pending', true, async (desc) => {
      p.offerUrl = base() + '#o=' + (await BOOT.pack({ h: S.id, d: BOOT.slim(desc) }));
      showOffer(p.offerUrl);
    }));
    S.pending = p;
  }

  async function scanAnswer() {
    let text;
    try { text = await scan('Отсканируй QR с телефона входящего'); } catch (e) { return alert('Нет доступа к камере: ' + e.message); }
    if (text) await acceptAnswer(text);
  }

  async function acceptAnswer(text) {
    if (!text.startsWith('WFIA:')) return alert('Это не ответный QR Wi-Fi Intercom.');
    let a; try { a = await BOOT.unpack(text.slice(5)); } catch { return alert('QR не прочитался, попробуй ещё раз.'); }
    const p = S.pending;
    if (!p || !/^[0-9a-f]{10}$/.test(a.pid)) return;
    p.id = a.pid;
    S.peers.set(a.pid, p);
    S.pending = null;
    banner('Ответ принят — соединяю телефоны…', true);
    await p.signal(a.d);
    newPending();
  }

  // ---------- участник: вход ----------
  async function readJoin() {
    const h = new URLSearchParams(location.hash.slice(1));
    try {
      if (h.get('c')) S.join = Object.assign({ kind: 'on' }, await BOOT.unpack(h.get('c')));
      else if (h.get('o')) S.join = Object.assign({ kind: 'off' }, await BOOT.unpack(h.get('o')));
    } catch { S.join = null; err('Ссылка входа повреждена — отсканируй QR ещё раз.'); }
    $('joinBtn').hidden = !S.join;
    $('createBtn').classList.toggle('primary', !S.join);
    if (S.join) $('startSub').textContent = 'Тебя пригласили в сессию. Введи имя и входи.';
  }

  async function joinSession() {
    if (!readProfile() || !S.join) return;
    try { await startMic(); } catch (e) { return err('Нет доступа к микрофону: ' + e.message); }
    const j = S.join;
    S.hostId = String(j.h);
    history.replaceState(null, '', base());
    if (j.kind === 'on') {
      step('Шаг 1/2: подключаюсь к облаку…');
      try { await startCloudAudio(); } catch (e) {
        return step('Не получилось выйти в облако (' + e.message + '). Нужен интернет — или попроси хаб переключиться на «Без интернета».');
      }
      S.ws = CLOUD.room(String(j.r), S.id, (m) => {
        if (m.from !== S.hostId) return;
        if (m.t === 'left') { if (!S.over) banner('Хаб вышел из сети — ждём, пока вернётся.', true); return; }
        enterMain();
        onHub(m);
      }, (st) => { if (st === 'open' && S.entered) hello(); }); // после обрыва представляемся заново
      step('Шаг 2/2: облако есть ✓, жду ответ хаба…');
      const knock = setInterval(() => (S.entered || S.over ? clearInterval(knock) : hello()), 2000);
      hello();
      setTimeout(() => { if (!S.entered) step('Хаб не отвечает. Проверь, что у хаба открыт QR «Есть интернет» и у него есть интернет.'); }, 25000);
    } else {
      const p = new Peer(S.hostId, peerOpts(S.hostId, false, async (desc) => {
        drawQr($('answerQr'), 'WFIA:' + (await BOOT.pack({ pid: S.id, d: BOOT.slim(desc) })));
        show('answer');
        step(`Жду, пока хаб отсканирует… (${addrInfo(p)})`);
      }));
      S.peers.set(S.hostId, p);
      p.signal(j.d);
    }
  }

  function readProfile() {
    const name = $('name').value.trim();
    if (!name) { err('Введи имя — его увидят остальные.'); $('name').focus(); return false; }
    prefs.name = name; prefs.role = $('role').value; savePrefs();
    err('');
    return true;
  }

  // ---------- главный экран ----------
  let wake = null;
  async function keepAwake() {
    try { wake = await navigator.wakeLock?.request('screen'); } catch { /* нет поддержки */ }
  }

  function enterMain() {
    if (S.entered) return;
    S.entered = true;
    if (!S.host) hello();
    show('main');
    keepAwake();
    S.stt = prefs.stt && STT.supported ? STT.create((text, final) => sendHub({ t: 'stt', text, final })) : null;
    applyMode();
    renderChans();
    $('tx').classList.toggle('off', !prefs.showText);
    $('textBtn').setAttribute('aria-pressed', String(prefs.showText));
    if (!STT.supported) banner('Этот браузер не умеет расшифровку — текст других будет виден, свой нет.');
    setInterval(tick, 1000);
  }

  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible' || !S.entered || S.over) return;
    keepAwake();
    if (S.mic && !S.mic.alive()) { // iOS отбирает микрофон в фоне
      try { await startMic(); banner('Микрофон снова работает. Не сворачивай приложение во время шоу.'); } catch { banner('Микрофон отключён — разреши его снова.'); }
    }
  });

  function banner(text, sticky) {
    const b = $('banner');
    b.textContent = text; b.hidden = false;
    clearTimeout(b._t);
    if (!sticky) b._t = setTimeout(() => { b.hidden = true; }, 8000);
  }
  $('banner').onclick = () => { $('banner').hidden = true; for (const a of $('remote').children) a.play().catch(() => {}); };

  const chColor = (c) => (c === ALL ? '#ffffff' : COLORS[(S.channels.indexOf(c) + 3) % COLORS.length]);

  function renderChans() {
    const my = me();
    if (!my) return;
    const box = $('listen');
    box.replaceChildren(...S.channels.map((c) => {
      const b = document.createElement('button');
      b.className = 'chip'; b.textContent = c;
      b.style.setProperty('--c', chColor(c));
      b.setAttribute('aria-pressed', String(my.listen.includes(c)));
      b.onclick = () => {
        const set = new Set(my.listen);
        if (set.has(c)) set.delete(c); else set.add(c);
        updateMe({ listen: S.channels.filter((x) => set.has(x)) });
      };
      return b;
    }));
    const sel = $('talkCh');
    const opts = [...S.channels];
    if (my.role === 'Режиссёр' || S.host) opts.push(ALL);
    sel.replaceChildren(...opts.map((c) => new Option(c === ALL ? 'Все каналы' : c, c)));
    sel.value = my.talk;
    $('peopleN').textContent = S.roster.length;
  }
  $('talkCh').onchange = (e) => updateMe({ talk: e.target.value });

  function renderPeople() {
    if (!$('peopleDlg').open) return;
    $('people').replaceChildren(...S.roster.map((m) => {
      const row = document.createElement('div');
      row.className = 'person' + (m.talking ? ' talking' : '');
      row.style.setProperty('--c', m.color);
      const sw = document.createElement('span'); sw.className = 'sw';
      const meta = document.createElement('div'); meta.className = 'meta';
      const b = document.createElement('b'); b.textContent = m.name + (m.id === S.id ? ' (я)' : '') + (m.id === S.hostId ? ' · хаб' : '');
      meta.append(b, document.createElement('br'), `${m.role} · говорит в: ${m.talk === ALL ? 'все' : m.talk} · слушает: ${m.listen.join(', ') || '—'}`);
      const lat = document.createElement('span'); lat.className = 'lat'; lat.id = 'lat_' + m.id;
      row.append(sw, meta, lat);
      return row;
    }));
    updateLatency();
  }

  async function updateLatency() {
    for (const [id, p] of S.peers) {
      const el = document.getElementById('lat_' + id);
      if (!el) continue;
      const s = await p.stats();
      // рот → ухо ≈ половина RTT + джиттер-буфер + ~40 мс захват/кодек/вывод
      el.textContent = s.rtt == null ? '…' : `~${Math.round(s.rtt / 2 + (s.jb || 0) + 40)} мс`;
    }
  }

  // ---------- лента расшифровки ----------
  const lines = new Map(); // id → {el, t}
  function lineFor(id) {
    let l = lines.get(id);
    const m = S.roster.find((x) => x.id === id);
    if (!l) {
      const el = document.createElement('div'); el.className = 'line';
      const who = document.createElement('div'); who.className = 'who';
      const say = document.createElement('div'); say.className = 'say';
      el.append(who, say);
      l = { el, who, say };
      lines.set(id, l);
    }
    l.el.style.setProperty('--c', m?.color || '#38bdf8');
    l.who.textContent = (m ? m.name : '?') + (m?.talk ? ` → ${m.talk === ALL ? 'всем' : m.talk}` : '');
    l.el.classList.remove('old');
    $('tx').append(l.el); // свежий — вниз, ближе к кнопке
    while ($('tx').children.length > 3) { const first = $('tx').firstChild; lines.forEach((v, k) => v.el === first && lines.delete(k)); first.remove(); }
    l.t = Date.now();
    return l;
  }

  function txTalk(id, on) {
    if (on) {
      const l = lineFor(id);
      l.say.textContent = l.say.textContent || '…';
      const live = document.createElement('span'); live.className = 'live'; live.textContent = '● ЭФИР';
      l.who.append(live);
    } else {
      const l = lines.get(id);
      l?.who.querySelector('.live')?.remove();
    }
  }

  function txText(id, text, final) {
    const l = lineFor(id);
    l.say.textContent = text;
    const m = S.roster.find((x) => x.id === id);
    if (m?.talking) { const live = document.createElement('span'); live.className = 'live'; live.textContent = '● ЭФИР'; l.who.append(live); }
    if (final) l.final = true;
  }

  // ---------- чат ----------
  let unread = 0;
  function addChat(m) {
    const x = S.roster.find((r) => r.id === m.id);
    const row = document.createElement('div'); row.className = 'msg';
    const nick = document.createElement('span'); nick.className = 'nick';
    nick.textContent = x ? x.name : '?'; nick.style.color = x?.color || '#9aa3b5';
    const time = document.createElement('time');
    time.textContent = new Date(m.ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    const text = document.createElement('div'); text.textContent = m.text;
    row.append(nick, time, text);
    $('msgs').append(row);
    $('msgs').scrollTop = $('msgs').scrollHeight;
    if (!$('chat').classList.contains('open') && m.id !== S.id) { unread++; $('unread').textContent = unread; $('unread').hidden = false; }
  }
  $('chatHandle').onclick = () => {
    const open = $('chat').classList.toggle('open');
    $('chatHandle').setAttribute('aria-expanded', String(open));
    if (open) { unread = 0; $('unread').hidden = true; }
  };
  $('chatForm').onsubmit = (e) => {
    e.preventDefault();
    const t = $('chatIn').value.trim();
    if (t) sendHub({ t: 'chat', text: t });
    $('chatIn').value = '';
  };
  $('emojis').append(...EMOJI.map((em) => {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = em;
    b.onclick = () => { $('chatIn').value += em; $('chatIn').focus(); };
    return b;
  }));
  $('emojiBtn').onclick = () => { $('emojis').hidden = !$('emojis').hidden; };

  // ---------- вызов ----------
  function callAlert(m) {
    const x = S.roster.find((r) => r.id === m.id);
    $('flashTxt').textContent = `ВЫЗОВ\n${x ? x.name : ''} → ${m.ch === ALL ? 'всем' : m.ch}`;
    $('flash').hidden = false;
    AUDIO.beep([988, 1319, 988, 1319], 0.15);
    navigator.vibrate?.([300, 120, 300, 120, 300]);
    clearTimeout(callAlert.t);
    callAlert.t = setTimeout(() => { $('flash').hidden = true; }, 3500);
  }
  $('flash').onclick = () => { $('flash').hidden = true; };
  $('callBtn').onclick = () => { const my = me(); if (my) sendHub({ t: 'call', ch: my.talk }); AUDIO.beep([660], 0.08); };

  // ---------- PTT ----------
  const ptt = $('ptt');
  const down = (e) => { e.preventDefault(); if (prefs.mode !== 'ptt') return; S.pttDown = true; setTalking(true); AUDIO.beep([1200], 0.04); };
  const up = () => { if (!S.pttDown) return; S.pttDown = false; setTalking(false); };
  ptt.addEventListener('pointerdown', down);
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) ptt.addEventListener(ev, up);
  ptt.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('keydown', (e) => { if (e.code === 'Space' && !e.repeat && S.entered && !e.target.matches('input,select,textarea')) down(e); });
  document.addEventListener('keyup', (e) => { if (e.code === 'Space') up(); });
  // в режиме «по голосу» тап по кругу — выключить/включить микрофон
  ptt.addEventListener('click', () => {
    if (prefs.mode !== 'vad') return;
    S.vadMuted = !S.vadMuted;
    if (S.vadMuted) setTalking(false);
    applyMode();
  });

  function applyMode() {
    ptt.classList.toggle('vad', prefs.mode === 'vad');
    ptt.classList.toggle('muted', prefs.mode === 'vad' && !!S.vadMuted);
    $('pttTxt').innerHTML = prefs.mode === 'ptt' ? 'ДЕРЖИ<br>И ГОВОРИ' : S.vadMuted ? 'МИКРОФОН<br>ВЫКЛ' : 'ПО ГОЛОСУ<br><small>тап — выкл</small>';
    $('mPtt').classList.toggle('on', prefs.mode === 'ptt');
    $('mVad').classList.toggle('on', prefs.mode === 'vad');
  }

  // ---------- настройки ----------
  $('setBtn').onclick = () => {
    $('ns').value = prefs.ns; $('band').checked = prefs.band; $('gate').value = prefs.gateDb;
    $('gateV').textContent = prefs.gateDb + ' дБ'; $('sttOn').checked = prefs.stt; $('vol').value = prefs.vol;
    $('gateMark').style.left = ((prefs.gateDb + 90) * (100 / 80)) + '%';
    $('setHint').textContent = S.mic && prefs.ns === 'rnnoise' && !S.mic.rnnoise ? 'RNNoise не запустился на этом устройстве — работает встроенный шумодав.' : '';
    $('setDlg').showModal();
  };
  $('mPtt').onclick = () => { prefs.mode = 'ptt'; savePrefs(); setTalking(false); applyMode(); };
  $('mVad').onclick = () => { prefs.mode = 'vad'; savePrefs(); setTalking(false); applyMode(); };
  const remic = async () => { savePrefs(); if (S.mic) try { await startMic(); } catch (e) { $('setHint').textContent = 'Микрофон: ' + e.message; } };
  $('ns').onchange = (e) => { prefs.ns = e.target.value; remic(); };
  $('band').onchange = (e) => { prefs.band = e.target.checked; remic(); };
  $('gate').oninput = (e) => {
    prefs.gateDb = +e.target.value; savePrefs();
    $('gateV').textContent = prefs.gateDb + ' дБ';
    $('gateMark').style.left = ((prefs.gateDb + 90) * (100 / 80)) + '%';
    S.mic?.setGate(prefs.gateDb);
  };
  $('sttOn').onchange = (e) => {
    prefs.stt = e.target.checked; savePrefs();
    S.stt?.stop();
    S.stt = prefs.stt && STT.supported ? STT.create((text, final) => sendHub({ t: 'stt', text, final })) : null;
  };
  $('vol').oninput = (e) => { prefs.vol = +e.target.value; savePrefs(); for (const a of $('remote').children) a.volume = prefs.vol; };
  $('textBtn').onclick = () => {
    prefs.showText = !prefs.showText; savePrefs();
    $('tx').classList.toggle('off', !prefs.showText);
    $('textBtn').setAttribute('aria-pressed', String(prefs.showText));
  };
  $('testBtn').onclick = async () => {
    if (!S.mic) return;
    const rec = new MediaRecorder(new MediaStream([S.mic.track.clone()]));
    const parts = [];
    rec.ondataavailable = (e) => parts.push(e.data);
    rec.onstop = () => { const a = new Audio(URL.createObjectURL(new Blob(parts, { type: rec.mimeType }))); a.play(); $('testBtn').textContent = 'Послушать себя (3 сек)'; };
    rec.start();
    $('testBtn').textContent = 'Говори… 3';
    setTimeout(() => rec.stop(), 3000);
  };
  $('peopleBtn').onclick = () => { $('peopleDlg').showModal(); renderPeople(); };
  setInterval(() => { if ($('peopleDlg').open) updateLatency(); }, 2000);

  // ---------- хаб: диалог ----------
  function openHost() {
    renderChEdit(); renderLic($('licBox'));
    if (S.joinUrl) drawQr($('joinQr'), S.joinUrl);
    $('hostDlg').showModal();
  }
  $('hostBtn').onclick = openHost;
  $('modeOn').onclick = () => setHostMode('on');
  $('modeOff').onclick = () => setHostMode('off');
  $('scanAnsBtn').onclick = scanAnswer;
  $('copyBtn').onclick = async () => { try { await navigator.clipboard.writeText(S.joinUrl); $('copyBtn').textContent = 'Скопировано ✓'; } catch { prompt('Ссылка для входа:', S.joinUrl); } };

  function renderChEdit() {
    const box = $('chEdit');
    box.replaceChildren(...S.channels.map((c, i) => {
      const row = document.createElement('div'); row.className = 'chRow';
      const inp = document.createElement('input'); inp.value = c; inp.maxLength = 20;
      inp.onchange = () => { const list = [...S.channels]; list[i] = inp.value.trim() || c; sendHub({ t: 'channels', list }); };
      const del = document.createElement('button'); del.textContent = '✕'; del.className = 'icon'; del.setAttribute('aria-label', 'Удалить канал ' + c);
      del.disabled = S.channels.length <= 1;
      del.onclick = () => { sendHub({ t: 'channels', list: S.channels.filter((_, j) => j !== i) }); setTimeout(renderChEdit, 50); };
      row.append(inp, del);
      return row;
    }));
  }
  $('chAdd').onclick = () => { sendHub({ t: 'channels', list: [...S.channels, 'Канал ' + (S.channels.length + 1)] }); setTimeout(renderChEdit, 50); };

  function renderLic(box) {
    box.replaceChildren();
    if (S.licEmail) { box.append(`Активировано: ${S.licEmail}. Пробных ограничений нет.`); return; }
    const p = document.createElement('p'); p.className = 'hint';
    p.textContent = `Пробная сессия — ${LIC.TRIAL / 60} минут. Ключ хаба (499 ⭐) — в Telegram-боте; ключ привязан к e-mail, после очистки браузера просто вставь его снова.`;
    const email = document.createElement('input'); email.type = 'email'; email.placeholder = 'E-mail из покупки'; email.autocomplete = 'email';
    const key = document.createElement('input'); key.placeholder = 'Ключ из бота'; key.style.marginTop = '8px';
    const go = document.createElement('button'); go.className = 'big primary'; go.textContent = 'Активировать';
    const buy = document.createElement('a'); buy.href = LIC.BUY_URL; buy.target = '_blank'; buy.rel = 'noopener'; buy.textContent = 'Купить ключ в Telegram-боте';
    buy.className = 'hint'; buy.style.display = 'block';
    go.onclick = async () => {
      if (!(await LIC.activate(email.value, key.value))) { p.textContent = 'Ключ не подходит к этому e-mail. Проверь, что скопирован целиком.'; return; }
      S.licEmail = await LIC.licensed();
      if (S.hub) { S.hub.trialEnd = null; S.trialEnd = null; S.hub.roster(); }
      renderLic(box);
    };
    box.append(p, email, key, go, buy);
  }

  // ---------- пробная сессия ----------
  function renderTrial() {
    const t = $('trial');
    if (!S.trialEnd) { t.hidden = true; return; }
    const left = Math.max(0, Math.round((S.trialEnd - Date.now()) / 1000));
    t.hidden = false;
    t.textContent = `⏱ ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    t.title = 'Пробная сессия';
  }

  function tick() {
    renderTrial();
    if (S.host && S.trialEnd && Date.now() >= S.trialEnd && !S.over) { S.hub.end('trial'); finish('trial'); }
    for (const [, l] of lines) if (Date.now() - l.t > 12000) l.el.classList.add('old');
  }

  function finish(reason) {
    if (S.over) return;
    S.over = true;
    setTalking(false);
    setTimeout(() => { for (const p of S.peers.values()) p.close(); S.pending?.close(); S.ws?.close(); S.sfu?.close(); S.mic?.stop(); }, 300);
    $('endTitle').textContent = reason === 'trial' ? 'Пробные 5 минут закончились' : 'Сессия закончилась';
    $('endTxt').textContent = reason === 'trial'
      ? (S.host ? 'Чтобы говорить без ограничений, активируй хаб. Можно начать новую пробную сессию.' : 'Хаб работает в пробном режиме. Попроси его активировать ключ или начни заново.')
      : '';
    $('endLic').replaceChildren();
    if (S.host && reason === 'trial') renderLic($('endLic'));
    $('endDlg').showModal();
  }
  $('againBtn').onclick = () => location.replace(base());

  // ---------- старт ----------
  $('ver').textContent = 'Версия ' + VER;
  $('name').value = prefs.name;
  $('role').value = prefs.role;
  $('createBtn').onclick = createSession;
  $('joinBtn').onclick = joinSession;
  $('scanJoinBtn').onclick = async () => {
    let text;
    try { text = await scan('Наведи камеру на QR хаба'); } catch (e) { return err('Нет доступа к камере: ' + e.message); }
    if (!text) return;
    const i = text.indexOf('#');
    if (i < 0 || !/[#&](j|o)=/.test(text.slice(i))) return err('Это не QR Wi-Fi Intercom.');
    history.replaceState(null, '', base() + text.slice(i));
    await readJoin();
  };
  window.addEventListener('hashchange', readJoin);
  readJoin();

  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});

  // для проверок в консоли
  window.__wfi = { S, prefs, acceptAnswer, sendHub, setTalking, setHostMode };
})();
