// PageGame: camada de plataforma.
// Na extensão, não faz nada (usa as APIs chrome.* de verdade).
// Fora dela (app do celular / site), cria um "chrome" de mentira com o mínimo
// que o jogo usa, guardando tudo no localStorage:
//   chrome.storage.local.get/set/remove + chrome.storage.onChanged
//   chrome.runtime.id + chrome.runtime.onMessage
// e expõe pgSend(cmd) para o menu do app falar com o jogo (no lugar de
// chrome.tabs.sendMessage, que só existe na extensão).
(() => {
  if (globalThis.chrome && chrome.storage && chrome.storage.local && chrome.runtime && chrome.runtime.id) {
    globalThis.PG_PLATFORM = 'extension';
    return;
  }
  globalThis.PG_PLATFORM = 'web';

  const PREFIX = 'pagegame:';
  const changeListeners = [];
  const msgListeners = [];

  const read = (k) => {
    try {
      const v = localStorage.getItem(PREFIX + k);
      return v == null ? undefined : JSON.parse(v);
    } catch { return undefined; }
  };
  const allKeys = () => {
    const out = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PREFIX)) out.push(k.slice(PREFIX.length));
    }
    return out;
  };
  const fire = (changes) => {
    if (!Object.keys(changes).length) return;
    setTimeout(() => { for (const f of changeListeners) { try { f(changes, 'local'); } catch (e) { console.warn(e); } } });
  };

  function get(keys, cb) {
    const list = keys == null ? allKeys()
      : Array.isArray(keys) ? keys
      : typeof keys === 'string' ? [keys]
      : Object.keys(keys);
    const out = {};
    for (const k of list) {
      const v = read(k);
      if (v !== undefined) out[k] = v;
      else if (keys && typeof keys === 'object' && !Array.isArray(keys) && k in keys) out[k] = keys[k];
    }
    if (cb) setTimeout(() => cb(out));
    return Promise.resolve(out);
  }
  function set(obj, cb) {
    const changes = {};
    for (const [k, v] of Object.entries(obj || {})) {
      const old = read(k);
      try { localStorage.setItem(PREFIX + k, JSON.stringify(v)); } catch {}
      changes[k] = { oldValue: old, newValue: v };
    }
    fire(changes);
    if (cb) setTimeout(cb);
    return Promise.resolve();
  }
  function remove(keys, cb) {
    const changes = {};
    for (const k of Array.isArray(keys) ? keys : [keys]) {
      const old = read(k);
      if (old === undefined) continue;
      localStorage.removeItem(PREFIX + k);
      changes[k] = { oldValue: old, newValue: undefined };
    }
    fire(changes);
    if (cb) setTimeout(cb);
    return Promise.resolve();
  }
  // mudanças feitas em outra aba do mesmo app
  addEventListener('storage', (e) => {
    if (!e.key || !e.key.startsWith(PREFIX)) return;
    const parse = (v) => { try { return v == null ? undefined : JSON.parse(v); } catch { return undefined; } };
    fire({ [e.key.slice(PREFIX.length)]: { oldValue: parse(e.oldValue), newValue: parse(e.newValue) } });
  });

  globalThis.chrome = {
    storage: {
      local: { get, set, remove },
      onChanged: { addListener: (f) => changeListeners.push(f) },
    },
    runtime: {
      id: 'pagegame-web',
      onMessage: { addListener: (f) => msgListeners.push(f) },
      sendMessage: async () => null,
    },
  };

  // o menu do app manda comandos para o jogo ('play', 'pause', 'restore', 'status')
  globalThis.pgSend = (cmd) => new Promise((resolve) => {
    let done = false;
    const reply = (r) => { if (!done) { done = true; resolve(r); } };
    for (const f of msgListeners) {
      try { f({ cmd }, {}, reply); } catch (e) { console.warn(e); }
    }
    setTimeout(() => reply(null), 4000);
  });
})();
