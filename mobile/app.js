// PageGame no celular (app web / PWA).
// O navegador do celular não roda a extensão, então este app abre artigos da
// Wikipédia dentro dele mesmo e roda o MESMO jogo (content.js) por cima.
// O platform.js faz o papel das APIs da extensão (chrome.storage etc.).
(() => {
  const $ = (id) => document.getElementById(id);
  const fmt = (n) => Number(n || 0).toLocaleString('pt-BR');
  const cfg = window.PG_CONFIG || {};
  const store = chrome.storage.local;

  // ---------- Supabase (mesma conta da extensão) ----------
  const chromeStorage = {
    getItem: async (k) => (await store.get(k))[k] ?? null,
    setItem: (k, v) => store.set({ [k]: v }),
    removeItem: (k) => store.remove(k),
  };
  const sb = supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    auth: { storage: chromeStorage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });

  // ---------- Configurações (as mesmas chaves do menu da extensão) ----------
  const DEFAULTS = {
    speed: 1, growth: 1, maxSegments: 70, color: '#ffd23f',
    eatWords: true, eatImages: true, eatObjects: true, showLabels: true, multiplayer: true,
    enemies: true, difficulty: 'normal', character: 'bicho', lang: 'pt',
  };
  let settings = { ...DEFAULTS };
  const save = () => store.set({ settings });

  function paint() {
    for (const b of $('character').children) b.setAttribute('aria-pressed', String(b.dataset.char === settings.character));
    for (const b of $('difficulty').children) b.setAttribute('aria-pressed', String(b.dataset.level === settings.difficulty));
    for (const b of $('lang').children) b.setAttribute('aria-pressed', String(b.dataset.lang === settings.lang));
    for (const b of $('colors').children) b.setAttribute('aria-pressed', String(b.dataset.color === settings.color));
    $('enemies').checked = settings.enemies;
    $('multiplayer').checked = settings.multiplayer;
    $('char-hint').textContent = settings.character === 'saltador'
      ? 'Cai do topo e pula nas letras. Botões na tela: ◀ ▶ andam, ⤒ pula, ⤓ desce, ⚡ dash, 💥 quebra as letras em volta. Toque na tela para atirar.'
      : 'Segue o seu dedo, come as letras e cresce.';
  }
  const pick = (id, key, attr) => $(id).addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || !b.dataset[attr]) return;
    settings[key] = b.dataset[attr]; paint(); save();
    if (key === 'lang') randomArticle();
  });
  pick('character', 'character', 'char');
  pick('difficulty', 'difficulty', 'level');
  pick('lang', 'lang', 'lang');
  pick('colors', 'color', 'color');
  for (const k of ['enemies', 'multiplayer']) $(k).addEventListener('change', (e) => { settings[k] = e.target.checked; save(); });

  // ---------- Conta ----------
  const ERRORS = [
    [/invalid login credentials/i, 'E-mail ou senha incorretos.'],
    [/email not confirmed/i, 'Confirme seu e-mail antes de entrar.'],
    [/already registered|already been registered/i, 'Já existe uma conta com esse e-mail.'],
    [/password should be at least/i, 'A senha precisa ter pelo menos 6 caracteres.'],
    [/rate limit|too many/i, 'Muitas tentativas. Espere um pouco.'],
    [/database error saving new user/i, 'Esse nome de usuário já está em uso.'],
    [/failed to fetch|network/i, 'Sem conexão com o servidor.'],
  ];
  const translate = (err) => {
    const m = (err && err.message) || String(err);
    const hit = ERRORS.find(([re]) => re.test(m));
    return hit ? hit[1] : m;
  };
  let mode = 'login';
  function setMode(m) {
    mode = m;
    $('tab-login').setAttribute('aria-selected', String(m === 'login'));
    $('tab-signup').setAttribute('aria-selected', String(m === 'signup'));
    $('field-username').hidden = m !== 'signup';
    $('auth-submit').textContent = m === 'login' ? 'Entrar' : 'Criar conta';
    authMsg('');
  }
  function authMsg(text, kind = 'error') {
    $('auth-msg').textContent = text; $('auth-msg').className = 'msg ' + kind; $('auth-msg').hidden = !text;
  }
  $('tab-login').addEventListener('click', () => setMode('login'));
  $('tab-signup').addEventListener('click', () => setMode('signup'));

  let user = null;
  async function enter(u) {
    user = u;
    const { data } = await sb.from('profiles').select('username').eq('id', u.id).maybeSingle();
    const username = (data && data.username) || (u.user_metadata && u.user_metadata.username) || u.email;
    $('username').textContent = '@' + username;
    await store.set({ pgAuth: { userId: u.id, username } });    // o jogo só roda com isto
    showView('game');
  }
  async function leave() {
    user = null;
    await store.remove('pgAuth');
    await pgSend('pause');
    showView('auth');
  }
  function showView(v) {
    $('view-auth').hidden = v !== 'auth';
    $('view-game').hidden = v !== 'game';
    $('who').hidden = v !== 'game';
  }

  $('auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('in-email').value.trim(), password = $('in-password').value;
    const username = $('in-username').value.trim().toLowerCase();
    if (!email || !password) return authMsg('Preencha e-mail e senha.');
    if (mode === 'signup' && !/^[a-z0-9_]{3,20}$/.test(username)) return authMsg('Nome de usuário: 3 a 20 caracteres (letras minúsculas, números e _).');
    $('auth-submit').disabled = true; authMsg('');
    try {
      if (mode === 'login') {
        const { data, error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
        await enter(data.user);
      } else {
        const { data: taken } = await sb.from('profiles').select('id').eq('username', username).maybeSingle();
        if (taken) throw new Error('Esse nome de usuário já está em uso.');
        const { data, error } = await sb.auth.signUp({ email, password, options: { data: { username } } });
        if (error) throw error;
        if (data.session) await enter(data.user);
        else { setMode('login'); authMsg(`Conta criada. Confirme o e-mail enviado para ${email} e depois entre.`, 'ok'); }
      }
      $('in-password').value = '';
    } catch (err) { authMsg(translate(err)); }
    finally { $('auth-submit').disabled = false; }
  });
  $('logout').addEventListener('click', async () => { await sb.auth.signOut(); await leave(); });

  // ---------- Menu (gaveta) ----------
  function openSheet() {
    pgSend('pause');                     // pausa para dar para mexer no menu
    $('sheet').hidden = false;
  }
  const closeSheet = () => { $('sheet').hidden = true; };
  $('menu-btn').addEventListener('click', openSheet);
  $('close-sheet').addEventListener('click', closeSheet);
  $('sheet').addEventListener('click', (e) => { if (e.target === $('sheet')) closeSheet(); });

  // ---------- Jogo ----------
  let last = null;
  async function play() {
    if (!user) { openSheet(); return; }
    closeSheet();
    $('results').hidden = true;
    render(await pgSend('play'));
  }
  $('fab').addEventListener('click', play);
  $('play').addEventListener('click', async () => {
    if (last && last.running) render(await pgSend('pause')); else play();
  });
  $('restore').addEventListener('click', async () => render(await pgSend('restore')));

  function render(st) {
    last = st;
    const running = !!(st && st.running);
    $('fab').hidden = running;
    $('fab').textContent = st && st.mounted ? '▶ Continuar' : '▶ Jogar';
    $('play').textContent = running ? '❚❚ Pausar' : (st && st.mounted ? '▶ Continuar' : '▶ Jogar');
    if (!st || !st.mounted) { $('stats').textContent = 'Abra um artigo e toque em Jogar.'; return; }
    const players = st.net === 'online' ? ` · ${st.players} ${st.players === 1 ? 'jogador' : 'jogadores'} aqui` : '';
    $('stats').textContent = `${fmt(st.points)} pontos · ${fmt(st.eaten.words)} letras · ${fmt(st.eaten.enemies)} inimigos${players}`;
  }
  setInterval(async () => render(await pgSend('status')), 1000);

  // ---------- Wikipédia ----------
  // O artigo vira a "página" do jogo. A sala do multiplayer é por artigo
  // (pagegame.app/wiki/<idioma>/<título>), só entre quem joga pelo app.
  const api = (lang) => `https://${lang}.wikipedia.org`;
  let current = null;

  async function openArticle(lang, title, push = true) {
    const art = $('article');
    const wasRunning = !!(last && last.running);
    if (last && last.mounted) render(await pgSend('restore'));    // limpa o jogo do artigo anterior
    art.innerHTML = '<p class="loading">Carregando…</p>';
    try {
      const res = await fetch(`${api(lang)}/api/rest_v1/page/html/${encodeURIComponent(title)}`);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
      doc.querySelectorAll('script, style, link, meta, .mw-ref, .navbox, .mw-editsection').forEach((n) => n.remove());
      for (const img of doc.querySelectorAll('img')) {
        for (const a of ['src', 'srcset']) {
          const v = img.getAttribute(a);
          if (v) img.setAttribute(a, v.replace(/(^|\s|,)\/\//g, '$1https://'));
        }
        img.loading = 'lazy';
      }
      for (const a of doc.querySelectorAll('a[href]')) {
        const href = a.getAttribute('href');
        if (href.startsWith('./')) {                         // link para outro artigo: abre no app
          a.setAttribute('href', `#/${lang}/${href.slice(2)}`);
        } else {
          a.target = '_blank'; a.rel = 'noopener';
        }
      }
      const h1 = document.createElement('h1');
      h1.textContent = decodeURIComponent(title).replace(/_/g, ' ');
      art.replaceChildren(h1, ...[...doc.body.childNodes].map((n) => document.importNode(n, true)));
      current = { lang, title };
      globalThis.PG_PAGE_URL = `https://pagegame.app/wiki/${lang}/${title}`;
      document.title = `${h1.textContent} · PageGame`;
      if (push) history.pushState(null, '', `#/${lang}/${title}`);
      scrollTo(0, 0);
      if (wasRunning) setTimeout(play, 300);                 // estava jogando: continua no artigo novo
    } catch (err) {
      art.innerHTML = '';
      const p = document.createElement('p');
      p.className = 'error';
      p.textContent = 'Não consegui abrir o artigo (' + err.message + '). Confira a internet e tente outro.';
      art.append(p);
    }
  }

  // Artigo aleatório que dá para jogar: tem texto suficiente (letras para
  // comer e plataformas para o saltador) e não é página de desambiguação.
  const FALLBACK = { pt: ['Gato', 'Brasil', 'Futebol', 'Sistema_Solar', 'Dinossauro'],
                     en: ['Cat', 'Brazil', 'Football', 'Solar_System', 'Dinosaur'],
                     es: ['Gato', 'Brasil', 'Fútbol', 'Sistema_solar', 'Dinosaurio'] };
  async function randomArticle() {
    const lang = settings.lang;
    $('article').innerHTML = '<p class="loading">Procurando um artigo bom para jogar…</p>';
    for (let tries = 0; tries < 8; tries++) {
      try {
        const res = await fetch(`${api(lang)}/api/rest_v1/page/random/summary`, { cache: 'no-store' });
        const j = await res.json();
        const okType = !j.type || j.type === 'standard';
        const longEnough = (j.extract || '').length >= 350;
        if (okType && longEnough) {
          return openArticle(lang, j.titles ? j.titles.canonical : j.title.replace(/ /g, '_'));
        }
      } catch { break; }                                   // sem internet: usa a lista fixa
    }
    const list = FALLBACK[lang] || FALLBACK.pt;
    openArticle(lang, list[(Math.random() * list.length) | 0]);
  }
  $('random-btn').addEventListener('click', randomArticle);

  // busca com sugestões
  let searchTimer = null;
  $('q').addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = $('q').value.trim();
    if (q.length < 2) { $('results').hidden = true; return; }
    searchTimer = setTimeout(async () => {
      try {
        const url = `${api(settings.lang)}/w/api.php?action=opensearch&search=${encodeURIComponent(q)}&limit=8&namespace=0&format=json&origin=*`;
        const [, titles] = await (await fetch(url)).json();
        $('results').replaceChildren(...titles.map((t) => {
          const li = document.createElement('li');
          const b = document.createElement('button');
          b.type = 'button'; b.textContent = t;
          b.addEventListener('click', () => { $('results').hidden = true; $('q').value = ''; $('q').blur(); openArticle(settings.lang, t.replace(/ /g, '_')); });
          li.append(b);
          return li;
        }));
        $('results').hidden = !titles.length;
      } catch { $('results').hidden = true; }
    }, 250);
  });
  $('search').addEventListener('submit', (e) => {
    e.preventDefault();
    const first = $('results').querySelector('button');
    if (first) first.click();
  });

  const fromHash = () => {
    const m = location.hash.match(/^#\/([a-z]{2,3})\/(.+)$/);
    return m ? { lang: m[1], title: m[2] } : null;
  };
  addEventListener('popstate', () => { const h = fromHash(); if (h) openArticle(h.lang, h.title, false); });
  addEventListener('hashchange', () => {
    const h = fromHash();
    if (h && (!current || h.title !== current.title || h.lang !== current.lang)) openArticle(h.lang, h.title, false);
  });

  // os botões do jogo ficam abaixo da barra de cima do app
  const setTouchTop = () => { globalThis.PG_TOUCH_TOP = document.querySelector('.bar').getBoundingClientRect().bottom; };
  setTouchTop();
  addEventListener('resize', setTouchTop);

  // ---------- Início ----------
  (async () => {
    const { settings: saved } = await store.get('settings');
    settings = { ...DEFAULTS, ...(saved || {}) };
    paint();
    setMode('login');

    const h = fromHash();
    if (h) openArticle(h.lang, h.title, false); else randomArticle();

    sb.auth.onAuthStateChange((event) => { if (event === 'SIGNED_OUT') leave(); });
    const { data: { session } } = await sb.auth.getSession();
    if (!session) { await store.remove('pgAuth'); showView('auth'); openSheet(); return; }
    const { data, error } = await sb.auth.getUser();
    if (error && !/fetch|network/i.test(error.message)) {
      await sb.auth.signOut({ scope: 'local' }); showView('auth'); openSheet(); return;
    }
    await enter((data && data.user) || session.user);
  })();

  // instalar como app (funciona offline o menu; os artigos precisam de internet)
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
