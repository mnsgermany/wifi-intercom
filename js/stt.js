// Расшифровка своего голоса встроенным распознаванием браузера (Safari → Apple, Chrome → Google).
// shortcut: офлайн работает только там, где браузер умеет processLocally (Chrome с языковым пакетом);
// офлайн-движок Vosk WASM — следующий шаг.
(function (root) {
  const SR = root.SpeechRecognition || root.webkitSpeechRecognition;

  function create(onText) {
    if (!SR) return null;
    let rec = null, want = false;

    function spawn() {
      rec = new SR();
      rec.lang = 'ru-RU';
      rec.continuous = true;
      rec.interimResults = true;
      if (!navigator.onLine && 'processLocally' in rec) rec.processLocally = true;
      rec.onresult = (e) => {
        let text = '', final = true;
        for (let i = e.resultIndex; i < e.results.length; i++) {
          text += e.results[i][0].transcript;
          if (!e.results[i].isFinal) final = false;
        }
        if (text.trim()) onText(text.trim(), final);
      };
      rec.onerror = (e) => { if (e.error === 'not-allowed' || e.error === 'service-not-allowed') want = false; };
      rec.onend = () => { rec = null; if (want) setTimeout(() => want && !rec && spawn(), 150); };
      try { rec.start(); } catch { rec = null; }
    }

    return {
      start() { want = true; if (!rec) spawn(); },
      stop() { want = false; try { rec?.stop(); } catch { /* уже */ } },
    };
  }

  root.WFI_STT = { supported: !!SR, create };
})(typeof window !== 'undefined' ? window : globalThis);
