// PageGame: inventário de armas (usado pelo menu da extensão e pelo app do celular).
// Mostra as armas da loja, as que você tem, qual está equipada e o saldo de
// moedas. Comprar/equipar chama as funções do banco (buy_item, equip_item).
// A arma equipada vai para chrome.storage.local.pgWeapon, que o jogo lê.
(() => {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => Number(n || 0).toLocaleString('pt-BR');
  const MSG = [
    [/moedas insuficientes/i, 'Moedas insuficientes.'],
    [/já tem/i, 'Você já tem essa arma.'],
    [/failed to fetch|network/i, 'Sem conexão.'],
  ];
  const nice = (e) => {
    const m = (e && e.message) || String(e);
    const hit = MSG.find(([re]) => re.test(m));
    return hit ? hit[1] : m;
  };

  async function load(sb) {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return null;
    const uid = session.user.id;
    const [items, inv, stats] = await Promise.all([
      sb.from('items').select('id,name,description,price,icon,rarity,sort_order').eq('kind', 'weapon').order('sort_order'),
      sb.from('inventory').select('item_id,quantity,equipped').eq('user_id', uid),
      sb.from('player_stats').select('coins').eq('user_id', uid).maybeSingle(),
    ]);
    const owned = new Map((inv.data || []).filter((r) => r.quantity > 0).map((r) => [r.item_id, r]));
    return { items: items.data || [], owned, coins: stats.data ? Number(stats.data.coins) : 0, error: items.error };
  }

  async function render(el, sb) {
    if (!el) return;
    let st;
    try { st = await load(sb); } catch (e) { el.innerHTML = `<p class="inv-note">${esc(nice(e))}</p>`; return; }
    if (!st) { el.innerHTML = ''; return; }
    if (!st.items.length) {
      // banco ainda sem as armas (migration_v19 não rodou): joga de pistola
      chrome.storage.local.set({ pgWeapon: 'pistola' });
      el.innerHTML = '<p class="inv-note">🔫 Pistola (a loja de armas ainda não está no banco).</p>';
      return;
    }
    const equipped = st.items.find((it) => st.owned.get(it.id) && st.owned.get(it.id).equipped);
    const current = equipped ? equipped.id : (st.owned.has('pistola') ? 'pistola' : 'pistola');
    chrome.storage.local.set({ pgWeapon: current });

    el.innerHTML = `<p class="inv-coins">🪙 ${fmt(st.coins)} moedas</p>` + st.items.map((it) => {
      const have = st.owned.has(it.id) || it.price === 0;
      const on = it.id === current;
      const btn = on ? '<span class="inv-on">Equipada</span>'
        : have ? `<button type="button" data-equip="${esc(it.id)}">Equipar</button>`
        : `<button type="button" data-buy="${esc(it.id)}" ${st.coins < it.price ? 'disabled' : ''}>🪙 ${fmt(it.price)}</button>`;
      return `<div class="inv-row${on ? ' on' : ''}">
        <span class="inv-icon">${esc(it.icon)}</span>
        <span class="inv-text"><b>${esc(it.name)}</b><small>${esc(it.description)}</small></span>
        ${btn}</div>`;
    }).join('') + '<p class="inv-msg" hidden></p>';

    const msg = (t) => { const p = el.querySelector('.inv-msg'); p.textContent = t; p.hidden = !t; };
    el.onclick = async (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      b.disabled = true;
      try {
        if (b.dataset.buy) {
          const { error } = await sb.rpc('buy_item', { p_item_id: b.dataset.buy, p_quantity: 1 });
          if (error) throw error;
        }
        const id = b.dataset.buy || b.dataset.equip;
        const { error } = await sb.rpc('equip_item', { p_item_id: id, p_equipped: true });
        if (error) throw error;
        chrome.storage.local.set({ pgWeapon: id });
        await render(el, sb);
      } catch (err) {
        b.disabled = false;
        msg(nice(err));
      }
    };
  }

  globalThis.PGInventory = { render };
})();
