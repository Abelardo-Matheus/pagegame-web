// PageGame: camada de rede que roda dentro da página.
// - Multiplayer: um canal privado do Supabase Realtime por página ("page:<hash>").
//   Presence = quem está na sala. Broadcast = posição dos bichos.
// - Pontuação: chama a função submit_game do banco.
// O content.js só conversa com este arquivo pela interface window.__pgNet.
(() => {
  // Uma cópia antiga (de antes de recarregar a extensão) não funciona mais: troca por esta.
  if (window.__pgNet) { try { window.__pgNet.disconnect(); } catch {} }

  const cfg = window.PG_CONFIG || {};
  const chromeStorage = {
    getItem: async (k) => (await chrome.storage.local.get(k))[k] ?? null,
    setItem: (k, v) => chrome.storage.local.set({ [k]: v }),
    removeItem: (k) => chrome.storage.local.remove(k),
  };

  // O menu é quem renova o login. Aqui só lemos a sessão salva
  // (getSession ainda renova sozinho se o token já tiver vencido).
  const sb = supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    auth: { storage: chromeStorage, persistSession: true, autoRefreshToken: false, detectSessionInUrl: false },
    realtime: { params: { eventsPerSecond: 20 } },
  });

  let channel = null;
  let subscribed = false;
  let authTimer = null;
  let me = null;
  let lastToken = null;
  let state = 'off';                 // off | connecting | online | error

  async function token() {
    const { data } = await sb.auth.getSession();
    lastToken = data.session ? data.session.access_token : null;
    return data.session;
  }

  async function refreshAuth() {
    await token();
    try { await sb.realtime.setAuth(); } catch {}
  }

  // quando o menu renova a sessão, repassa o token novo para o socket
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && Object.keys(changes).some((k) => k.startsWith('sb-'))) refreshAuth();
  });

  async function connect({ room, profile, onPos, onPeers, onEvent, onState }) {
    if (channel) await disconnect();
    const setState = (s) => { state = s; onState && onState(s); };
    setState('connecting');

    const session = await token();
    if (!session) { setState('error'); throw new Error('sem sessão'); }
    me = { user_id: session.user.id, ...profile };
    await sb.realtime.setAuth();

    channel = sb.channel('page:' + room, {
      config: { private: true, broadcast: { self: false }, presence: { key: me.user_id } },
    });
    channel
      .on('broadcast', { event: 'pos' }, ({ payload }) => onPos(payload))
      .on('broadcast', { event: 'ev' }, ({ payload }) => onEvent && onEvent(payload))
      .on('presence', { event: 'sync' }, () => onPeers(channel.presenceState()));

    await new Promise((resolve, reject) => {
      channel.subscribe(async (status, err) => {
        if (status === 'SUBSCRIBED') {
          subscribed = true;
          setState('online');
          try { await channel.track(me); } catch {}
          resolve();
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          subscribed = false;
          setState('error');
          reject(err || new Error(status));
        } else if (status === 'CLOSED') {
          subscribed = false;
          setState('off');
        }
      });
    });

    clearInterval(authTimer);
    authTimer = setInterval(refreshAuth, 60_000);
    return me.user_id;
  }

  function sendPos(payload) {
    if (!subscribed) return;
    channel.send({ type: 'broadcast', event: 'pos', payload });
  }

  // Eventos do jogo: inimigas, trombadas, palavras soltas
  function sendEvent(payload) {
    if (!subscribed) return;
    channel.send({ type: 'broadcast', event: 'ev', payload });
  }

  async function updateProfile(partial) {
    if (!subscribed || !me) return;
    me = { ...me, ...partial };
    try { await channel.track(me); } catch {}
  }

  async function disconnect() {
    clearInterval(authTimer);
    subscribed = false;
    if (channel) {
      const ch = channel;
      channel = null;
      try { await sb.removeChannel(ch); } catch {}
    }
    state = 'off';
  }

  // ---------- Pontuação ----------
  const rpcArgs = (g) => ({
    p_page_hash: g.pageHash, p_words: g.words, p_images: g.images, p_others: g.others,
    p_max_length: g.maxLength, p_duration_ms: g.durationMs,
    p_enemies: g.enemies || 0, p_hits: g.hits || 0,
  });

  async function submitGame(g) {
    const { data, error } = await sb.rpc('submit_game', rpcArgs(g));
    if (error) throw error;
    return data;
  }

  // Versão para quando a aba está fechando: fetch com keepalive sobrevive à página.
  function submitGameBeacon(g) {
    if (!lastToken) return;
    try {
      fetch(cfg.SUPABASE_URL + '/rest/v1/rpc/submit_game', {
        method: 'POST',
        keepalive: true,
        headers: {
          'Content-Type': 'application/json',
          apikey: cfg.SUPABASE_ANON_KEY,
          Authorization: 'Bearer ' + lastToken,
        },
        body: JSON.stringify(rpcArgs(g)),
      });
    } catch {}
  }

  token();
  window.__pgNet = {
    connect, disconnect, sendPos, sendEvent, updateProfile, submitGame, submitGameBeacon,
    get state() { return state; },
  };
})();
