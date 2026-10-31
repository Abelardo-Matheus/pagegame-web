// PageGame v0.25: o bichinho come palavras, imagens e elementos de qualquer página.
//
// Como o scan fica leve mesmo em páginas enormes:
//  1. Nada roda até o Play: o script só é injetado na aba quando você aperta Play.
//  2. Nenhum <span> é criado. Um TreeWalker percorre a página e guarda só UM
//     retângulo por nó de texto (não por palavra), em Float32Array.
//  3. O scan é fatiado no tempo: no máximo ~6 ms por quadro, então a página
//     nunca trava, e o bicho já anda enquanto o scan continua.
//  4. Uma grade espacial (células de 128 px) diz quais nós estão perto da boca.
//  5. Só os nós perto da boca viram palavras individuais (lazy), e um cache LRU
//     descarta as posições dos nós que ficaram para trás.
//  6. Palavras comidas somem com a CSS Custom Highlight API: o texto fica
//     transparente via Range, sem mexer no DOM nem no layout.
(() => {
  // O menu só injeta este script quando ninguém na aba respondeu. Então, se já
  // existe uma cópia antiga aqui, ela está morta (a extensão foi recarregada
  // sem recarregar a página): desmonta o que sobrou dela e começa de novo.
  const prev = window.__pageGame;
  try { if (prev && typeof prev === 'object') prev.kill(); } catch {}
  document.querySelectorAll('[data-pagegame]').forEach((el) => el.remove());
  for (const el of [...document.documentElement.children]) {   // sobras da v0.5, que não marcava os elementos
    if (/^(canvas|div)$/.test(el.localName) && el.style.zIndex >= 2147483646 && el.style.pointerEvents === 'none') el.remove();
  }

  const RT = chrome.runtime;            // referência desta cópia: some quando a extensão é recarregada
  const alive = () => { try { return !!RT.id; } catch { return false; } };
  window.__pageGame = { alive, kill: () => {} };

  // ---------- Configurações (vêm do menu) ----------
  const DEFAULTS = {
    speed: 1, growth: 1, maxSegments: 70, color: '#ffd23f',
    eatWords: true, eatImages: true, eatObjects: true, showLabels: true, multiplayer: true,
    enemies: true, difficulty: 'normal', character: 'bicho', bots: true,
  };
  let S = { ...DEFAULTS };
  chrome.storage.local.get('settings', (r) => { S = { ...DEFAULTS, ...(r.settings || {}) }; });
  chrome.storage.onChanged.addListener((c, area) => {
    if (area !== 'local') return;
    if (c.settings) {
      const before = S;
      S = { ...DEFAULTS, ...c.settings.newValue };
      if (mounted && before.multiplayer !== S.multiplayer) S.multiplayer ? mpConnect() : mpDisconnect();
      if (mounted && before.color !== S.color && window.__pgNet) window.__pgNet.updateProfile({ color: S.color });
      if (mounted && before.character !== S.character) {           // trocou de personagem no menu
        resetCreature();
        if (isJumper()) initJumper();
        syncTouchUI();
      }
    }
    // saiu da conta: o jogo para na hora em todas as abas
    if (c.pgAuth && !c.pgAuth.newValue && mounted) {
      pause(); mpDisconnect();
      hud.textContent = '🐛 entre na sua conta no menu para jogar';
    }
  });

  // Só joga com login feito (o menu grava pgAuth depois do login no Supabase).
  let myName = '';
  const isLoggedIn = async () => {
    const { pgAuth } = await chrome.storage.local.get('pgAuth');
    if (pgAuth) myName = pgAuth.username || '';
    return !!pgAuth;
  };

  // ---------- Constantes ----------
  const CELL = 128;
  const OBJ = 1 << 24;                // ids >= OBJ na grade são objetos (imagens etc.)
  // Modo leve: celular/tablet (ou quando o aparelho não aguenta 40 fps).
  // Canvas em resolução menor, sem sombras/brilho, menos partículas, scan
  // mais curto por quadro e menos mensagens de rede.
  const LITE = matchMedia('(pointer: coarse)').matches || Math.min(screen.width, screen.height) < 700;
  let lite = LITE;
  const SCAN_BUDGET_MS = LITE ? 4 : 6;
  const LRU_MAX = LITE ? 150 : 300;    // nós de texto com palavras resolvidas em cache
  const FX_CAP = LITE ? 30 : 120;      // máximo de partículas / textos subindo ao mesmo tempo
  const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'head', 'meta', 'link', 'title']);
  const IMAGE_TAGS = new Set(['img', 'svg', 'canvas']);
  const OTHER_TAGS = new Set(['video', 'iframe', 'input', 'textarea', 'select', 'embed', 'object', 'audio']);

  const hasHighlight = !!(window.CSS && CSS.highlights && window.Highlight);
  const eatenHL = hasHighlight ? new Highlight() : null;
  if (hasHighlight) CSS.highlights.set('pg-eaten', eatenHL);

  // ---------- Índice espacial ----------
  // nodes[i] = nó de texto; rects[i*4..] = x,y,w,h em coordenadas da página
  function newIndex() {
    return {
      nodes: [], rects: new Float32Array(4096 * 4), n: 0,
      objs: [], orects: new Float32Array(256 * 4), on: 0,
      grid: new Map(), words: 0, images: 0, others: 0,
    };
  }
  const grow = (arr, need) => {
    if (need <= arr.length) return arr;
    const next = new Float32Array(Math.max(need, arr.length * 2));
    next.set(arr);
    return next;
  };
  const cellKey = (cx, cy) => (cx + 4096) * 1048576 + (cy + 4096);
  function gridInsert(ix, id, x, y, w, h) {
    const x0 = Math.floor(x / CELL), x1 = Math.floor((x + w) / CELL);
    const y0 = Math.floor(y / CELL), y1 = Math.floor((y + h) / CELL);
    for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) {
      const k = cellKey(cx, cy);
      const list = ix.grid.get(k);
      list ? list.push(id) : ix.grid.set(k, [id]);
    }
  }

  let index = newIndex();
  let chunkStamp = new Uint32Array(1), objStamp = new Uint32Array(1), stamp = 0;
  let layoutEpoch = 0;

  // Conta palavras sem alocar nada (sem regex, sem split).
  const isSpace = (c) => c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 160 ||
    (c >= 0x2000 && c <= 0x200a) || c === 0x3000;
  function countWords(t) {
    let n = 0, inW = false;
    for (let i = 0; i < t.length; i++) {
      const sp = isSpace(t.charCodeAt(i));
      if (!sp && !inW) { n++; inW = true; } else if (sp) inW = false;
    }
    return n;
  }

  // ---------- Scan fatiado ----------
  let scan = null;
  const scanRange = document.createRange();

  function startScan() {
    layoutEpoch++;
    const ix = newIndex();
    const filter = {
      acceptNode(n) {
        if (n.nodeType === 3) {
          return /\S/.test(n.data) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
        }
        const tag = n.localName;
        if (SKIP_TAGS.has(tag) || n.hidden || n.hasAttribute('data-pagegame-ui')) return NodeFilter.FILTER_REJECT;   // menu do app não é comida
        const isImg = IMAGE_TAGS.has(tag), isOther = OTHER_TAGS.has(tag);
        if (isImg || isOther) {
          // objeto do jogo: mede e não desce nos filhos (ex.: <path> dentro de <svg>)
          const r = n.getBoundingClientRect();
          if (r.width >= 6 && r.height >= 6) {
            const i = ix.on++;
            ix.objs.push(n);
            ix.orects = grow(ix.orects, ix.on * 4);
            const x = r.left + scrollX, y = r.top + scrollY;
            ix.orects.set([x, y, r.width, r.height], i * 4);
            gridInsert(ix, OBJ + i, x, y, r.width, r.height);
            isImg ? ix.images++ : ix.others++;
          }
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_SKIP;
      },
    };
    scan = {
      ix,
      walker: document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, filter),
      t0: performance.now(),
      ms: 0,
    };
  }

  function scanStep(budget) {
    const s = scan, ix = s.ix;
    const t0 = performance.now(), end = t0 + budget;
    let node, k = 0;
    while ((node = s.walker.nextNode())) {
      scanRange.selectNodeContents(node);
      const r = scanRange.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        const i = ix.n++;
        ix.nodes.push(node);
        ix.rects = grow(ix.rects, ix.n * 4);
        const x = r.left + scrollX, y = r.top + scrollY;
        ix.rects[i * 4] = x; ix.rects[i * 4 + 1] = y; ix.rects[i * 4 + 2] = r.width; ix.rects[i * 4 + 3] = r.height;
        gridInsert(ix, i, x, y, r.width, r.height);
        ix.words += countWords(node.data);
      }
      if ((++k & 31) === 0 && performance.now() > end) { s.ms += performance.now() - t0; return; }
    }
    // terminou: troca o índice antigo pelo novo de uma vez
    s.ms += performance.now() - t0;
    lastScanMs = s.ms;
    index = ix;
    chunkStamp = new Uint32Array(ix.n + 1);
    objStamp = new Uint32Array(ix.on + 1);
    scan = null;
  }
  let lastScanMs = 0;

  let rescanTimer = null;
  function requestRescan(delay = 250) {
    if (!running) return;
    clearTimeout(rescanTimer);
    rescanTimer = setTimeout(startScan, delay);
  }

  // ---------- Letras sob demanda (lazy) + cache LRU ----------
  // Cada nó de texto vira palavras (só para agrupar) e cada palavra vira
  // letras. O bicho come LETRA por LETRA. Posições são medidas em dois
  // níveis e só perto da boca: primeiro o retângulo da palavra, e só se a
  // boca encosta nela, o retângulo de cada letra.
  //
  // d = {
  //   len, starts, ends    limites de cada palavra no texto do nó
  //   wn, wl               letras por palavra / letras que ainda estão lá
  //   ate                  1 por caractere comido (marcado no início da letra)
  //   left                 total de letras que ainda estão lá
  //   rects, epoch         retângulos das palavras (página)
  //   lr                   Map palavra -> { offs, lens, rects } das letras
  // }
  let nodeData = new WeakMap();
  const lru = new Set();
  const wordRange = document.createRange();

  // tamanho da letra em unidades UTF-16 (emoji e afins ocupam 2)
  const charLen = (text, i) => {
    const c = text.charCodeAt(i);
    return c >= 0xd800 && c <= 0xdbff && i + 1 < text.length ? 2 : 1;
  };

  // Palavras e letras de um nó sem medir posições (barato). Usado pela rede.
  function wordData(node) {
    const text = node.data;
    let d = nodeData.get(node);
    if (!d || d.len !== text.length) {          // primeira vez ou o texto mudou
      const n = countWords(text);
      const starts = new Uint32Array(n), ends = new Uint32Array(n), wn = new Uint16Array(n);
      let w = -1, inW = false;
      for (let i = 0; i < text.length; i++) {
        const sp = isSpace(text.charCodeAt(i));
        if (!sp && !inW) { starts[++w] = i; inW = true; }
        else if (sp && inW) { ends[w] = i; inW = false; }
      }
      if (inW) ends[w] = text.length;
      let total = 0;
      for (let k = 0; k < n; k++) {
        let c = 0;
        for (let i = starts[k]; i < ends[k]; i += charLen(text, i)) c++;
        wn[k] = Math.min(c, 65535); total += wn[k];
      }
      d = { len: text.length, starts, ends, wn, wl: wn.slice(), ate: new Uint8Array(text.length),
            left: total, rects: null, epoch: -1, lr: new Map() };
      nodeData.set(node, d);
    }
    return d;
  }

  // palavra que começa no caractere s (busca binária)
  function findWord(d, s) {
    let lo = 0, hi = d.starts.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1, v = d.starts[mid];
      if (v === s) return mid;
      v < s ? (lo = mid + 1) : (hi = mid - 1);
    }
    return -1;
  }
  // palavra que contém o caractere o
  function wordAt(d, o) {
    let lo = 0, hi = d.starts.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (d.starts[mid] <= o) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans >= 0 && o < d.ends[ans] ? ans : -1;
  }

  // retângulos das palavras do nó (só as que ainda têm letra)
  function wordsOf(node) {
    const d = wordData(node);
    if (d.left > 0 && (!d.rects || d.epoch !== layoutEpoch)) {
      const n = d.starts.length, rects = d.rects && d.rects.length === n * 4 ? d.rects : new Float32Array(n * 4);
      const sx = scrollX, sy = scrollY;
      for (let i = 0; i < n; i++) {
        if (!d.wl[i]) continue;
        wordRange.setStart(node, d.starts[i]);
        wordRange.setEnd(node, d.ends[i]);
        const r = wordRange.getBoundingClientRect();
        rects[i * 4] = r.left + sx; rects[i * 4 + 1] = r.top + sy; rects[i * 4 + 2] = r.width; rects[i * 4 + 3] = r.height;
      }
      d.rects = rects;
      d.epoch = layoutEpoch;
      d.lr.clear();                              // letras são medidas de novo quando precisar
    }
    lru.delete(d); lru.add(d);
    if (lru.size > LRU_MAX) {                   // libera as posições mais antigas
      const oldest = lru.values().next().value;
      oldest.rects = null;
      oldest.lr.clear();
      lru.delete(oldest);
    }
    return d;
  }

  // letras de uma palavra: início, tamanho e retângulo (medidos só agora)
  function lettersOf(node, d, w) {
    let L = d.lr.get(w);
    if (L) return L;
    const text = node.data, n = d.wn[w];
    const offs = new Uint32Array(n), lens = new Uint8Array(n), rects = new Float32Array(n * 4);
    const sx = scrollX, sy = scrollY;
    let k = 0;
    for (let i = d.starts[w]; i < d.ends[w] && k < n; k++) {
      const len = charLen(text, i);
      offs[k] = i; lens[k] = len;
      wordRange.setStart(node, i); wordRange.setEnd(node, i + len);
      const r = wordRange.getBoundingClientRect();
      rects[k * 4] = r.left + sx; rects[k * 4 + 1] = r.top + sy; rects[k * 4 + 2] = r.width; rects[k * 4 + 3] = r.height;
      i += len;
    }
    L = { offs, lens, rects };
    d.lr.set(w, L);
    return L;
  }

  // =====================================================================
  // GANCHO: a palavra mudou (uma letra foi comida ou voltou).
  // Use isto para o seu método de "a palavra que sobrou forma outra palavra".
  //
  // info = {
  //   original:  'casa'          a palavra inteira, como está no site
  //   remaining: 'asa'           só as letras que continuam na página
  //   mask:      [0, 1, 1, 1]    1 = letra original, 2 = subiu da linha de baixo, 0 = buraco
  //   reason:    'comeu' | 'renasceu' | 'subiu' | 'perdeu' (a letra dela subiu para outra)
  //   byMe:      true            eu comi (false = outro jogador / renasceu)
  //   node, start, end           onde ela está (nó de texto + caracteres)
  //   x, y                       posição na tela (centro da palavra)
  // }
  //
  // Exemplo (troque pela sua regra):
  //   if (info.byMe && info.remaining.length >= 3 && MEU_DICIONARIO.has(info.remaining.toLowerCase())) {
  //     floaters.push({ text: info.remaining + '!', x: info.x + scrollX, y: info.y + scrollY, life: 1, good: true });
  //   }
  // =====================================================================
  function onWordChanged(info) { // eslint-disable-line no-unused-vars
  }

  function wordChanged(node, d, w, reason, byMe) {
    const text = node.data, s = d.starts[w], e = d.ends[w];
    const mask = [];
    let remaining = '';
    for (let i = s; i < e;) {
      const len = charLen(text, i);
      const f = d.ate[i] && d.fill ? d.fill.get(i) : null;
      if (!d.ate[i]) { mask.push(1); remaining += text.slice(i, i + len); }
      else if (f) { mask.push(2); remaining += f.ch; }               // 2 = letra que subiu da linha de baixo
      else mask.push(0);
      i += len;
    }
    // virou palavra da lista? (só quem causou a mudança cria o inimigo)
    if (byMe && reason !== 'renasceu' && remaining.length >= 4) checkTransform(node, d, w, remaining);
    let x = 0, y = 0;
    if (d.rects && d.rects[w * 4 + 2]) {
      x = d.rects[w * 4] - scrollX + d.rects[w * 4 + 2] / 2;
      y = d.rects[w * 4 + 1] - scrollY + d.rects[w * 4 + 3] / 2;
    }
    try {
      onWordChanged({ original: text.slice(s, e), remaining, mask, reason, byMe, node, start: s, end: e, x, y });
    } catch (err) {
      console.warn('[PageGame] erro no onWordChanged:', err);
    }
  }

  // ---------- Criatura ----------
  const mouse = { x: innerWidth / 2, y: innerHeight / 2 };
  let segs = [], heading = 0, speedNow = 0, food = 0, mouthOpen = 0, t = 0;
  let carried = [], particles = [];
  const eaten = { words: 0, images: 0, others: 0 };
  const objState = new Map();                 // elemento -> { hp, max, op, vis, done }

  const scale = () => 1 + Math.min(food, 400) / 120;
  const mouthR = () => 8 + 6 * scale();

  function resetCreature() {
    segs = [{ x: mouse.x, y: mouse.y }];
    food = 0; heading = 0; speedNow = 0; carried = []; particles = [];
    eaten.words = eaten.images = eaten.others = 0;
    growTo(4);
  }
  function growTo(n) {
    while (segs.length < n) {
      const last = segs[segs.length - 1];
      segs.push({ x: last.x, y: last.y });
    }
  }
  function addFood(v, label, x, y) {
    food += v;
    mouthOpen = 1;
    carried.unshift(label.slice(0, 14));
    if (carried.length > 40) carried.pop();
    particles.push({ text: label.slice(0, 20), x, y, life: 1 });
    const target = Math.min(S.maxSegments, 4 + Math.floor(food * S.growth / 2));
    growTo(target);
  }

  // ---------- Comer ----------
  const circleHitsRect = (cx, cy, R, x, y, w, h) => {
    const dx = Math.max(x - cx, 0, cx - (x + w));
    const dy = Math.max(y - cy, 0, cy - (y + h));
    return dx * dx + dy * dy < R * R;
  };

  function eatCheck() {
    const ix = index;
    const hx = segs[0].x + scrollX, hy = segs[0].y + scrollY, R = mouthR();
    stamp++;
    const x0 = Math.floor((hx - R) / CELL), x1 = Math.floor((hx + R) / CELL);
    const y0 = Math.floor((hy - R) / CELL), y1 = Math.floor((hy + R) / CELL);
    for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) {
      const list = ix.grid.get(cellKey(cx, cy));
      if (!list) continue;
      for (const id of list) {
        if (id >= OBJ) {
          const i = id - OBJ;
          if (objStamp[i] === stamp) continue;
          objStamp[i] = stamp;
          const o = ix.orects;
          if (circleHitsRect(hx, hy, R, o[i * 4], o[i * 4 + 1], o[i * 4 + 2], o[i * 4 + 3])) biteObject(ix.objs[i], o, i);
          continue;
        }
        if (!S.eatWords || !hasHighlight || chunkStamp[id] === stamp) continue;
        chunkStamp[id] = stamp;
        const r = ix.rects;
        if (!circleHitsRect(hx, hy, R, r[id * 4], r[id * 4 + 1], r[id * 4 + 2], r[id * 4 + 3])) continue;
        const node = ix.nodes[id];
        if (!node.isConnected) continue;
        const d = wordsOf(node);
        if (d.left === 0) continue;
        const wr = d.rects;
        for (let w = 0; w < d.starts.length; w++) {
          if (!d.wl[w] || wr[w * 4 + 2] === 0) continue;
          if (!circleHitsRect(hx, hy, R, wr[w * 4], wr[w * 4 + 1], wr[w * 4 + 2], wr[w * 4 + 3])) continue;
          // a boca encostou na palavra: agora sim olha letra por letra
          const L = lettersOf(node, d, w), lr = L.rects;
          let changed = false;
          for (let k = 0; k < L.offs.length; k++) {
            const o = L.offs[k];
            if (d.ate[o] || lr[k * 4 + 2] === 0) continue;
            if (circleHitsRect(hx, hy, R, lr[k * 4], lr[k * 4 + 1], lr[k * 4 + 2], lr[k * 4 + 3])) {
              eatLetter(node, d, w, o, L.lens[k], lr[k * 4] - scrollX + lr[k * 4 + 2] / 2, lr[k * 4 + 1] - scrollY + lr[k * 4 + 3] / 2);
              changed = true;
            }
          }
          if (changed) wordChanged(node, d, w, 'comeu', true);
        }
      }
    }
  }

  // marca a letra como comida e esconde (sem mexer no DOM)
  function hideLetter(node, d, w, o, len, delay) {
    d.ate[o] = 1; d.wl[w]--; d.left--;
    const range = new Range();
    range.setStart(node, o); range.setEnd(node, o + len);
    eatenHL.add(range);
    queueRespawn(node, d, [o], range, delay);
  }

  // palavra inteira (para as inimigas): esconde todas as letras de uma vez
  function letterOffsets(node, d, w) {
    const offs = [];
    for (let i = d.starts[w]; i < d.ends[w]; i += charLen(node.data, i)) offs.push(i);
    return offs;
  }
  function hideWord(node, d, w) {
    const offs = letterOffsets(node, d, w);
    for (const o of offs) d.ate[o] = 1;
    d.left -= d.wl[w]; d.wl[w] = 0;
    return offs;
  }
  function unhideLetters(node, d, offs) {
    let touched = -1;
    for (const o of offs) {
      if (!d.ate[o]) continue;
      const w = wordAt(d, o);
      if (w < 0) continue;
      const f = d.fill && d.fill.get(o);
      if (f) releaseFill(f, 'volta');            // a letra que tinha subido volta para baixo
      d.ate[o] = 0; d.wl[w]++; d.left++;
      if (d.wl[w] === 1) d.epoch = -1;          // a palavra estava toda comida: mede de novo
      if (w !== touched) { touched = w; }
    }
    return touched;
  }

  let carryKey = null;               // junta as letras da mesma palavra no corpo
  function eatLetter(node, d, w, o, len, x, y) {
    hideLetter(node, d, w, o, len);
    pendingFills.push({ node, d, o, len, at: performance.now() + FILL_DELAY });   // a letra de baixo sobe
    shareEat(node, o);
    eaten.words++;                   // 1 ponto por letra
    const ch = node.data.slice(o, o + len);
    const key = d.starts[w] + ':' + w;
    if (carryKey && carryKey.node === node && carryKey.key === key && carried.length) {
      carried[0] = (carried[0] + ch).slice(-14);
    } else {
      carried.unshift('');
      carried[0] = ch;
      if (carried.length > 40) carried.pop();
      carryKey = { node, key };
    }
    food += 0.3;
    mouthOpen = 1;
    particles.push({ text: ch, x, y, life: 1 });
    growTo(Math.min(S.maxSegments, 4 + Math.floor(food * S.growth / 2)));
  }

  function biteObject(el, o, i) {
    const tag = el.localName;
    const isImg = IMAGE_TAGS.has(tag);
    if (isImg ? !S.eatImages : !S.eatObjects) return;
    const area = o[i * 4 + 2] * o[i * 4 + 3];
    let st = objState.get(el);
    if (!st) {
      const max = Math.min(400, Math.max(4, area / 600));
      st = { hp: max, max, op: el.style.getPropertyValue('opacity'), vis: el.style.getPropertyValue('visibility'), done: false };
      objState.set(el, st);
    }
    if (st.done) return;
    st.hp -= 1 + scale() * 1.5;
    mouthOpen = Math.max(mouthOpen, 0.6);
    if (st.hp <= 0) {
      st.done = true;
      el.style.setProperty('visibility', 'hidden', 'important');
      shareObject(el);
      isImg ? eaten.images++ : eaten.others++;
      const label = isImg ? (el.getAttribute('alt') || 'imagem') : tag;
      addFood(Math.min(60, Math.max(3, area / 1500)), label,
        o[i * 4] - scrollX + o[i * 4 + 2] / 2, o[i * 4 + 1] - scrollY + o[i * 4 + 3] / 2);
    } else {
      el.style.setProperty('opacity', String(Math.max(0.1, st.hp / st.max)), 'important');
    }
  }

  // =====================================================================
  // Palavras inimigas: de vez em quando uma palavra ganha vida, sai da
  // linha e atira letras no mouse. Cada tiro levado tira pontos.
  // O corpo do bicho funciona como escudo, e comer a inimiga dá bônus.
  // =====================================================================
  const HIT_PENALTY = 5;
  const ENEMY_BONUS = 5;
  const DIFFICULTY = {
    facil:   { spawn: [7000, 12000], fire: 1900, speed: 3.0, max: 2, life: 12000 },
    normal:  { spawn: [4000, 8000],  fire: 1300, speed: 4.0, max: 4, life: 14000 },
    dificil: { spawn: [1800, 4200],  fire: 850,  speed: 5.4, max: 7, life: 16000 },
  };
  const ENEMY_COLOR = '#d7263d';

  const enemies = [];      // palavras vivas (coordenadas da página)
  const bullets = [];      // letras disparadas (coordenadas da página)
  const floaters = [];     // "-5", "+5" subindo (coordenadas da página)
  let hits = 0, enemiesEaten = 0;
  let nextSpawn = 0, invulnerableUntil = 0, hitFlash = 0;
  let enemySeq = 0;
  let slowUntil = 0, pushVX = 0, pushVY = 0;      // efeitos do gelo e da ventania

  // levei um tiro / encostão
  const buzz = (ms) => { try { if (navigator.vibrate && matchMedia('(pointer: coarse)').matches) navigator.vibrate(ms); } catch {} };
  function hurtMe(now, mx, my) {
    if (now <= invulnerableUntil) return;
    if (isJumper() && now < J.dashUntil + 80) return;                 // dash: desvia dos tiros
    hits++;
    invulnerableUntil = now + 600;
    hitFlash = 1;
    buzz(35);                                                          // celular vibra quando leva tiro
    floaters.push({ text: `-${HIT_PENALTY}`, x: mx, y: my - 10, life: 1, good: false });
  }

  // Dificuldade FIXA POR SALA: sai do nome da sala (o hash da página), então
  // todo mundo na mesma página joga na mesma dificuldade, e ela não muda.
  // 1 em 4 salas é Fácil, 2 em 4 Normal, 1 em 4 Difícil.
  // Quanto mais jogadores na sala, menos palavras inimigas: o limite e o
  // intervalo entre elas são divididos pelo "tamanho do grupo" (crowd).
  const DIFF_BY_ROOM = ['facil', 'normal', 'normal', 'dificil'];
  const DIFF_NAME = { facil: 'Fácil', normal: 'Normal', dificil: 'Difícil' };
  let roomDiffKey = '', roomDiffVal = 'normal';
  function roomDifficulty() {
    const url = globalThis.PG_PAGE_URL || location.href;
    if (url !== roomDiffKey) {
      roomDiffKey = url;
      try { roomDiffVal = DIFF_BY_ROOM[parseInt(roomNow().slice(0, 8), 16) % DIFF_BY_ROOM.length]; }
      catch { roomDiffVal = 'normal'; }
    }
    return roomDiffVal;
  }
  // 1 jogador = 1; cada jogador a mais soma 0,5 (2 = 1,5; 3 = 2; 5 = 3...)
  const crowd = () => 1 + 0.5 * (netState === 'online' ? peerCount : 0);
  function diff() {
    const base = DIFFICULTY[roomDifficulty()] || DIFFICULTY.normal;
    const f = crowd();
    if (f === 1) return base;
    return { ...base, max: Math.max(1, Math.round(base.max / f)), spawn: [base.spawn[0] * f, base.spawn[1] * f] };
  }
  const rand = (a, b) => a + Math.random() * (b - a);
  const points = () =>
    eaten.words + eaten.images * 5 + eaten.others * 3 + enemiesEaten * ENEMY_BONUS - hits * HIT_PENALTY;

  // Gerador de números com semente: todos na sala calculam os mesmos tiros.
  function seeded(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Cria a inimiga a partir dos dados (os mesmos que vão pela rede).
  // m = { id, seed, txt, life, fire, spd, p, s, e, a, fs, age, tp?, tr? }
  //   tp = tipo (arma, rapido...), tr = 1 quando veio de uma palavra transformada
  function makeEnemy(m, now) {
    if (enemies.some((e) => e.id === m.id)) return null;
    const T = m.tp ? WORD_ENEMIES[m.tp] : null;
    if (m.tp && !T) return null;
    const rng = seeded(m.seed);
    let node = null, d = null, w = -1, range = null, offs = null, x, y, ww, hh, font;
    // acha a palavra original nesta página (para escondê-la)
    const cand = m.p != null ? nodeAt(m.p) : null;
    if (cand && cand.data.length >= m.e) {
      const dd = wordsOf(cand);
      const ww0 = findWord(dd, m.s);
      if (ww0 >= 0 && dd.ends[ww0] === m.e && (m.tr || (dd.wl[ww0] === dd.wn[ww0] && dd.rects))) {
        node = cand; d = dd; w = ww0;
      }
    }
    if (node) {
      wordRange.setStart(node, m.s); wordRange.setEnd(node, m.e);
      const r = wordRange.getBoundingClientRect();
      x = r.left + scrollX; y = r.top + scrollY; ww = r.width; hh = r.height;
      if (!ww) node = null;
    }
    let fs = m.fs || 16, family = 'system-ui, sans-serif';
    if (node) {
      if (m.tr) {
        // palavra transformada: esconde o que sobrou dela e as letras que subiram
        offs = [];
        const consumed = [];
        for (let i = m.s; i < m.e; i += charLen(node.data, i)) {
          if (!d.ate[i]) { d.ate[i] = 1; d.wl[w]--; d.left--; offs.push(i); }
          else if (d.fill && d.fill.has(i)) consumed.push(d.fill.get(i));
        }
        for (const f of consumed) releaseFill(f, 'consome');
      } else {
        offs = hideWord(node, d, w);
      }
      range = new Range();
      range.setStart(node, m.s); range.setEnd(node, m.e);
      eatenHL.add(range);
      const style = getComputedStyle(node.parentElement);
      fs = parseFloat(style.fontSize) || fs; family = style.fontFamily;
    } else {
      // não achou a palavra (layout diferente): aparece no lugar equivalente
      const pos = fromAnchor(m.a);
      x = pos.x; y = pos.y;
    }
    if (T && T.big) fs *= T.big;
    font = `700 ${fs}px ${family}`;
    if (T || !node) {                        // mede o texto que vai ser desenhado
      ctx.font = font;
      ww = ctx.measureText(m.txt).width; hh = fs * 1.25;
    }
    const born = now - (m.age || 0);
    const e = {
      id: m.id, msg: m, rng, fire: m.fire, spd: m.spd, T, type: m.tp || null,
      color: T ? T.cor : ENEMY_COLOR, hp: T && T.hp ? T.hp : 1, maxHp: T && T.hp ? T.hp : 1,
      text: m.txt, node, d, w, range, offs,
      homeX: x, homeY: y, w: ww, h: hh, x, y, font,
      born, nextShot: born + 900 + rng() * 600, dieAt: born + m.life,
      nextBlink: born + 1200, nextGust: born + 1500, burstLeft: 0,
      phase: rng() * 10,
    };
    if (T && !T.fire) e.nextShot = Infinity;                       // não atira (ou só depois de teleportar)
    while (e.nextShot < now) e.nextShot += e.fire * (0.75 + rng() * 0.55);   // quem entrou depois
    enemies.push(e);
    return e;
  }

  // Escolhe uma palavra visível, longe do mouse, e dá vida a ela.
  // Só quem é o "anfitrião" da sala faz isso; os outros recebem pela rede.
  function spawnEnemy(now) {
    if (!hasHighlight) return false;
    const ix = index;
    const sx = scrollX, sy = scrollY;
    const x0 = Math.floor(sx / CELL), x1 = Math.floor((sx + innerWidth) / CELL);
    const y0 = Math.floor(sy / CELL), y1 = Math.floor((sy + innerHeight) / CELL);
    const ids = new Set();
    for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) {
      const list = ix.grid.get(cellKey(cx, cy));
      if (list) for (const id of list) if (id < OBJ) ids.add(id);
    }
    const pool = [...ids];
    const mx = mouse.x + sx, my = mouse.y + sy;
    for (let tries = 0; tries < 12 && pool.length; tries++) {
      const id = pool[(Math.random() * pool.length) | 0];
      const node = ix.nodes[id];
      if (!node.isConnected) continue;
      const d = wordsOf(node);
      if (!d.left || !d.rects) continue;
      const cands = [];
      for (let w = 0; w < d.starts.length; w++) {
        if (d.wl[w] !== d.wn[w] || d.wn[w] < 3) continue;           // só palavra inteira

        const r = d.rects;
        const wx = r[w * 4], wy = r[w * 4 + 1], ww = r[w * 4 + 2], wh = r[w * 4 + 3];
        if (!ww || wx < sx + 20 || wx + ww > sx + innerWidth - 20 || wy < sy + 20 || wy + wh > sy + innerHeight - 20) continue;
        if (Math.hypot(wx + ww / 2 - mx, wy + wh / 2 - my) < 180) continue;   // justo: não nasce em cima do mouse
        cands.push(w);
      }
      if (!cands.length) continue;
      const w = cands[(Math.random() * cands.length) | 0];
      const r = d.rects;
      const txt = node.data.slice(d.starts[w], d.ends[w]).replace(/[^\p{L}\p{N}-]/gu, '') || '???';
      const D = diff();
      const path = pathOf(node);
      // muitas vezes a palavra sorteada vira um inimigo especial (Atirador,
      // Corredor, Bomba...), igual aos que nascem da junção de letras
      const tp = Math.random() < RANDOM_TYPED ? pickRandomType() : null;
      const T = tp ? WORD_ENEMIES[tp] : null;
      const hard = D.fire / DIFFICULTY.normal.fire;                  // fácil atira mais devagar, difícil mais rápido
      const m = {
        id: (myId ? myId.slice(0, 8) : 'local') + '-' + (++enemySeq),
        seed: (Math.random() * 2 ** 31) | 0, txt: T ? txt.toUpperCase() : txt,
        life: Math.round(D.life * rand(0.8, 1.2) * (T ? 1.3 : 1)),
        fire: T ? (T.fire ? Math.round(T.fire * hard) : 99999) : D.fire,
        spd: T ? (T.spd || D.speed) : D.speed,
        p: path, s: d.starts[w], e: d.ends[w], a: toAnchor(r[w * 4], r[w * 4 + 1]),
        fs: parseFloat(getComputedStyle(node.parentElement).fontSize) || 16,
      };
      if (tp) m.tp = tp;
      const e = makeEnemy(m, now);
      if (e && T) {
        spawnBurst(e);
        floaters.push({ text: `${T.nome}!`, x: e.x + e.w / 2, y: e.y - 18, life: 1.4, good: false });
      }
      netEvent({ k: 'en', ...m });
      return true;
    }
    return false;
  }

  // A palavra volta para o lugar dela (não foi comida).
  function retireEnemy(e) {
    if (!e.range) return;
    if (e.msg.tr) { enemyGone(e); return; }      // palavra transformada não volta: renasce aos poucos
    eatenHL.delete(e.range);
    if (e.node.isConnected && nodeData.get(e.node) === e.d) unhideLetters(e.node, e.d, e.offs);
  }

  // Inimiga comida (por mim ou por outro jogador): a palavra fica comida e
  // renasce depois, como as outras.
  function enemyGone(e) {
    if (e.range) queueRespawn(e.node, e.d, e.offs, e.range);
  }

  // Alvo de cada tiro: o jogador mais perto da inimiga. Todos fazem a mesma
  // conta, então os tiros são iguais para a sala inteira.
  function nearestTarget(ox, oy, mx, my) {
    let best = { me: true, x: mx, y: my }, bd = Math.hypot(mx - ox, my - oy);
    for (const p of peers.values()) {
      if (p.bot) continue;                                         // inimigas miram só em gente de verdade
      const h = p.segs[0];
      const dd = Math.hypot(h.x - ox, h.y - oy);
      if (dd < bd) { bd = dd; best = { me: false, x: h.x, y: h.y }; }
    }
    return best;
  }

  function updateEnemies(now) {
    const D = diff();
    if (!nextSpawn) nextSpawn = now + 3000;          // a primeira aparece depois de 3 s
    if (!S.enemies) {
      while (enemies.length) retireEnemy(enemies.pop());
      bullets.length = 0;
    } else if (!scan && now >= nextSpawn) {
      if (isHost() && enemies.filter((e) => !e.msg.tr).length < D.max) spawnEnemy(now);   // as da junção de letras têm limite próprio
      nextSpawn = now + rand(D.spawn[0], D.spawn[1]);
    }

    const sx = scrollX, sy = scrollY;
    const mx = mouse.x + sx, my = mouse.y + sy;
    // alvo dos inimigos: o mouse (bicho) ou o próprio saltador
    const JP = isJumper();
    const tX = JP ? J.x : mx, tY = JP ? J.y - JH / 2 : my;
    const hitsMe = (x, y, r) => (JP ? Math.abs(x - tX) < JW / 2 + r && Math.abs(y - tY) < JH / 2 + r : Math.hypot(x - mx, y - my) < 12 + r);
    const head = segs[0], hx = head.x + sx, hy = head.y + sy, R = mouthR();

    for (let i = enemies.length - 1; i >= 0; i--) {
      const e = enemies[i], T = e.T;
      const age = now - e.born;
      const lift = Math.min(1, age / 400);
      let cx = e.x + e.w / 2, cy = e.y + e.h / 2;

      if (T && T.chase) {
        // corre na direção do jogador mais perto
        const tg = nearestTarget(cx, cy, tX, tY);
        const dx = tg.x - cx, dy = tg.y - cy, dd = Math.hypot(dx, dy) || 1;
        if (age > 500 && dd > 4) { e.homeX += dx / dd * T.chase; e.homeY += dy / dd * T.chase; }
        e.x = e.homeX; e.y = e.homeY - 10 * lift + Math.abs(Math.sin(age / 90)) * -4 * lift;
      } else {
        if (T && T.blink && age > 600 && now >= e.nextBlink) {
          // ninja: some e aparece do lado de um jogador, e ataca logo depois
          const tg = nearestTarget(cx, cy, tX, tY);
          const ang = e.rng() * Math.PI * 2;
          floaters.push({ text: '✧', x: cx, y: cy, life: 0.6, good: false });
          e.homeX = tg.x + Math.cos(ang) * 150 - e.w / 2;
          e.homeY = tg.y + Math.sin(ang) * 110 - e.h / 2 + 26;
          e.nextBlink = now + T.blink;
          e.nextShot = now + 300;
        }
        // sai da linha, pula e fica rondando o lugar de origem
        e.x = e.homeX + Math.sin(age / 520 + e.phase) * 22 * lift;
        e.y = e.homeY - 26 * lift + Math.sin(age / 310 + e.phase * 2) * 7 * lift;
      }
      cx = e.x + e.w / 2; cy = e.y + e.h / 2;

      // o bicho morde a inimiga (algumas precisam de várias mordidas)
      if (!JP && now >= (e.hurtUntil || 0) && circleHitsRect(hx, hy, R, e.x, e.y, e.w, e.h)) {
        if (e.hp > 1) {
          e.hp--; e.hurtUntil = now + 600;
          const kx = cx - hx, ky = cy - hy, kd = Math.hypot(kx, ky) || 1;
          e.homeX += kx / kd * 50; e.homeY += ky / kd * 50;
          floaters.push({ text: `${e.hp}/${e.maxHp}`, x: cx, y: e.y - 6, life: 0.8, good: true });
          mouthOpen = 1;
        } else {
          enemies.splice(i, 1);
          enemiesEaten++;
          enemyGone(e);
          netEvent({ k: 'ed', id: e.id });
          addFood(3, e.text, cx - sx, cy - sy);
          floaters.push({ text: `+${ENEMY_BONUS}`, x: cx, y: e.y, life: 1, good: true });
          continue;
        }
      }
      if (now > e.dieAt) { retireEnemy(e); enemies.splice(i, 1); continue; }

      // corredor: encostou no seu mouse, bate e se desfaz
      if (T && T.touch && age > 500 && hitsMe(cx, cy, 2 + e.h / 2)) {
        hurtMe(now, tX, tY);
        enemies.splice(i, 1);
        enemyGone(e);
        netEvent({ k: 'ed', id: e.id });
        floaters.push({ text: 'POW!', x: cx, y: cy - 10, life: 1, good: false });
        continue;
      }

      // bomba: estoura perto de alguém ou quando o pavio acaba
      if (T && T.fuse && age > 600) {
        const tg = nearestTarget(cx, cy, tX, tY);
        if (age > T.fuse || Math.hypot(tg.x - cx, tg.y - cy) < 70) {
          for (let k = 0; k < T.boom; k++) {
            const a2 = (k / T.boom) * Math.PI * 2 + e.phase;
            bullets.push({ x: cx, y: cy, vx: Math.cos(a2) * 4.2, vy: Math.sin(a2) * 4.2, ch: '✹',
                           born: now, harm: true, life: 1600, color: e.color });
          }
          floaters.push({ text: 'BUM!', x: cx, y: cy - 10, life: 1.2, good: false });
          hitFlash = Math.max(hitFlash, 0.5);
          enemies.splice(i, 1);
          enemyGone(e);
          continue;
        }
      }

      // ventania: rajada que empurra o bicho para longe
      if (T && T.gust && age > 800 && now >= e.nextGust) {
        e.nextGust = now + T.gust;
        e.gustFx = 1;
        const gx = hx - cx, gy = hy - cy, gd = Math.hypot(gx, gy) || 1;
        if (gd < 340) {
          pushVX += gx / gd * T.push; pushVY += gy / gd * T.push;
          floaters.push({ text: '~ ~', x: hx, y: hy - 14, life: 0.8, good: false });
        }
      }
      e.gustFx = Math.max(0, (e.gustFx || 0) - 0.03);

      // atira letras no jogador mais perto
      if (now >= e.nextShot && age > 500) {
        const tg = nearestTarget(cx, cy, tX, tY);
        const base = Math.atan2(tg.y - cy, tg.x - cx);
        const n = (T && T.spread) || 1, cone = (T && T.cone) || 0;
        for (let k = 0; k < n; k++) {
          const a2 = base + (n > 1 ? (k / (n - 1) - 0.5) * cone : 0);
          bullets.push({
            x: cx, y: cy, vx: Math.cos(a2) * e.spd, vy: Math.sin(a2) * e.spd,
            ch: e.text[(e.rng() * e.text.length) | 0], born: now, harm: tg.me,
            life: (T && T.reach) || 4000, color: e.color, slow: !!(T && T.slow), laser: !!(T && T.laser),
          });
        }
        if (!e.burstLeft) e.burstLeft = (T && T.burst) || 1;          // rajada: vários tiros seguidos
        e.burstLeft--;
        e.nextShot = now + (e.burstLeft > 0 ? 120 : e.fire * (0.75 + e.rng() * 0.55));
        e.recoil = 1;
      }
      e.recoil = Math.max(0, (e.recoil || 0) - 0.08);
    }

    // tiros
    for (let i = bullets.length - 1; i >= 0; i--) {
      const b = bullets[i];
      b.x += b.vx; b.y += b.vy;
      if (now - b.born > (b.life || 4000)) { bullets.splice(i, 1); continue; }

      // acertou o mouse (só os tiros que vieram em mim)
      if (b.harm && hitsMe(b.x, b.y, 0)) {
        bullets.splice(i, 1);
        hurtMe(now, tX, tY);
        if (b.slow) {                                         // gelo: o bicho fica lento
          slowUntil = now + 3000;
          floaters.push({ text: '❄', x: mx + 12, y: my - 14, life: 1, good: false });
        }
        continue;
      }

      // o corpo do bicho bloqueia o tiro (menos a parte colada no mouse,
      // senão a cabeça parada em cima do cursor viraria um escudo perfeito)
      const br = 4.5 * scale() * 1.6;
      for (let k = 1; k < segs.length; k++) {
        const p = segs[k];
        const px = p.x + sx, py = p.y + sy;
        if (Math.abs(px - b.x) < br && Math.abs(py - b.y) < br && Math.hypot(px - mx, py - my) > 24) {
          bullets.splice(i, 1);
          floaters.push({ text: '✦', x: b.x, y: b.y, life: 0.5, good: true });
          break;
        }
      }
    }

    for (let i = floaters.length - 1; i >= 0; i--) {
      floaters[i].y -= 0.8; floaters[i].life -= 0.02;
      if (floaters[i].life <= 0) floaters.splice(i, 1);
    }
    hitFlash = Math.max(0, hitFlash - 0.04);
  }

  // =====================================================================
  // Palavras renascem: o que foi comido volta aos poucos para a página.
  // =====================================================================
  const RESPAWN_MS = [25000, 70000];
  const respawnQ = [];
  // O tempo para renascer sai de um hash da posição da palavra: todo mundo
  // na sala calcula o mesmo, então ela volta junto para todos sem mensagem extra.
  function respawnDelay(path, s) {
    let h = 2166136261;
    for (let i = 0; i < path.length; i++) h = Math.imul(h ^ path.charCodeAt(i), 16777619);
    h = Math.imul(h ^ s, 16777619);
    return RESPAWN_MS[0] + ((h >>> 0) % (RESPAWN_MS[1] - RESPAWN_MS[0]));
  }
  // offs = letras (início de cada uma) que voltam juntas; range = o que esconde elas
  function queueRespawn(node, d, offs, range, delay) {
    if (delay == null) {
      const path = pathOf(node);
      delay = path ? respawnDelay(path, offs[0]) : rand(RESPAWN_MS[0], RESPAWN_MS[1]);
    }
    respawnQ.push({ node, d, offs, range, at: performance.now() + delay });
  }
  function respawnTick(now) {
    if (t % 10) return;
    let n = 0;
    for (let i = respawnQ.length - 1; i >= 0 && n < 12; i--) {
      const q = respawnQ[i];
      if (now < q.at) continue;
      respawnQ.splice(i, 1);
      n++;
      eatenHL.delete(q.range);
      if (!q.node.isConnected || nodeData.get(q.node) !== q.d || q.d.len !== q.node.data.length) continue;
      const w = unhideLetters(q.node, q.d, q.offs);
      if (w >= 0) wordChanged(q.node, q.d, w, 'renasceu', false);
      const r = q.range.getBoundingClientRect();
      if (r.width) floaters.push({ text: '✿', x: r.left + scrollX + r.width / 2, y: r.top + scrollY, life: 0.6, good: true });
    }
  }

  // =====================================================================
  // GRAVIDADE + PALAVRAS QUE VIRAM INIMIGOS
  //
  // Quando o bicho come uma letra, a letra que está logo ABAIXO dela (na
  // linha seguinte) sobe para ocupar o buraco. A letra de baixo some do
  // lugar dela e é desenhada no canvas no buraco de cima (o DOM não muda).
  //
  // Depois de cada mudança, a palavra é montada com as letras que ficaram +
  // as que subiram. Se ela for uma das palavras da lista abaixo, ou um
  // anagrama dela (ex.: "rmaa" = ARMA), a palavra vira um inimigo daquele tipo.
  // =====================================================================
  const WORD_ENEMIES = {
    arma:   { nome: 'Atirador',      cor: '#d7263d', fire: 1150, spd: 5.5, burst: 3 },          // rajada de 3 tiros
    rapido: { nome: 'Corredor',      cor: '#ff7a00', chase: 4.8, touch: true },                  // corre até você e bate
    bomba:  { nome: 'Bomba',         cor: '#6a1b9a', chase: 1.4, fuse: 4500, boom: 12 },         // chega perto e explode em 12 tiros
    fogo:   { nome: 'Lança-chamas',  cor: '#ff4d00', fire: 600, spd: 3.6, spread: 3, cone: 0.5, reach: 900 }, // leque curto
    gelo:   { nome: 'Congelador',    cor: '#1e88e5', fire: 1500, spd: 3.8, slow: true },         // tiro que deixa o bicho lento
    laser:  { nome: 'Laser',         cor: '#e0007a', fire: 2300, spd: 12, laser: true },         // tiro muito rápido
    ninja:  { nome: 'Ninja',         cor: '#212121', blink: 2600, spd: 6.5, burst: 2 },          // teleporta perto e ataca
    escudo: { nome: 'Escudo',        cor: '#546e7a', hp: 3, fire: 1800, spd: 4 },                // precisa de 3 mordidas
    chefe:  { nome: 'Chefão',        cor: '#8b0000', hp: 5, big: 1.7, fire: 1700, spd: 4.2, spread: 5, cone: 1.1 }, // grandão
    vento:  { nome: 'Ventania',      cor: '#00897b', gust: 2400, push: 10 },                     // empurra o bicho para longe
  };
  // Palavras transformadas são raras: no máximo 3 vivas, uma a cada 12 s por
  // jogador, e as letras só são "puxadas" de longe de vez em quando.
  const TRANSFORM_MAX = 3;
  // Palavras sorteadas (spawnEnemy) também viram esses inimigos especiais:
  // RANDOM_TYPED das vezes ganham um tipo; o resto é a inimiga vermelha comum.
  const RANDOM_TYPED = 0.65;
  const RANDOM_WEIGHTS = { arma: 3, rapido: 3, gelo: 2, fogo: 2, laser: 2, ninja: 2, vento: 2, bomba: 2, escudo: 2, chefe: 1 };
  function pickRandomType() {
    const all = Object.entries(RANDOM_WEIGHTS);
    let r = Math.random() * all.reduce((a, [, n]) => a + n, 0);
    for (const [k, n] of all) { if ((r -= n) < 0) return k; }
    return 'arma';
  }
  const TRANSFORM_COOLDOWN = 12000;
  // com mais gente na sala: menos palavras transformadas e mais espaço entre elas
  const transformMax = () => Math.max(1, Math.round(TRANSFORM_MAX / crowd()));
  const transformCooldown = () => TRANSFORM_COOLDOWN * crowd();
  const PULL_CHANCE = 0.12;           // chance de um buraco puxar a letra que falta
  const PULL_COOLDOWN = 6000;
  let lastTransform = -1e9, lastPull = -1e9;
  const TRANSFORM_LIFE = 22000;

  // sem acento, minúsculas, só letras
  const plain = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]/g, '');
  const anagramKey = (s) => [...s].sort().join('');
  const ENEMY_BY_KEY = new Map(Object.keys(WORD_ENEMIES).map((w) => [anagramKey(w), w]));

  // virou uma palavra da lista? (só quem causou a mudança faz isso)
  function checkTransform(node, d, w, composed) {
    if (!S.enemies || !hasHighlight) return;
    const p = plain(composed);
    if (p.length < 4 || p.length > 6) return;
    const type = ENEMY_BY_KEY.get(anagramKey(p));
    if (!type) return;
    if (performance.now() - lastTransform < transformCooldown()) return;
    if (enemies.filter((e) => e.msg.tr).length >= transformMax()) return;
    const path = pathOf(node);
    if (!path || !d.rects || !d.rects[w * 4 + 2]) return;
    const T = WORD_ENEMIES[type];
    const m = {
      id: (myId ? myId.slice(0, 8) : 'local') + '-t' + (++enemySeq),
      seed: (Math.random() * 2 ** 31) | 0, txt: composed.toUpperCase(),
      life: TRANSFORM_LIFE, fire: T.fire || 99999, spd: T.spd || 4,
      p: path, s: d.starts[w], e: d.ends[w], a: toAnchor(d.rects[w * 4], d.rects[w * 4 + 1]),
      fs: parseFloat(getComputedStyle(node.parentElement).fontSize) || 16,
      tp: type, tr: 1,
    };
    const e = makeEnemy(m, performance.now());
    if (!e) return;
    lastTransform = performance.now();
    buzz(40);
    near = near.filter((n) => !(n.node === node && n.w === w));
    spawnBurst(e);
    floaters.push({ text: `${T.nome}!`, x: e.x + e.w / 2, y: e.y - 18, life: 1.4, good: false });
    // manda antes as letras comidas / que subiram, para os outros montarem a mesma palavra
    eatFlushAt = 0; flushEat(performance.now());
    if (fillBuf.length) netEvent({ k: 'fl', n: fillBuf.splice(0, 200) });
    netEvent({ k: 'en', ...m });
  }

  // ---------- letras que sobem / vêm de longe ----------
  // Quando o bicho come uma letra, o buraco é preenchido assim:
  //  1. se dá para a palavra virar uma palavra da lista (ou anagrama), puxa a
  //     letra que falta de uma palavra COMPLETA em qualquer lugar do site
  //     (a mais perto, em cima ou embaixo). A letra vem voando, brilhando.
  //  2. senão, gravidade: a letra logo abaixo sobe (ou a de cima desce).
  const FILL_DELAY = 300, FILL_ANIM = 380, FILL_ANIM_MAX = 1100;
  const pendingFills = [];           // buracos esperando letra
  const fills = [];                  // letras que vieram (desenhadas no canvas)
  const fillBuf = [];                // lote para a rede
  let near = [];                     // palavras quase virando inimigo (contorno pontilhado)
  const bursts = [];                 // explosão de quando a palavra vira inimigo

  function letterRect(node, o, len) {
    wordRange.setStart(node, o); wordRange.setEnd(node, o + len);
    return wordRange.getBoundingClientRect();
  }
  function fontOf(el) {
    const st = getComputedStyle(el);
    return { font: `${st.fontStyle} ${st.fontWeight} ${st.fontSize} ${st.fontFamily}`, color: st.color,
             bold: `${st.fontStyle} 800 ${st.fontSize} ${st.fontFamily}` };
  }

  // letras presentes da palavra (originais + que vieram) e buracos vazios
  function wordState(node, d, w) {
    const text = node.data;
    let have = '';
    const holes = [];
    for (let i = d.starts[w]; i < d.ends[w];) {
      const len = charLen(text, i);
      if (!d.ate[i]) have += plain(text.slice(i, i + len));
      else if (d.fill && d.fill.has(i)) have += plain(d.fill.get(i).ch);
      else holes.push(i);
      i += len;
    }
    return { have, holes };
  }

  // qual palavra da lista dá para formar com o que sobrou + letras novas
  // nos buracos? Devolve a que precisa de menos letras.
  function bestTarget(have, holeCount) {
    let best = null;
    for (const t of Object.keys(WORD_ENEMIES)) {
      const k = t.length - have.length;
      if (k < 1 || k > holeCount) continue;
      const c = {};
      for (const ch of t) c[ch] = (c[ch] || 0) + 1;
      let ok = true;
      for (const ch of have) { if (!c[ch]) { ok = false; break; } c[ch]--; }
      if (!ok) continue;
      const need = [];
      for (const [ch, n] of Object.entries(c)) for (let j = 0; j < n; j++) need.push(ch);
      if (!best || need.length < best.need.length || (need.length === best.need.length && Math.random() < 0.5)) {
        best = { type: t, need };
      }
    }
    return best;
  }

  // procura a letra numa palavra COMPLETA em qualquer lugar do site
  // (a mais perto do buraco primeiro, em cima ou embaixo)
  const ACCENTS = { a: 'aáàâãä', e: 'eéèêë', i: 'iíìîï', o: 'oóòôõö', u: 'uúùûü', c: 'cç', n: 'nñ' };
  const letterRe = {};
  function findLetterAnywhere(ch, holeNode, holeW, hy) {
    const re = letterRe[ch] || (letterRe[ch] = new RegExp('[' + (ACCENTS[ch] || ch) + ']', 'i'));
    const ix = index, r = ix.rects, cands = [];
    for (let i = 0; i < ix.n; i++) if (re.test(ix.nodes[i].data)) cands.push(i);
    cands.sort((a, b) => Math.abs(r[a * 4 + 1] - hy) - Math.abs(r[b * 4 + 1] - hy));
    for (const i of cands.slice(0, 80)) {
      const n = ix.nodes[i];
      if (!n.isConnected) continue;
      const sd = wordData(n), text = n.data;
      for (let w2 = 0; w2 < sd.starts.length; w2++) {
        if (sd.wl[w2] !== sd.wn[w2] || sd.wn[w2] < 2) continue;          // só de palavra completa
        if (n === holeNode && w2 === holeW) continue;
        for (let o = sd.starts[w2]; o < sd.ends[w2]; o += charLen(text, o)) {
          if (plain(text[o]) === ch) return { node: n, d: sd, o, len: charLen(text, o) };
        }
      }
    }
    return null;
  }

  // gravidade: a letra logo abaixo (dir = 1) ou logo acima (dir = -1) do buraco,
  // só de palavra completa
  function letterNear(node, o, len, dir) {
    const r = letterRect(node, o, len);
    if (!r.width) return null;
    const px = r.left + r.width / 2, py = dir > 0 ? r.bottom + r.height * 0.55 : r.top - r.height * 0.55;
    if (py < 0 || py > innerHeight - 1 || px < 0 || px > innerWidth - 1) return null;   // fora da tela
    let sn = null, so = 0;
    if (document.caretRangeFromPoint) {
      const cr = document.caretRangeFromPoint(px, py);
      if (cr) { sn = cr.startContainer; so = cr.startOffset; }
    } else if (document.caretPositionFromPoint) {
      const cp = document.caretPositionFromPoint(px, py);
      if (cp) { sn = cp.offsetNode; so = cp.offset; }
    }
    if (!sn || sn.nodeType !== 3 || canvas.contains(sn) || hud.contains(sn) || board.contains(sn)) return null;
    for (const c of [so, so - 1]) {
      if (c < 0 || c >= sn.data.length) continue;
      const code = sn.data.charCodeAt(c);
      if (isSpace(code) || (code >= 0xdc00 && code <= 0xdfff)) continue;
      const sd = wordData(sn);
      if (sd.ate[c]) continue;
      const sw = wordAt(sd, c);
      if (sw < 0 || sd.wl[sw] !== sd.wn[sw]) continue;                    // só de palavra completa
      const sl = charLen(sn.data, c);
      const sr = letterRect(sn, c, sl);
      const ok = dir > 0 ? sr.top > r.top + r.height * 0.5 : sr.bottom < r.bottom - r.height * 0.5;
      if (sr.left - 1 <= px && px <= sr.right + 1 && ok) return { node: sn, d: sd, o: c, len: sl, rect: sr };
    }
    return null;
  }

  // a letra src vem para o buraco (node, o). hint = tipo de inimigo que ela ajuda a formar
  function doFill(node, d, o, len, src, ch, byMe, hint) {
    if (!d.ate[o] || (d.fill && d.fill.has(o))) return null;
    const hr = letterRect(node, o, len);
    if (!hr.width) return null;
    const sx = scrollX, sy = scrollY;
    let from = { x: hr.left + sx, y: hr.bottom + sy + hr.height };
    const look = fontOf(node.parentElement);
    let srcInfo = null;
    if (src && !src.d.ate[src.o]) {
      const sw = wordAt(src.d, src.o);
      if (sw >= 0) {
        src.d.ate[src.o] = 1; src.d.wl[sw]--; src.d.left--;
        const range = new Range();
        range.setStart(src.node, src.o); range.setEnd(src.node, src.o + src.len);
        eatenHL.add(range);
        const sr = src.rect || letterRect(src.node, src.o, src.len);
        from = { x: sr.left + sx, y: sr.top + sy };
        look.color = fontOf(src.node.parentElement).color;
        ch = src.node.data.slice(src.o, src.o + src.len);
        srcInfo = { node: src.node, d: src.d, o: src.o, len: src.len, range, w: sw };
      }
    }
    if (!ch) return null;
    if (hint && !WORD_ENEMIES[hint]) hint = null;
    const dist = Math.hypot(hr.left + sx - from.x, hr.top + sy - from.y);
    const f = { node, d, o, len, ch, font: look.font, bold: look.bold, color: look.color, src: srcInfo, hint,
                x: hr.left + sx, y: hr.top + sy, w: hr.width, h: hr.height, epoch: layoutEpoch,
                fx: from.x, fy: from.y, born: performance.now(),
                anim: Math.max(FILL_ANIM, Math.min(FILL_ANIM_MAX, dist / 1.4)) };
    (d.fill || (d.fill = new Map())).set(o, f);
    fills.push(f);
    if (byMe) {
      const hp = pathOf(node), sp = srcInfo ? pathOf(srcInfo.node) : null;
      if (hp && netState === 'online') fillBuf.push(sp ? [hp, o, sp, srcInfo.o, ch, hint || ''] : [hp, o, '', -1, ch, hint || '']);
    }
    // as duas palavras mudaram (a do buraco ganhou letra, a de onde veio perdeu)
    const w = wordAt(d, o);
    if (w >= 0) wordChanged(node, d, w, 'subiu', byMe);
    if (srcInfo) wordChanged(srcInfo.node, srcInfo.d, srcInfo.w, 'perdeu', byMe);
    return f;
  }

  // tira a letra que veio. mode: 'volta' (ela volta para o lugar dela),
  // 'consome' (foi comida ou virou inimigo: a original renasce depois)
  function releaseFill(f, mode) {
    const i = fills.indexOf(f);
    if (i >= 0) fills.splice(i, 1);
    if (f.d.fill) f.d.fill.delete(f.o);
    const s = f.src;
    if (!s) return;
    if (mode === 'volta') {
      eatenHL.delete(s.range);
      if (s.node.isConnected && nodeData.get(s.node) === s.d && s.d.ate[s.o]) {
        const w = wordAt(s.d, s.o);
        s.d.ate[s.o] = 0; s.d.left++;
        if (w >= 0) { s.d.wl[w]++; if (s.d.wl[w] === 1) s.d.epoch = -1; }
      }
    } else {
      queueRespawn(s.node, s.d, [s.o], s.range);
    }
  }

  function fillTick(now) {
    if (t % 4) return;
    for (let i = pendingFills.length - 1; i >= 0; i--) {
      const q = pendingFills[i];
      if (now < q.at) continue;
      pendingFills.splice(i, 1);
      if (!q.node.isConnected || nodeData.get(q.node) !== q.d || !q.d.ate[q.o] || (q.d.fill && q.d.fill.has(q.o))) continue;
      const w = wordAt(q.d, q.o);
      if (w < 0) continue;
      let src = null, hint = null;
      const canPull = S.enemies && hasHighlight && now - lastPull > PULL_COOLDOWN &&
        now - lastTransform > transformCooldown() && Math.random() < PULL_CHANCE &&
        enemies.filter((e) => e.msg.tr).length < transformMax();
      if (canPull) {
        const st = wordState(q.node, q.d, w);
        const found = bestTarget(st.have, st.holes.length);
        const best = found && found.need.length === 1 ? found : null;   // só quando falta 1 letra
        if (best) {
          lastPull = now;
          const hr = letterRect(q.node, q.o, q.len);
          src = findLetterAnywhere(best.need[0], q.node, w, hr.top + scrollY);
          if (src) {
            hint = best.type;
            near = near.filter((n) => !(n.node === q.node && n.w === w));
            near.push({ node: q.node, d: q.d, w, type: best.type, until: now + 8000 });
            // faltam mais letras: chama letras para os outros buracos da palavra também
            if (best.need.length > 1) {
              for (const h of st.holes) {
                if (h === q.o || pendingFills.some((p) => p.node === q.node && p.o === h)) continue;
                pendingFills.push({ node: q.node, d: q.d, o: h, len: charLen(q.node.data, h), at: now + 220 });
              }
            }
          }
        }
      }
      if (!src) src = letterNear(q.node, q.o, q.len, 1) || letterNear(q.node, q.o, q.len, -1);
      if (src) doFill(q.node, q.d, q.o, q.len, src, null, true, hint);
    }
    if (fillBuf.length) { netEvent({ k: 'fl', n: fillBuf.splice(0, 200) }); }
  }

  // explosão quando a palavra vira inimigo (bem visível)
  function spawnBurst(e) {
    const cx = e.x + e.w / 2, cy = e.y + e.h / 2, now = performance.now();
    bursts.push({ ring: true, x: cx, y: cy, color: e.color, born: now });
    const nb = lite ? 8 : 18;
    for (let k = 0; k < nb; k++) {
      const a = (k / nb) * Math.PI * 2, v = 2.5 + Math.random() * 3;
      bursts.push({ x: cx, y: cy, vx: Math.cos(a) * v, vy: Math.sin(a) * v, ch: e.text[k % e.text.length],
                    color: e.color, born: now });
    }
    hitFlash = Math.max(hitFlash, 0.35);
  }
  function drawBursts(now) {
    const sx = scrollX, sy = scrollY;
    ctx.save();
    ctx.translate(-sx, -sy);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let i = bursts.length - 1; i >= 0; i--) {
      const b = bursts[i], age = now - b.born;
      if (age > 900) { bursts.splice(i, 1); continue; }
      const k = age / 900;
      ctx.globalAlpha = 1 - k;
      if (b.ring) {
        ctx.strokeStyle = b.color; ctx.lineWidth = 4 * (1 - k) + 1;
        ctx.beginPath(); ctx.arc(b.x, b.y, 12 + k * 110, 0, Math.PI * 2); ctx.stroke();
      } else {
        b.x += b.vx; b.y += b.vy; b.vy += 0.08;
        ctx.font = '800 14px system-ui, sans-serif'; ctx.fillStyle = b.color;
        ctx.fillText(b.ch, b.x, b.y);
      }
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  // contorno pontilhado nas palavras que estão quase virando inimigo
  function drawNear(now) {
    if (!near.length) return;
    ctx.save();
    for (let i = near.length - 1; i >= 0; i--) {
      const n = near[i];
      if (now > n.until || !n.node.isConnected || nodeData.get(n.node) !== n.d) { near.splice(i, 1); continue; }
      const st = wordState(n.node, n.d, n.w);
      if (!st.holes.length && !pendingFills.some((p) => p.node === n.node)) { near.splice(i, 1); continue; }  // não deu
      const T = WORD_ENEMIES[n.type];
      wordRange.setStart(n.node, n.d.starts[n.w]); wordRange.setEnd(n.node, n.d.ends[n.w]);
      const r = wordRange.getBoundingClientRect();
      if (!r.width || r.bottom < 0 || r.top > innerHeight) continue;
      const pulse = 0.55 + 0.45 * Math.sin(now / 160);
      ctx.globalAlpha = pulse;
      ctx.setLineDash([4, 3]); ctx.strokeStyle = T.cor; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.roundRect(r.left - 4, r.top - 3, r.width + 8, r.height + 6, 6); ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      ctx.font = '800 10px system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
      const label = `${n.type.toUpperCase()} ${Math.min(st.have.length, n.type.length)}/${n.type.length}`;
      ctx.lineWidth = 3; ctx.strokeStyle = '#fff'; ctx.strokeText(label, r.left - 2, r.top - 4);
      ctx.fillStyle = T.cor; ctx.fillText(label, r.left - 2, r.top - 4);
    }
    ctx.restore();
  }

  // o bicho também come as letras que subiram
  function fillEatCheck() {
    if (!fills.length || !S.eatWords) return;
    const hx = segs[0].x + scrollX, hy = segs[0].y + scrollY, R = mouthR();
    const now = performance.now();
    for (let i = fills.length - 1; i >= 0; i--) {
      const f = fills[i];
      if (now - f.born < f.anim) continue;
      if (!circleHitsRect(hx, hy, R, f.x, f.y, f.w, f.h)) continue;
      releaseFill(f, 'consome');
      eaten.words++;
      food += 0.3; mouthOpen = 1;
      particles.push({ text: f.ch, x: f.x - scrollX + f.w / 2, y: f.y - scrollY + f.h / 2, life: 1 });
      const hp = pathOf(f.node);
      if (hp && netState === 'online') fillBuf.push([hp, f.o]);         // [caminho, letra] = a que subiu foi comida
      const w = wordAt(f.d, f.o);
      if (w >= 0) wordChanged(f.node, f.d, w, 'comeu', true);
    }
  }

  function drawFills(now) {
    if (!fills.length) return;
    const sx = scrollX, sy = scrollY;
    ctx.save();
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
    for (const f of fills) {
      if (f.epoch !== layoutEpoch && f.node.isConnected) {          // layout mudou: mede o buraco de novo
        const r = letterRect(f.node, f.o, f.len);
        f.x = r.left + sx; f.y = r.top + sy; f.w = r.width; f.h = r.height; f.epoch = layoutEpoch;
      }
      const age = now - f.born;
      const k = Math.min(1, age / f.anim), e = 1 - (1 - k) * (1 - k);
      const arc = f.hint ? Math.sin(k * Math.PI) * Math.min(160, Math.abs(f.y - f.fy) * 0.25 + 40) : 0;
      const x = f.fx + (f.x - f.fx) * e - sx, y = f.fy + (f.y - f.fy) * e - sy - arc;
      if (x < -50 || x > innerWidth + 50 || y < -50 || y > innerHeight + 50) continue;
      const T = f.hint && WORD_ENEMIES[f.hint];
      // fundo destacado: a letra que veio de outro lugar aparece bem
      const glow = T ? 0.55 + 0.45 * Math.sin(now / 140) : 0.6;
      ctx.globalAlpha = glow * (k < 1 ? 1 : 0.9);
      ctx.fillStyle = T ? T.cor : '#ffd23f';
      ctx.beginPath(); ctx.roundRect(x - 2, y - 1, f.w + 4, f.h + 2, 3); ctx.fill();
      ctx.globalAlpha = 1;
      if (T) {
        ctx.shadowColor = T.cor; ctx.shadowBlur = 10;
        // rastro enquanto voa
        if (k < 1) {
          for (let j = 1; j <= 4; j++) {
            const kk = Math.max(0, k - j * 0.05), ee = 1 - (1 - kk) * (1 - kk);
            const ax = Math.sin(kk * Math.PI) * Math.min(160, Math.abs(f.y - f.fy) * 0.25 + 40);
            ctx.globalAlpha = 0.35 - j * 0.07;
            ctx.fillStyle = T.cor; ctx.font = f.bold;
            ctx.fillText(f.ch, f.fx + (f.x - f.fx) * ee - sx, f.fy + (f.y - f.fy) * ee - sy - ax + f.h / 2);
          }
          ctx.globalAlpha = 1;
        }
      }
      ctx.font = T ? f.bold : f.font;
      ctx.fillStyle = T ? '#fff' : f.color;
      if (T) { ctx.lineWidth = 3; ctx.strokeStyle = T.cor; ctx.strokeText(f.ch, x, y + f.h / 2); }
      ctx.fillText(f.ch, x, y + f.h / 2);
      ctx.shadowBlur = 0;
    }
    ctx.restore();
  }

  // letras que subiram na tela de outro jogador
  function applyFills(n) {
    if (!hasHighlight || !Array.isArray(n)) return;
    for (const g of n.slice(0, 300)) {
      if (!Array.isArray(g) || typeof g[0] !== 'string') continue;
      const node = nodeAt(g[0]);
      if (!node) continue;
      const d = wordData(node), o = g[1] | 0;
      if (o < 0 || o >= d.len) continue;
      if (g.length === 2) {                                          // a que subiu foi comida
        const f = d.fill && d.fill.get(o);
        if (f) { releaseFill(f, 'consome'); const w = wordAt(d, o); if (w >= 0) wordChanged(node, d, w, 'comeu', false); }
        continue;
      }
      let src = null;
      if (g[2] && (g[3] | 0) >= 0) {
        const sn = nodeAt(g[2]);
        if (sn) {
          const sd = wordData(sn), so = g[3] | 0;
          if (so < sd.len && !sd.ate[so]) src = { node: sn, d: sd, o: so, len: charLen(sn.data, so) };
        }
      }
      doFill(node, d, o, charLen(node.data, o), src, typeof g[4] === 'string' ? g[4].slice(0, 2) : '', false,
             typeof g[5] === 'string' ? g[5] : null);
    }
  }

  // =====================================================================
  // Trombada entre jogadores: quem leva a batida perde as palavras do corpo,
  // que saem voando e caem em lugares aleatórios. Qualquer um pode comer.
  // =====================================================================
  const loose = [];                 // palavras soltas (coordenadas da página)
  const LOOSE_MAX = 300, LOOSE_LIFE = 90000, FLY_MS = 800;
  let looseSeq = 0, shieldUntil = 0;
  const hitCooldown = new Map();     // user_id -> quando posso bater de novo

  function addLoose(id, text, fx, fy, x, y, color, now) {
    if (loose.some((l) => l.id === id)) return;
    loose.push({ id, text, fx, fy, x, y, color, born: now, phase: Math.random() * 6 });
    if (loose.length > LOOSE_MAX) loose.shift();
  }

  // levei uma trombada: as palavras do corpo saem voando
  function dropWords(now) {
    if (isJumper() || now < shieldUntil) return;
    shieldUntil = now + 3000;
    hitFlash = 1;
    const k = Math.min(carried.length, 24);
    const words = carried.splice(0, k);
    food = Math.max(0, food - Math.max(k, segs.length / 3) * 1.5);
    const target = Math.max(4, Math.min(S.maxSegments, 4 + Math.floor(food * S.growth / 2)));
    if (segs.length > target) segs.length = target;
    const W = document.documentElement.clientWidth || innerWidth;
    const H = document.documentElement.clientHeight || innerHeight;
    const ox = segs[0].x + scrollX, oy = segs[0].y + scrollY;
    const items = words.map((text) => {
      const x = scrollX + rand(40, W - 40), y = scrollY + rand(50, H - 40);
      const id = (myId || 'me').slice(0, 8) + '-w' + (++looseSeq);
      addLoose(id, text, ox, oy, x, y, S.color, now);
      return { id, t: text, a: toAnchor(x, y) };
    });
    floaters.push({ text: 'POW!', x: ox, y: oy - 20, life: 1, good: false });
    sendMyPosition(true);
    if (items.length) netEvent({ k: 'drop', o: toAnchor(ox, oy), c: S.color, items });
  }

  // minha cabeça bateu em outro bicho?
  function pvpCheck(now) {
    if (!peers.size || now < shieldUntil) return;                 // peers inclui os bots (funciona até offline)
    const hx = segs[0].x + scrollX, hy = segs[0].y + scrollY, R = mouthR();
    for (const [id, p] of peers) {
      if (p.kind === 'j' || p.iv || now < (hitCooldown.get(id) || 0)) continue;   // saltador não leva trombada
      const pr = 4.5 * p.scale * 1.4;
      let hit = false;
      for (let i = 1; i < p.segs.length && !hit; i++) {        // corpo dele
        const s = p.segs[i];
        if (Math.hypot(s.x - hx, s.y - hy) < R * 0.7 + pr) hit = true;
      }
      // cabeça com cabeça: o menor leva
      const h = p.segs[0];
      if (!hit && Math.hypot(h.x - hx, h.y - hy) < R * 0.7 + pr * 1.3 && p.n < segs.length) hit = true;
      if (!hit) continue;
      hitCooldown.set(id, now + 2500);
      peerHit(id, now);
      floaters.push({ text: 'POW!', x: hx, y: hy - 16, life: 1, good: true });
    }
  }

  // como palavras soltas que estão perto da boca
  function looseCheck(now) {
    if (!loose.length) return;
    const hx = segs[0].x + scrollX, hy = segs[0].y + scrollY, R = mouthR();
    for (let i = loose.length - 1; i >= 0; i--) {
      const l = loose[i];
      const age = now - l.born;
      if (age > LOOSE_LIFE) { loose.splice(i, 1); continue; }
      if (age < FLY_MS) continue;                                // ainda voando
      const half = Math.max(10, l.text.length * 4);
      if (Math.abs(l.x - hx) < half + R && Math.abs(l.y - hy) < 8 + R) {
        loose.splice(i, 1);
        const pts = Math.max(1, [...l.text].length);               // 1 ponto por letra
        eaten.words += pts;
        addFood(pts * 0.3, l.text, l.x - scrollX, l.y - scrollY);
        floaters.push({ text: '+' + pts, x: l.x, y: l.y - 8, life: 0.8, good: true });
        netEvent({ k: 'pick', id: l.id });
      }
    }
  }

  function drawLoose(now) {
    if (!loose.length) return;
    const sx = scrollX, sy = scrollY;
    ctx.save();
    ctx.translate(-sx, -sy);
    ctx.font = '700 13px system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
    for (const l of loose) {
      const age = now - l.born;
      let x = l.x, y = l.y;
      if (age < FLY_MS) {                                         // voa em arco até o lugar
        const k = age / FLY_MS, e = 1 - (1 - k) * (1 - k);
        x = l.fx + (l.x - l.fx) * e;
        y = l.fy + (l.y - l.fy) * e - Math.sin(k * Math.PI) * 120;
      } else {
        y += Math.sin(now / 400 + l.phase) * 2;
      }
      if (x < sx - 100 || x > sx + innerWidth + 100 || y < sy - 50 || y > sy + innerHeight + 50) continue;
      ctx.globalAlpha = age > LOOSE_LIFE - 5000 ? Math.max(0, (LOOSE_LIFE - age) / 5000) : 1;
      const tw = ctx.measureText(l.text).width + 12;
      ctx.fillStyle = l.color || '#ffd23f'; ctx.strokeStyle = LINE; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.roundRect(x - tw / 2, y - 9, tw, 18, 9); ctx.fill(); ctx.stroke();
      ctx.fillStyle = LINE;
      ctx.fillText(l.text, x, y + 0.5);
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  // =====================================================================
  // Comida compartilhada: o que um jogador come some para todos.
  // Só vai pela rede a localização: caminho do nó de texto no DOM + o
  // caractere onde a palavra começa. Juntado em lotes a cada 250 ms.
  //   { k: 'eat', n: [["3.1.0", 12, 18, 25], ...] }
  // =====================================================================
  const eatBuf = new Map();          // caminho -> [início das letras]
  let eatFlushAt = 0;
  function shareEat(node, o) {
    if (netState !== 'online') return;
    const p = pathOf(node);
    if (!p) return;
    const a = eatBuf.get(p);
    a ? a.push(o) : eatBuf.set(p, [o]);
  }
  // Letras seguidas viram uma sequência: [12, 13, 14, 15, 20] -> [12, -3, 20]
  // (número negativo = "mais N letras logo depois da anterior").
  function packRuns(a) {
    a.sort((x, y) => x - y);
    const out = [];
    let run = 0, prev = -2;
    for (const o of a) {
      if (o === prev) continue;
      if (o === prev + 1) { run++; prev = o; continue; }
      if (run) out.push(-run);
      out.push(o); run = 0; prev = o;
    }
    if (run) out.push(-run);
    return out;
  }
  function flushEat(now) {
    if (!eatBuf.size || now < eatFlushAt) return;
    eatFlushAt = now + 250;
    const n = [];
    for (const [p, a] of eatBuf) n.push([p, ...packRuns(a)]);
    eatBuf.clear();
    netEvent({ k: 'eat', n });
  }
  function shareObject(el) {
    if (netState !== 'online') return;
    const p = pathOf(el);
    if (p) netEvent({ k: 'obj', p });
  }

  // aplica uma letra comida por outro jogador (delay = quando renasce)
  function applyEat(node, d, o, delay, changed) {
    if (o < 0 || o >= d.len || d.ate[o]) return;
    const c = node.data.charCodeAt(o);
    if (isSpace(c) || (c >= 0xdc00 && c <= 0xdfff)) return;     // não é início de letra
    const w = wordAt(d, o);
    if (w < 0) return;
    hideLetter(node, d, w, o, charLen(node.data, o), delay);
    changed.add(w);
  }
  function applyEatList(n, withDelay) {
    if (!hasHighlight || !Array.isArray(n)) return;
    for (const g of n.slice(0, 500)) {
      if (!Array.isArray(g) || typeof g[0] !== 'string') continue;
      const node = nodeAt(g[0]);
      if (!node) continue;
      const d = wordData(node), changed = new Set();
      if (withDelay) {
        for (let i = 1; i + 1 < g.length; i += 2) applyEat(node, d, g[i] | 0, (g[i + 1] | 0) * 1000, changed);
      } else {
        let last = -1;
        for (let i = 1; i < g.length && i < 4000; i++) {
          const v = g[i] | 0;
          if (v >= 0) { applyEat(node, d, v, undefined, changed); last = v; }
          else for (let j = 1; j <= Math.min(-v, 2000); j++) applyEat(node, d, last + j, undefined, changed);
          if (v < 0) last -= v;
        }
      }
      for (const w of changed) wordChanged(node, d, w, 'comeu', false);
    }
  }
  // quem entra depois recebe o que já está comido (e quanto falta para renascer)
  function sendEatSnapshot(now) {
    const byPath = new Map();
    for (const q of respawnQ) {
      const p = pathOf(q.node);
      if (!p) continue;
      let a = byPath.get(p);
      if (!a) byPath.set(p, a = []);
      const rem = Math.max(1, Math.round((q.at - now) / 1000));
      for (const o of q.offs) a.push(o, rem);
    }
    let n = [], size = 0;
    for (const [p, a] of byPath) {
      n.push([p, ...a]); size += a.length;
      if (size > 1500) { netEvent({ k: 'eats', n }); n = []; size = 0; }
    }
    if (n.length) netEvent({ k: 'eats', n });
    // e as letras que subiram (para ver as mesmas letras no lugar)
    const fl = [];
    for (const f of fills) {
      const hp = pathOf(f.node), sp = f.src ? pathOf(f.src.node) : null;
      if (hp) fl.push(sp ? [hp, f.o, sp, f.src.o, f.ch] : [hp, f.o, '', -1, f.ch]);
    }
    for (let i = 0; i < fl.length; i += 200) netEvent({ k: 'fl', n: fl.slice(i, i + 200) });
  }
  function elementAt(path) {
    let n = document.body;
    for (const i of path.split('.')) { n = n && n.childNodes[+i]; if (!n) return null; }
    return n.nodeType === 1 ? n : null;
  }
  function applyObject(path) {
    const el = elementAt(path);
    if (!el || !(IMAGE_TAGS.has(el.localName) || OTHER_TAGS.has(el.localName))) return;
    let st = objState.get(el);
    if (st && st.done) return;
    if (!st) {
      st = { hp: 0, max: 1, op: el.style.getPropertyValue('opacity'), vis: el.style.getPropertyValue('visibility'), done: true };
      objState.set(el, st);
    }
    st.done = true;
    el.style.setProperty('visibility', 'hidden', 'important');
  }

  // Mensagens da sala (tudo que não é posição)
  function onNetEvent(m) {
    if (!m || !m.k || !mounted) return;
    const now = performance.now();
    if (m.k === 'en') {
      if (S.enemies && hasHighlight) {
        const e = makeEnemy(m, now);
        if (e && m.tp) spawnBurst(e);                  // inimigo especial (sorteado ou da junção) aparece com explosão
      }
    } else if (m.k === 'ed') {
      const i = enemies.findIndex((e) => e.id === m.id);
      if (i >= 0) {
        const e = enemies[i];
        enemies.splice(i, 1);
        enemyGone(e);
        floaters.push({ text: 'nhac', x: e.x + e.w / 2, y: e.y, life: 0.7, good: true });
      }
    } else if (m.k === 'hit') {
      if (m.v === myId) dropWords(now);
      else { const b = peers.get(m.v); if (b && b.local) botDrop(b, now); }   // trombaram num bot meu
    } else if (m.k === 'bots') {
      onBots(m);
    } else if (m.k === 'drop' && Array.isArray(m.items)) {
      const o = fromAnchor(m.o || {});
      for (const it of m.items.slice(0, 40)) {
        if (!it || typeof it.t !== 'string' || !it.a) continue;
        const p = fromAnchor(it.a);
        addLoose(String(it.id), it.t.slice(0, 14), o.x, o.y, p.x, p.y, m.c, now);
      }
    } else if (m.k === 'eat') {
      applyEatList(m.n, false);
    } else if (m.k === 'eats') {
      applyEatList(m.n, true);
    } else if (m.k === 'fl') {
      applyFills(m.n);
    } else if (m.k === 'obj') {
      if (typeof m.p === 'string') applyObject(m.p);
    } else if (m.k === 'pw' && Array.isArray(m.a)) {               // tiros de outro jogador (só visual)
      const p = peers.get(m.id);
      if (p) for (const a of m.a.slice(0, 12)) spawnShots(p.segs[0].x, p.segs[0].y, +a || 0, WEAPONS[m.w] ? m.w : 'pistola', false);
    } else if (m.k === 'ph') {                                        // um tiro de outro jogador me acertou
      if (m.v === myId) {
        const o = gunPos();
        hurtMe(now, o.x, o.y);
        sendMyPosition(true);
      } else { const b = peers.get(m.v); if (b && b.local) botHurt(b, now); }   // atiraram num bot meu
    } else if (m.k === 'pick') {
      const i = loose.findIndex((l) => l.id === m.id);
      if (i >= 0) loose.splice(i, 1);
    }
  }

  function drawEnemies(now) {
    const sx = scrollX, sy = scrollY;
    ctx.save();
    ctx.translate(-sx, -sy);
    ctx.lineCap = 'round';
    for (const e of enemies) {
      const cx = e.x + e.w / 2, by = e.y + e.h;
      const shake = (e.recoil || 0) * 2 + (now < (e.hurtUntil || 0) ? Math.sin(now / 30) * 2 : 0);
      const T = e.T, col = e.color;
      if (T && T.fuse && Math.floor((now - e.born) / Math.max(80, 400 - (now - e.born) / 15)) % 2) continue;  // bomba pisca
      // ventania: anel da rajada
      if (e.gustFx > 0) {
        ctx.globalAlpha = e.gustFx; ctx.strokeStyle = col; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(cx, e.y + e.h / 2, 340 * (1 - e.gustFx) + 20, 0, Math.PI * 2); ctx.stroke();
        ctx.globalAlpha = 1;
      }
      // escudo: contorno em volta da palavra
      if (T && T.hp) {
        ctx.strokeStyle = col; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.roundRect(e.x - 6, e.y - 4, e.w + 12, e.h + 8, 8); ctx.stroke();
        for (let k = 0; k < e.maxHp; k++) {                                  // vida
          ctx.fillStyle = k < e.hp ? col : '#ddd';
          ctx.beginPath(); ctx.arc(cx + (k - (e.maxHp - 1) / 2) * 9, by + 14, 3, 0, Math.PI * 2); ctx.fill();
        }
      }
      // perninhas
      ctx.strokeStyle = col; ctx.lineWidth = 1.4;
      ctx.beginPath();
      const legs = Math.max(2, Math.min(5, Math.round(e.w / 14)));
      for (let k = 0; k < legs; k++) {
        const lx = e.x + (k + 0.5) * e.w / legs;
        const sw = Math.sin(now / 90 + k * 1.7 + e.phase) * 3;
        ctx.moveTo(lx, by - 2); ctx.lineTo(lx + sw, by + 6);
      }
      ctx.stroke();
      // a palavra
      ctx.font = e.font;
      ctx.textBaseline = 'top'; ctx.textAlign = 'left';
      ctx.lineWidth = 3; ctx.strokeStyle = '#fff'; ctx.lineJoin = 'round';
      ctx.strokeText(e.text, e.x + shake, e.y);
      if (T && now - e.born < 1500) { ctx.shadowColor = col; ctx.shadowBlur = 22 * (1 - (now - e.born) / 1500); }  // acabou de nascer: brilha
      ctx.fillStyle = col;
      ctx.fillText(e.text, e.x + shake, e.y);
      ctx.shadowBlur = 0;
      // nome do tipo em cima (palavras transformadas)
      if (T) {
        ctx.save();
        ctx.font = '800 10px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        ctx.lineWidth = 3; ctx.strokeStyle = '#fff';
        ctx.strokeText(T.nome.toUpperCase(), cx, e.y - 14);
        ctx.fillStyle = col; ctx.fillText(T.nome.toUpperCase(), cx, e.y - 14);
        ctx.restore();
      }
      // olhos bravos olhando para o mouse
      const ang = Math.atan2(mouse.y + sy - (e.y - 6), mouse.x + sx - cx);
      for (const side of [-1, 1]) {
        const ex = cx + side * 6, ey = e.y - 7;
        ctx.fillStyle = '#fff'; ctx.strokeStyle = '#2b1d00'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(ex, ey, 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#2b1d00';
        ctx.beginPath(); ctx.arc(ex + Math.cos(ang) * 1.6, ey + Math.sin(ang) * 1.6, 1.8, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.moveTo(ex - 5, ey - 6 - side); ctx.lineTo(ex + 5, ey - 6 + side); ctx.stroke(); // sobrancelha
      }
    }
    // tiros: letras dentro de bolinhas vermelhas
    ctx.font = '700 11px system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const b of bullets) {
      const bc = b.color || ENEMY_COLOR;
      if (b.laser) {                                                       // laser: risco comprido
        ctx.strokeStyle = bc; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(b.x - b.vx * 3, b.y - b.vy * 3); ctx.lineTo(b.x, b.y); ctx.stroke();
        continue;
      }
      ctx.fillStyle = b.slow ? '#bfe3ff' : bc;
      ctx.beginPath(); ctx.arc(b.x, b.y, 8, 0, Math.PI * 2); ctx.fill();
      if (b.slow) { ctx.strokeStyle = bc; ctx.lineWidth = 1.5; ctx.stroke(); }
      ctx.fillStyle = b.slow ? bc : '#fff';
      ctx.fillText(b.ch, b.x, b.y + 0.5);
    }
    // +5 / -5
    ctx.font = '800 15px system-ui, sans-serif';
    for (const f of floaters) {
      ctx.globalAlpha = Math.max(0, f.life);
      ctx.lineWidth = 3; ctx.strokeStyle = '#fff';
      ctx.strokeText(f.text, f.x, f.y);
      ctx.fillStyle = f.good ? '#1f8a3b' : ENEMY_COLOR;
      ctx.fillText(f.text, f.x, f.y);
    }
    ctx.globalAlpha = 1;
    ctx.restore();

    // tela pisca em vermelho quando leva tiro
    if (hitFlash > 0) {
      ctx.save();
      ctx.globalAlpha = hitFlash * 0.5;
      ctx.strokeStyle = ENEMY_COLOR;
      ctx.lineWidth = 16;
      ctx.strokeRect(0, 0, innerWidth, innerHeight);
      ctx.restore();
    }
  }

  function clearEnemies() {
    while (enemies.length) retireEnemy(enemies.pop());
    bullets.length = 0; floaters.length = 0;
  }

  // ---------- Movimento ----------
  const EDGE = 70;             // faixa perto do topo/fundo da janela que rola a página
  const MAX_SCROLL = 16;       // rolagem máxima por quadro (px)
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const norm = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  let resting = true;          // parado no mouse: a cabeça não gira
  let mouseIn = true;          // mouse dentro da janela (fora dela não rola a página)
  let lastBump = 0;

  // Paredes: bate, perde velocidade e não atravessa (a cabeça continua
  // virada para onde ia, então ela desliza junto da parede até o mouse).
  function bump(h, vertical) {
    const into = vertical ? Math.abs(Math.sin(heading)) : Math.abs(Math.cos(heading));
    if (speedNow * into > 1.2 && t - lastBump > 12) {
      lastBump = t;
      floaters.push({ text: '✦', x: h.x + scrollX, y: h.y + scrollY, life: 0.5, good: true });
    }
    speedNow *= 1 - 0.6 * into;
  }

  // Cabeça na borda de cima/baixo com o mouse lá também: a página rola.
  function edgeScroll(head, H, steer = false) {
    if (!mouseIn && !steer) return;
    const se = document.scrollingElement || document.documentElement;
    const maxY = Math.max(0, se.scrollHeight - H);
    // volante (celular): rola se a cabeça está na borda indo para aquele lado
    const goDown = steer ? Math.sin(heading) > 0.15 : mouse.y > H - EDGE;
    const goUp = steer ? Math.sin(heading) < -0.15 : mouse.y < EDGE;
    let want = 0;
    if (head.y > H - EDGE && goDown && scrollY < maxY - 0.5) {
      want = Math.ceil(2 + clamp((head.y - (H - EDGE)) / EDGE, 0, 1) * MAX_SCROLL * S.speed);
    } else if (head.y < EDGE && goUp && scrollY > 0.5) {
      want = -Math.ceil(2 + clamp((EDGE - head.y) / EDGE, 0, 1) * MAX_SCROLL * S.speed);
    }
    if (!want) return;
    const before = scrollY;
    scrollBy({ top: want, behavior: 'instant' });
    allowedX = scrollX; allowedY = scrollY;          // esta rolagem foi do bicho: vale
    const moved = scrollY - before;
    // o corpo fica preso na página e vem atrás da cabeça
    if (moved) for (let i = 1; i < segs.length; i++) segs[i].y -= moved;
  }

  // =====================================================================
  // PERSONAGEM 2: SALTADOR
  // Cai do topo da tela e usa as LETRAS como plataforma.
  //   A / D (ou ← →)  anda       W (ou ↑)  pula       S (ou ↓)  desce da plataforma
  //   Espaço          bate no chão e quebra as letras num círculo em volta
  //   clique / segurar o botão do mouse   atira na direção do mouse
  // Ele não cresce. As plataformas são de mão única: por baixo e pelos lados
  // ele atravessa, então nunca fica preso (se ficar parado em cima de uma
  // letra que some, ele cai).
  // =====================================================================
  const isJumper = () => S.character === 'saltador';
  const JW = 22, JH = 28;                      // tamanho do saltador (px)
  const J = { x: 0, y: 0, vx: 0, vy: 0, onGround: false, face: 1, squash: 0, dropUntil: 0,
              lastShot: 0, lastSlam: 0, shooting: false, aim: 0, broke: 0, kills: 0, jumpBuf: 0, dropBuf: 0,
              dashUntil: 0, lastDash: 0, dvx: 0, dvy: 0, airDash: true, trail: [] };
  const jkeys = new Set();
  const shots = [];                            // tiros do saltador (coordenadas da página)
  const slams = [];                            // ondas do Espaço

  function initJumper() {
    const W = document.documentElement.clientWidth || innerWidth;
    J.x = scrollX + clamp(mouse.x, JW, W - JW); J.y = scrollY + (globalThis.PG_TOUCH_TOP || 0) + JH + 4;    // cai do topo da tela (abaixo da barra do app, se tiver)
    J.vx = 0; J.vy = 0; J.onGround = false; J.squash = 0;
    segs = [{ x: J.x - scrollX, y: J.y - scrollY - JH / 2 }];
    food = 0; carried = [];
  }

  // a letra mais alta que serve de chão entre y0 e y1 (coordenadas da página)
  function platformBetween(x0, x1, y0, y1) {
    const ix = index;
    let best = null;
    const cx0 = Math.floor(x0 / CELL), cx1 = Math.floor(x1 / CELL);
    const cy0 = Math.floor((y0 - 40) / CELL), cy1 = Math.floor((y1 + 4) / CELL);
    stamp++;
    for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
      const list = ix.grid.get(cellKey(cx, cy));
      if (!list) continue;
      for (const id of list) {
        if (id >= OBJ || chunkStamp[id] === stamp) continue;
        chunkStamp[id] = stamp;
        const r = ix.rects;
        if (r[id * 4] > x1 || r[id * 4] + r[id * 4 + 2] < x0 || r[id * 4 + 1] > y1 + 2 || r[id * 4 + 1] + r[id * 4 + 3] < y0 - 40) continue;
        const node = ix.nodes[id];
        if (!node.isConnected) continue;
        const d = wordsOf(node);
        if (!d.left || !d.rects) continue;
        const wr = d.rects;
        for (let w = 0; w < d.starts.length; w++) {
          if (!d.wl[w] || !wr[w * 4 + 2]) continue;
          if (wr[w * 4] > x1 || wr[w * 4] + wr[w * 4 + 2] < x0) continue;
          const L = lettersOf(node, d, w), lr = L.rects;
          for (let k = 0; k < L.offs.length; k++) {
            if (d.ate[L.offs[k]] || !lr[k * 4 + 2]) continue;
            if (lr[k * 4] > x1 || lr[k * 4] + lr[k * 4 + 2] < x0) continue;
            const top = lr[k * 4 + 1] + lr[k * 4 + 3] * 0.2;          // topo visível da letra
            if (top >= y0 && top <= y1 && (best === null || top < best)) best = top;
          }
        }
      }
    }
    for (const f of fills) {                                           // letras que vieram também são chão
      if (f.x > x1 || f.x + f.w < x0) continue;
      const top = f.y + f.h * 0.2;
      if (top >= y0 && top <= y1 && (best === null || top < best)) best = top;
    }
    return best;
  }

  // a câmera acompanha o saltador (só o jogo rola a página)
  function camScroll(dy) {
    if (!dy) return;
    const se = document.scrollingElement || document.documentElement;
    const H = document.documentElement.clientHeight || innerHeight;
    const target = clamp(scrollY + dy, 0, Math.max(0, se.scrollHeight - H));
    if (Math.abs(target - scrollY) < 0.5) return;
    scrollTo({ left: scrollX, top: target, behavior: 'instant' });
    allowedX = scrollX; allowedY = scrollY;
  }

  // Shift: dash grande na direção do mouse. Durante o dash ele atravessa
  // tudo e não leva tiro. No chão recarrega em 0,6 s; no ar só 1 dash até pousar.
  const DASH_MS = 190, DASH_SPEED = 21;
  function dash(angle) {
    const now = performance.now();
    if (now - J.lastDash < 600 || now < J.dashUntil) return;
    if (angle != null) J.aim = angle;                                   // botão do celular escolhe a direção
    if (!J.onGround && !J.airDash) return;
    if (!J.onGround) J.airDash = false;
    J.lastDash = now; J.dashUntil = now + DASH_MS;
    J.dvx = Math.cos(J.aim) * DASH_SPEED; J.dvy = Math.sin(J.aim) * DASH_SPEED;
    J.onGround = false; J.squash = 0;
    J.trail = [];
    floaters.push({ text: '»', x: J.x, y: J.y - JH, life: 0.5, good: true });
  }

  function updateJumper() {
    const now = performance.now();
    const W = document.documentElement.clientWidth || innerWidth;
    const H = document.documentElement.clientHeight || innerHeight;
    // mira sempre no mouse
    J.aim = Math.atan2(mouse.y + scrollY - (J.y - JH / 2), mouse.x + scrollX - J.x);

    // dash em andamento: vai reto, sem gravidade e sem plataformas
    if (now < J.dashUntil) {
      J.trail.push({ x: J.x, y: J.y, born: now });
      J.x = clamp(J.x + J.dvx, scrollX + JW / 2, scrollX + W - JW / 2);
      J.y += J.dvy;
      if (J.y - JH < 0) J.y = JH;
      J.vx = J.dvx * 0.35; J.vy = J.dvy * 0.35;                       // sai do dash com um pouco de embalo
      const sy0 = J.y - scrollY;                                        // câmera acompanha o dash
      if (sy0 > H * 0.65) camScroll(sy0 - H * 0.65);
      else if (sy0 - JH < H * 0.22 && scrollY > 0) camScroll(sy0 - JH - H * 0.22);
      segs.length = 1;
      segs[0].x = J.x - scrollX; segs[0].y = J.y - scrollY - JH / 2;
      return;
    }
    const slowK = now < slowUntil ? 0.45 : 1;
    const left = jkeys.has('left'), right = jkeys.has('right');
    const want = (right - left) * 4.2 * S.speed * slowK;
    J.vx += (want - J.vx) * (J.onGround ? 0.3 : 0.12);
    J.vx += pushVX; pushVX *= 0.85; J.vy += pushVY * 0.5; pushVY *= 0.85;   // ventania
    if (want) J.face = Math.sign(want);

    // pulo: vale segurar W ou só um toque rápido (fica guardado por 150 ms)
    if ((jkeys.has('up') || now < J.jumpBuf) && J.onGround) { J.vy = -11.5 * Math.sqrt(slowK); J.onGround = false; J.squash = -0.25; J.jumpBuf = 0; }
    if ((jkeys.has('down') || now < J.dropBuf) && J.onGround) { J.dropUntil = now + 260; J.onGround = false; J.dropBuf = 0; }   // desce da plataforma

    // horizontal, preso entre as paredes da janela
    J.x = clamp(J.x + J.vx, scrollX + JW / 2, scrollX + W - JW / 2);

    // vertical: gravidade e plataformas de mão única (letras)
    const prev = J.y;
    J.vy = Math.min(J.vy + 0.55, 14);
    let ny = J.y + J.vy;
    let landed = false;
    if (J.vy >= 0 && now > J.dropUntil) {
      const top = platformBetween(J.x - JW / 2 + 4, J.x + JW / 2 - 4, prev - 1, ny + 1);
      if (top !== null) {
        if (!J.onGround && J.vy > 4) J.squash = Math.min(0.35, J.vy / 30);
        ny = top; J.vy = 0; landed = true;
      }
    }
    J.y = ny; J.onGround = landed;
    if (landed) J.airDash = true;                                       // pousou: recarrega o dash do ar
    if (J.y - JH < 0) { J.y = JH; J.vy = Math.max(J.vy, 0); }        // teto: o topo da página
    J.squash *= 0.8;

    // caiu da página: volta do topo da tela
    const se = document.scrollingElement || document.documentElement;
    if (J.y > se.scrollHeight + 200) { J.y = scrollY + 4; J.vy = 0; floaters.push({ text: '↓', x: J.x, y: J.y + 10, life: 0.8, good: false }); }

    // câmera: mantém o saltador entre 22% e 65% da altura da tela
    const sy = J.y - scrollY;
    if (sy > H * 0.65) camScroll((sy - H * 0.65) * (J.vy > 8 ? 1 : 0.35));
    else if (sy - JH < H * 0.22 && scrollY > 0) camScroll((sy - JH - H * 0.22) * 0.35);

    // mira e tiros
    const cx = J.x, cy = J.y - JH / 2;
    J.aim = Math.atan2(mouse.y + scrollY - cy, mouse.x + scrollX - cx);
    // o resto do jogo (partículas, rede, inimigos) usa segs[0] = centro do saltador na tela
    segs.length = 1;
    segs[0].x = J.x - scrollX; segs[0].y = J.y - scrollY - JH / 2;
    heading = J.face > 0 ? 0 : Math.PI;
    speedNow = Math.abs(J.vx);
  }

  // =====================================================================
  // GRANADA (Espaço / 💣): o saltador joga uma granada na direção do mouse.
  // Ela tem gravidade e quica nas letras (plataformas). Como as plataformas
  // são de mão única, jogada de baixo para cima ela atravessa e, quando volta
  // caindo, para em cima da letra. Depois de 1,6 s explode e quebra as letras
  // num círculo (e machuca os inimigos perto).
  // =====================================================================
  const SLAM_R = 85;
  const grenades = [];
  const GRENADE_FUSE = 1600;
  function throwGrenade(angle) {
    const now = performance.now();
    if (now - J.lastSlam < 550 || grenades.length >= 3) return;
    J.lastSlam = now;
    const a = angle != null ? angle : J.aim;
    const sp = 10.5;
    grenades.push({ x: J.x + Math.cos(a) * 14, y: J.y - JH / 2 + Math.sin(a) * 14,
                    vx: Math.cos(a) * sp + J.vx * 0.4, vy: Math.sin(a) * sp, born: now, spin: 0 });
    J.squash = 0.12;
    buzz(10);
  }
  function updateGrenades(now) {
    const W = document.documentElement.clientWidth || innerWidth;
    const se = document.scrollingElement || document.documentElement;
    for (let i = grenades.length - 1; i >= 0; i--) {
      const g = grenades[i];
      if (now - g.born > GRENADE_FUSE) { grenades.splice(i, 1); breakCircle(g.x, g.y - 5); continue; }
      const prev = g.y;
      g.vy = Math.min(g.vy + 0.42, 15);
      g.x += g.vx; g.y += g.vy; g.spin += g.vx * 0.09;
      // bate nas paredes da janela
      const minX = scrollX + 5, maxX = scrollX + W - 5;
      if (g.x < minX) { g.x = minX; g.vx = Math.abs(g.vx) * 0.6; }
      else if (g.x > maxX) { g.x = maxX; g.vx = -Math.abs(g.vx) * 0.6; }
      // plataformas de mão única: subindo atravessa; descendo quica e fica
      if (g.vy >= 0) {
        // (largura maior que o espaço entre palavras, senão cai no vão)
        const top = platformBetween(g.x - 8, g.x + 8, prev - 1, g.y + 1);
        if (top !== null) {
          g.y = top;
          if (g.vy > 2.2) { g.vy = -g.vy * 0.42; g.vx *= 0.7; }     // quica
          else { g.vy = 0; g.vx *= 0.6; if (Math.abs(g.vx) < 0.25) g.vx = 0; }   // parou na letra
        }
      }
      if (g.y > se.scrollHeight + 100) grenades.splice(i, 1);
    }
  }
  function drawGrenades(now) {
    const sx = scrollX, sy = scrollY;
    for (const g of grenades) {
      const x = g.x - sx, y = g.y - sy - 5.5, left = 1 - (now - g.born) / GRENADE_FUSE;
      ctx.save(); ctx.translate(x, y); ctx.rotate(g.spin);
      ctx.fillStyle = '#2f3b22'; ctx.strokeStyle = LINE; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.arc(0, 0, 5.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = S.color; ctx.fillRect(-5.5, -1.3, 11, 2.6);       // faixa na cor do jogador
      ctx.restore();
      // pavio pisca cada vez mais rápido
      if (Math.floor((now - g.born) / Math.max(50, 220 * left)) % 2) {
        ctx.fillStyle = '#ff5a1f';
        ctx.beginPath(); ctx.arc(x + 2, y - 7, 2.6, 0, Math.PI * 2); ctx.fill();
      }
    }
  }

  // explosão: quebra as letras num círculo em volta de (cx, cy)
  function breakCircle(cx, cy, R = SLAM_R) {
    const now = performance.now();
    slams.push({ x: cx, y: cy, born: now, r: R });
    buzz(25);
    const ix = index, R2 = R * R;
    stamp++;
    for (let gx = Math.floor((cx - R) / CELL); gx <= Math.floor((cx + R) / CELL); gx++) {
      for (let gy = Math.floor((cy - R) / CELL); gy <= Math.floor((cy + R) / CELL); gy++) {
        const list = ix.grid.get(cellKey(gx, gy));
        if (!list) continue;
        for (const id of list) {
          if (id >= OBJ || chunkStamp[id] === stamp) continue;
          chunkStamp[id] = stamp;
          const r = ix.rects;
          if (!circleHitsRect(cx, cy, R, r[id * 4], r[id * 4 + 1], r[id * 4 + 2], r[id * 4 + 3])) continue;
          const node = ix.nodes[id];
          if (!node.isConnected || !S.eatWords || !hasHighlight) continue;
          const d = wordsOf(node);
          if (!d.left || !d.rects) continue;
          for (let w = 0; w < d.starts.length; w++) {
            const wr = d.rects;
            if (!d.wl[w] || !wr[w * 4 + 2] || !circleHitsRect(cx, cy, R, wr[w * 4], wr[w * 4 + 1], wr[w * 4 + 2], wr[w * 4 + 3])) continue;
            const L = lettersOf(node, d, w), lr = L.rects;
            let changed = false;
            for (let k = 0; k < L.offs.length; k++) {
              const o = L.offs[k];
              if (d.ate[o] || !lr[k * 4 + 2]) continue;
              const lx = lr[k * 4] + lr[k * 4 + 2] / 2, ly = lr[k * 4 + 1] + lr[k * 4 + 3] / 2;
              if ((lx - cx) ** 2 + (ly - cy) ** 2 > R2) continue;
              eatLetter(node, d, w, o, L.lens[k], lx - scrollX, ly - scrollY);
              J.broke++;
              changed = true;
            }
            if (changed) wordChanged(node, d, w, 'comeu', true);
          }
        }
      }
    }
    // a onda também machuca os inimigos perto
    for (let i = enemies.length - 1; i >= 0; i--) {
      const e = enemies[i];
      if (circleHitsRect(cx, cy, R, e.x, e.y, e.w, e.h)) damageEnemy(e, i, now);
    }
  }

  // tiro / onda acertou um inimigo
  function damageEnemy(e, i, now) {
    if (now < (e.hurtUntil || 0)) return false;
    if (e.hp > 1) {
      e.hp--; e.hurtUntil = now + 250;
      floaters.push({ text: `${e.hp}/${e.maxHp}`, x: e.x + e.w / 2, y: e.y - 6, life: 0.7, good: true });
      return false;
    }
    enemies.splice(i, 1);
    enemiesEaten++; J.kills++;
    enemyGone(e);
    netEvent({ k: 'ed', id: e.id });
    spawnBurst(e);
    floaters.push({ text: `+${ENEMY_BONUS}`, x: e.x + e.w / 2, y: e.y, life: 1, good: true });
    return true;
  }

  // =====================================================================
  // ARMAS: o bicho e o saltador atiram SOZINHOS no alvo mais perto.
  // Prioridade: outros jogadores (dentro do alcance); se não tiver nenhum,
  // as palavras inimigas. A arma equipada vem do inventário (loja no menu);
  // todo mundo começa com a pistola.
  // Rede: quem atira avisa a sala só a direção dos tiros (em lote a cada
  // 250 ms) para os outros verem; quem acerta um jogador manda {k:'ph'}.
  // =====================================================================
  const WEAPONS = {
    pistola:      { nome: 'Pistola',      icon: '🔫', cad: 450,  spd: 11, n: 1, spread: 0,    range: 620, cor: '#ffd23f' },
    metralhadora: { nome: 'Metralhadora', icon: '💨', cad: 140,  spd: 12, n: 1, spread: 0.12, range: 540, cor: '#ffb020' },
    espingarda:   { nome: 'Espingarda',   icon: '💥', cad: 900,  spd: 10, n: 5, spread: 0.55, range: 340, cor: '#ff7a3d', life: 620 },
    laser:        { nome: 'Laser',        icon: '🔆', cad: 650,  spd: 22, n: 1, spread: 0,    range: 820, cor: '#ff3dd6', pierce: true },
    bazuca:       { nome: 'Bazuca',       icon: '🚀', cad: 1400, spd: 7.5, n: 1, spread: 0,   range: 680, cor: '#9be15d', boom: 55 },
  };
  let weaponId = 'pistola';
  const weapon = () => WEAPONS[weaponId] || WEAPONS.pistola;
  chrome.storage.local.get('pgWeapon', (r) => { if (r && WEAPONS[r.pgWeapon]) weaponId = r.pgWeapon; });
  chrome.storage.onChanged.addListener((c, area) => {
    if (area === 'local' && c.pgWeapon && WEAPONS[c.pgWeapon.newValue]) weaponId = c.pgWeapon.newValue;
  });

  let lastAuto = 0;
  const shotBuf = [];                 // direções dos meus tiros, para a sala
  let shotFlushAt = 0;

  // de onde sai o tiro: centro do saltador ou cabeça do bicho (coordenadas da página)
  const gunPos = () => (isJumper() ? { x: J.x, y: J.y - JH / 2 } : { x: segs[0].x + scrollX, y: segs[0].y + scrollY });

  // alvo: jogador mais perto no alcance; se não tiver, inimigo mais perto
  function pickTarget(ox, oy, range) {
    let best = null, bd = range;
    for (const [id, p] of peers) {
      if (p.iv) continue;                                          // piscando (acabou de levar dano)
      const h = p.segs[0], d = Math.hypot(h.x - ox, h.y - oy);
      if (d < bd) { bd = d; best = { x: h.x, y: h.y, peer: id }; }
    }
    if (best) return best;
    bd = range;
    for (const e of enemies) {
      const cx = e.x + e.w / 2, cy = e.y + e.h / 2, d = Math.hypot(cx - ox, cy - oy);
      if (d < bd) { bd = d; best = { x: cx, y: cy }; }
    }
    return best;
  }

  function spawnShots(ox, oy, ang, wid, mine, bot) {
    const W = WEAPONS[wid] || WEAPONS.pistola;
    const now = performance.now();
    for (let k = 0; k < W.n; k++) {
      const a = ang + (W.n > 1 ? (k / (W.n - 1) - 0.5) * W.spread : (Math.random() - 0.5) * W.spread);
      shots.push({ x: ox + Math.cos(a) * 14, y: oy + Math.sin(a) * 14, vx: Math.cos(a) * W.spd, vy: Math.sin(a) * W.spd,
                   born: now, w: wid, mine, bot, life: W.life || (W.range / W.spd) * 16.7 + 150, hit: W.pierce ? new Set() : null });
    }
  }

  function autoFire(now) {
    const W = weapon();
    if (now - lastAuto < W.cad) return;
    const o = gunPos();
    const tg = pickTarget(o.x, o.y, W.range);
    if (!tg) return;
    lastAuto = now;
    const ang = Math.atan2(tg.y - o.y, tg.x - o.x);
    if (isJumper()) J.aim = ang;                                   // o canhão vira para o alvo
    spawnShots(o.x, o.y, ang, weaponId, true);
    if (netState === 'online') shotBuf.push(+ang.toFixed(2));
  }
  function flushShots(now) {
    if (!shotBuf.length || now < shotFlushAt) return;
    shotFlushAt = now + 250;
    netEvent({ k: 'pw', id: myId, w: weaponId, a: shotBuf.splice(0, 12) });
  }

  // o tiro (meu) acertou um jogador? (cada um confere o próprio tiro)
  function shotTouchesPeer(s, p) {
    if (p.kind === 'j') {
      const h = p.segs[0];
      return Math.abs(s.x - h.x) < JW / 2 + 3 && Math.abs(s.y - h.y) < JH / 2 + 3;
    }
    const pr = 4.5 * p.scale * 1.5;
    for (let i = 0; i < p.segs.length; i++) {
      const g = p.segs[i];
      if (Math.abs(s.x - g.x) < pr && Math.abs(s.y - g.y) < pr) return true;
    }
    return false;
  }
  function shotHitsPeer(s) {
    for (const [id, p] of peers) {
      if (p.iv || (s.hit && s.hit.has(id))) continue;
      if (shotTouchesPeer(s, p)) return id;
    }
    return null;
  }

  function updateShots(now) {
    const sx = scrollX, sy = scrollY;
    const W = document.documentElement.clientWidth || innerWidth;
    const H = document.documentElement.clientHeight || innerHeight;
    for (let i = shots.length - 1; i >= 0; i--) {
      const s = shots[i];
      s.x += s.vx; s.y += s.vy;
      const Wp = WEAPONS[s.w] || WEAPONS.pistola;
      const out = now - s.born > (s.life || 1200) || s.x < sx - 40 || s.x > sx + W + 40 || s.y < sy - 40 || s.y > sy + H + 40;
      if (out) {
        if (s.mine && Wp.boom && now - s.born > (s.life || 1200)) breakCircle(s.x, s.y, Wp.boom);   // bazuca explode no fim
        shots.splice(i, 1); continue;
      }
      if (s.bot) {                                                  // tiro de um bot meu
        if (botShotHits(s, now)) shots.splice(i, 1);
        continue;
      }
      if (!s.mine) continue;                                        // tiro dos outros: só aparece
      let done = false;
      // jogadores primeiro
      const pid = shotHitsPeer(s);
      if (pid) {
        peerShot(pid, s.w, now);
        floaters.push({ text: '✦', x: s.x, y: s.y, life: 0.5, good: true });
        const pp = peers.get(pid); if (pp) pp.iv = true;             // pisca até a próxima posição chegar
        if (s.hit) s.hit.add(pid); else done = true;
      }
      if (!done) {
        for (let k = enemies.length - 1; k >= 0; k--) {
          const e = enemies[k];
          if (s.hit && s.hit.has(e.id)) continue;
          if (s.x > e.x - 6 && s.x < e.x + e.w + 6 && s.y > e.y - 6 && s.y < e.y + e.h + 6) {
            damageEnemy(e, k, now);
            floaters.push({ text: '✦', x: s.x, y: s.y, life: 0.4, good: true });
            if (s.hit) s.hit.add(e.id); else { done = true; break; }
          }
        }
      }
      if (done) {
        if (Wp.boom) breakCircle(s.x, s.y, Wp.boom);
        shots.splice(i, 1);
      }
    }
  }

  // desenha um saltador. c = { x, y (centro na tela), color, face, aim, squash, name, alpha, t, moving, onGround }
  function drawJumper(c) {
    const A = c.alpha == null ? 1 : c.alpha;
    ctx.save();
    ctx.globalAlpha = A;
    ctx.translate(c.x, c.y);
    const sq = c.squash || 0;
    const w = JW * (1 + sq), h = JH * (1 - sq);
    ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.strokeStyle = LINE; ctx.lineWidth = 1.6;
    // pernas
    const step = c.moving && c.onGround ? Math.sin(c.t * 0.45) * 4 : 0;
    ctx.beginPath();
    ctx.moveTo(-5, h / 2 - 3); ctx.lineTo(-5 + step, h / 2 + 3);
    ctx.moveTo(5, h / 2 - 3); ctx.lineTo(5 - step, h / 2 + 3);
    ctx.stroke();
    // corpo
    ctx.fillStyle = c.color;
    ctx.beginPath(); ctx.roundRect(-w / 2, -h / 2, w, h, 9); ctx.fill(); ctx.stroke();
    // canhão (aponta para o mouse)
    if (c.aim != null) {
      ctx.save(); ctx.rotate(c.aim);
      ctx.fillStyle = LINE; ctx.beginPath(); ctx.roundRect(4, -3, 15, 6, 3); ctx.fill();
      ctx.restore();
    }
    // olhos
    const look = c.aim != null ? c.aim : (c.face > 0 ? 0 : Math.PI);
    for (const side of [-1, 1]) {
      const ex = side * 5 + c.face * 2, ey = -h / 2 + 9;
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(ex, ey, 3.8, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = LINE; ctx.beginPath(); ctx.arc(ex + Math.cos(look) * 1.5, ey + Math.sin(look) * 1.5, 1.8, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
    if (c.name) {
      ctx.save();
      ctx.font = '600 11px system-ui, sans-serif';
      const tw = ctx.measureText(c.name).width + 12;
      const nx = c.x - tw / 2, ny = c.y - JH / 2 - 26;
      ctx.fillStyle = c.color; ctx.strokeStyle = LINE; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.roundRect(nx, ny, tw, 17, 8.5); ctx.fill(); ctx.stroke();
      ctx.fillStyle = LINE; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(c.name, c.x, ny + 9);
      ctx.restore();
    }
  }

  function drawShotsAndSlams(now) {
    const sx = scrollX, sy = scrollY;
    drawGrenades(now);
    drawBotGrenades(now);
    ctx.save();
    for (const s of shots) {
      const Wp = WEAPONS[s.w] || WEAPONS.pistola;
      const len = s.w === 'laser' ? 2.2 : 1.2;
      ctx.strokeStyle = Wp.cor; ctx.lineWidth = s.w === 'bazuca' ? 7 : 4; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(s.x - s.vx * len - sx, s.y - s.vy * len - sy); ctx.lineTo(s.x - sx, s.y - sy); ctx.stroke();
      ctx.strokeStyle = LINE; ctx.lineWidth = 1;
      ctx.stroke();
    }
    for (let i = slams.length - 1; i >= 0; i--) {
      const s = slams[i], k = (now - s.born) / 400;
      if (k >= 1) { slams.splice(i, 1); continue; }
      ctx.globalAlpha = 1 - k;
      ctx.strokeStyle = S.color; ctx.lineWidth = 6 * (1 - k) + 1;
      ctx.fillStyle = 'rgba(255,140,40,' + (0.35 * (1 - k)) + ')';                      // clarão da explosão
      const sr = s.r || SLAM_R;
      ctx.beginPath(); ctx.arc(s.x - sx, s.y - sy, 10 + k * sr * 0.9, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(s.x - sx, s.y - sy, 18 + k * sr, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = LINE; ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.restore();
  }

  // teclado e mouse do saltador (só enquanto o jogo roda com ele)
  const JKEY = { KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right',
                 KeyW: 'up', ArrowUp: 'up', KeyS: 'down', ArrowDown: 'down' };
  addEventListener('keydown', (e) => {
    if (!running || !isJumper() || isEditable(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (JKEY[e.code]) {
      const k = JKEY[e.code];
      jkeys.add(k);
      if (k === 'up') J.jumpBuf = performance.now() + 150;
      if (k === 'down') J.dropBuf = performance.now() + 150;
      e.preventDefault(); e.stopPropagation();
    }
    else if (e.code === 'Space') { if (!e.repeat) throwGrenade(); e.preventDefault(); e.stopPropagation(); }
    else if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') { if (!e.repeat) dash(); e.preventDefault(); e.stopPropagation(); }
  }, { capture: true });
  addEventListener('keyup', (e) => { if (JKEY[e.code]) jkeys.delete(JKEY[e.code]); }, { capture: true });
  addEventListener('blur', () => { jkeys.clear(); J.shooting = false; });
  // clicar atira (e não abre links nem seleciona texto da página)
  addEventListener('mousedown', (e) => {
    if (!running || !isJumper() || e.button !== 0 || isUI(e.target)) return;
    J.shooting = true; e.preventDefault(); e.stopPropagation();
  }, { capture: true });
  addEventListener('mouseup', (e) => { if (e.button === 0) J.shooting = false; }, { capture: true });
  addEventListener('click', (e) => {
    if (running && isJumper() && !isUI(e.target)) { e.preventDefault(); e.stopPropagation(); }
  }, { capture: true });

  // =====================================================================
  // DASH DO BICHO (Shift / ⚡): arrancada rápida na direção do mouse (ou do
  // dedo), comendo tudo pelo caminho. Recarrega em 1,2 s.
  // =====================================================================
  const WD = { until: 0, last: 0, trail: [] };
  function wormDash() {
    const now = performance.now();
    if (now - WD.last < 1200) return;
    WD.last = now; WD.until = now + 260;
    resting = false;
    buzz(12);
    floaters.push({ text: '»', x: segs[0].x + scrollX, y: segs[0].y + scrollY - 16, life: 0.5, good: true });
  }
  addEventListener('keydown', (e) => {
    if (!running || isJumper() || e.repeat || isEditable(e.target)) return;
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') { wormDash(); e.preventDefault(); }
  }, { capture: true });

  // volante do bicho no celular: ◀ ▶ seguram a curva
  const steerKeys = new Set();
  const STEER_TURN = 0.075;                                         // rad por quadro (~4,5 rad/s)

  // movimento do bicho (personagem padrão)
  function updateWorm() {
    const head = segs[0];
    const W = document.documentElement.clientWidth || innerWidth;     // sem a barra de rolagem
    const H = document.documentElement.clientHeight || innerHeight;
    const R = mouthR();
    const tx = clamp(mouse.x, R, W - R), ty = clamp(mouse.y, R, H - R);
    const dx = tx - head.x, dy = ty - head.y;
    const dist = Math.hypot(dx, dy);

    // Chegou no mouse: para e mantém a cabeça para a frente (antes ela
    // ficava dando voltas em cima do cursor). Só volta a andar quando o
    // mouse se afasta um pouco.
    const stopR = Math.max(10, R * 0.9);
    if (resting) { if (dist > stopR * 2) resting = false; }
    else if (dist < stopR) resting = true;

    const slowK = performance.now() < slowUntil ? 0.45 : 1;        // gelo
    const maxSpeed = 3.4 * S.speed * (0.8 + scale() * 0.3) * slowK;
    const steer = isTouch();                                        // celular: sempre anda para a frente, ◀ ▶ viram
    let wanted = 0;
    if (steer) {
      resting = false;
      heading = norm(heading + STEER_TURN * ((steerKeys.has('right') ? 1 : 0) - (steerKeys.has('left') ? 1 : 0)));
      wanted = maxSpeed;
    } else if (!resting) {
      const diff = norm(Math.atan2(dy, dx) - heading);
      const turn = 0.14 + 0.12 * clamp(1 - dist / 150, 0, 1);       // vira mais rápido perto do alvo
      heading = norm(heading + clamp(diff, -turn, turn));
      // virado para o lado errado: freia e vira, em vez de dar a volta no mouse
      const align = Math.max(0, Math.cos(diff));
      wanted = Math.min(maxSpeed, dist * 0.09) * (dist < 120 ? align : Math.max(0.35, align));
    }
    speedNow += (wanted - speedNow) * 0.15;
    if (performance.now() < WD.until) {                             // dash: vira direto para o alvo e dispara
      if (dist > 4 && !steer) heading = Math.atan2(dy, dx);    // no volante o dash vai para a frente
      speedNow = Math.max(speedNow, 3.4 * S.speed * 3.4);
      WD.trail.push({ x: head.x + scrollX, y: head.y + scrollY, born: performance.now() });
    }
    const wiggle = Math.sin(t * 0.25) * 0.05 * (speedNow / (maxSpeed || 1));
    head.x += Math.cos(heading + wiggle) * speedNow + pushVX;
    head.y += Math.sin(heading + wiggle) * speedNow + pushVY;
    pushVX *= 0.88; pushVY *= 0.88;                                  // rajada da ventania perde força

    // paredes laterais (no volante ele bate e volta, para não ficar preso andando contra a parede)
    if (head.x < R) { head.x = R; if (Math.cos(heading) < 0) { bump(head, false); if (steer) heading = norm(Math.PI - heading); } }
    else if (head.x > W - R) { head.x = W - R; if (Math.cos(heading) > 0) { bump(head, false); if (steer) heading = norm(Math.PI - heading); } }
    edgeScroll(head, H, steer);
    // topo e fundo (quando a página não rola mais)
    if (head.y < R) { head.y = R; if (Math.sin(heading) < 0) { bump(head, true); if (steer) heading = norm(-heading); } }
    else if (head.y > H - R) { head.y = H - R; if (Math.sin(heading) > 0) { bump(head, true); if (steer) heading = norm(-heading); } }

    const gap = 7 * scale();
    for (let i = 1; i < segs.length; i++) {
      const a = segs[i - 1], b = segs[i];
      const ex = b.x - a.x, ey = b.y - a.y;
      const d = Math.hypot(ex, ey) || 1;
      if (d > gap) { b.x = a.x + (ex / d) * gap; b.y = a.y + (ey / d) * gap; }
    }

  }

  function update() {
    t++;
    if (isJumper()) updateJumper(); else updateWorm();
    const now = performance.now();
    const JP = isJumper();
    if (!JP) eatCheck();                    // o saltador não come encostando: ele quebra (Espaço) e atira
    updateEnemies(now);
    autoFire(now);
    updateShots(now);
    flushShots(now);
    updateBots(now);
    if (JP) updateGrenades(now);
    looseCheck(now);
    if (!JP) pvpCheck(now);
    respawnTick(now);
    if (!JP) fillEatCheck();
    fillTick(now);
    flushEat(now);
    mouthOpen = Math.max(0, mouthOpen - 0.08);
    const head = segs[0];
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.x += (head.x - p.x) * 0.25;
      p.y += (head.y - p.y) * 0.25;
      p.life -= 0.06;
      if (p.life <= 0) particles.splice(i, 1);
    }
  }

  // =====================================================================
  // BOTS: jogadores de mentira que completam a sala.
  // - Sozinho você joga com alguns bots; cada jogador de verdade que entra
  //   tira um bot. Quantos bots e quão fortes eles são depende da
  //   dificuldade da sala (Fácil / Normal / Difícil).
  // - 5 tipos (BOT_TYPES): 3 minhocas (Comilão, Caçador, Pistoleiro) e 2
  //   saltadores (Pulador, Granadeiro). A sala sorteia tipos diferentes.
  // - Eles comem/quebram letras, atiram em você, as minhocas dão trombada
  //   (e levam: as palavras do corpo caem para você comer) e todos entram
  //   no placar.
  // - Rede: só o anfitrião (menor id) mexe os bots. Ele manda a posição de
  //   todos num único evento {k:'bots'} a cada 250 ms; os outros desenham
  //   como se fossem jogadores. Tiro ou trombada num bot vai para o
  //   anfitrião com o id do bot ('bot:...'), igual a um jogador.
  //   Se o anfitrião sai, o próximo assume os bots que já estavam na sala.
  // =====================================================================
  // Força pela dificuldade da sala:
  //   fill  = jogadores na sala contando os bots (você + bots)
  //   spd   = velocidade (1 = a do seu bicho)      turn = quanto vira por quadro
  //   aim   = erro da mira (rad)                   cad  = multiplica o intervalo entre tiros
  //   range = multiplica o alcance da arma
  //   lead  = quanto prevê para onde você vai      hunt = chance de te caçar em vez de comer
  //   react = de quanto em quanto tempo decide (ms) dash = intervalo do dash na caça (0 = sem)
  //   look  = raio em que procura comida (px)      guns = armas que podem sortear
  const BOT_CFG = {
    facil:   { fill: 3, spd: 0.70, turn: 0.07, aim: 0.55, cad: 4.2,  range: 0.45, lead: 0,   hunt: 0.10, react: [1100, 1900], dash: 0,    look: 380, guns: ['pistola'] },
    normal:  { fill: 4, spd: 0.90, turn: 0.10, aim: 0.22, cad: 2.0,  range: 0.75, lead: 0.5, hunt: 0.30, react: [650, 1200],  dash: 2600, look: 520, guns: ['pistola'] },
    dificil: { fill: 5, spd: 1.10, turn: 0.14, aim: 0.06, cad: 1.0,  range: 1,    lead: 1,   hunt: 0.60, react: [300, 700],   dash: 1600, look: 680, guns: ['pistola', 'metralhadora', 'espingarda', 'laser'] },
  };
  // Os 5 tipos. Os números multiplicam os da dificuldade (1 = igual).
  //   kind  = 'w' minhoca / 'j' saltador          hunt = chance de caçar (0 = nunca)
  //   eat   = quanto cresce por letra              keep = distância que tenta manter de você (px)
  //   hop   = chance de pular à toa (por quadro)  stomp = raio que quebra letras ao cair (px)
  //   gren  = intervalo entre granadas (ms)        guns = armas por dificuldade (senão as da dificuldade)
  const BOT_TYPES = {
    comilao:    { nome: 'Comilão',    kind: 'w', spd: 1.0,  hunt: 0.3, cad: 1.6, aim: 1.2, range: 0.9, eat: 1.6 },
    cacador:    { nome: 'Caçador',    kind: 'w', spd: 1.12, hunt: 2.2, cad: 1.3, aim: 1.0, range: 0.9, eat: 1.0, dash: 0.6 },
    pistoleiro: { nome: 'Pistoleiro', kind: 'w', spd: 0.95, hunt: 0,   cad: 0.85, aim: 0.7, range: 1.2, eat: 0.8, keep: 300,
                  guns: { facil: ['pistola'], normal: ['pistola', 'laser'], dificil: ['laser'] } },
    pulador:    { nome: 'Pulador',    kind: 'j', spd: 1.05, hunt: 0,   cad: 1.2, aim: 1.0, range: 0.9, hop: 0.035, stomp: 42 },
    granadeiro: { nome: 'Granadeiro', kind: 'j', spd: 0.9,  hunt: 0,   cad: 2.2, aim: 1.0, range: 0.8, hop: 0.01, keep: 260, gren: 2600,
                  guns: { facil: ['pistola'], normal: ['pistola'], dificil: ['pistola', 'espingarda'] } },
  };
  const BOT_TYPE_IDS = Object.keys(BOT_TYPES);
  const BOT_COLORS = ['#ff9f43', '#54a0ff', '#a29bfe', '#1dd1a1', '#ff6b81', '#feca57', '#f368e0', '#48dbfb'];
  const BOT_MAX_SEG = 60;
  const BOT_GRAVITY = 0.42;
  const bots = [];                   // os bots que EU controlo (também estão em peers)
  const botGrenades = [];            // granadas dos Granadeiros (coordenadas da página)
  let botSeq = 0, nextBotAt = 0, botSentAt = 0, botsWereSent = false;
  const isBot = (id) => typeof id === 'string' && id.startsWith('bot:');
  const botCfg = () => BOT_CFG[roomDifficulty()] || BOT_CFG.normal;
  const botType = (b) => BOT_TYPES[b.btype] || BOT_TYPES.comilao;
  const botCount = () => { let n = 0; for (const p of peers.values()) if (p.bot) n++; return n; };

  // quantos bots a sala precisa agora
  function botsWanted() {
    if (!S.bots) return 0;
    const fill = botCfg().fill - (lite ? 1 : 0);                       // celular: um bot a menos
    const humansHere = 1 + (netState === 'online' ? peerCount : 0);
    return Math.max(0, fill - humansHere);
  }

  // jogadores de verdade (eu + os outros), em coordenadas da página
  function humans() {
    const out = [];
    const ivMe = performance.now() < Math.max(shieldUntil, invulnerableUntil);
    if (isJumper()) {
      out.push({ id: 'me', me: true, j: true, x: J.x, y: J.y - JH / 2, n: 1, h: Math.atan2(J.vy, J.vx), v: Math.hypot(J.vx, J.vy), iv: ivMe });
    } else {
      out.push({ id: 'me', me: true, j: false, x: segs[0].x + scrollX, y: segs[0].y + scrollY, n: segs.length, h: heading, v: speedNow, iv: ivMe });
    }
    for (const [id, p] of peers) {
      if (p.bot) continue;
      out.push({ id, p, j: p.kind === 'j', x: p.segs[0].x, y: p.segs[0].y, n: p.n, h: p.heading, v: p.speed, iv: !!p.iv });
    }
    return out;
  }
  // corpo de um jogador (coordenadas da página)
  const bodyOf = (u) => (u.me ? segs.map((s) => ({ x: s.x + scrollX, y: s.y + scrollY })) : u.p.segs);
  const scaleOf = (u) => (u.me ? scale() : u.p.scale);

  function pickGun(type) {
    const list = (type.guns && type.guns[roomDifficulty()]) || botCfg().guns;
    return list[Math.floor(Math.random() * list.length)];
  }
  function newBotAi(now, b) {
    const T = botType(b);
    return {
      food: b.kind === 'w' ? Math.max(0, (b.n - 4) * 2) : 0,
      words: b.pts || 0, loot: 0, hits: 0,
      mode: 'eat', goal: null, thinkAt: 0, shotAt: now + 2000, dashAt: 0, dashUntil: 0,
      shield: 0, hurt: 0, sh: [], gr: [], hitCd: new Map(), carry: null,
      gun: pickGun(T), grenAt: now + 3000,
      vx: 0, vy: 0, onGround: false, dropUntil: 0, squash: 0, goalX: 0, goalY: 0,
    };
  }

  // a sala sorteia o tipo que tem menos bots (para ter variedade)
  function chooseBotType() {
    const count = {};
    for (const t of BOT_TYPE_IDS) count[t] = 0;
    for (const p of peers.values()) if (p.bot && count[p.btype] != null) count[p.btype]++;
    const min = Math.min(...Object.values(count));
    const free = BOT_TYPE_IDS.filter((t) => count[t] === min);
    return free[Math.floor(Math.random() * free.length)];
  }

  function spawnBot(now) {
    const H = humans();
    const near = H[Math.floor(Math.random() * H.length)];
    const btype = chooseBotType(), T = BOT_TYPES[btype];
    const side = Math.random() < 0.5 ? -1 : 1;
    const x = clamp(near.x + side * rand(220, 420), 30, docW() - 30);
    // minhoca entra pelo lado; saltador cai de cima
    const y = T.kind === 'j' ? Math.max(JH, near.y - rand(220, 320)) : clamp(near.y + rand(-220, 220), 30, docH() - 30);
    const used = new Set(), usedColors = new Set([S.color]);
    for (const p of peers.values()) { used.add(p.name); usedColors.add(p.color); }
    let name = '🤖 ' + T.nome;
    for (let k = 2; used.has(name); k++) name = '🤖 ' + T.nome + ' ' + k;
    const color = BOT_COLORS.find((c) => !usedColors.has(c)) || BOT_COLORS[botSeq % BOT_COLORS.length];
    const id = 'bot:' + String(myId || 'local').slice(0, 6) + '-' + (++botSeq);
    const b = {
      id, bot: true, local: true, btype, kind: T.kind, name, color,
      segs: [{ x, y }], heading: side > 0 ? Math.PI : 0, scale: 1, mouthOpen: 0, speed: 0, t: 0,
      labels: [], n: T.kind === 'j' ? 1 : 4, pts: 0, iv: false, seen: now, target: { x, y }, targetHeading: 0,
      face: -side, onGround: false, squash: 0,
    };
    if (T.kind === 'w') while (b.segs.length < 4) b.segs.push({ x, y });
    b.ai = newBotAi(now, b);
    bots.push(b);
    peers.set(id, b);
    floaters.push({ text: name + ' entrou', x, y: y - 24, life: 1, good: false });
  }

  // virei anfitrião: os bots que o anterior mexia passam a ser meus
  function adoptBot(id, p, now) {
    p.id = id;
    p.local = true;
    if (!BOT_TYPES[p.btype]) p.btype = p.kind === 'j' ? 'pulador' : 'comilao';
    p.labels = Array.isArray(p.labels) ? p.labels : [];
    p.ai = newBotAi(now, p);
    bots.push(p);
  }

  function removeBot(b) {
    const i = bots.indexOf(b);
    if (i >= 0) bots.splice(i, 1);
    peers.delete(b.id);
  }

  function updateBots(now) {
    updateBotGrenades(now);
    if (netState === 'connecting') return;                            // ainda não sabe se é o anfitrião
    if (!isHost()) {                                                   // outro mexe os bots
      if (bots.length) { for (const b of bots.splice(0)) peers.delete(b.id); }
      return;
    }
    for (const [id, p] of peers) if (p.bot && !p.local) adoptBot(id, p, now);
    const want = botsWanted();
    while (bots.length > want) {                                       // entrou gente: sai um bot
      const b = bots[bots.length - 1];
      floaters.push({ text: b.name + ' saiu', x: b.segs[0].x, y: b.segs[0].y - 24, life: 1, good: true });
      removeBot(b);
    }
    const settled = netState !== 'online' || now - onlineSince > 2500;  // espera o Presence dizer quem está na sala
    if (bots.length < want && !scan && settled && now >= nextBotAt) {
      spawnBot(now);
      nextBotAt = now + 1500;
    }
    if (bots.length) {
      const H = humans();
      for (const b of bots) tickBot(b, H, now);
    }
    botBroadcast(now);
  }

  // escolhe um lugar com letras perto do jogador (para o bot ficar à vista)
  function findFood(b, tg) {
    const C = botCfg(), h = b.segs[0];
    const cx = tg ? h.x + (tg.x - h.x) * 0.4 : h.x, cy = tg ? h.y + (tg.y - h.y) * 0.4 : h.y;
    const ix = index, r = ix.rects;
    let checks = 0;
    for (let k = 0; k < 10 && checks < 3; k++) {
      const px = cx + rand(-C.look, C.look), py = cy + rand(-C.look * 0.7, C.look * 0.7);
      const list = ix.grid.get(cellKey(Math.floor(px / CELL), Math.floor(py / CELL)));
      if (!list) continue;
      const id = list[Math.floor(Math.random() * list.length)];
      if (id >= OBJ) continue;
      const node = ix.nodes[id];
      if (!node || !node.isConnected) continue;
      checks++;
      if (wordsOf(node).left === 0) continue;
      return { x: r[id * 4] + rand(0, r[id * 4 + 2]), y: r[id * 4 + 1] + r[id * 4 + 3] * rand(0.2, 0.8) };
    }
    const base = tg || h;
    return { x: clamp(base.x + rand(-300, 300), 20, docW() - 20), y: clamp(base.y + rand(-200, 200), 20, docH() - 20) };
  }

  function tickBot(b, H, now) {
    const A = b.ai, h = b.segs[0];
    b.t++;
    // jogador de verdade mais perto
    let tg = null, td = Infinity;
    for (const u of H) { const d = Math.hypot(u.x - h.x, u.y - h.y); if (d < td) { td = d; tg = u; } }
    if (b.kind === 'j') tickJumperBot(b, now, tg, td);
    else tickWormBot(b, now, tg, td);
    b.iv = now < Math.max(A.shield, A.hurt);
    botLoose(b, h.x, h.y, b.kind === 'j' ? 18 : 8 + 6 * b.scale, now);
    botShoot(b, H, now);
    if (b.kind === 'w') botRam(b, H, now);
    else if (botType(b).gren) botGrenade(b, tg, td, now);
    b.pts = Math.max(0, A.words + A.loot - A.hits * HIT_PENALTY);
  }

  // ---------- minhocas: Comilão, Caçador, Atirador ----------
  function tickWormBot(b, now, tg, td) {
    const A = b.ai, C = botCfg(), T = botType(b), h = b.segs[0];
    b.scale = 1 + Math.min(A.food, 400) / 120;
    const R = 8 + 6 * b.scale;

    if (tg && td > 900 && A.mode !== 'back') {                       // longe de todo mundo: volta
      A.mode = 'back';
      A.goal = { x: tg.x + rand(-200, 200), y: tg.y + rand(-150, 150) };
    } else if (now >= A.thinkAt || !A.goal || (A.mode === 'back' && td < 450)) {
      A.thinkAt = now + rand(C.react[0], C.react[1]);
      const big = tg && (b.segs.length >= tg.n * 0.7 || roomDifficulty() === 'dificil' || b.btype === 'cacador');
      const huntP = Math.min(0.95, C.hunt * T.hunt);
      if (tg && !tg.j && !tg.iv && td < C.look * 1.4 && big && Math.random() < huntP) A.mode = 'hunt';
      else if (T.keep && tg && td < T.keep * 1.6) {
        // Pistoleiro: fica a uma distância boa para atirar, de lado
        A.mode = 'keep';
        const a = Math.atan2(h.y - tg.y, h.x - tg.x) + rand(-0.8, 0.8);
        A.goal = { x: clamp(tg.x + Math.cos(a) * T.keep, 20, docW() - 20), y: clamp(tg.y + Math.sin(a) * T.keep, 20, docH() - 20) };
      } else { A.mode = 'eat'; A.goal = findFood(b, tg); }
    }

    // para onde vai
    let gx, gy;
    if (A.mode === 'hunt' && tg) {
      // mira no meio do corpo (trombada) e prevê para onde o jogador vai
      const body = bodyOf(tg), mid = body[Math.min(body.length - 1, Math.max(1, Math.floor(body.length / 2)))] || tg;
      gx = mid.x + Math.cos(tg.h) * tg.v * 14 * C.lead;
      gy = mid.y + Math.sin(tg.h) * tg.v * 14 * C.lead;
    } else { gx = A.goal.x; gy = A.goal.y; }
    const dx = gx - h.x, dy = gy - h.y, dist = Math.hypot(dx, dy);
    const turn = C.turn * (A.mode === 'hunt' ? 1.25 : 1);
    b.heading = norm(b.heading + clamp(norm(Math.atan2(dy, dx) - b.heading), -turn, turn));
    let sp = 3.4 * C.spd * T.spd * (0.8 + b.scale * 0.3) * Math.min(1, dist / 60 + 0.35);
    if (C.dash && A.mode === 'hunt' && dist < 200 && now > A.dashAt) { A.dashAt = now + C.dash * (T.dash || 1); A.dashUntil = now + 260; }
    if (now < A.dashUntil) sp = Math.max(sp, 3.4 * 3);
    b.speed += (sp - b.speed) * 0.15;
    h.x = clamp(h.x + Math.cos(b.heading) * b.speed, R, docW() - R);
    h.y = clamp(h.y + Math.sin(b.heading) * b.speed, R, docH() - R);
    if (A.mode !== 'hunt' && dist < 18) A.thinkAt = 0;               // chegou: escolhe outro lugar

    // corpo segue a cabeça
    const target = Math.min(BOT_MAX_SEG, 4 + Math.floor(A.food / 2));
    while (b.segs.length < target) b.segs.push({ ...b.segs[b.segs.length - 1] });
    const gap = 7 * b.scale;
    for (let i = 1; i < b.segs.length; i++) {
      const a = b.segs[i - 1], c = b.segs[i];
      const ex = c.x - a.x, ey = c.y - a.y, d = Math.hypot(ex, ey) || 1;
      if (d > gap) { c.x = a.x + (ex / d) * gap; c.y = a.y + (ey / d) * gap; }
    }
    b.n = b.segs.length;
    b.mouthOpen = Math.max(0, b.mouthOpen - 0.08);
    botEat(b, h.x, h.y, R);
  }

  // ---------- saltadores: Pulador, Granadeiro ----------
  // Mesma física do seu saltador: gravidade e letras como plataformas de
  // mão única. segs[0] = centro do corpo (os pés ficam JH/2 abaixo).
  function tickJumperBot(b, now, tg, td) {
    const A = b.ai, C = botCfg(), T = botType(b), h = b.segs[0];
    let fy = h.y + JH / 2;                                            // pés
    // longe de todo mundo (ou caiu da página): cai de novo perto de alguém
    if (tg && (td > 1100 || fy > docH() + 200)) {
      h.x = clamp(tg.x + rand(-260, 260), JW, docW() - JW);
      fy = Math.max(JH, tg.y - rand(220, 320)); A.vy = 0; A.vx = 0;
    }
    if (tg && now >= A.thinkAt) {
      A.thinkAt = now + rand(C.react[0], C.react[1]);
      if (T.keep) {                                                   // Granadeiro: fica de lado, a uma distância boa
        const side = Math.sign(h.x - tg.x) || (Math.random() < 0.5 ? -1 : 1);
        A.goalX = tg.x + side * rand(T.keep * 0.7, T.keep * 1.2);
      } else A.goalX = tg.x + rand(-260, 260);                        // Pulador: pula em volta de você
      A.goalX = clamp(A.goalX, JW, docW() - JW);
      A.goalY = tg.y + rand(-120, 60);
    }
    const dx = A.goalX - h.x;
    const want = Math.abs(dx) > 14 ? Math.sign(dx) * 4.2 * C.spd * T.spd : 0;
    A.vx += (want - A.vx) * (A.onGround ? 0.3 : 0.12);
    if (want) b.face = Math.sign(want);
    else if (tg) b.face = Math.sign(tg.x - h.x) || b.face;           // parado: olha para você
    if (A.onGround) {
      const above = A.goalY < fy - 40, below = A.goalY > fy + 90;
      if ((above && Math.random() < 0.08) || Math.random() < (T.hop || 0)) {
        A.vy = -11.5; A.onGround = false; A.squash = -0.25;
      } else if (below && Math.random() < 0.04) { A.dropUntil = now + 260; A.onGround = false; }
    }
    h.x = clamp(h.x + A.vx, JW / 2, docW() - JW / 2);
    const prev = fy;
    A.vy = Math.min(A.vy + 0.55, 14);
    let ny = fy + A.vy, landed = false;
    if (A.vy >= 0 && now > A.dropUntil) {
      const top = platformBetween(h.x - JW / 2 + 4, h.x + JW / 2 - 4, prev - 1, ny + 1);
      if (top !== null) {
        if (!A.onGround && A.vy > 4) A.squash = Math.min(0.35, A.vy / 30);
        if (T.stomp && !A.onGround && A.vy > 6) botBreak(b, h.x, top, T.stomp);   // Pulador: cai quebrando letras
        ny = top; A.vy = 0; landed = true;
      }
    }
    fy = ny; A.onGround = landed;
    if (fy - JH < 0) { fy = JH; A.vy = Math.max(A.vy, 0); }
    A.squash *= 0.8;
    h.y = fy - JH / 2;
    b.speed = Math.abs(A.vx); b.onGround = landed; b.squash = A.squash;
    b.heading = b.face > 0 ? 0 : Math.PI;
    b.n = 1;
  }

  // explosão / pisão de bot: quebra as letras num círculo (os pontos vão para o bot)
  function botBreak(b, cx, cy, R) {
    slams.push({ x: cx, y: cy, born: performance.now(), r: R });
    if (!S.eatWords || !hasHighlight) return;
    const ix = index, R2 = R * R, A = b.ai;
    stamp++;
    for (let gx = Math.floor((cx - R) / CELL); gx <= Math.floor((cx + R) / CELL); gx++) {
      for (let gy = Math.floor((cy - R) / CELL); gy <= Math.floor((cy + R) / CELL); gy++) {
        const list = ix.grid.get(cellKey(gx, gy));
        if (!list) continue;
        for (const id of list) {
          if (id >= OBJ || chunkStamp[id] === stamp) continue;
          chunkStamp[id] = stamp;
          const r = ix.rects;
          if (!circleHitsRect(cx, cy, R, r[id * 4], r[id * 4 + 1], r[id * 4 + 2], r[id * 4 + 3])) continue;
          const node = ix.nodes[id];
          if (!node.isConnected) continue;
          const d = wordsOf(node);
          if (!d.left || !d.rects) continue;
          for (let w = 0; w < d.starts.length; w++) {
            const wr = d.rects;
            if (!d.wl[w] || !wr[w * 4 + 2] || !circleHitsRect(cx, cy, R, wr[w * 4], wr[w * 4 + 1], wr[w * 4 + 2], wr[w * 4 + 3])) continue;
            const L = lettersOf(node, d, w), lr = L.rects;
            let changed = false;
            for (let k = 0; k < L.offs.length; k++) {
              const o = L.offs[k];
              if (d.ate[o] || !lr[k * 4 + 2]) continue;
              const lx = lr[k * 4] + lr[k * 4 + 2] / 2, ly = lr[k * 4 + 1] + lr[k * 4 + 3] / 2;
              if ((lx - cx) ** 2 + (ly - cy) ** 2 > R2) continue;
              hideLetter(node, d, w, o, L.lens[k]);
              shareEat(node, o);
              A.words++;
              changed = true;
            }
            if (changed) wordChanged(node, d, w, 'comeu', false);
          }
        }
      }
    }
  }

  // Granadeiro: joga uma granada em arco que cai em cima de você
  function botGrenade(b, tg, td, now) {
    const A = b.ai, C = botCfg(), T = botType(b);
    if (!tg || tg.iv || now < A.grenAt || td > 480 || td < 60) { if (now >= A.grenAt) A.grenAt = now + 400; return; }
    A.grenAt = now + T.gren * C.cad / 2 * rand(0.85, 1.2);
    const h = b.segs[0];
    const dx = tg.x - h.x, dy = tg.y - h.y;
    const t = clamp(Math.abs(dx) / 6.5, 22, 60);                      // quadros até cair em você
    let vx = dx / t, vy = (dy - 0.5 * BOT_GRAVITY * t * t) / t;
    vx *= 1 + rand(-1, 1) * C.aim;                                    // erra mais no Fácil
    const sp = Math.hypot(vx, vy);
    if (sp > 14) { vx *= 14 / sp; vy *= 14 / sp; }
    vx = +vx.toFixed(2); vy = +vy.toFixed(2);
    botGrenades.push({ x: h.x, y: h.y - 6, vx, vy, born: now, spin: 0, color: b.color, owner: b });
    A.gr.push([vx, vy]);
    A.squash = 0.12;
  }

  // granadas dos bots: as minhas explodem de verdade; as que vieram pela rede só aparecem
  function updateBotGrenades(now) {
    for (let i = botGrenades.length - 1; i >= 0; i--) {
      const g = botGrenades[i];
      if (now - g.born > GRENADE_FUSE) {
        botGrenades.splice(i, 1);
        if (g.owner && g.owner.local && bots.includes(g.owner)) botExplode(g.owner, g.x, g.y - 5, now);
        else slams.push({ x: g.x, y: g.y - 5, born: now, r: SLAM_R * 0.8 });
        continue;
      }
      const prev = g.y;
      g.vy = Math.min(g.vy + BOT_GRAVITY, 15);
      g.x += g.vx; g.y += g.vy; g.spin += g.vx * 0.09;
      if (g.x < 5) { g.x = 5; g.vx = Math.abs(g.vx) * 0.6; }
      else if (g.x > docW() - 5) { g.x = docW() - 5; g.vx = -Math.abs(g.vx) * 0.6; }
      if (g.vy >= 0) {
        const top = platformBetween(g.x - 8, g.x + 8, prev - 1, g.y + 1);
        if (top !== null) {
          g.y = top;
          if (g.vy > 2.2) { g.vy = -g.vy * 0.42; g.vx *= 0.7; }
          else { g.vy = 0; g.vx *= 0.6; if (Math.abs(g.vx) < 0.25) g.vx = 0; }
        }
      }
      if (g.y > docH() + 100) botGrenades.splice(i, 1);
    }
  }
  function botExplode(b, x, y, now) {
    const R = SLAM_R * 0.8;
    botBreak(b, x, y, R);
    // machuca quem estiver perto (eu e os outros jogadores de verdade)
    const me = gunPos();
    if (Math.hypot(me.x - x, me.y - y) < R + 10) { hurtMe(now, me.x, me.y); sendMyPosition(true); }
    for (const [id, p] of peers) {
      if (p.bot || p.iv) continue;
      if (Math.hypot(p.segs[0].x - x, p.segs[0].y - y) < R + 10) { netEvent({ k: 'ph', v: id, w: 'bazuca' }); p.iv = true; }
    }
  }
  function drawBotGrenades(now) {
    if (!botGrenades.length) return;
    const sx = scrollX, sy = scrollY;
    for (const g of botGrenades) {
      const x = g.x - sx, y = g.y - sy - 5.5, left = 1 - (now - g.born) / GRENADE_FUSE;
      if (x < -20 || y < -20 || x > innerWidth + 20 || y > innerHeight + 20) continue;
      ctx.save(); ctx.translate(x, y); ctx.rotate(g.spin);
      ctx.fillStyle = '#2f3b22'; ctx.strokeStyle = LINE; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.arc(0, 0, 5.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = g.color || '#d7263d'; ctx.fillRect(-5.5, -1.3, 11, 2.6);
      ctx.restore();
      if (Math.floor((now - g.born) / Math.max(50, 220 * left)) % 2) {
        ctx.fillStyle = '#ff5a1f';
        ctx.beginPath(); ctx.arc(x + 2, y - 7, 2.6, 0, Math.PI * 2); ctx.fill();
      }
    }
  }

  // a minhoca-bot come as letras que encostam na boca (igual ao seu bicho)
  function botEat(b, hx, hy, R) {
    if (!S.eatWords || !hasHighlight) return;
    const ix = index, A = b.ai, eatK = botType(b).eat || 1;
    stamp++;
    const x0 = Math.floor((hx - R) / CELL), x1 = Math.floor((hx + R) / CELL);
    const y0 = Math.floor((hy - R) / CELL), y1 = Math.floor((hy + R) / CELL);
    for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) {
      const list = ix.grid.get(cellKey(cx, cy));
      if (!list) continue;
      for (const id of list) {
        if (id >= OBJ || chunkStamp[id] === stamp) continue;
        chunkStamp[id] = stamp;
        const r = ix.rects;
        if (!circleHitsRect(hx, hy, R, r[id * 4], r[id * 4 + 1], r[id * 4 + 2], r[id * 4 + 3])) continue;
        const node = ix.nodes[id];
        if (!node.isConnected) continue;
        const d = wordsOf(node);
        if (d.left === 0) continue;
        const wr = d.rects;
        for (let w = 0; w < d.starts.length; w++) {
          if (!d.wl[w] || wr[w * 4 + 2] === 0) continue;
          if (!circleHitsRect(hx, hy, R, wr[w * 4], wr[w * 4 + 1], wr[w * 4 + 2], wr[w * 4 + 3])) continue;
          const L = lettersOf(node, d, w), lr = L.rects;
          let changed = false;
          for (let k = 0; k < L.offs.length; k++) {
            const o = L.offs[k];
            if (d.ate[o] || lr[k * 4 + 2] === 0) continue;
            if (!circleHitsRect(hx, hy, R, lr[k * 4], lr[k * 4 + 1], lr[k * 4 + 2], lr[k * 4 + 3])) continue;
            hideLetter(node, d, w, o, L.lens[k]);
            shareEat(node, o);
            A.words++; A.food += 0.3 * eatK; b.mouthOpen = 1;
            const ch = node.data.slice(o, o + L.lens[k]);
            const key = id + ':' + w;
            if (A.carry === key && b.labels.length) b.labels[0] = (b.labels[0] + ch).slice(-14);
            else { b.labels.unshift(ch); if (b.labels.length > 40) b.labels.pop(); A.carry = key; }
            changed = true;
          }
          if (changed) wordChanged(node, d, w, 'comeu', false);
        }
      }
    }
  }

  // o bot também pega as palavras soltas (de trombadas)
  function botLoose(b, hx, hy, R, now) {
    for (let i = loose.length - 1; i >= 0; i--) {
      const l = loose[i];
      if (now - l.born < FLY_MS) continue;
      const half = Math.max(10, l.text.length * 4);
      if (Math.abs(l.x - hx) < half + R && Math.abs(l.y - hy) < 8 + R) {
        loose.splice(i, 1);
        const pts = Math.max(1, [...l.text].length);
        b.ai.loot += pts; b.mouthOpen = 1;
        if (b.kind === 'w') { b.ai.food += pts * 0.3; b.labels.unshift(l.text); if (b.labels.length > 40) b.labels.pop(); }
        netEvent({ k: 'pick', id: l.id });
      }
    }
  }

  // o bot atira no jogador de verdade mais perto (mira pior no Fácil)
  function botShoot(b, H, now) {
    const A = b.ai, C = botCfg(), T = botType(b);
    if (now < A.shotAt) return;
    const W = WEAPONS[A.gun] || WEAPONS.pistola, h = b.segs[0];
    let tg = null, td = W.range * C.range * T.range;
    for (const u of H) {
      if (u.iv) continue;
      const d = Math.hypot(u.x - h.x, u.y - h.y);
      if (d < td) { td = d; tg = u; }
    }
    if (!tg) { A.shotAt = now + 300; return; }
    A.shotAt = now + W.cad * C.cad * T.cad * rand(0.85, 1.25);
    const tt = td / W.spd;                                             // quadros até chegar
    const px = tg.x + Math.cos(tg.h) * tg.v * tt * C.lead, py = tg.y + Math.sin(tg.h) * tg.v * tt * C.lead;
    const ang = Math.atan2(py - h.y, px - h.x) + (Math.random() - 0.5) * 2 * C.aim * T.aim;
    if (b.kind === 'j') b.aim = ang;
    spawnShots(h.x, h.y, ang, A.gun, false, b.id);
    A.sh.push(+ang.toFixed(2));
  }

  // a cabeça do bot bateu no corpo de um jogador? (mesma regra da trombada entre jogadores)
  function botRam(b, H, now) {
    if (b.iv) return;
    const A = b.ai, h = b.segs[0], R = 8 + 6 * b.scale;
    for (const u of H) {
      if (u.j || u.iv || now < (A.hitCd.get(u.id) || 0)) continue;
      if (Math.hypot(u.x - h.x, u.y - h.y) > 900) continue;
      const body = bodyOf(u), pr = 4.5 * scaleOf(u) * 1.4;
      let hit = false;
      for (let i = 1; i < body.length && !hit; i++) if (Math.hypot(body[i].x - h.x, body[i].y - h.y) < R * 0.7 + pr) hit = true;
      if (!hit && Math.hypot(body[0].x - h.x, body[0].y - h.y) < R * 0.7 + pr * 1.3 && u.n < b.segs.length) hit = true;
      if (!hit) continue;
      A.hitCd.set(u.id, now + 2500);
      if (u.me) dropWords(now); else netEvent({ k: 'hit', v: u.id });
      floaters.push({ text: 'POW!', x: h.x, y: h.y - 16, life: 1, good: false });
    }
  }

  // tiro de bot: acertou alguém? (só o anfitrião confere)
  function botShotHits(s, now) {
    if (!(s.hit && s.hit.has('me')) && now >= Math.max(shieldUntil, invulnerableUntil)) {
      let hitMe = false;
      if (isJumper()) hitMe = Math.abs(s.x - J.x) < JW / 2 + 3 && Math.abs(s.y - (J.y - JH / 2)) < JH / 2 + 3;
      else {
        const pr = 4.5 * scale() * 1.5;
        for (let i = 0; i < segs.length && !hitMe; i++) hitMe = Math.abs(s.x - segs[i].x - scrollX) < pr && Math.abs(s.y - segs[i].y - scrollY) < pr;
      }
      if (hitMe) {
        const o = gunPos();
        hurtMe(now, o.x, o.y);
        sendMyPosition(true);
        if (s.hit) s.hit.add('me'); else return true;
      }
    }
    for (const [id, p] of peers) {
      if (p.bot || p.iv || (s.hit && s.hit.has(id))) continue;
      if (!shotTouchesPeer(s, p)) continue;
      netEvent({ k: 'ph', v: id, w: s.w });
      p.iv = true;
      floaters.push({ text: '✦', x: s.x, y: s.y, life: 0.5, good: false });
      if (s.hit) s.hit.add(id); else return true;
    }
    return false;
  }

  // levou trombada: as palavras do corpo do bot saem voando (só minhoca)
  function botDrop(b, now) {
    const A = b.ai;
    if (!A || b.kind === 'j' || now < A.shield) return;
    A.shield = now + 3000;
    A.thinkAt = 0; A.mode = 'eat';
    const k = Math.min(b.labels.length, 12);                         // menos que um jogador: não enche a tela
    const words = b.labels.splice(0, k);
    A.food = Math.max(0, A.food - Math.max(k, b.segs.length / 3) * 1.5);
    const target = Math.max(4, Math.min(BOT_MAX_SEG, 4 + Math.floor(A.food / 2)));
    if (b.segs.length > target) b.segs.length = target;
    const ox = b.segs[0].x, oy = b.segs[0].y;
    const items = words.map((text) => {
      const x = clamp(ox + rand(-350, 350), 20, docW() - 20), y = clamp(oy + rand(-250, 250), 20, docH() - 20);
      const id = b.id.slice(4) + '-w' + (++looseSeq);
      addLoose(id, text, ox, oy, x, y, b.color, now);
      return { id, t: text, a: toAnchor(x, y) };
    });
    floaters.push({ text: 'POW!', x: ox, y: oy - 20, life: 1, good: true });
    if (items.length) netEvent({ k: 'drop', o: toAnchor(ox, oy), c: b.color, items });
  }

  // levou tiro: perde pontos e pisca
  function botHurt(b, now) {
    const A = b.ai;
    if (!A || now < Math.max(A.hurt, A.shield)) return;
    A.hits++;
    A.hurt = now + 600;
    floaters.push({ text: `-${HIT_PENALTY}`, x: b.segs[0].x, y: b.segs[0].y - 10, life: 1, good: true });
  }

  // eu acertei um jogador ou bot (com tiro ou trombada): bot meu resolve aqui, o resto vai pela rede
  function peerHit(id, now) {
    const b = peers.get(id);
    if (b && b.local) botDrop(b, now); else netEvent({ k: 'hit', v: id });
  }
  function peerShot(id, w, now) {
    const b = peers.get(id);
    if (b && b.local) botHurt(b, now); else netEvent({ k: 'ph', v: id, w });
  }

  // anfitrião: manda a posição dos bots (e os tiros e granadas deles) para a sala
  function botBroadcast(now) {
    if (netState !== 'online') { for (const b of bots) { b.ai.sh.length = 0; b.ai.gr.length = 0; } return; }
    if (now < botSentAt || (!bots.length && !botsWereSent)) return;
    botSentAt = now + 250;
    botsWereSent = bots.length > 0;
    netEvent({
      k: 'bots',
      b: bots.map((b) => ({
        id: b.id, a: toAnchor(b.segs[0].x, b.segs[0].y), h: +b.heading.toFixed(2), n: b.segs.length,
        s: +b.scale.toFixed(2), c: b.color, u: b.name, pt: b.pts, iv: b.iv ? 1 : 0,
        k: b.kind, f: b.face, ty: b.btype,
        w: b.ai.gun, sh: b.ai.sh.splice(0, 8), gr: b.ai.gr.splice(0, 3), lb: b.kind === 'w' ? b.labels.slice(0, 8) : undefined,
      })),
    });
  }

  // não sou o anfitrião: desenho os bots dele como jogadores
  function onBots(m) {
    if (!Array.isArray(m.b) || isHost()) return;
    const now = performance.now();
    const seen = new Set();
    for (const x of m.b.slice(0, 8)) {
      if (!x || !isBot(x.id) || !x.a) continue;
      seen.add(x.id);
      onPeerPos({ id: x.id, a: x.a, h: x.h, n: x.n, s: x.s, c: x.c, pt: x.pt, iv: x.iv, k: x.k === 'j' ? 'j' : 'w', f: x.f });
      const p = peers.get(x.id);
      if (!p) continue;
      p.bot = true;
      p.btype = BOT_TYPES[x.ty] ? x.ty : (p.kind === 'j' ? 'pulador' : 'comilao');
      p.name = String(x.u || '🤖 Bot').slice(0, 24);
      p.labels = Array.isArray(x.lb) ? x.lb.slice(0, 8).map((s) => String(s).slice(0, 14)) : null;
      if (Array.isArray(x.sh)) {
        const w = WEAPONS[x.w] ? x.w : 'pistola';
        for (const a of x.sh.slice(0, 8)) spawnShots(p.segs[0].x, p.segs[0].y, +a || 0, w, false);
      }
      if (Array.isArray(x.gr)) {
        for (const g of x.gr.slice(0, 3)) {
          if (!Array.isArray(g)) continue;
          botGrenades.push({ x: p.segs[0].x, y: p.segs[0].y - 6, vx: +g[0] || 0, vy: +g[1] || 0, born: now, spin: 0, color: p.color, owner: null });
        }
      }
    }
    for (const [id, p] of peers) if (p.bot && !p.local && !seen.has(id)) peers.delete(id);
  }

  // ---------- Desenho ----------
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'all:initial;position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483646;';
  canvas.dataset.pagegame = '';
  const ctx = canvas.getContext('2d');   // (sem "desynchronized": no Android ele deixava a tela preta)
  // modo leve: sombra/brilho do canvas é o que mais pesa no celular; vira nada
  function liteCanvas() {
    try { Object.defineProperty(ctx, 'shadowBlur', { configurable: true, get: () => 0, set: () => {} }); } catch {}
  }
  if (LITE) liteCanvas();
  const hud = document.createElement('div');
  hud.style.cssText = [
    'all:initial', 'position:fixed', 'left:12px', 'bottom:12px', 'z-index:2147483647',
    'font:600 12px/1.2 system-ui,-apple-system,Segoe UI,Roboto,sans-serif', 'color:#2b1d00',
    'border:1.5px solid #2b1d00', 'border-radius:999px', 'padding:6px 12px', 'pointer-events:none',
  ].join(';');
  hud.dataset.pagegame = '';

  // Placar dos jogadores que estão nesta página (canto direito)
  const board = document.createElement('div');
  board.style.cssText = [
    'all:initial', 'position:fixed', 'right:12px', 'top:12px', 'z-index:2147483647', 'min-width:150px',
    'max-width:220px', 'font:600 12px/1.35 system-ui,-apple-system,Segoe UI,Roboto,sans-serif', 'color:#2b1d00',
    'background:rgba(255,255,255,0.93)', 'border:1.5px solid #2b1d00', 'border-radius:10px',
    'padding:8px 10px', 'pointer-events:none', 'box-shadow:0 2px 8px rgba(0,0,0,0.15)',
  ].join(';');
  board.dataset.pagegame = '';
  let boardKey = '';
  function updateBoard() {
    const show = netState === 'online' || peers.size > 0;   // multiplayer ligado ou tem bots
    board.style.visibility = show ? 'visible' : 'hidden';
    if (!show) return;
    const rows = [{ name: '@' + (myName || 'você'), pts: points(), color: S.color, me: true }];
    for (const p of peers.values()) rows.push({ name: p.name, pts: p.pts || 0, color: p.color });
    rows.sort((a, b) => b.pts - a.pts);
    const title = `Placar · ${rows.length} ${rows.length === 1 ? 'jogador' : 'jogadores'}`;
    const key = title + rows.map((r) => r.name + r.pts + r.color).join('|');
    if (key === boardKey) return;           // nada mudou: não mexe no DOM
    boardKey = key;
    const head = document.createElement('div');
    head.style.cssText = 'all:initial;display:block;font:800 11px/1.4 system-ui,sans-serif;color:#2b1d00;letter-spacing:.04em;text-transform:uppercase;margin-bottom:4px';
    head.textContent = title;
    const list = rows.slice(0, 10).map((r, i) => {
      const row = document.createElement('div');
      row.style.cssText = 'all:initial;display:flex;align-items:center;gap:6px;font:' + (r.me ? '800' : '600') +
        ' 12px/1.5 system-ui,sans-serif;color:#2b1d00;white-space:nowrap';
      const pos = document.createElement('span');
      pos.style.cssText = 'all:initial;font:inherit;color:#2b1d00;opacity:.6;min-width:14px';
      pos.textContent = i + 1 + '.';
      const dot = document.createElement('span');
      dot.style.cssText = `all:initial;width:10px;height:10px;border-radius:50%;border:1.2px solid #2b1d00;background:${r.color}`;
      const name = document.createElement('span');
      name.style.cssText = 'all:initial;font:inherit;color:#2b1d00;flex:1;overflow:hidden;text-overflow:ellipsis';
      name.textContent = r.name + (r.me ? ' (você)' : '');
      const pts = document.createElement('span');
      pts.style.cssText = 'all:initial;font:inherit;color:#2b1d00;margin-left:8px';
      pts.textContent = r.pts.toLocaleString('pt-BR');
      row.append(pos, dot, name, pts);
      return row;
    });
    board.replaceChildren(head, ...list);
  }

  function resizeCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, lite ? 1.5 : 2.5);   // tela 3x do celular custa caro
    canvas.width = Math.round(innerWidth * dpr);
    canvas.height = Math.round(innerHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  const LINE = '#2b1d00';
  function segAngle(segs, i) {
    const a = segs[Math.max(0, i - 1)], b = segs[Math.min(segs.length - 1, i + 1)];
    return Math.atan2(a.y - b.y, a.x - b.x);
  }

  // Desenha um bicho. c = { segs, heading, scale, color, mouthOpen, speed, t, labels, name }
  // (ox, oy) desloca do sistema do bicho para a tela.
  function drawCreature(c, ox, oy) {
    const segs = c.segs, s = c.scale, r = 4.5 * s;
    const gait = c.t * 0.35 * (c.speed / 3.4 + 0.15);
    const A = c.alpha == null ? 1 : c.alpha;     // pisca quando levou trombada
    ctx.save();
    ctx.translate(ox, oy);
    ctx.globalAlpha = A;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';

    // pernas
    ctx.strokeStyle = LINE; ctx.globalAlpha = 0.55 * A;
    ctx.lineWidth = Math.max(1, 0.8 * s);
    ctx.beginPath();
    for (let i = 1; i < segs.length; i++) {
      const p = segs[i], ang = segAngle(segs, i);
      const fx = Math.cos(ang), fy = Math.sin(ang);
      for (const side of [-1, 1]) {
        const px = -fy * side, py = fx * side;
        const swing = Math.sin(gait + i * 0.9 + (side > 0 ? Math.PI : 0)) * 4 * s;
        const kx = p.x + px * r * 2.2 + fx * swing * 0.5, ky = p.y + py * r * 2.2 + fy * swing * 0.5;
        ctx.moveTo(p.x, p.y); ctx.lineTo(kx, ky);
        ctx.lineTo(kx + px * r * 1.6 + fx * swing, ky + py * r * 1.6 + fy * swing);
      }
    }
    ctx.stroke();
    ctx.globalAlpha = A;

    // corpo
    ctx.lineWidth = Math.max(1, 1.1 * s);
    ctx.fillStyle = c.color; ctx.strokeStyle = LINE;
    for (let i = segs.length - 1; i >= 1; i--) {
      const p = segs[i], ang = segAngle(segs, i);
      const taper = 1 - (i / segs.length) * 0.45;
      const w = r * 2.2 * taper, h = r * 1.5 * taper;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(ang);
      ctx.beginPath(); ctx.rect(-w / 2, -h, w, h * 2); ctx.fill(); ctx.stroke();
      ctx.restore();
    }

    // palavras carregadas no corpo
    if (c.labels && s > 1.25) {
      ctx.font = `600 ${Math.min(13, 6 + s * 2)}px system-ui, sans-serif`;
      ctx.fillStyle = LINE; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (let i = 3; i < segs.length; i += 3) {
        const word = c.labels[i / 3 - 1];
        if (!word) break;
        const p = segs[i];
        let ta = segAngle(segs, i) + Math.PI / 2;
        if (Math.cos(ta) < 0) ta += Math.PI;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(ta);
        ctx.fillText(word, 0, -r * 1.5 - 8);
        ctx.restore();
      }
    }

    // cabeça
    const head = segs[0];
    ctx.save(); ctx.translate(head.x, head.y); ctx.rotate(c.heading);
    ctx.strokeStyle = LINE; ctx.lineWidth = Math.max(1, 1.1 * s);
    const wave = Math.sin(c.t * 0.12) * 0.25;
    ctx.beginPath();
    for (const side of [-1, 1]) {
      ctx.moveTo(r * 1.2, side * r * 0.6);
      ctx.quadraticCurveTo(r * 3.5, side * (r * 1.5 + wave * r * side), r * 5.2, side * r * (2.6 + wave));
      const open = 0.35 + c.mouthOpen * 0.6;
      ctx.moveTo(r * 1.3, side * r * 0.5);
      ctx.lineTo(r * 2.4, side * r * (0.5 + open));
      ctx.lineTo(r * 2.9, side * r * open * 0.3);
    }
    ctx.stroke();
    ctx.fillStyle = c.color;
    ctx.beginPath(); ctx.ellipse(0, 0, r * 1.6, r * 1.25, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = LINE;
    for (const side of [-1, 1]) {
      ctx.beginPath(); ctx.arc(r * 0.7, side * r * 0.55, Math.max(1.2, r * 0.22), 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();

    // nome do jogador (só nos bichos dos outros)
    if (c.name) {
      ctx.font = '600 11px system-ui, sans-serif';
      const tw = ctx.measureText(c.name).width + 12;
      const nx = head.x - tw / 2, ny = head.y - r * 3 - 22;
      ctx.fillStyle = c.color; ctx.strokeStyle = LINE; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.roundRect(nx, ny, tw, 17, 8.5); ctx.fill(); ctx.stroke();
      ctx.fillStyle = LINE; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(c.name, head.x, ny + 9);
    }
    ctx.restore();
  }

  function draw() {
    ctx.clearRect(0, 0, innerWidth, innerHeight);

    // outros jogadores (coordenadas da página -> tela)
    const sx = scrollX, sy = scrollY;
    const now = performance.now();
    const blink = (t >> 2) % 2 ? 0.35 : 0.9;
    drawLoose(now);
    drawNear(now);
    drawFills(now);
    for (const p of peers.values()) {
      const h = p.segs[0];
      if (h.x - sx < -600 || h.x - sx > innerWidth + 600 || h.y - sy < -600 || h.y - sy > innerHeight + 600) continue;
      p.alpha = p.iv ? blink : 1;
      if (p.kind === 'j') drawJumper({ x: h.x - sx, y: h.y - sy, color: p.color, face: p.face || 1, aim: p.aim, squash: p.squash || 0, t: p.t, moving: p.speed > 0.5, onGround: p.onGround !== false, name: p.name, alpha: p.alpha });
      else drawCreature(p, -sx, -sy);
    }

    drawEnemies(performance.now());
    drawBursts(performance.now());

    // o seu personagem (coordenadas da tela)
    drawShotsAndSlams(now);
    if (isJumper()) {
      // rastro do dash
      for (let i = J.trail.length - 1; i >= 0; i--) {
        const tr = J.trail[i], k = (now - tr.born) / 260;
        if (k >= 1) { J.trail.splice(i, 1); continue; }
        ctx.globalAlpha = 0.45 * (1 - k);
        ctx.fillStyle = S.color;
        ctx.beginPath(); ctx.roundRect(tr.x - sx - JW / 2, tr.y - sy - JH, JW, JH, 9); ctx.fill();
      }
      ctx.globalAlpha = 1;
      if (now < J.dashUntil) {                                          // riscos de velocidade
        ctx.strokeStyle = S.color; ctx.lineWidth = 2; ctx.lineCap = 'round';
        const ux = -Math.cos(J.aim), uy = -Math.sin(J.aim);
        for (let k = -1; k <= 1; k++) {
          const ox = -uy * k * 9, oy = ux * k * 9;
          ctx.beginPath();
          ctx.moveTo(J.x - sx + ox + ux * 16, J.y - sy - JH / 2 + oy + uy * 16);
          ctx.lineTo(J.x - sx + ox + ux * 46, J.y - sy - JH / 2 + oy + uy * 46);
          ctx.stroke();
        }
      }
      drawJumper({ x: J.x - sx, y: J.y - sy - JH / 2, color: S.color, face: J.face, aim: J.aim, squash: J.squash,
                   t, moving: Math.abs(J.vx) > 0.5, onGround: J.onGround, alpha: now < invulnerableUntil ? blink : 1 });
    } else {
      for (let i = WD.trail.length - 1; i >= 0; i--) {              // rastro do dash do bicho
        const tr = WD.trail[i], k = (now - tr.born) / 280;
        if (k >= 1) { WD.trail.splice(i, 1); continue; }
        ctx.globalAlpha = 0.4 * (1 - k); ctx.fillStyle = S.color;
        ctx.beginPath(); ctx.arc(tr.x - sx, tr.y - sy, mouthR() * (1 - k * 0.5), 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
    if (!isJumper()) drawCreature({
      segs, heading, scale: scale(), color: S.color, mouthOpen, speed: speedNow, t,
      labels: S.showLabels ? carried : null, name: null,
      alpha: now < shieldUntil ? blink : 1,
    }, 0, 0);

    // itens voando para a boca
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = LINE;
    for (const p of particles) {
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.font = `600 ${10 + p.life * 4}px system-ui, sans-serif`;
      ctx.fillText(p.text, p.x, p.y);
    }
    ctx.globalAlpha = 1;
  }

  // =====================================================================
  // Multiplayer (nível 1: ver os outros jogadores na mesma página)
  // =====================================================================
  // Sala = hash da URL sem rastreadores e sem # (room.js). A URL nunca sai do navegador.
  // No app do celular, PG_PAGE_URL diz qual artigo está aberto (a sala muda junto).
  const roomNow = () => globalThis.pgRoomKey(globalThis.PG_PAGE_URL || location.href);

  // Cada pessoa vê a página com um layout diferente (tela, fonte, anúncios).
  // Por isso a posição viaja ancorada no texto: "nó de texto X, a 30% da
  // largura e 60% da altura dele". Cada um converte para o próprio layout.
  const pathCache = new WeakMap();
  function pathOf(node) {
    let p = pathCache.get(node);
    if (p) return p;
    const parts = [];
    for (let n = node; n && n !== document.body; n = n.parentNode) {
      const parent = n.parentNode;
      if (!parent) return null;
      parts.push(Array.prototype.indexOf.call(parent.childNodes, n));
    }
    p = parts.reverse().join('.');
    pathCache.set(node, p);
    return p;
  }

  const resolveCache = new Map();
  function nodeAt(path) {
    let n = resolveCache.get(path);
    if (n && n.isConnected) return n;
    n = document.body;
    for (const i of path.split('.')) {
      n = n && n.childNodes[+i];
      if (!n) return null;
    }
    if (n.nodeType !== 3) return null;
    if (resolveCache.size > 500) resolveCache.clear();
    resolveCache.set(path, n);
    return n;
  }

  const anchorRange = document.createRange();
  const docW = () => Math.max(document.documentElement.scrollWidth, 1);
  const docH = () => Math.max(document.documentElement.scrollHeight, 1);

  // posição na página -> âncora
  function toAnchor(px, py) {
    const ix = index, r = ix.rects;
    const cx = Math.floor(px / CELL), cy = Math.floor(py / CELL);
    let best = -1, bestD = 160 * 160;
    for (let gx = cx - 1; gx <= cx + 1; gx++) for (let gy = cy - 1; gy <= cy + 1; gy++) {
      const list = ix.grid.get(cellKey(gx, gy));
      if (!list) continue;
      for (const id of list) {
        if (id >= OBJ) continue;
        const dx = Math.max(r[id * 4] - px, 0, px - (r[id * 4] + r[id * 4 + 2]));
        const dy = Math.max(r[id * 4 + 1] - py, 0, py - (r[id * 4 + 1] + r[id * 4 + 3]));
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = id; if (d === 0) break; }
      }
    }
    if (best >= 0 && ix.nodes[best].isConnected) {
      const path = pathOf(ix.nodes[best]);
      if (path) {
        const x = r[best * 4], y = r[best * 4 + 1], w = Math.max(r[best * 4 + 2], 1), h = Math.max(r[best * 4 + 3], 1);
        return { p: path, fx: +((px - x) / w).toFixed(3), fy: +((py - y) / h).toFixed(3) };
      }
    }
    return { fx: +(px / docW()).toFixed(4), fy: +(py / docH()).toFixed(4) };   // sem texto perto
  }

  // âncora -> posição na página (no layout de quem recebe)
  function fromAnchor(a) {
    if (a.p) {
      const node = nodeAt(a.p);
      if (node) {
        anchorRange.selectNodeContents(node);
        const rc = anchorRange.getBoundingClientRect();
        if (rc.width > 0) {
          return { x: rc.left + scrollX + a.fx * rc.width, y: rc.top + scrollY + a.fy * rc.height };
        }
      }
    }
    return { x: (a.p ? 0.5 : a.fx) * docW(), y: a.fy * docH() };
  }

  const peers = new Map();        // user_id -> bicho remoto
  let myId = null;
  const roomIds = new Set();      // quem está na sala (Presence), menos eu
  let onlineSince = 0;

  // Anfitrião = quem tem o menor id na sala. Só ele cria as palavras inimigas,
  // para todo mundo ver as mesmas.
  function isHost() {
    if (netState !== 'online' || !myId) return true;
    for (const id of roomIds) if (id < myId) return false;
    return true;
  }
  function netEvent(m) {
    if (netState === 'online' && window.__pgNet && window.__pgNet.sendEvent) window.__pgNet.sendEvent(m);
  }
  let peerCount = 0;
  let netState = 'off';
  let lastSent = 0, lastSentX = 0, lastSentY = 0, lastSentH = 0;

  function onPeerPos(m) {
    if (!m || m.id === myId || !m.a) return;
    const target = fromAnchor(m.a);
    let p = peers.get(m.id);
    if (!p) {
      p = { segs: [{ x: target.x, y: target.y }], heading: m.h || 0, scale: 1, color: '#ccc',
            mouthOpen: 0, speed: 0, t: 0, labels: null, name: '…', target, n: 4 };
      peers.set(m.id, p);
    }
    p.target = target;
    p.targetHeading = m.h || 0;
    p.n = Math.min(200, m.n | 0 || 4);
    p.scale = Math.min(5, +m.s || 1);
    p.pts = Number(m.pt) || 0;
    p.iv = !!m.iv;
    p.kind = m.k === 'j' ? 'j' : 'w';
    p.face = m.f === -1 ? -1 : 1;
    if (p.kind === 'j') p.n = 1;
    if (m.c) p.color = m.c;
    if (m.u) p.name = '@' + m.u;
    p.seen = performance.now();
  }

  function onPeers(stateObj) {
    const ids = new Set();
    for (const [id, metas] of Object.entries(stateObj)) {
      if (id === myId) continue;
      ids.add(id);
      const meta = metas[metas.length - 1] || {};
      const p = peers.get(id);
      if (p) { if (meta.username) p.name = '@' + meta.username; if (meta.color) p.color = meta.color; }
    }
    for (const id of peers.keys()) if (!ids.has(id) && !isBot(id)) peers.delete(id);   // saiu da sala (bots ficam)
    peerCount = ids.size;
    // Alguém entrou: quem já era o anfitrião (e já estava na sala antes) manda
    // as inimigas vivas e as palavras que já foram comidas.
    const now = performance.now();
    const wasHost = isHost();
    let joined = false;
    for (const id of ids) if (!roomIds.has(id)) joined = true;
    roomIds.clear();
    for (const id of ids) roomIds.add(id);
    if (joined && wasHost && now - onlineSince > 1500) {
      for (const e of enemies) netEvent({ k: 'en', ...e.msg, age: Math.round(now - e.born) });
      sendEatSnapshot(now);
    }
  }

  function updatePeers() {
    const now = performance.now();
    for (const [id, p] of peers) {
      if (p.local) continue;                                           // bot meu: quem mexe é o updateBots
      if (now - (p.seen || now) > 15000) { peers.delete(id); continue; }  // sumiu sem avisar
      p.t++;
      const h = p.segs[0];
      const dx = p.target.x - h.x, dy = p.target.y - h.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 1500) { h.x = p.target.x; h.y = p.target.y; }           // pulou longe: teleporta
      else { h.x += dx * 0.18; h.y += dy * 0.18; }
      p.speed = Math.min(8, dist * 0.18);
      let diff = (dist > 2 ? Math.atan2(dy, dx) : p.targetHeading) - p.heading;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      p.heading += diff * 0.2;
      while (p.segs.length < p.n) p.segs.push({ ...p.segs[p.segs.length - 1] });
      if (p.segs.length > p.n) p.segs.length = p.n;
      const gap = 7 * p.scale;
      for (let i = 1; i < p.segs.length; i++) {
        const a = p.segs[i - 1], b = p.segs[i];
        const ex = b.x - a.x, ey = b.y - a.y, d = Math.hypot(ex, ey) || 1;
        if (d > gap) { b.x = a.x + (ex / d) * gap; b.y = a.y + (ey / d) * gap; }
      }
      p.mouthOpen = Math.max(0, p.mouthOpen - 0.08);
    }
  }

  let profile = null;
  function sendMyPosition(force) {
    if (netState !== 'online') return;
    const now = performance.now();
    const h = segs[0];
    const moved = Math.abs(h.x + scrollX - lastSentX) + Math.abs(h.y + scrollY - lastSentY) > 1.5 ||
      Math.abs(heading - lastSentH) > 0.05;
    // 8 envios/s quando anda; 1 a cada 2 s parado (para quem acabou de entrar)
    if (!force && !(moved && now - lastSent > (lite ? 200 : 125)) && now - lastSent < 2000) return;   // 5/s no celular
    lastSent = now; lastSentX = h.x + scrollX; lastSentY = h.y + scrollY; lastSentH = heading;
    window.__pgNet.sendPos({
      id: myId, a: toAnchor(lastSentX, lastSentY), h: +heading.toFixed(2),
      n: segs.length, s: +scale().toFixed(2), c: S.color, u: profile && profile.username,
      pt: points(), iv: performance.now() < Math.max(shieldUntil, invulnerableUntil) ? 1 : 0,
      k: isJumper() ? 'j' : 'w', f: J.face,
    });
  }

  async function mpConnect() {
    if (!window.__pgNet || !S.multiplayer || netState === 'connecting' || netState === 'online') return;
    const { pgAuth } = await chrome.storage.local.get('pgAuth');
    if (!pgAuth) return;
    profile = { username: pgAuth.username, color: S.color };
    // já sabe quem é antes do primeiro "sync" de Presence (senão se conta como outro jogador)
    myId = pgAuth.userId;
    try {
      myId = await window.__pgNet.connect({
        room: roomNow(), profile, onPos: onPeerPos, onPeers, onEvent: onNetEvent,
        onState: (st) => { netState = st; if (st === 'online') { onlineSince = performance.now(); sendMyPosition(true); } },
      });
    } catch (e) {
      netState = 'error';
      console.warn('[PageGame] multiplayer indisponível:', e && e.message);
    }
  }

  async function mpDisconnect() {
    peers.clear(); peerCount = 0; roomIds.clear(); bots.length = 0; botGrenades.length = 0; botsWereSent = false;
    netState = 'off';
    if (window.__pgNet) await window.__pgNet.disconnect();
  }

  // =====================================================================
  // Pontuação: envia o que foi comido para o banco (submit_game)
  // =====================================================================
  let playMs = 0, maxLen = 0;
  const sentScore = { words: 0, images: 0, others: 0, enemies: 0, hits: 0, ms: 0 };
  let account = null;            // estatísticas da conta devolvidas pelo banco
  let flushing = false;
  let scoreGen = 0;              // muda ao restaurar a página (zera os contadores)

  function pendingGame() {
    const g = {
      pageHash: roomNow(),
      words: eaten.words - sentScore.words,
      images: eaten.images - sentScore.images,
      others: eaten.others - sentScore.others,
      enemies: enemiesEaten - sentScore.enemies,
      hits: hits - sentScore.hits,
      maxLength: Math.min(200, maxLen),
      durationMs: Math.round(playMs - sentScore.ms),
    };
    return (g.words || g.images || g.others || g.enemies || g.hits) ? g : null;
  }
  function markSent(g) {
    sentScore.words += g.words; sentScore.images += g.images; sentScore.others += g.others;
    sentScore.enemies += g.enemies; sentScore.hits += g.hits; sentScore.ms += g.durationMs;
  }

  async function flushScore() {
    const g = pendingGame();
    if (!g || flushing || !window.__pgNet) return;
    flushing = true;
    const gen = scoreGen;
    try {
      account = await window.__pgNet.submitGame(g);
      if (gen === scoreGen) markSent(g);
    } catch (e) {
      console.warn('[PageGame] não salvou a pontuação:', e && e.message);
    } finally {
      flushing = false;
    }
  }

  addEventListener('pagehide', () => {
    const g = pendingGame();
    if (g && window.__pgNet) { window.__pgNet.submitGameBeacon(g); markSent(g); }
  });
  setInterval(() => { if (running) flushScore(); }, 60_000);

  const fmt = (n) => n.toLocaleString('pt-BR');
  function updateHud() {
    hud.style.background = S.color;
    if (!running) { hud.textContent = '🐛 pausado (Esc ou menu para continuar)'; return; }
    if (scan) { hud.textContent = `🐛 escaneando… ${fmt(scan.ix.words)} palavras`; return; }
    const pts = points();
    let txt;
    if (isJumper()) {
      txt = `🎯 ${fmt(pts)} ${Math.abs(pts) === 1 ? 'ponto' : 'pontos'}  |  quebrou ${fmt(eaten.words)} letras  |  derrubou ${fmt(enemiesEaten)}`;
    } else {
      txt = `🐛 ${fmt(pts)} ${Math.abs(pts) === 1 ? 'ponto' : 'pontos'}`;
      txt += `  |  comeu ${fmt(eaten.words + eaten.images + eaten.others + enemiesEaten)}`;
    }
    txt += `  |  ${weapon().icon} ${weapon().nome}`;
    if (hits) txt += `  |  levou ${fmt(hits)} ${hits === 1 ? 'tiro' : 'tiros'}`;
    if (S.enemies) txt += `  |  ⚔ ${DIFF_NAME[roomDifficulty()]}`;
    if (netState === 'online') txt += peerCount ? `  |  ${peerCount + 1} jogando aqui` : '  |  só você aqui';
    const nb = botCount();
    if (nb) txt += `  |  🤖 ${nb} ${nb === 1 ? 'bot' : 'bots'}`;
    hud.textContent = txt;
    updateBoard();
  }

  // ---------- Loop ----------
  let running = false, raf = null, mounted = false;
  let lastFrame = 0;
  let slowFrames = 0, lastIvSent = false;
  function frame(now) {
    if (lastFrame) {
      const dt = now - lastFrame;
      playMs += Math.min(100, dt);
      // aparelho lento (menos de ~40 fps por uns 3 s): liga o modo leve sozinho
      if (!lite && dt > 25 && dt < 200) { if (++slowFrames > 120) { lite = true; liteCanvas(); resizeCanvas(); } }
      else if (slowFrames > 0) slowFrames--;
    }
    lastFrame = now;
    if (particles.length > FX_CAP) particles.splice(0, particles.length - FX_CAP);
    if (floaters.length > FX_CAP) floaters.splice(0, floaters.length - FX_CAP);
    if (scan) scanStep(SCAN_BUDGET_MS);
    update();
    maxLen = Math.max(maxLen, segs.length);
    updatePeers();
    // terminou a invencibilidade (depois de levar tiro): avisa logo, para voltar a poder ser alvo
    const ivNow = now < Math.max(shieldUntil, invulnerableUntil);
    if (ivNow !== lastIvSent) { lastIvSent = ivNow; sendMyPosition(true); }
    sendMyPosition(false);
    draw();
    if (t % 8 === 0) updateHud();
    raf = requestAnimationFrame(frame);
  }

  // ---------- Eventos (só reagem enquanto está rodando) ----------
  addEventListener('mousemove', (e) => { mouse.x = e.clientX; mouse.y = e.clientY; mouseIn = true; }, { passive: true });
  document.addEventListener('mouseout', (e) => { if (!e.relatedTarget) mouseIn = false; }, { passive: true });
  addEventListener('resize', () => { if (mounted) resizeCanvas(); requestRescan(); });
  document.addEventListener('scroll', (e) => {
    if (e.target !== document) requestRescan(200);   // rolagem dentro de caixas internas
  }, { capture: true, passive: true });
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && mounted) running ? pause() : tryPlay();
  });

  // ---------- Rolagem travada: durante o jogo, só o bicho rola a página ----------
  // Bloqueia roda do mouse, touchpad, toque, botão do meio (autoscroll) e as
  // teclas de rolagem. Se a página rolar por outro jeito (arrastar a barra,
  // Ctrl+F...), volta para onde o bicho deixou.
  let allowedX = 0, allowedY = 0;
  const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', ' ', 'Spacebar']);
  const isEditable = (el) => el && (el.isContentEditable || /^(input|textarea|select)$/i.test(el.localName));
  const block = (e) => { if (running) e.preventDefault(); };
  addEventListener('wheel', (e) => { if (running && !e.ctrlKey) e.preventDefault(); }, { passive: false, capture: true });  // Ctrl+roda (zoom) continua
  addEventListener('touchmove', (e) => { if (!isUI(e.target)) block(e); }, { passive: false, capture: true });
  addEventListener('mousedown', (e) => { if (running && e.button === 1) e.preventDefault(); }, { capture: true });
  addEventListener('keydown', (e) => {
    if (running && SCROLL_KEYS.has(e.key) && !isEditable(e.target) && !e.ctrlKey && !e.metaKey && !e.altKey) e.preventDefault();
  }, { capture: true });
  addEventListener('scroll', () => {
    if (!running) return;
    if (Math.abs(scrollY - allowedY) > 1 || Math.abs(scrollX - allowedX) > 1) {
      scrollTo({ left: allowedX, top: allowedY, behavior: 'instant' });
    }
  }, { passive: true });
  let mutTimer = null;
  const observer = new MutationObserver(() => {
    if (!running || mutTimer) return;
    mutTimer = setTimeout(() => { mutTimer = null; requestRescan(0); }, 1200);
  });
  let lastHeight = 0;
  setInterval(() => {
    if (!running) return;
    const h = document.documentElement.scrollHeight;
    if (h !== lastHeight) { lastHeight = h; requestRescan(0); }
  }, 2000);

  // =====================================================================
  // CELULAR / TOQUE
  // Em tela de toque aparecem controles na tela:
  //  - botão de pausar (canto de cima)
  //  - bicho: anda sempre para a frente; ◀ ▶ viram, ⚡ dá o dash
  //  - saltador: ◀ ▶ à esquerda; pular, descer, dash e quebrar à direita;
  //    tocar/segurar no resto da tela mira e atira
  // Elementos com data-pagegame-ui (o menu do app) não são comidos nem
  // bloqueados pelo jogo.
  // =====================================================================
  const isTouch = () => matchMedia('(pointer: coarse)').matches;   // celular/tablet (notebook com tela de toque continua no mouse)
  const isUI = (el) => !!(el && el.closest && el.closest('[data-pagegame-ui]'));
  const touchUI = document.createElement('div');
  touchUI.dataset.pagegame = '';
  touchUI.dataset.pagegameUi = '';
  touchUI.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;' +
    'font:700 18px/1 system-ui,sans-serif;user-select:none;-webkit-user-select:none;touch-action:none';
  const BTN = 'all:initial;position:absolute;display:flex;align-items:center;justify-content:center;pointer-events:auto;' +
    'width:58px;height:58px;border-radius:50%;background:rgba(255,255,255,.82);border:2px solid #2b1d00;' +
    'box-shadow:0 2px 8px rgba(0,0,0,.25);font:800 20px/1 system-ui,sans-serif;color:#2b1d00;touch-action:none;' +
    'user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent';
  function tbtn(label, css, down, up) {
    const b = document.createElement('div');
    b.textContent = label;
    b.style.cssText = BTN + ';' + css;
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      try { b.setPointerCapture(e.pointerId); } catch {}
      b.style.transform = 'scale(.92)'; b.style.background = 'rgba(255,210,63,.95)';
      down && down();
    });
    const end = (e) => {
      e.preventDefault(); e.stopPropagation();
      b.style.transform = ''; b.style.background = 'rgba(255,255,255,.82)';
      up && up();
    };
    b.addEventListener('pointerup', end);
    b.addEventListener('pointercancel', end);
    return b;
  }
  const hold = (k) => [() => { jkeys.add(k); if (k === 'up') J.jumpBuf = performance.now() + 150; if (k === 'down') J.dropBuf = performance.now() + 150; },
                       () => jkeys.delete(k)];
  // dash pelo botão: na direção das setas apertadas (ou para onde está virado)
  const dashButton = () => {
    const dx = (jkeys.has('right') ? 1 : 0) - (jkeys.has('left') ? 1 : 0);
    const dy = (jkeys.has('down') ? 1 : 0) - (jkeys.has('up') ? 1 : 0);
    dash(Math.atan2(dy || (dx ? 0 : -0.35), dx || J.face));
  };
  let lastTouchAim = 0;
  const grenadeButton = () => {
    const recent = performance.now() - lastTouchAim < 2500;
    throwGrenade(recent ? J.aim : (J.face > 0 ? -0.85 : Math.PI + 0.85));
  };
  const pauseBtn = tbtn('❚❚', 'left:10px;top:10px;width:44px;height:44px;font-size:15px', () => (running ? pause() : tryPlay()));
  const pad = document.createElement('div');
  pad.style.cssText = 'all:initial;position:absolute;inset:0;pointer-events:none';
  pad.append(
    tbtn('◀', 'left:14px;bottom:22px', ...hold('left')),
    tbtn('▶', 'left:84px;bottom:22px', ...hold('right')),
    tbtn('⤒', 'right:84px;bottom:22px', ...hold('up')),
    tbtn('⤓', 'right:84px;bottom:92px;width:48px;height:48px;font-size:17px', ...hold('down')),
    tbtn('💣', 'right:14px;bottom:92px', () => grenadeButton()),
    tbtn('⚡', 'right:14px;bottom:22px', () => dashButton()),
  );
  // bicho no celular: anda sempre para a frente; ◀ vira para a esquerda, ▶ para a direita; ⚡ dash
  const steerHold = (k) => [() => steerKeys.add(k), () => steerKeys.delete(k)];
  const wormPad = document.createElement('div');
  wormPad.style.cssText = 'all:initial;position:absolute;inset:0;pointer-events:none';
  wormPad.append(
    tbtn('◀', 'left:16px;bottom:24px;width:70px;height:70px;font-size:26px', ...steerHold('left')),
    tbtn('▶', 'right:16px;bottom:24px;width:70px;height:70px;font-size:26px', ...steerHold('right')),
    tbtn('⚡', 'right:28px;bottom:108px;width:52px;height:52px;font-size:20px', () => wormDash()),
  );
  touchUI.append(pauseBtn, pad, wormPad);

  function syncTouchUI() {
    const on = mounted && isTouch();
    if (!on) { touchUI.remove(); return; }
    if (!touchUI.isConnected) document.documentElement.append(touchUI);
    pauseBtn.textContent = running ? '❚❚' : '▶';
    // no app do celular, pausado quem continua é o botão do próprio app
    pauseBtn.style.display = globalThis.PG_PLATFORM === 'web' && !running ? 'none' : 'flex';
    pad.style.display = running && isJumper() ? 'block' : 'none';
    wormPad.style.display = running && !isJumper() ? 'block' : 'none';
    // no celular o HUD vai para cima (embaixo ficam os botões).
    // PG_TOUCH_TOP: o app do celular avisa a altura da barra dele, para não cobrir o menu.
    // pausado no app do celular a barra dele volta: tudo desce para baixo dela (PG_BAR_H)
    const top = (running ? (globalThis.PG_TOUCH_TOP || 0) : (globalThis.PG_BAR_H ?? globalThis.PG_TOUCH_TOP ?? 0)) + 10;
    pauseBtn.style.top = top + 'px';
    hud.style.left = '62px'; hud.style.top = (top + 6) + 'px'; hud.style.bottom = 'auto';
    board.style.top = (top + 2) + 'px';
  }

  // dedo na tela: o bicho segue; o saltador mira e atira
  let pageStyle = null;
  addEventListener('pointerdown', (e) => {
    if (!running || e.pointerType === 'mouse' || isUI(e.target)) return;
    mouse.x = e.clientX; mouse.y = e.clientY; mouseIn = true;
    lastTouchAim = performance.now();
    if (isJumper()) J.shooting = true;
  }, { capture: true });
  addEventListener('pointermove', (e) => {
    if (!running || e.pointerType === 'mouse' || isUI(e.target)) return;
    mouse.x = e.clientX; mouse.y = e.clientY;
  }, { capture: true, passive: true });
  const touchEnd = (e) => { if (e.pointerType !== 'mouse' && !isUI(e.target)) J.shooting = false; };
  addEventListener('pointerup', touchEnd, { capture: true });
  addEventListener('pointercancel', touchEnd, { capture: true });
  // toque na página não abre link, não seleciona texto e não dá zoom
  addEventListener('touchstart', (e) => { if (running && !isUI(e.target)) e.preventDefault(); }, { passive: false, capture: true });
  function lockTouch(on) {
    const st = document.documentElement.style;
    if (on && !pageStyle) {
      pageStyle = { ta: st.touchAction, us: st.webkitUserSelect, us2: st.userSelect, ob: st.overscrollBehavior };
      st.touchAction = 'none'; st.webkitUserSelect = 'none'; st.userSelect = 'none';
      st.overscrollBehavior = 'none';                  // sem "puxar para atualizar" no meio do jogo
    } else if (!on && pageStyle) {
      st.touchAction = pageStyle.ta; st.webkitUserSelect = pageStyle.us; st.userSelect = pageStyle.us2;
      st.overscrollBehavior = pageStyle.ob;
      pageStyle = null;
    }
  }

  // ---------- Controles ----------
  function play() {
    if (!mounted) {
      mounted = true;
      document.documentElement.append(canvas, hud, board);
      resizeCanvas();
      resetCreature();
      if (isJumper()) initJumper();
      startScan();
      lastHeight = document.documentElement.scrollHeight;
    }
    canvas.style.display = 'block';
    hud.style.display = 'block';
    board.style.display = 'block';
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    allowedX = scrollX; allowedY = scrollY;          // trava onde a página está agora
    running = true;
    lastFrame = 0;
    if (!raf) raf = requestAnimationFrame(frame);
    if (S.multiplayer && netState === 'off') mpConnect();
    lockTouch(true);
    syncTouchUI();
    updateHud();
    notifyApp();
  }
  // avisa o app do celular que o jogo começou/parou (ele atualiza os botões na hora)
  function notifyApp() { if (globalThis.PG_PLATFORM === 'web') { try { dispatchEvent(new Event('pagegame-state')); } catch {} } }

  async function tryPlay() {
    if (dead) return false;
    if (await isLoggedIn()) { play(); return true; }
    if (mounted) hud.textContent = '🐛 entre na sua conta no menu para jogar';
    return false;
  }

  function pause() {
    if (running) flushScore();
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = null;
    observer.disconnect();
    jkeys.clear(); steerKeys.clear(); J.shooting = false;
    lockTouch(false);
    syncTouchUI();
    updateHud();
    notifyApp();
  }

  function restore() {
    pause();
    mpDisconnect();
    scoreGen++;
    sentScore.words = sentScore.images = sentScore.others = sentScore.enemies = sentScore.hits = sentScore.ms = 0;
    playMs = 0; maxLen = 0;
    clearEnemies();
    hits = 0; enemiesEaten = 0;
    if (eatenHL) eatenHL.clear();
    for (const [el, st] of objState) {
      st.op ? el.style.setProperty('opacity', st.op) : el.style.removeProperty('opacity');
      st.vis ? el.style.setProperty('visibility', st.vis) : el.style.removeProperty('visibility');
    }
    objState.clear();
    nodeData = new WeakMap();
    lru.clear();
    index = newIndex();
    scan = null;
    respawnQ.length = 0; loose.length = 0; eatBuf.clear();
    fills.length = 0; pendingFills.length = 0; fillBuf.length = 0; near = []; bursts.length = 0;
    grenades.length = 0; WD.trail.length = 0; shots.length = 0; shotBuf.length = 0; hitCooldown.clear(); shieldUntil = 0; boardKey = '';
    canvas.remove(); hud.remove(); board.remove(); touchUI.remove();
    mounted = false;
    resetCreature();
  }

  function status(extra = {}) {
    const ix = scan ? scan.ix : index;
    return {
      ...extra,
      mounted, running, scanning: !!scan, highlightSupported: hasHighlight,
      found: { words: ix.words, images: ix.images, others: ix.others, nodes: ix.n },
      eaten: { ...eaten, enemies: enemiesEaten }, hits, points: points(),
      difficulty: roomDifficulty(), difficultyName: DIFF_NAME[roomDifficulty()], enemyMax: diff().max, scanMs: Math.round(scan ? scan.ms : lastScanMs),
      net: netState, players: netState === 'online' ? peerCount + 1 : 0, bots: botCount(),
      account: account && { total_score: account.total_score, coins: account.coins },
    };
  }

  // Extensão recarregada ou removida: esta cópia fica órfã. Desmonta tudo
  // e devolve a página (a cópia nova é injetada no próximo Jogar).
  let dead = false;
  function kill() {
    if (dead) return;
    dead = true;
    try { restore(); } catch {}
    canvas.remove(); hud.remove(); board.remove(); touchUI.remove();
  }
  window.__pageGame.kill = kill;
  const aliveTimer = setInterval(() => { if (!alive()) { clearInterval(aliveTimer); kill(); } }, 1000);

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (dead) return false;           // cópia antiga: quem responde é a nova
    if (msg.cmd === 'play') {
      tryPlay().then((ok) => reply(status(ok ? {} : { needsLogin: true })));
      return true;                    // resposta assíncrona
    }
    if (msg.cmd === 'pause') pause();
    else if (msg.cmd === 'restore') restore();
    reply(status());
  });
})();
