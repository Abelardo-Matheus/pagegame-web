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
      ? 'Cai do topo e pula nas letras. Botões: ◀ ▶ andam, ⤒ pula, ⤓ desce, ⚡ dash, 💣 granada. A arma atira sozinha (primeiro nos jogadores).'
      : 'Anda sempre para a frente: segure ◀ ou ▶ para virar. Come as letras e cresce. ⚡ dá um dash. A arma atira sozinha (primeiro nos jogadores).';
  }
  const pick = (id, key, attr) => $(id).addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || !b.dataset[attr]) return;
    settings[key] = b.dataset[attr]; paint(); save();
    if (key === 'lang') findArticle();
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

  let user = null, myName = '';
  async function enter(u) {
    user = u;
    const { data } = await sb.from('profiles').select('username').eq('id', u.id).maybeSingle();
    const username = (data && data.username) || (u.user_metadata && u.user_metadata.username) || u.email;
    $('username').textContent = '@' + username;
    myName = username;
    await store.set({ pgAuth: { userId: u.id, username } });    // o jogo só roda com isto
    showView('game');
    joinLobby();
    PGInventory.render($('inventory'), sb);                     // armas: loja e equipar
  }
  async function leave() {
    user = null;
    leaveLobby();
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
        busiest().then((b) => { if (b) { openArticle(b.lang, b.title); toast(`${b.count} ${b.count === 1 ? 'pessoa jogando' : 'pessoas jogando'} aqui`); } });
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
  async function play(stay = false) {
    if (!user) { openSheet(); return; }
    closeSheet();
    $('results').hidden = true;
    // antes de começar: se tem gente jogando em outro artigo (e aqui não), vai para lá
    // (stay: acabou de escolher a sala pelo "Nova sala", fica nela)
    if (!stay && !(last && last.mounted)) {
      const b = await busiest(false);
      if (b && !(current && b.lang === current.lang && b.title === current.title) && othersHere() === 0) {
        await openArticle(b.lang, b.title);
        toast(`${b.count} ${b.count === 1 ? 'pessoa jogando' : 'pessoas jogando'} aqui`);
      }
    }
    setPlaying(true);                                        // esconde a barra antes de o jogo montar os botões
    render(await pgSend('play'));
  }
  $('fab').addEventListener('click', () => play());

  // Nova sala: sai deste artigo e vai para outro com gente jogando (o mais
  // cheio, sem contar o atual); se não tiver ninguém, um artigo aleatório.
  let searchingRoom = false;
  async function newRoom() {
    if (!user) { openSheet(); return; }
    if (searchingRoom) return;
    searchingRoom = true;
    const btns = [$('new-room'), $('fab-room')];
    btns.forEach((b) => { b.disabled = true; });
    $('new-room').textContent = '🔎 Procurando…';
    closeSheet();
    try {
      const b = await busiest(true, true);
      if (b) {
        await openArticle(b.lang, b.title);
        toast(`${b.count} ${b.count === 1 ? 'pessoa jogando' : 'pessoas jogando'} aqui`);
      } else {
        await randomArticle();
        toast('Ninguém jogando agora: artigo novo');
      }
      await play(true);
    } finally {
      searchingRoom = false;
      btns.forEach((b) => { b.disabled = false; });
      $('new-room').textContent = '🔀 Nova sala';
    }
  }
  $('new-room').addEventListener('click', newRoom);
  $('fab-room').addEventListener('click', newRoom);
  $('play').addEventListener('click', async () => {
    if (last && last.running) render(await pgSend('pause')); else play();
  });
  $('restore').addEventListener('click', async () => render(await pgSend('restore')));

  function render(st) {
    const was = !!(last && last.running);
    last = st;
    const running = !!(st && st.running);
    setPlaying(running);
    if (was !== running) trackLobby();
    $('fab').hidden = running;
    $('fab-room').hidden = running;
    $('fab').textContent = st && st.mounted ? '▶ Continuar' : '▶ Jogar';
    $('play').textContent = running ? '❚❚ Pausar' : (st && st.mounted ? '▶ Continuar' : '▶ Jogar');
    if (!st || !st.mounted) { $('stats').textContent = 'Abra um artigo e toque em Jogar.'; return; }
    const players = st.net === 'online' ? ` · ${st.players} ${st.players === 1 ? 'jogador' : 'jogadores'} aqui` : '';
    $('stats').textContent = `${fmt(st.points)} pontos · ${fmt(st.eaten.words)} letras · ${fmt(st.eaten.enemies)} inimigos${players}`;
  }
  setInterval(async () => render(await pgSend('status')), 1000);
  addEventListener('pagegame-state', async () => render(await pgSend('status')));   // jogo pausou/continuou

  // ---------- Wikipédia ----------
  // O artigo vira a "página" do jogo. A sala do multiplayer é por artigo
  // (pagegame.app/wiki/<idioma>/<título>), só entre quem joga pelo app.
  const api = (lang) => `https://${lang}.wikipedia.org`;
  let current = null;

  // busca com tempo limite (rede ruim no celular não trava o app)
  async function fetchT(url, ms = 15000) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), ms);
    try { return await fetch(url, { signal: ac.signal }); }
    finally { clearTimeout(timer); }
  }
  // HTML do artigo: API REST; se falhar, a API "action" (outro caminho do mesmo site)
  async function articleHtml(lang, title) {
    let lastErr = null;
    try {
      const res = await fetchT(`${api(lang)}/api/rest_v1/page/html/${encodeURIComponent(title)}`);
      if (res.ok) return await res.text();
      lastErr = new Error('HTTP ' + res.status);
    } catch (e) { lastErr = e; }
    try {
      const url = `${api(lang)}/w/api.php?action=parse&page=${encodeURIComponent(title)}&prop=text&redirects=1&format=json&formatversion=2&origin=*`;
      const j = await (await fetchT(url)).json();
      if (j && j.parse && j.parse.text) return '<!doctype html><html><body><section>' + j.parse.text + '</section></body></html>';
      lastErr = new Error((j && j.error && j.error.info) || 'resposta vazia');
    } catch (e) { lastErr = e; }
    throw lastErr || new Error('falhou');
  }

  async function openArticle(lang, title, push = true) {
    const art = $('article');
    const wasRunning = !!(last && last.running);
    if (last && last.mounted) render(await pgSend('restore'));    // limpa o jogo do artigo anterior
    art.innerHTML = '<p class="loading">Carregando…</p>';
    let step = 'baixando';
    try {
      const html = await articleHtml(lang, title);
      step = 'montando';
      const doc = new DOMParser().parseFromString(html, 'text/html');
      slimArticle(doc);
      for (const img of doc.querySelectorAll('img')) {
        const v = img.getAttribute('src');
        if (v) img.setAttribute('src', v.replace(/^\/\//, 'https://'));
        img.removeAttribute('srcset');                       // sem versões 2x/3x: imagem leve no celular
        img.loading = 'lazy'; img.decoding = 'async';
      }
      for (const a of doc.querySelectorAll('a[href]')) {
        const href = a.getAttribute('href');
        if (href.startsWith('./')) {                         // link para outro artigo: abre no app
          a.setAttribute('href', `#/${lang}/${href.slice(2)}`);
        } else if (href.startsWith('/wiki/')) {              // (formato da API "action")
          a.setAttribute('href', `#/${lang}/${href.slice(6)}`);
        } else {
          a.target = '_blank'; a.rel = 'noopener';
        }
      }
      step = 'mostrando';
      const h1 = document.createElement('h1');
      h1.textContent = decodeURIComponent(title).replace(/_/g, ' ');
      const frag = document.createDocumentFragment();
      frag.appendChild(h1);
      for (const n of Array.from(doc.body.childNodes)) frag.appendChild(document.importNode(n, true));
      art.textContent = '';
      art.appendChild(frag);
      current = { lang, title };
      globalThis.PG_PAGE_URL = `https://pagegame.app/wiki/${lang}/${title}`;
      document.title = `${h1.textContent} · PageGame`;
      if (push) { try { history.pushState(null, '', `#/${lang}/${title}`); } catch { /* alguns WebViews não deixam */ } }
      trackLobby();                                            // avisa a sala geral em qual artigo estou
      scrollTo(0, 0);
      if (wasRunning) setTimeout(play, 300);                 // estava jogando: continua no artigo novo
    } catch (err) {
      art.textContent = '';
      const p = document.createElement('p');
      p.className = 'error';
      const why = err && err.name === 'AbortError' ? 'a internet demorou demais' : ((err && err.message) || String(err));
      p.textContent = `Não consegui abrir o artigo (${step}: ${why}).`;
      const again = document.createElement('button');
      again.className = 'play'; again.type = 'button'; again.textContent = 'Tentar outro artigo';
      again.style.marginTop = '12px';
      again.addEventListener('click', () => findArticle());
      art.append(p, again);
      reportError('Artigo: ' + step + ': ' + why);
    }
  }

  // ---------- Erros visíveis (para teste no celular) ----------
  // Mostra o erro numa faixa vermelha, para dar para contar o que aconteceu.
  function reportError(msg) {
    let el = $('err-bar');
    if (!el) {
      el = document.createElement('div');
      el.id = 'err-bar'; el.className = 'err-bar'; el.setAttribute('data-pagegame-ui', '');
      el.addEventListener('click', () => { el.hidden = true; });
      document.body.append(el);
    }
    el.textContent = '⚠ ' + String(msg).slice(0, 300) + '  (toque para fechar)';
    el.hidden = false;
  }
  addEventListener('error', (e) => reportError((e.message || 'erro') + (e.filename ? ' @' + e.filename.split('/').pop() + ':' + e.lineno : '')));
  addEventListener('unhandledrejection', (e) => reportError('promessa: ' + ((e.reason && e.reason.message) || e.reason)));
  // WebView muito antigo não tem o que o jogo precisa (esconder letras etc.)
  const chromeVer = +((navigator.userAgent.match(/Chrome\/(\d+)/) || [])[1] || 0);
  if (chromeVer && chromeVer < 105) {
    setTimeout(() => reportError(`O navegador interno do seu Android está desatualizado (Chrome ${chromeVer}). ` +
      'Atualize "Android System WebView" (ou o Chrome) na Play Store.'), 500);
  }

  // Artigo aleatório que dá para jogar: tem texto suficiente (letras para
  // comer e plataformas para o saltador) e não é página de desambiguação.
  const FALLBACK = { pt: ['Gato', 'Brasil', 'Futebol', 'Sistema_Solar', 'Dinossauro'],
                     en: ['Cat', 'Brazil', 'Football', 'Solar_System', 'Dinosaur'],
                     es: ['Gato', 'Brasil', 'Fútbol', 'Sistema_solar', 'Dinosaurio'] };
  // ---------- Onde tem gente ----------
  // Sala geral "page:lobby": cada jogador do app avisa em qual artigo está
  // (Presence). Ao abrir o app (e ao tocar em Jogar) o jogo vai para o artigo
  // com mais gente; se não tiver ninguém, abre um aleatório.
  let lobby = null, lobbyReady = false, lobbyState = {};
  const lobbyWaiters = [];
  async function joinLobby() {
    if (lobby || !user) return;
    try {
      const { data } = await sb.auth.getSession();
      if (!data.session) return;
      await sb.realtime.setAuth(data.session.access_token);
      const ch = sb.channel('page:lobby', { config: { private: true, presence: { key: user.id } } });
      lobby = ch;
      ch.on('presence', { event: 'sync' }, () => {
        lobbyState = ch.presenceState();
        while (lobbyWaiters.length) lobbyWaiters.shift()();
      });
      ch.subscribe((status) => {
        if (status === 'SUBSCRIBED') { lobbyReady = true; trackLobby(); }
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') { while (lobbyWaiters.length) lobbyWaiters.shift()(); }
      });
    } catch { /* sem conexão: segue sem a sala geral */ }
  }
  function leaveLobby() {
    if (lobby) { try { sb.removeChannel(lobby); } catch {} }
    lobby = null; lobbyReady = false; lobbyState = {};
  }
  function trackLobby() {
    if (!lobby || !lobbyReady || !current) return;
    lobby.track({ lang: current.lang, title: current.title, u: myName, playing: !!(last && last.running) }).catch(() => {});
  }
  // espera a primeira lista de quem está na sala geral (no máximo ~2,5 s)
  const lobbySynced = () => new Promise((r) => {
    if (Object.keys(lobbyState).length || !lobby) return r();
    lobbyWaiters.push(r); setTimeout(r, 2500);
  });
  function othersHere() {
    if (!current) return 0;
    let n = 0;
    for (const [id, metas] of Object.entries(lobbyState)) {
      const m = metas[metas.length - 1];
      if (id !== (user && user.id) && m && m.lang === current.lang && m.title === current.title) n++;
    }
    return n;
  }
  // wait = false: não espera a sala geral responder (ex.: ao tocar em Jogar, para não travar)
  // skipCurrent = true: não conta o artigo aberto agora (botão "Nova sala")
  async function busiest(wait = true, skipCurrent = false) {
    if (!user) return null;
    await joinLobby();
    if (wait) await lobbySynced();
    const count = new Map();
    for (const [id, metas] of Object.entries(lobbyState)) {
      if (id === user.id) continue;
      const m = metas[metas.length - 1];
      if (!m || !m.title || !m.lang) continue;
      if (skipCurrent && current && m.lang === current.lang && m.title === current.title) continue;
      const k = m.lang + '|' + m.title;
      count.set(k, (count.get(k) || 0) + (m.playing ? 2 : 1));      // quem está jogando pesa mais
    }
    let best = null;
    for (const [k, n] of count) if (!best || n > best.n) best = { k, n };
    if (!best) return null;
    const [lang, title] = best.k.split('|');
    let people = 0;
    for (const [id, metas] of Object.entries(lobbyState)) {
      const m = metas[metas.length - 1];
      if (id !== user.id && m && m.lang === lang && m.title === title) people++;
    }
    return { lang, title, count: people };
  }
  // abre o artigo com gente; se não tiver ninguém, um aleatório bom para jogar
  async function findArticle() {
    const b = await busiest();
    if (b) {
      await openArticle(b.lang, b.title);
      toast(`${b.count} ${b.count === 1 ? 'pessoa jogando' : 'pessoas jogando'} aqui`);
      return;
    }
    randomArticle();
  }
  let toastTimer = null;
  function toast(text) {
    let el = $('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast'; el.className = 'toast'; el.setAttribute('data-pagegame-ui', '');
      el.setAttribute('role', 'status');
      document.body.append(el);
    }
    el.textContent = text; el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
  }

  // Artigo mais leve para o celular: tira referências, caixas de navegação,
  // atributos enormes do Parsoid (data-mw) e corta depois de ~MAX letras.
  const MAX_TEXT = matchMedia('(pointer: coarse)').matches ? 18000 : 45000;
  const SKIP_SECTIONS = /refer|nota|liga[cç][oõ]es externas|bibliograf|ver tamb|fontes|leitura|see also|external links|further reading|bibliography|notes|sources|enlaces externos|v[ée]ase tambi|bibliograf/i;
  function slimArticle(doc) {
    doc.querySelectorAll('script, style, link, meta, .mw-ref, sup.reference, .reference, .references, .reflist, ' +
      '.navbox, .navbox-styles, .metadata, .ambox, .mw-editsection, .noprint, .sistersitebox, .portal, ' +
      '.mw-references-wrap, .mbox-small, .vertical-navbox, .authority-control').forEach((n) => n.remove());
    for (const el of doc.body.querySelectorAll('*')) {
      for (const at of [...el.attributes]) {
        if (at.name.startsWith('data-') || at.name === 'about' || at.name === 'typeof' || at.name === 'property' || at.name === 'style') {
          el.removeAttribute(at.name);
        }
      }
    }
    let total = 0;
    for (const sec of [...doc.body.children]) {
      const h = sec.querySelector('h2');
      if ((h && SKIP_SECTIONS.test(h.textContent)) || total > MAX_TEXT) { sec.remove(); continue; }
      total += sec.textContent.length;
    }
  }

  async function randomArticle() {
    const lang = settings.lang;
    $('article').innerHTML = '<p class="loading">Procurando um artigo bom para jogar…</p>';
    for (let tries = 0; tries < 8; tries++) {
      try {
        const res = await fetchT(`${api(lang)}/api/rest_v1/page/random/summary`, 10000);
        const j = await res.json();
        const okType = !j.type || j.type === 'standard';
        const longEnough = (j.extract || '').length >= 350;
        if (okType && longEnough) {
          return openArticle(lang, j.titles ? j.titles.canonical : j.title.replace(/ /g, '_'));
        }
      } catch { break; }                                   // sem internet: usa a lista fixa
    }
    const list = FALLBACK[lang] || FALLBACK.pt;
    return openArticle(lang, list[(Math.random() * list.length) | 0]);
  }

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
  // A barra de cima é fixa. Jogando, ela some (mais tela) e os botões do jogo
  // sobem para o topo; pausado, ela volta e os botões ficam abaixo dela.
  const barH = () => document.querySelector('.bar').offsetHeight;
  let playingNow = null;
  function setPlaying(on) {
    document.documentElement.style.setProperty('--bar-h', barH() + 'px');
    globalThis.PG_TOUCH_TOP = on ? 0 : barH();
    globalThis.PG_BAR_H = barH();
    if (on === playingNow) return;
    playingNow = on;
    document.documentElement.classList.toggle('playing', on);
  }
  setPlaying(false);
  addEventListener('resize', () => setPlaying(!!playingNow));

  // ---------- Início ----------
  (async () => {
    const { settings: saved } = await store.get('settings');
    settings = { ...DEFAULTS, ...(saved || {}) };
    paint();
    setMode('login');

    const h = fromHash();
    sb.auth.onAuthStateChange((event) => { if (event === 'SIGNED_OUT') leave(); });
    const { data: { session } } = await sb.auth.getSession();
    if (!session) {
      // sem conta: abre um artigo para ler enquanto entra
      if (h) openArticle(h.lang, h.title, false); else randomArticle();
      await store.remove('pgAuth'); showView('auth'); openSheet(); return;
    }
    const { data, error } = await sb.auth.getUser();
    if (error && !/fetch|network/i.test(error.message)) {
      if (h) openArticle(h.lang, h.title, false); else randomArticle();
      await sb.auth.signOut({ scope: 'local' }); showView('auth'); openSheet(); return;
    }
    await enter((data && data.user) || session.user);
    // link direto para um artigo abre ele; senão vai para onde tem gente (ou aleatório)
    if (h) openArticle(h.lang, h.title, false); else findArticle();
  })();

  // instalar como app (funciona offline o menu; os artigos precisam de internet)
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
