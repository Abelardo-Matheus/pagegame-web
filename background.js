// PageGame: aviso de jogadores na página (número no ícone da extensão).
//
// Fica de olho só na aba ativa. Entra na sala dela ("page:<hash>") como
// OBSERVADOR: recebe o Presence (quem está jogando) mas não aparece para os
// outros. Mostra quantos estão jogando no ícone e responde ao menu.
// Só funciona com login feito (as salas são privadas).
importScripts('config.js', 'lib/supabase.js', 'room.js');

const cfg = globalThis.PG_CONFIG || {};
const chromeStorage = {
  getItem: async (k) => (await chrome.storage.local.get(k))[k] ?? null,
  setItem: (k, v) => chrome.storage.local.set({ [k]: v }),
  removeItem: (k) => chrome.storage.local.remove(k),
};
const sb = supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
  auth: { storage: chromeStorage, persistSession: true, autoRefreshToken: false, detectSessionInUrl: false },
});

let watch = { tabId: null, room: null, channel: null, players: [], ready: false };
let myId = null;
let timer = null;
const waiters = [];

const roomOf = (url) => (url && /^https?:\/\//.test(url) ? pgRoomKey(url) : null);

async function enabled() {
  const { settings, pgAuth } = await chrome.storage.local.get(['settings', 'pgAuth']);
  return !!pgAuth && (settings ? settings.peerBadge !== false : true);
}

function setBadge(tabId, n) {
  if (tabId == null) return;
  const text = n > 0 ? String(n) : '';
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  if (n > 0) chrome.action.setBadgeBackgroundColor({ tabId, color: '#1f8a3b' }).catch(() => {});
  chrome.action.setTitle({
    tabId, title: n > 0 ? `PageGame: ${n} ${n === 1 ? 'jogador' : 'jogadores'} nesta página` : 'PageGame',
  }).catch(() => {});
}

function wake() { while (waiters.length) waiters.shift()(); }

async function leave() {
  const ch = watch.channel;
  watch = { tabId: watch.tabId, room: null, channel: null, players: [], ready: false };
  if (ch) { try { await sb.removeChannel(ch); } catch {} }
}

// confere a aba ativa e troca de sala se precisar (com um pequeno atraso
// para não entrar e sair de salas a cada clique rápido entre abas)
function schedule(delay = 400) {
  clearTimeout(timer);
  timer = setTimeout(check, delay);
}

async function check() {
  let tab;
  try { [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }); } catch {}
  if (!tab) return;
  const room = (await enabled()) ? roomOf(tab.url) : null;
  if (!room) { await leave(); watch.tabId = tab.id; setBadge(tab.id, 0); wake(); return; }
  if (watch.room === room && watch.channel) {
    if (watch.tabId !== tab.id) { setBadge(watch.tabId, 0); watch.tabId = tab.id; }
    setBadge(tab.id, watch.players.length);
    return;
  }
  await leave();
  if (watch.tabId != null && watch.tabId !== tab.id) setBadge(watch.tabId, 0);
  watch.tabId = tab.id;
  const { data } = await sb.auth.getSession();
  const session = data && data.session;
  if (!session) { setBadge(tab.id, 0); wake(); return; }
  myId = session.user.id;
  try { await sb.realtime.setAuth(session.access_token); } catch {}

  watch.room = room;
  const ch = sb.channel('page:' + room, { config: { private: true } });
  watch.channel = ch;
  ch.on('presence', { event: 'sync' }, () => {
    if (watch.channel !== ch) return;
    const players = [];
    for (const [id, metas] of Object.entries(ch.presenceState())) {
      if (id === myId) continue;                     // eu mesmo jogando nesta página não conta
      const meta = metas[metas.length - 1] || {};
      players.push(meta.username ? '@' + meta.username : 'alguém');
    }
    watch.players = players;
    watch.ready = true;
    setBadge(watch.tabId, players.length);
    wake();
  });
  ch.subscribe((status) => {
    if (watch.channel !== ch) return;
    if (status === 'SUBSCRIBED') { watch.ready = true; setTimeout(wake, 1500); }
    else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') { watch.ready = true; setBadge(watch.tabId, 0); wake(); }
  });
}

// ---------- quando olhar de novo ----------
chrome.tabs.onActivated.addListener(() => schedule(300));
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (tab.active && (info.url || info.status === 'complete')) schedule(500);
});
chrome.windows.onFocusChanged.addListener(() => schedule(300));
chrome.runtime.onStartup.addListener(() => schedule(1000));
chrome.runtime.onInstalled.addListener(() => schedule(1000));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.pgAuth || changes.settings) { leave().then(() => schedule(100)); return; }
  // o menu renovou o login: passa o token novo para a conexão
  if (Object.keys(changes).some((k) => k.startsWith('sb-'))) {
    sb.auth.getSession().then(({ data }) => {
      if (data && data.session) sb.realtime.setAuth(data.session.access_token).catch(() => {});
    });
  }
});

// ---------- o menu pergunta quem está na página ----------
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (!msg || msg.pg !== 'players') return false;
  (async () => {
    await check();
    if (watch.channel && !watch.ready) {
      await new Promise((r) => { waiters.push(r); setTimeout(r, 3000); });
    }
    reply({ watching: !!watch.channel, count: watch.players.length, players: watch.players.slice(0, 8) });
  })();
  return true;                                       // resposta assíncrona
});

schedule(500);
