const DEFAULTS = {
  speed: 1, growth: 1, maxSegments: 70, color: '#ffd23f',
  eatWords: true, eatImages: true, eatObjects: true, showLabels: true, multiplayer: true,
  enemies: true, difficulty: 'normal', peerBadge: true, character: 'bicho',
};
const $ = (id) => document.getElementById(id);
const fmt = (n) => n.toLocaleString('pt-BR');
let settings = { ...DEFAULTS };
let tabId = null;
let pollTimer = null;
let accountTimer = null;

// =====================================================================
// Supabase
// =====================================================================
const cfg = window.PG_CONFIG || {};
const configured = !!cfg.SUPABASE_URL && !!cfg.SUPABASE_ANON_KEY &&
  !cfg.SUPABASE_URL.includes('SEU-PROJETO') && !cfg.SUPABASE_ANON_KEY.includes('COLE-AQUI');

// A sessão fica no chrome.storage.local (o popup fecha e abre o tempo todo).
const chromeStorage = {
  getItem: async (k) => (await chrome.storage.local.get(k))[k] ?? null,
  setItem: (k, v) => chrome.storage.local.set({ [k]: v }),
  removeItem: (k) => chrome.storage.local.remove(k),
};

const sb = configured
  ? supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
      auth: { storage: chromeStorage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    })
  : null;

// Sinal simples que o content script lê para saber se pode jogar.
const setAuthFlag = (user, username) =>
  chrome.storage.local.set({ pgAuth: { userId: user.id, username } });
const clearAuthFlag = () => chrome.storage.local.remove('pgAuth');

const ERRORS = [
  [/invalid login credentials/i, 'E-mail ou senha incorretos.'],
  [/email not confirmed/i, 'Confirme seu e-mail antes de entrar (veja sua caixa de entrada).'],
  [/already registered|already been registered/i, 'Já existe uma conta com esse e-mail.'],
  [/password should be at least/i, 'A senha precisa ter pelo menos 6 caracteres.'],
  [/rate limit|too many/i, 'Muitas tentativas. Espere um pouco e tente de novo.'],
  [/database error saving new user/i, 'Esse nome de usuário já está em uso.'],
  [/invalid.*email|unable to validate email/i, 'E-mail inválido.'],
  [/failed to fetch|network/i, 'Sem conexão com o servidor. Confira a internet e o config.js.'],
];
const translate = (err) => {
  const m = (err && err.message) || String(err);
  const hit = ERRORS.find(([re]) => re.test(m));
  return hit ? hit[1] : m;
};

async function loadUsername(user) {
  const { data } = await sb.from('profiles').select('username').eq('id', user.id).maybeSingle();
  return (data && data.username) || (user.user_metadata && user.user_metadata.username) || user.email;
}

// =====================================================================
// Telas
// =====================================================================
function show(view) {
  for (const v of ['config', 'auth', 'game']) $('view-' + v).hidden = v !== view;
  $('footer').hidden = view !== 'game';
  $('who').hidden = view !== 'game';
  clearInterval(pollTimer);
  if (view === 'game') {
    refreshStatus();
    pollTimer = setInterval(refreshStatus, 500);
    clearInterval(accountTimer);
    accountTimer = setInterval(() => loadAccount(), 10_000);
  }
}

async function enterGame(user) {
  const username = await loadUsername(user);
  $('username').textContent = '@' + username;
  await setAuthFlag(user, username);
  show('game');
  startPlayers();
  loadAccount(user.id);
  PGInventory.render($('inventory'), sb);                 // armas: loja e equipar
}

// Pontos e moedas da conta (tabela player_stats)
let accountUser = null;
async function loadAccount(userId) {
  accountUser = userId || accountUser;
  if (!accountUser) return;
  const { data } = await sb.from('player_stats').select('total_score, coins').eq('user_id', accountUser).maybeSingle();
  if (data) renderAccount(data);
}
function renderAccount(a) {
  $('account').textContent = `${fmt(Number(a.total_score))} pontos, ${fmt(Number(a.coins))} moedas`;
}

async function leaveGame() {
  clearInterval(playersTimer);
  $('players-banner').hidden = true;
  await clearAuthFlag();
  await send('pause');
  show('auth');
}

// ---------- Formulário de login / cadastro ----------
let mode = 'login';
function setMode(m) {
  mode = m;
  $('tab-login').setAttribute('aria-selected', String(m === 'login'));
  $('tab-signup').setAttribute('aria-selected', String(m === 'signup'));
  $('field-username').hidden = m !== 'signup';
  $('auth-submit').textContent = m === 'login' ? 'Entrar' : 'Criar conta';
  $('in-password').autocomplete = m === 'login' ? 'current-password' : 'new-password';
  authMsg('');
}
$('tab-login').addEventListener('click', () => setMode('login'));
$('tab-signup').addEventListener('click', () => setMode('signup'));

function authMsg(text, kind = 'error') {
  const el = $('auth-msg');
  el.textContent = text;
  el.className = 'msg ' + kind;
  el.hidden = !text;
}

$('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('in-email').value.trim();
  const password = $('in-password').value;
  const username = $('in-username').value.trim().toLowerCase();

  if (!email || !password) return authMsg('Preencha e-mail e senha.');
  if (password.length < 6) return authMsg('A senha precisa ter pelo menos 6 caracteres.');
  if (mode === 'signup' && !/^[a-z0-9_]{3,20}$/.test(username)) {
    return authMsg('Nome de usuário: 3 a 20 caracteres, só letras minúsculas, números e _.');
  }

  const btn = $('auth-submit');
  btn.disabled = true;
  authMsg('');
  try {
    if (mode === 'login') {
      const { data, error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
      $('in-password').value = '';
      await enterGame(data.user);
    } else {
      const { data: taken } = await sb.from('profiles').select('id').eq('username', username).maybeSingle();
      if (taken) throw new Error('Esse nome de usuário já está em uso.');
      const { data, error } = await sb.auth.signUp({ email, password, options: { data: { username } } });
      if (error) throw error;
      $('in-password').value = '';
      if (data.session) {
        await enterGame(data.user);
      } else {
        // Projeto com confirmação de e-mail ligada
        setMode('login');
        authMsg(`Conta criada. Enviamos um link de confirmação para ${email}. Confirme e depois entre.`, 'ok');
      }
    }
  } catch (err) {
    authMsg(translate(err));
  } finally {
    btn.disabled = false;
  }
});

$('logout').addEventListener('click', async () => {
  await sb.auth.signOut();          // onAuthStateChange cuida do resto
  await leaveGame();
});

// =====================================================================
// Jogo (conversa com a aba)
// =====================================================================
async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function send(cmd) {
  if (tabId == null) return null;
  try { return await chrome.tabs.sendMessage(tabId, { cmd }); }
  catch { return null; }          // script ainda não foi injetado nesta aba
}

async function inject() {
  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['config.js', 'lib/supabase.js', 'room.js', 'net.js', 'content.js'] });
    return true;
  } catch {
    showError('O navegador não deixa extensões rodarem nesta página (páginas internas, Web Store, PDFs). Tente outro site.');
    return false;
  }
}

function showError(msg) { $('error').textContent = msg; $('error').hidden = !msg; }

async function refreshStatus() { render(await send('status')); }

// ---------- Aviso: quem está jogando nesta página (vem do background.js) ----------
let playersTimer = null;
async function refreshPlayers() {
  let r = null;
  try { r = await chrome.runtime.sendMessage({ pg: 'players' }); } catch {}
  const banner = $('players-banner');
  if (!r || !r.count) { banner.hidden = true; return; }
  $('players-count').textContent = r.count === 1 ? '1 jogador nesta página agora' : `${r.count} jogadores nesta página agora`;
  const names = r.players.join(', ') + (r.count > r.players.length ? '…' : '');
  $('players-names').textContent = names + ' · entre também!';
  banner.hidden = false;
}
function startPlayers() {
  clearInterval(playersTimer);
  refreshPlayers();
  playersTimer = setInterval(refreshPlayers, 3000);
}

function render(st) {
  const play = $('play');
  if (!st || !st.running) play.textContent = st && st.mounted ? '▶ Continuar' : '▶ Jogar nesta página';
  else play.textContent = '❚❚ Pausar';
  $('restore').disabled = !st || !st.mounted;

  if (st && st.account) renderAccount(st.account);
  if (!st || !st.mounted) {
    $('found').textContent = '—'; $('eaten').textContent = '—'; $('points').textContent = '—'; $('scan').textContent = '—'; $('players').textContent = '—';
    return;
  }
  const NET = { off: 'desligado', connecting: 'conectando…', error: 'sem conexão' };
  $('players').textContent = st.net === 'online'
    ? (st.players > 1 ? `${st.players} jogando nesta página` : 'só você nesta página')
    : NET[st.net] || '—';
  const f = st.found, e = st.eaten;
  $('found').textContent = `${fmt(f.words)} palavras, ${fmt(f.images)} imagens, ${fmt(f.others)} outros`;
  $('eaten').textContent = `${fmt(e.words)} letras, ${fmt(e.images)} imagens, ${fmt(e.others)} outros` +
    (e.enemies ? `, ${fmt(e.enemies)} inimigas` : '');
  $('points').textContent = `${fmt(st.points || 0)}` + (st.hits ? ` (levou ${fmt(st.hits)} ${st.hits === 1 ? 'tiro' : 'tiros'})` : '');
  $('scan').textContent = st.scanning
    ? `escaneando… ${fmt(f.nodes)} blocos de texto`
    : `${fmt(f.nodes)} blocos de texto em ${st.scanMs} ms`;
  if (!st.highlightSupported) showError('Este navegador não suporta esconder letras; só imagens e elementos serão comidos.');
}

$('play').addEventListener('click', async () => {
  showError('');
  // confere a sessão antes de cada partida
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return leaveGame();

  const st = await send('status');
  if (st && st.running) { render(await send('pause')); return; }
  if (!st && !(await inject())) return;
  let res = await send('play');
  if (!res) {                          // o script acabou de entrar: tenta mais uma vez
    await new Promise((r) => setTimeout(r, 200));
    res = await send('play');
  }
  // o jogo começou: fecha o menu para liberar a página
  if (res && res.running) { window.close(); return; }
  render(res);
  if (!res) showError('Não consegui iniciar o jogo nesta aba. Recarregue a página (F5) e aperte Jogar de novo.');
});
$('restore').addEventListener('click', async () => render(await send('restore')));

// ---------- Configurações ----------
function save() { chrome.storage.local.set({ settings }); }

const sliders = {
  speed: (v) => `${Number(v).toFixed(1)}x`,
  growth: (v) => `${Number(v).toFixed(2).replace(/0$/, '')}x`,
  maxSegments: (v) => `${v} segmentos`,
};
function paint() {
  for (const [key, label] of Object.entries(sliders)) {
    $(key).value = settings[key];
    $(key + 'Out').textContent = label(settings[key]);
  }
  for (const key of ['eatWords', 'eatImages', 'eatObjects', 'showLabels', 'multiplayer', 'enemies', 'peerBadge']) $(key).checked = settings[key];
  for (const b of $('difficulty').children) b.setAttribute('aria-pressed', String(b.dataset.level === settings.difficulty));
  for (const b of $('character').children) b.setAttribute('aria-pressed', String(b.dataset.char === settings.character));
  $('char-hint').innerHTML = settings.character === 'saltador'
    ? 'Cai do topo e pula nas letras. <kbd>A</kbd><kbd>D</kbd> anda, <kbd>W</kbd> pula, <kbd>S</kbd> desce, <kbd>Shift</kbd> dash até o mouse, <kbd>Espaço</kbd> joga granada (quica nas letras). A arma atira sozinha, primeiro nos jogadores.'
    : 'Segue o mouse, come as letras e cresce. <kbd>Shift</kbd> dá um dash. A arma atira sozinha, primeiro nos jogadores.';
  for (const b of $('colors').children) b.setAttribute('aria-pressed', String(b.dataset.color === settings.color));
  document.documentElement.style.setProperty('--accent', settings.color);
}
for (const key of Object.keys(sliders)) {
  $(key).addEventListener('input', (e) => { settings[key] = Number(e.target.value); paint(); save(); });
}
for (const key of ['eatWords', 'eatImages', 'eatObjects', 'showLabels', 'multiplayer', 'enemies', 'peerBadge']) {
  $(key).addEventListener('change', (e) => { settings[key] = e.target.checked; save(); });
}
$('character').addEventListener('click', (e) => {
  const c = e.target.closest('button');
  if (!c || !c.dataset.char) return;
  settings.character = c.dataset.char; paint(); save();
});
$('difficulty').addEventListener('click', (e) => {
  const lv = e.target.dataset && e.target.dataset.level;
  if (!lv) return;
  settings.difficulty = lv; paint(); save();
});
$('colors').addEventListener('click', (e) => {
  const c = e.target.dataset && e.target.dataset.color;
  if (!c) return;
  settings.color = c; paint(); save();
});

// =====================================================================
// Início
// =====================================================================
(async () => {
  const { settings: saved } = await chrome.storage.local.get('settings');
  settings = { ...DEFAULTS, ...(saved || {}) };
  paint();
  const tab = await activeTab();
  tabId = tab ? tab.id : null;

  if (!configured) { await clearAuthFlag(); return show('config'); }

  sb.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') leaveGame();
  });

  const { data: { session } } = await sb.auth.getSession();
  if (!session) { await clearAuthFlag(); setMode('login'); return show('auth'); }

  // valida o token no servidor (conta apagada, sessão revogada etc.)
  const { data, error } = await sb.auth.getUser();
  if (error && !/fetch|network/i.test(error.message)) {
    await sb.auth.signOut({ scope: 'local' });
    setMode('login');
    return show('auth');
  }
  await enterGame((data && data.user) || session.user);
})();
