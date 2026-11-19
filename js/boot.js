// Упаковка рукопожатия в QR без интернета: сжатый SDP (deflate + base64url).
(function (root) {
  const enc = new TextEncoder(), dec = new TextDecoder();

  const b64u = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

  async function pipe(bytes, Stream) {
    const out = new Response(new Blob([bytes]).stream().pipeThrough(new Stream('deflate-raw')));
    return new Uint8Array(await out.arrayBuffer());
  }
  // Для QR: в одной Wi-Fi нужны только UDP IPv4 (или .local) кандидаты — QR становится в разы проще.
  function slim(desc) {
    const keep = (l) => {
      if (l.startsWith('a=candidate:')) {
        const f = l.split(' ');
        return f[2].toLowerCase() === 'udp' && !f[4].includes(':');
      }
      return !/^a=(extmap-allow-mixed|msid-semantic|ice-options)/.test(l);
    };
    return { type: desc.type, sdp: desc.sdp.split('\r\n').filter((l) => l && keep(l)).join('\r\n') + '\r\n' };
  }

  const pack = async (obj) => b64u(await pipe(enc.encode(JSON.stringify(obj)), CompressionStream));
  const unpack = async (s) => JSON.parse(dec.decode(await pipe(unb64u(s), DecompressionStream)));

  root.WFI_BOOT = { pack, unpack, slim, b64u };
})(typeof window !== 'undefined' ? window : globalThis);
