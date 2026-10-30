// PageGame: nome da sala de uma página (usado pelo jogo e pelo aviso no ícone).
// Sala = hash da URL sem rastreadores e sem #. A URL nunca sai do navegador:
// só este hash vai para o Supabase.
(() => {
  const cyrb = (s, seed) => {          // cyrb53 duas vezes = 106 bits, sem crypto.subtle (que falta em http://)
    let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < s.length; i++) {
      const ch = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
  };
  globalThis.pgRoomKey = (href) => {
    const u = new URL(href);
    u.hash = '';
    for (const k of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_|ref$|ref_|si$|igsh)/i.test(k)) u.searchParams.delete(k);
    }
    u.searchParams.sort();
    return cyrb(u.host.toLowerCase() + u.pathname.replace(/\/+$/, '') + u.search, 1) +
           cyrb(u.host.toLowerCase() + u.pathname.replace(/\/+$/, '') + u.search, 2);
  };
})();
