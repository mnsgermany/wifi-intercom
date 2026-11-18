// Лицензия Wi-Fi Intercom: ключ = RSA-SHA256 подпись "WiFiIntercom-1|<e-mail>", base64.
// Ключ привязан к e-mail, а не к устройству: после очистки Safari тот же ключ из чата с ботом
// вставляется снова и работает без интернета — перевыпуск не нужен.
// shortcut: без онлайн-учёта устройств ключ можно передать другу; лимит «2 устройства на ключ» —
// через бэкенд бота (Apps Script), когда Макс утвердит.
(function (root) {
  const PUBLIC_KEY = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA1CxhEwaZQvDwFFfXqxIjWfNpMMkqDj1tExPqe+xt24bSSyDdhqSz1wYW/rb/aOyr5jy82y6gXkjuVHWF/ca9gAbl+Obq+Hs7ndOjCUHof/lS9+x2BSHzFRXUhAnbbv/79ZAn0SrJ/+ek+q3GMIuXdutZfnEcI91PeefUJCmyAXjMp7HTwfhVnIbqs5T6zG/6rAXRc4q/NNgFrGBPHx/WuRqel6i0NrOEunS+YzmscP99h9pjpGSr8pBGZKo8hKVgcHDG419p9/8WGlr0ObRMhrE54ai2BDZxawhYdbNY/cLsn5TwpENK20G+kk9eZP/jQq60WxH3RJt89MMSRtXwBQIDAQAB';
  const PREFIX = 'WiFiIntercom-1';
  const BUY_URL = 'https://t.me/Qlab_waveform_bot';
  const TRIAL = 5 * 60; // секунд на одну пробную сессию
  const STORE = 'wfi_lic';
  const b64 = (s) => Uint8Array.from(atob(String(s).replace(/\s/g, '')), (c) => c.charCodeAt(0));
  const cleanEmail = (s) => String(s ?? '').trim().toLowerCase();

  async function valid(email, key) {
    email = cleanEmail(email);
    if (!email || !key) return false;
    try {
      const pub = await crypto.subtle.importKey('spki', b64(PUBLIC_KEY), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
      return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', pub, b64(key), new TextEncoder().encode(`${PREFIX}|${email}`));
    } catch { return false; }
  }

  function saved() {
    try { return JSON.parse(localStorage.getItem(STORE)) || null; } catch { return null; }
  }

  async function activate(email, key) {
    if (!(await valid(email, key))) return false;
    try {
      localStorage.setItem(STORE, JSON.stringify({ email: cleanEmail(email), key: String(key).trim() }));
      navigator.storage?.persist?.(); // просим Safari не чистить данные сайта сам по себе
    } catch { /* приватный режим — работает до закрытия */ }
    return true;
  }

  async function licensed() {
    const s = saved();
    return !!s && (await valid(s.email, s.key)) ? s.email : null;
  }

  root.WFI_LICENSE = { PREFIX, BUY_URL, TRIAL, valid, activate, licensed };
})(typeof window !== 'undefined' ? window : globalThis);
