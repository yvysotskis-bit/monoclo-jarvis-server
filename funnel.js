// Етап 11 (версія 2.4): воронка «Monoclo · Свій принт» у KeyCRM.
// J.A.R.V.I.S сам переставляє картки за подіями в чаті, переводить у «Нагадування» тих, хто мовчить,
// бере ціну з картки для чернеток, додає товар і суму в картку, позначає гарячі картки,
// кладе ТЗ дизайнеру в примітку, пропонує «Оплачено» і причину втрати (їх ставить Юрій),
// рахує конверсію етапів для коуча і пише блок воронки в ранковий брифінг.
// Картку для чату шукаємо за ім'ям: назва чату = нік або ім'я контакту в картці («Чат з …»).

const FUNNEL_DEFAULT_NAME = 'Monoclo · Свій принт';
const FUNNEL_STAGES = [
  { key: 'new', title: 'новий', rank: 0, label: 'Новий' },
  { key: 'consult', title: 'консультація / бриф', rank: 1, label: 'Консультація / бриф' },
  { key: 'price', title: 'ціна названа', rank: 2, label: 'Ціна названа' },
  { key: 'sketch', title: 'ескіз у роботі', rank: 3, label: 'Ескіз у роботі' },
  { key: 'sketch_sent', title: 'ескіз надіслано', rank: 4, label: 'Ескіз надіслано' },
  { key: 'invoice', title: 'виставлено рахунок', rank: 5, label: 'Виставлено рахунок' },
  { key: 'remind', title: 'нагадування', rank: -1, label: 'Нагадування' },
  { key: 'paid', title: 'оплачено', rank: 6, label: 'Оплачено', final: true },
  { key: 'lost_price', title: 'зник після ціни', lost: true, label: 'Зник після ціни' },
  { key: 'lost_sketch', title: 'зник після ескізу', lost: true, label: 'Зник після ескізу' },
  { key: 'lost_size', title: 'розмір', lost: true, label: 'Розмір' },
  { key: 'lost_expensive', title: 'дорого', lost: true, label: 'Дорого' },
  { key: 'lost_other', title: 'інше', lost: true, label: 'Інше' }
];
const STAGE = Object.fromEntries(FUNNEL_STAGES.map((s) => [s.key, s]));
const OPEN_KEYS = ['new', 'consult', 'price', 'sketch', 'sketch_sent', 'invoice', 'remind'];
const WAIT_KEYS = ['price', 'sketch_sent', 'invoice'];   // тут чекаємо на клієнта: тиша понад добу → «Нагадування»
const HOT_KEYS = ['sketch', 'sketch_sent', 'invoice'];   // передоплату внесено або рахунок виставлено
// Стара спільна воронка: картки Monoclo переносимо в нову, щойно ви працюєте з чатом.
const OLD_MAP = { 'новий': 'new', 'взято в роботу': 'consult', 'виставлено рахунок': 'invoice', 'нагадування що до замовлення': 'remind', 'індивідуальні замовлення': 'consult' };
const HOT_MARK = '🔥 ';
const AUTO_ITEM = /· свій принт$|^Друк на рукаві$|^Постер A[23]$/;
const manualProducts = (card) => (card.products || []).filter((p) => !AUTO_ITEM.test(p.name || ''));
const FDAY = 24 * 3600 * 1000;
const NUDGE_GAPS = [5 * FDAY, 8 * FDAY];   // після 1-го нагадування наступне за 5 днів, після 2-го за 8 (≈ два тижні разом)
const LOSS_AFTER_LAST = 3 * FDAY;            // після 3-го нагадування чекаємо ще 3 дні, потім пропонуємо закрити

const fnorm = (t) => String(t || '').toLowerCase().replace(/[’'`ʼ]/g, '').replace(/\s+/g, ' ').trim();
const nameKey = (t) => String(t || '').toLowerCase().replace(/^чат з\s+/i, '').replace(/[^\p{L}\p{N}]+/gu, '');

function kcStamp(ts) {
  return new Date(ts).toISOString().slice(0, 19).replace('T', ' ');
}
// Час для полів, які KeyCRM читає як київський (наступний контакт): інакше UTC виходить «у минулому».
function kcLocalStamp(ts) {
  return new Date(ts).toLocaleString('sv-SE', { timeZone: 'Europe/Kyiv', hour12: false }).slice(0, 19);
}

async function funnelCfg() {
  const s = await chrome.storage.local.get(['funnelOn', 'funnelName', 'shopSources']);
  return {
    on: s.funnelOn !== false,
    name: (s.funnelName || FUNNEL_DEFAULT_NAME).trim(),
    shopSources: String(s.shopSources != null ? s.shopSources : '212,198,216').split(',').map(Number).filter((x) => x > 0)
  };
}

const listOf = (d) => (d && Array.isArray(d.data) ? d.data : Array.isArray(d) ? d : []);

// ---------- Довідник: воронки, статуси, джерела ----------

let funnelMetaMem = null;

async function funnelMeta(force = false) {
  if (!force && funnelMetaMem && Date.now() - funnelMetaMem.at < 6 * 3600 * 1000) return funnelMetaMem;
  if (!force) {
    const { funnelMeta: saved } = await chrome.storage.local.get(['funnelMeta']);
    if (saved && Date.now() - saved.at < 6 * 3600 * 1000) { funnelMetaMem = saved; return saved; }
  }
  const cfg = await funnelCfg();
  const pipes = listOf(await keycrm('/pipelines?limit=50'));
  // Назва може прийти в полі name або title, з різними пробілами й крапками: порівнюємо лише літери й цифри.
  const pname = (p) => String(p.name || p.title || p.alias || '');
  const loose = (t) => nameKey(t);
  const target = pipes.find((p) => loose(pname(p)) === loose(cfg.name))
    || pipes.find((p) => /monoclo/i.test(pname(p)) && /принт/i.test(pname(p)));
  if (!target) {
    const seen = pipes.map((p) => `«${pname(p) || 'id ' + p.id}»`).join(', ') || 'жодної';
    throw new Error(`Не знайшов воронку «${cfg.name}». KeyCRM API бачить: ${seen}.`);
  }
  const meta = { at: Date.now(), pipelineId: target.id, pipelineName: pname(target), ids: {}, byId: {}, old: [], sources: [], missing: [],
    // Чи створює «Оплачено» нове замовлення (налаштування воронки «Дія з успішною карткою»).
    createsOrder: target.target_type ? /order/i.test(String(target.target_type)) : (await chrome.storage.local.get(['funnelCreatesOrder'])).funnelCreatesOrder !== false,
    targetType: target.target_type || '' };
  const sts = listOf(await keycrm(`/pipelines/${target.id}/statuses?limit=50`));
  for (const st of sts) {
    const stage = FUNNEL_STAGES.find((x) => x.title === fnorm(st.title || st.name));
    if (stage) { meta.ids[stage.key] = st.id; meta.byId[st.id] = stage.key; }
  }
  meta.missing = FUNNEL_STAGES.filter((x) => !meta.ids[x.key]).map((x) => x.label);
  for (const p of pipes.filter((x) => x.id !== target.id)) {
    const map = {};
    for (const st of listOf(await keycrm(`/pipelines/${p.id}/statuses?limit=50`))) {
      const k = OLD_MAP[fnorm(st.title || st.name)];
      if (k) map[st.id] = k;
    }
    if (Object.keys(map).length) meta.old.push({ id: p.id, name: pname(p), map });
  }
  let src = [];
  try { src = listOf(await keycrm('/order/source?limit=50')).filter((x) => /monoclo|моноклo|моноклo/i.test(`${x.name || ''} ${x.alias || ''}`)).map((x) => x.id); } catch (_) { src = []; }
  meta.sources = [...new Set([...src, ...cfg.shopSources])];
  funnelMetaMem = meta;
  await chrome.storage.local.set({ funnelMeta: meta });
  return meta;
}

// ---------- Кеш карток ----------

function cardNames(c) {
  const out = new Set();
  const t = nameKey(c.title);
  if (t) out.add(t);
  const ct = c.contact || {};
  for (const v of [ct.full_name, ct.social_name, ct.client && ct.client.full_name]) { const k = nameKey(v); if (k) out.add(k); }
  return [...out];
}

// Сума картки: ваші товари повністю, а з доданих J.A.R.V.I.S лише один виріб (кілька означають помилковий перелік цін).
function cardTotal(products) {
  const own = products.filter((p) => !AUTO_ITEM.test(p.name || ''));
  const auto = products.filter((p) => AUTO_ITEM.test(p.name || ''));
  const sum = (list) => list.reduce((s, p) => s + p.price * (p.quantity || 1), 0);
  return sum(own) + (auto.length === 1 ? sum(auto) : 0);
}

function slimCard(c, meta, oldMap) {
  const key = meta.byId[c.status_id] || (oldMap && oldMap[c.status_id]) || null;
  const products = (c.products || []).map((p) => ({ name: p.name, price: Number(p.price) || 0, quantity: Number(p.quantity) || 1 }));
  return {
    id: c.id,
    title: c.title || '',
    names: cardNames(c),
    statusId: c.status_id,
    key,
    inNew: !!meta.byId[c.status_id],
    sourceId: c.source_id || null,
    clientId: (c.contact && (c.contact.client_id || (c.contact.client && c.contact.client.id))) || null,
    changedAt: kcTime(c.status_changed_at) || kcTime(c.updated_at),
    statusAt: kcTime(c.status_changed_at) || null,   // лише справжня зміна етапу; updated_at міняє будь-яка правка картки
    createdAt: kcTime(c.created_at),
    products,
    total: cardTotal(products)
  };
}

async function fetchCards(filter, pages, meta, oldMap) {
  const out = [];
  for (let page = 1; page <= pages; page++) {
    const q = Object.entries(filter).map(([k, v]) => `filter[${k}]=${encodeURIComponent(v)}`).join('&');
    const d = await keycrm(`/pipelines/cards?limit=50&page=${page}&include=contact,products&${q}`);
    const rows = listOf(d);
    for (const c of rows) out.push(slimCard(c, meta, oldMap));
    if (rows.length < 50) break;
  }
  return out;
}

async function funnelLog(entry) {
  const { funnelLog: log = [] } = await chrome.storage.local.get(['funnelLog']);
  log.push(Object.assign({ at: Date.now() }, entry));
  const cut = Date.now() - 120 * FDAY;
  await chrome.storage.local.set({ funnelLog: log.filter((x) => x.at > cut).slice(-3000) });
}

let syncLock = null;
async function syncFunnel(full = true) {
  if (syncLock) return syncLock;
  syncLock = (async () => {
    const meta = await funnelMeta();
    const { funnelCards: prev = {} } = await chrome.storage.local.get(['funnelCards']);
    const openIds = OPEN_KEYS.map((k) => meta.ids[k]).filter(Boolean).join(',');
    const cards = await fetchCards({ pipeline_id: meta.pipelineId, status_id: openIds }, 4, meta);
    if (full) {
      for (const o of meta.old) {
        const ids = Object.keys(o.map).join(',');
        const f = { pipeline_id: o.id, status_id: ids };
        if (meta.sources.length) f.source_id = meta.sources.join(',');
        try { cards.push(...(await fetchCards(f, 3, meta, o.map))); } catch (_) { /* стара воронка не критична */ }
      }
      // Закриті за 35 днів: для конверсії і причин втрат.
      const finals = FUNNEL_STAGES.filter((x) => x.final || x.lost).map((x) => meta.ids[x.key]).filter(Boolean).join(',');
      try {
        const from = kcStamp(Date.now() - 35 * FDAY);
        const closed = await fetchCards({ pipeline_id: meta.pipelineId, status_id: finals, updated_between: `${from}, ${kcStamp(Date.now() + 60000)}` }, 2, meta);
        await chrome.storage.local.set({ funnelClosed: { at: Date.now(), cards: closed } });
      } catch (_) { /* не критично */ }
    }
    const next = {};
    for (const c of cards) {
      next[c.id] = c;
      const p = prev[c.id];
      if (p && p.key !== c.key && c.inNew) await funnelLog({ id: c.id, from: p.key, to: c.key, by: 'crm' });
    }
    // Картки, що зникли з відкритих (закрили в KeyCRM руками), лишаємо в кеші стару нову воронку не чіпаючи.
    if (!full) for (const [id, c] of Object.entries(prev)) if (!next[id] && !c.inNew) next[id] = c;
    if (full) { try { await checkOrders(next, meta); } catch (_) { /* не критично */ } }
    await chrome.storage.local.set({ funnelCards: next, funnelSyncAt: Date.now(), funnelSyncFullAt: full ? Date.now() : ((await chrome.storage.local.get(['funnelSyncFullAt'])).funnelSyncFullAt || 0) });
    return next;
  })();
  try { return await syncLock; } finally { syncLock = null; }
}

let lastQuickSync = 0;
async function findCard(name) {
  const k = nameKey(name);
  if (!k) return null;
  const pickFrom = (cards) => Object.values(cards).filter((c) => c.names.includes(k)).sort((a, b) => (b.inNew - a.inNew) || (b.createdAt - a.createdAt))[0] || null;
  let { funnelCards = {}, funnelSyncFullAt = 0 } = await chrome.storage.local.get(['funnelCards', 'funnelSyncFullAt']);
  let c = pickFrom(funnelCards);
  if (c) return c;
  if (Date.now() - lastQuickSync > 60000) {
    lastQuickSync = Date.now();
    funnelCards = await syncFunnel(Date.now() - funnelSyncFullAt > 30 * 60000);
    c = pickFrom(funnelCards);
  }
  return c;
}

async function fstate(id) {
  const { funnelState = {} } = await chrome.storage.local.get(['funnelState']);
  return funnelState[id] || {};
}
async function setFstate(id, patch) {
  const { funnelState = {} } = await chrome.storage.local.get(['funnelState']);
  funnelState[id] = Object.assign({}, funnelState[id] || {}, patch, { touched: Date.now() });
  // Старі записи (понад 90 днів без змін) прибираємо.
  const cut = Date.now() - 90 * FDAY;
  for (const [k, v] of Object.entries(funnelState)) if ((v.touched || 0) < cut) delete funnelState[k];
  await chrome.storage.local.set({ funnelState });
  return funnelState[id];
}

async function saveCardCache(card) {
  const { funnelCards = {} } = await chrome.storage.local.get(['funnelCards']);
  funnelCards[card.id] = card;
  await chrome.storage.local.set({ funnelCards });
}

// Переставляє картку. Статус з нової воронки переносить картку і зі старої.
async function setStage(card, key, { by = 'jarvis', communicateAt, note } = {}) {
  const meta = await funnelMeta();
  const sid = meta.ids[key];
  if (!sid) throw new Error(`У воронці немає статусу «${STAGE[key] ? STAGE[key].label : key}».`);
  const body = { status_id: sid };
  if (communicateAt) body.communicate_at = kcLocalStamp(Math.max(communicateAt, Date.now() + 10 * 60000));
  if (note) body.note = note;
  const hot = HOT_KEYS.includes(key);
  if (hot && card.title && !card.title.startsWith(HOT_MARK)) body.title = HOT_MARK + card.title;
  try {
    await keycrm(`/pipelines/cards/${card.id}`, { method: 'PUT', body });
  } catch (e) {
    // Час контакту не критичний: якщо KeyCRM його не приймає, міняємо лише етап.
    if (!body.communicate_at) throw e;
    delete body.communicate_at;
    await keycrm(`/pipelines/cards/${card.id}`, { method: 'PUT', body });
    await chrome.storage.local.set({ funnelLastPutErr: `${card.id}: ${e.message}` });
  }
  const from = card.inNew ? card.key : `old:${card.key || ''}`;
  const next = Object.assign({}, card, { key, statusId: sid, inNew: true, changedAt: Date.now(), title: body.title || card.title });
  await saveCardCache(next);
  const st0 = await fstate(card.id);
  await funnelLog(Object.assign({ id: card.id, from, to: key, by }, STAGE[key] && STAGE[key].lost && st0.reason ? { reason: st0.reason } : {}));
  // Клієнт пішов далі (передоплата, ескіз, рахунок): заперечення відпрацьоване, причину знімаємо.
  if (st0.reason && STAGE[key] && !STAGE[key].lost && STAGE[key].rank >= STAGE.sketch.rank) await setFstate(card.id, { reason: null, reasonQuote: null });
  // Тест нагадувань A/B: картка після нагадування дійшла до ескізу чи далі — варіант спрацював.
  if (st0.abVar && !st0.abWon && STAGE[key] && !STAGE[key].lost && STAGE[key].rank >= STAGE.sketch.rank) await setFstate(card.id, { abWon: true, abWonAt: Date.now() });
  return next;
}

// ---------- Замовлення клієнта вже є: закриваємо картку без дубля ----------
// Шукаємо в KeyCRM замовлення того самого покупця, створені після появи картки.
async function checkOrders(cards, meta) {
  const open = Object.values(cards).filter((c) => c.inNew && c.clientId && OPEN_KEYS.includes(c.key));
  if (!open.length) return;
  const from = Math.max(Math.min(...open.map((c) => c.createdAt || Date.now())) - 2 * FDAY, Date.now() - 45 * FDAY);
  const byBuyer = {};
  for (let page = 1; page <= 4; page++) {
    const d = await keycrm(`/order?limit=50&page=${page}&include=buyer,payments&filter[created_between]=${encodeURIComponent(kcStamp(from) + ', ' + kcStamp(Date.now() + 60000))}`);
    const rows = listOf(d);
    for (const o of rows) {
      const bid = (o.buyer && o.buyer.id) || o.buyer_id || o.client_id;
      if (!bid) continue;
      const paidSum = (o.payments || []).filter((p) => !p.status || p.status === 'paid').reduce((s, p) => s + (Number(p.amount) || 0), 0);
      const ps = String(o.payment_status || '');
      (byBuyer[bid] = byBuyer[bid] || []).push({ id: o.id, at: kcTime(o.created_at), paid: /^(paid|overpaid|part_paid)$/.test(ps) || paidSum > 0 });
    }
    if (rows.length < 50) break;
  }
  const { funnelState = {} } = await chrome.storage.local.get(['funnelState']);
  for (const c of open) {
    const orders = (byBuyer[c.clientId] || []).filter((o) => !c.createdAt || o.at >= c.createdAt - 2 * FDAY).sort((a, b) => b.at - a.at);
    if (!orders.length) continue;
    const o = orders.find((x) => x.paid) || orders[0];
    const st = funnelState[c.id] || {};
    const patch = { orderId: o.id, orderPaid: o.paid };
    try {
      if (o.paid && !meta.createsOrder) {
        cards[c.id] = await setStage(c, 'paid', { by: 'order' });
        Object.assign(patch, { suggest: null, prev: null });
      } else if (o.paid) {
        patch.suggest = null;   // «Оплачено» тут створило б дубль: показуємо, що замовлення вже є
      } else if (STAGE[c.key].rank >= 0 && STAGE[c.key].rank < STAGE.invoice.rank) {
        cards[c.id] = await setStage(c, 'invoice', { by: 'order' });
      }
    } catch (_) { /* наступного разу */ }
    if (st.orderId !== patch.orderId || st.orderPaid !== patch.orderPaid || patch.suggest === null) await setFstate(c.id, patch);
  }
}

// ---------- Розпізнавання подій у повідомленнях менеджера ----------

const PRICE_ITEMS = [
  { re: /дитяч\S*\s+футболк/i, name: 'Дитяча футболка · свій принт', price: 950 },
  { re: /\bA3\b|А3/i, name: 'Постер A3', price: 1350, cat: { product: 'Постер з Індивідуальним принтом', seed: 'SK19037596', sku: /^SK19037596$/ } },
  { re: /\bA2\b|А2/i, name: 'Постер A2', price: 1550, cat: { product: 'Постер з Індивідуальним принтом', seed: 'SK19037596', sku: /^SK95425183$/ } },
  { re: /худі|худи|hoodie/i, name: 'Худі · свій принт', price: 2450, cat: { product: 'Індивідуальний Принт Monoclo', seed: 'IND-MC-0001', sku: /^IND-MC-\d/ } },
  { re: /футболк|футболоч|t-?shirt/i, name: 'Футболка · свій принт', price: 1450, cat: { product: 'Індивідуальний Принт Monoclo', seed: 'IND-MC-0001', sku: /^IND-MC-TS-/ } }
];

function amountsIn(text) {
  return [...String(text || '').matchAll(/(\d[\d\s]{1,6}\d)\s*(грн|гривень|гривні|гривня|₴|uah)/gi)].map((m) => Number(m[1].replace(/\s/g, ''))).filter((n) => n >= 100 && n <= 100000);
}

// Товари для картки з тексту, де названо ціну. Сума поруч із назвою виробу важливіша за стандартну.
const CUSTOM_PRICES = [950, 1350, 1450, 1550, 2450];
function itemsFromText(text) {
  const t = String(text || '');
  const out = [];
  // Перелік цін (шаблон «футболка 1450, худі 2450») — це не замовлення: товар додаємо, лише коли згадано один виріб.
  const kinds = PRICE_ITEMS.filter((x) => x.re.test(t)).length;
  if (kinds !== 1) return [];
  if (!/принт|ескіз|макет|дизайн/i.test(t) && !amountsIn(t).some((n) => CUSTOM_PRICES.includes(n))) return [];
  for (const sentence of t.split(/(?<=[.!?\n])/)) {
    const hit = PRICE_ITEMS.find((x) => x.re.test(sentence));
    if (!hit) continue;
    const nums = amountsIn(sentence);
    const price = nums.find((n) => n >= 500 && (CUSTOM_PRICES.includes(n) || /принт|ескіз|макет/i.test(t))) || null;
    if (price && !out.some((o) => o.name === hit.name)) out.push({ name: hit.name, price, quantity: 1, cat: hit.cat || null });
  }
  if (/рукав/i.test(t) && /\+\s?200|200\s*грн/i.test(t) && out.length) out.push({ name: 'Друк на рукаві', price: 200, quantity: 1 });
  return out;
}


// ---------- Товари з каталогу KeyCRM ----------
// Замість вільного тексту «Худі · свій принт» додаємо справжній варіант із каталогу (за артикулом),
// тоді сума, собівартість і аналітика товарів у KeyCRM збігаються.
const SIZE_RE = /\b(XXS|XS|S|M|L|XL|XXL|2XL|3XL)\b/i;
const COLOR_MAP = [[/чорн|black/i, 'чорн'], [/біл|white/i, 'біл'], [/графіт/i, 'графіт'], [/сір|grey|gray/i, 'сір'], [/рожев|pink/i, 'рожев']];
let _offerCache = { at: 0, rows: [] };

async function customOffers() {
  if (Date.now() - _offerCache.at < 6 * 3600 * 1000 && _offerCache.rows.length) return _offerCache.rows;
  // Товар знаходимо за одним відомим артикулом, потім беремо всі його варіанти.
  const seeds = {};
  PRICE_ITEMS.filter((x) => x.cat).forEach((x) => { seeds[x.cat.product] = x.cat.seed; });
  const rows = [];
  for (const [name, seed] of Object.entries(seeds)) {
    const first = await keycrmOffer(seed);
    const pid = first && (first.product_id || (first.product && first.product.id));
    if (!pid) continue;
    for (let page = 1; page <= 3; page++) {
      const r = await keycrm(`/offers?filter[product_id]=${pid}&limit=50&page=${page}`);
      const list = (r && r.data) || [];
      list.forEach((o) => rows.push({ sku: String(o.sku || ''), price: Number(o.price) || 0, product: name, props: (o.properties || []).map((x) => `${x.name}: ${x.value}`).join('; ') }));
      if (list.length < 50) break;
    }
    if (!rows.some((o) => o.product === name)) rows.push({ sku: seed, price: Number(first.price) || 0, product: name, props: '' });
  }
  _offerCache = { at: Date.now(), rows };
  return rows;
}

function pickOffer(rows, cat, hint) {
  const list = rows.filter((o) => o.product === cat.product && cat.sku.test(o.sku));
  if (!list.length) return null;
  const size = (String(hint || '').match(SIZE_RE) || [])[1];
  const sz = size ? size.toUpperCase().replace(/^2XL$/, 'XXL') : null;
  const col = (COLOR_MAP.find(([re]) => re.test(hint || '')) || [])[1];
  const score = (o) => {
    const p = o.props.toLowerCase();
    let s = 0;
    if (sz && new RegExp(`(розмір|size)[^;]*\\b${sz.toLowerCase()}\\b`).test(p)) s += 2;
    if (col && p.includes(col)) s += 1;
    if (!sz && /\bm\b/.test(p)) s += 0.5;      // розмір ще не відомий: беремо M як середній
    if (!col && p.includes('чорн')) s += 0.25;
    return s;
  };
  return list.slice().sort((a, b) => score(b) - score(a))[0];
}

async function catalogItems(items, hint) {
  let rows = [];
  try { rows = await customOffers(); } catch (_) { rows = []; }
  return items.map((it) => {
    const o = it.cat && pickOffer(rows, it.cat, hint);
    if (!o) return { name: it.name, price: it.price, quantity: it.quantity };
    return { sku: o.sku, name: it.cat.product, price: it.price, quantity: it.quantity };
  });
}

async function addItemsToCard(card, items, hint) {
  const body = await catalogItems(items, hint);
  await keycrm(`/pipelines/cards/${card.id}`, { method: 'PUT', body: { products: body } });
  const products = body.map((p) => ({ name: p.name, price: p.price, quantity: p.quantity }));
  card = Object.assign({}, card, { products, total: cardTotal(products) });
  await saveCardCache(card);
  return card;
}

function classifyMine(text, hasImage) {
  const t = String(text || '');
  const found = new Set();
  if (/оплат\S*\s+(отримав|отримали|надійшл|прийшл)|отримав\S*\s+(вашу\s+)?оплат|замовлення прийнято|передав замовлення у виробництво|передаю (замовлення )?у виробництво/i.test(t)) found.add('paid');
  if (/(передоплат\S*|200\s*грн)[\s\S]{0,80}(отримав|надійшл|прийшл|бачу)|(отримав|надійшл|прийшл|бачу)[\s\S]{0,50}(передоплат|200\s*грн)|передав\S*\s+(ваш\S*\s+)?(запит|бриф|ідею|фото)?\s*дизайнер|дизайнер\S*\s+(вже\s+)?(взяв|узяв|почав|малює|працює)/i.test(t)) found.add('sketch');
  if (/ескіз\S*\s+(готов|підготував)|дизайнер\S*\s+підготував|ось\s+(ваш\S*\s+)?(ескіз|макет)/i.test(t) || (hasImage && /ескіз|макет/i.test(t))) found.add('sketch_sent');
  if (/UA\d{2}\s?\d{4}|4035\s?2000\s?4102\s?9528|реквізит|посиланн\S*\s+на\s+оплат|pay\.mbnk|send\.monobank|monobank\.ua\/(pay|chast)/i.test(t)) found.add('invoice');
  if (/\b(1\s?450|2\s?450|950|1\s?350|1\s?550)\s*(грн|гривень|гривні|₴)/i.test(t) || (amountsIn(t).some((n) => n >= 500) && /коштує|ціна|вартість|буде|виходить|за\s+\d/i.test(t))) found.add('price');
  return found;
}


// ---------- Причина відмови з повідомлень клієнта ----------
// «Дорого» і «розмір» — це заперечення: картку не закриваємо одразу, менеджер ще може відпрацювати.
// Причина запам'ятовується і використовується, коли картка піде у втрату. Пряма відмова одразу дає кнопку «Закрити».
const REASON_LABEL = { lost_expensive: 'дорого', lost_size: 'розмір', lost_other: 'відмова', think: 'думає' };
const R_NOT_EXP = /не\s+(так\s+|аж\s+)?дорог|недорог/i;
const R_EXP = /дорог|дорага|задорого|не по кишені|не потягну|бюджет|дешевш|за так[іу] (гроші|ціну)|(нема|немає|не маю)\s+(зараз\s+)?грошей|грошей\s+(нема|немає)|багатувато|многовато|ціна кусає|(завелик|висок|велик)\S*\s+ціна|ціна\s+(завелик|висок|велик)/i;
const R_SIZE = /немає?\s+(мого\s+|потрібного\s+|такого\s+)?розміру|нема\s+(мого\s+|потрібного\s+)?розміру|не\s+мій\s+розмір|розмір\S*\s+не\s+(підійде|підходить|той|сяде)|не\s+(сяде|налізе|підійде по розміру)|маломір|великомір|(замал|завелик)\S*\s+(буде|на мене|для мене|мені)/i;
const R_REFUSE = /^\s*(ні,?\s*|дякую,?\s*)?(вже\s+)?не\s+(треба|потрібно|актуально)[.!)\s]*$|не\s+(актуально|цікаво|буду\s+замовля)|неактуальн|передумал|передумав|відмовл|вже\s+не\s+(треба|потрібно|хочу|актуально)|(знайшл|замовил|купил)\S*\s+(в|у|в іншому|деінде)\s*інш|деінде|іншим разом|^\s*(ні,?\s*)?не хочу[.!\s]*$|ні,?\s+дякую|дякую,?\s+ні\b/i;
const R_THINK = /подума(ю|ти|єм|ємо|ю ще)|порад(жусь|юсь|итись|итися)|(напишу|відпишу|відповім)\s+(пізніше|потім|згодом|ввечері|завтра)|дам знати|ще не вирішил|вирішу|подумать|посоветуюсь/i;

function reasonFromClient(texts) {
  const recent = (texts || []).map((t) => String(t || '')).filter(Boolean).slice(-5);
  if (!recent.length) return null;
  const f = { exp: null, size: null, refuse: null, think: null };
  for (let i = recent.length - 1; i >= 0; i--) {
    const t = recent[i];
    if (!f.exp && R_EXP.test(t) && !R_NOT_EXP.test(t)) f.exp = t;
    if (!f.size && R_SIZE.test(t)) f.size = t;
    if (!f.refuse && R_REFUSE.test(t)) f.refuse = t;
    if (!f.think && R_THINK.test(t)) f.think = t;
  }
  const key = f.exp ? 'lost_expensive' : f.size ? 'lost_size' : f.refuse ? 'lost_other' : f.think ? 'think' : null;
  if (!key) return null;
  const src = f.exp || f.size || f.refuse || f.think;
  return { key, refused: !!f.refuse, quote: src.replace(/\s+/g, ' ').trim().slice(0, 120) };
}

// Записує причину в стан картки. Повертає patch для setFstate.
function reasonPatch(card, st, texts) {
  if (!card || !card.inNew || !card.key || !OPEN_KEYS.includes(card.key)) return {};
  const r = reasonFromClient(texts);
  if (!r) return {};
  const patch = {};
  if (st.reason !== r.key || st.reasonQuote !== r.quote) Object.assign(patch, { reason: r.key, reasonQuote: r.quote, reasonAt: Date.now() });
  if (r.refused && st.suggest !== 'paid' && !(st.suggest && STAGE[st.suggest] && STAGE[st.suggest].lost)) {
    patch.suggest = r.key === 'think' ? 'lost_other' : r.key;
  }
  return patch;
}

function nextNudgeAt(nudges) {
  const gap = NUDGE_GAPS[Math.min(nudges - 1, NUDGE_GAPS.length - 1)] || NUDGE_GAPS[0];
  return Date.now() + gap;
}

function lossFor(prev, reason) {
  if (reason === 'lost_expensive' || reason === 'lost_size') return reason;
  if (prev === 'sketch_sent') return 'lost_sketch';
  if (prev === 'invoice') return 'lost_other';
  return 'lost_price';
}

async function cardView(card) {
  if (!card) return null;
  const st = await fstate(card.id);
  const meta = await funnelMeta();
  return {
    id: card.id,
    key: card.key,
    label: card.key && STAGE[card.key] ? STAGE[card.key].label : 'стара воронка',
    inNew: card.inNew,
    total: card.total,
    products: card.products,
    hot: HOT_KEYS.includes(card.key),
    nudges: st.nudges || 0,
    prev: st.prev || null,
    suggest: st.suggest || null,
    orderId: st.orderId || null,
    orderPaid: !!st.orderPaid,
    createsOrder: meta.createsOrder,
    suggestLabel: st.suggest && STAGE[st.suggest] ? STAGE[st.suggest].label : '',
    reason: st.reason ? REASON_LABEL[st.reason] || null : null,
    reasonQuote: st.reasonQuote || '',
    stages: FUNNEL_STAGES.filter((x) => meta.ids[x.key]).map((x) => ({ key: x.key, label: x.label, lost: !!x.lost, final: !!x.final }))
  };
}

// Повідомлення менеджера пішло клієнту.
async function onMineSent({ name, text, transcript }) {
  const cfg = await funnelCfg();
  if (!cfg.on) return { off: true };
  let card = await findCard(name);
  if (!card) return { card: null };
  const st = await fstate(card.id);
  const found = classifyMine(text, false);
  const patch = { lastMineAt: Date.now() };
  let target = null;
  for (const k of ['invoice', 'sketch_sent', 'sketch', 'price']) if (found.has(k)) { target = k; break; }

  if (!card.inNew) {
    // Переносимо з MS\MC 25: етап зі старої воронки або вищий, якщо повідомлення показує прогрес.
    const base = card.key || 'consult';
    const to = target && STAGE[target].rank > (STAGE[base].rank || 0) ? target : base === 'new' ? 'consult' : base;
    card = await setStage(card, to, { by: 'migrate' });
    if (to === 'remind') patch.prev = 'consult';
  } else if (card.key === 'remind') {
    if (target && STAGE[target].rank > (STAGE[st.prev || 'consult'].rank || 0)) {
      card = await setStage(card, target);
      patch.prev = null; patch.nudges = 0; patch.suggest = null;
    } else {
      // Повідомлення в «Нагадуванні» рахуємо як нагадування.
      const n = (st.nudges || 0) + 1;
      patch.nudges = n; patch.lastNudgeAt = Date.now();
      if (n < 3) {
        try { await keycrm(`/pipelines/cards/${card.id}`, { method: 'PUT', body: { communicate_at: kcLocalStamp(nextNudgeAt(n)) } }); } catch (_) { /* не критично */ }
      }
    }
  } else if (card.key && STAGE[card.key].rank >= 0) {
    const cur = STAGE[card.key].rank;
    const to = target && STAGE[target].rank > cur ? target : card.key === 'new' ? 'consult' : null;
    if (to) card = await setStage(card, to);
  }

  if (found.has('paid') && card.key !== 'paid') patch.suggest = 'paid';

  // Сума в картці: додаємо товар, лише якщо в картці ще порожньо (API не оновлює, а додає товари).
  if (!card.products.length) {
    const items = itemsFromText(text);
    if (items.length) {
      try {
        card = await addItemsToCard(card, items, text);
      } catch (_) { /* не критично */ }
    }
  }

  // ТЗ дизайнеру в примітку картки, щойно картка вперше дійшла до «Ескіз у роботі».
  if (card.key === 'sketch' && !st.briefDone && transcript) {
    patch.briefDone = true;
    designerBrief({ transcript }).then(async (b) => {
      if (b && b.brief) {
        try { await keycrm(`/pipelines/cards/${card.id}`, { method: 'PUT', body: { note: `ТЗ дизайнеру (J.A.R.V.I.S):\n${b.brief}` } }); } catch (_) { /* ignore */ }
        if (await funnelBriefToTg()) { try { await tgSend(`J.A.R.V.I.S · ТЗ дизайнеру · ${name}\n\n${b.brief}`); } catch (_) { /* ignore */ } }
      }
    }).catch(() => {});
  }
  await setFstate(card.id, patch);
  return { card: await cardView(card) };
}

async function funnelBriefToTg() {
  const { funnelBriefTg } = await chrome.storage.local.get(['funnelBriefTg']);
  return funnelBriefTg === true;
}

async function catchUp(card, mine, transcript) {
  const st = await fstate(card.id);
  // Те саме вже розбирали: пропускаємо.
  const sig = mine.map((m) => (m.text || '').slice(0, 40) + (m.img ? '#' : '')).join('|');
  if (st.seenSig === sig && card.inNew) return card;
  let best = null;
  let sawSketch = false;
  const found = new Set();
  for (const m of mine) {
    const f = classifyMine(m.text, m.img);
    f.forEach((k) => found.add(k));
    if (f.has('sketch')) sawSketch = true;
    if (m.img && sawSketch) found.add('sketch_sent');
  }
  for (const k of ['invoice', 'sketch_sent', 'sketch', 'price']) if (found.has(k)) { best = k; break; }
  if (!best && mine.some((m) => (m.text || '').length > 0 || m.img)) best = 'consult';
  const patch = { seenSig: sig };
  const curKey = card.inNew ? card.key : card.key || 'consult';
  const curRank = curKey === 'remind' ? STAGE[st.prev || 'consult'].rank : STAGE[curKey] ? STAGE[curKey].rank : 0;
  if (!card.inNew && curKey === 'remind') {
    // Зі старого «Нагадування»: у нову воронку на етап, до якого дійшла переписка; таймер сам поверне в «Нагадування».
    const to = best && STAGE[best].rank > 0 ? best : 'consult';
    card = await setStage(card, to, { by: 'migrate' });
  } else if (best && (STAGE[best].rank > curRank || !card.inNew) && curKey !== 'remind') {
    const to = !card.inNew && STAGE[best].rank <= curRank ? (curKey === 'new' ? 'consult' : curKey) : best;
    card = await setStage(card, to, { by: 'catchup' });
  }
  if (found.has('paid') && card.key !== 'paid') patch.suggest = 'paid';
  if (!card.products.length) {
    for (const m of mine) {
      const items = itemsFromText(m.text);
      if (!items.length) continue;
      try {
        card = await addItemsToCard(card, items, mine.map((x) => x.text).join("\n"));
      } catch (_) { /* ignore */ }
      break;
    }
  }
  await setFstate(card.id, patch);
  return card;
}

// Прев'ю в списку чатів: відповідь іншого менеджера. Лише рух уперед за явними фразами менеджера.
async function onPreview({ name, text }) {
  const cfg = await funnelCfg();
  if (!cfg.on) return { off: true };
  const found = classifyMine(text, false);
  if (!found.size) return {};
  let card = await findCard(name);
  if (!card) return {};
  const st = await fstate(card.id);
  let target = null;
  for (const k of ['invoice', 'sketch_sent', 'sketch', 'price']) if (found.has(k)) { target = k; break; }
  const patch = { lastMineAt: Date.now() };
  const curKey = card.inNew ? card.key : card.key || 'consult';
  const curRank = curKey === 'remind' ? STAGE[st.prev || 'consult'].rank : STAGE[curKey] ? STAGE[curKey].rank : 0;
  if (target && (STAGE[target].rank > curRank || !card.inNew)) {
    card = await setStage(card, STAGE[target].rank > curRank ? target : curKey === 'new' ? 'consult' : curKey, { by: 'preview' });
    if (curKey === 'remind') { patch.prev = null; patch.nudges = 0; patch.suggest = null; }
  }
  if (found.has('paid') && card.key !== 'paid') patch.suggest = 'paid';
  if (!card.products.length) {
    const items = itemsFromText(text);
    if (items.length) {
      try {
        card = await addItemsToCard(card, items, text);
      } catch (_) { /* ignore */ }
    }
  }
  await setFstate(card.id, patch);
  return { moved: card.key };
}

// Повна історія картки (внутрішній запит KeyCRM з вкладки): точні часи і всі відповіді менеджерів.
async function onHistory({ cardId, messages }) {
  const cfg = await funnelCfg();
  if (!cfg.on || !Array.isArray(messages) || !messages.length) return {};
  if (typeof SERVER_MODE === 'undefined' && (await chrome.storage.local.get(['funnelServer'])).funnelServer) return { server: true };
  const { funnelCards = {} } = await chrome.storage.local.get(['funnelCards']);
  let card = funnelCards[cardId];
  if (!card) return {};
  // Лише переписка цієї картки: старі розмови постійного клієнта не мають рухати нову картку.
  if (card.createdAt) messages = messages.filter((m) => !m.at || m.at >= card.createdAt - 3600000);
  if (!messages.length) return {};
  const mine = messages.filter((m) => m.mine === true);
  const client = messages.filter((m) => m.mine === false);
  const lastMine = mine.length ? mine[mine.length - 1].at : 0;
  const lastClient = client.length ? client[client.length - 1].at : 0;
  if (mine.length) card = await catchUp(card, mine.slice(-30), '');
  const st = await fstate(card.id);
  const patch = {};
  if (lastMine) patch.lastMineAt = lastMine;
  if (lastClient) patch.lastClientAt = lastClient;
  // Причину шукаємо лише в репліках клієнта після останньої відповіді менеджера і трохи раніше.
  Object.assign(patch, reasonPatch(card, st, client.slice(-5).map((m) => m.text)));
  if (card.inNew && card.key === 'remind') {
    const since = st.remindAt || card.changedAt || 0;
    if (lastClient > since && lastClient >= lastMine) {
      card = await setStage(card, st.prev && st.prev !== 'remind' && OPEN_KEYS.includes(st.prev) ? st.prev : 'consult', { by: 'reply' });
      Object.assign(patch, { prev: null, nudges: 0, suggest: null });
    } else {
      // Нагадування: скільки разів менеджер писав після переходу в «Нагадування».
      const n = mine.filter((m) => m.at > since).length;
      if (n > (st.nudges || 0)) { patch.nudges = Math.min(n, 9); patch.lastNudgeAt = lastMine; }
    }
  }
  await setFstate(card.id, patch);
  return { key: card.key };
}

// Ми надіслали фото: якщо дизайнер працював над ескізом, вважаємо, що ескіз надіслано.
async function onMineImage({ name }) {
  const cfg = await funnelCfg();
  if (!cfg.on) return { off: true };
  let card = await findCard(name);
  if (!card || !card.inNew) return { card: await cardView(card) };
  await setFstate(card.id, { lastMineAt: Date.now() });
  if (card.key === 'sketch') card = await setStage(card, 'sketch_sent');
  return { card: await cardView(card) };
}

// Відкрили чат: показуємо етап; якщо клієнт відповів у «Нагадуванні», повертаємо картку на її етап.
async function onChatOpen({ name, lastIsClient, mine, client, transcript }) {
  const cfg = await funnelCfg();
  if (!cfg.on) return { off: true };
  let card = await findCard(name);
  if (!card) return { card: null };
  // Доганяємо етап за відповідями менеджерів, відправленими не з цього Chrome (інший менеджер, телефон).
  if (Array.isArray(mine) && mine.length) {
    try { card = await catchUp(card, mine, transcript); } catch (_) { /* не критично */ }
  }
  if (Array.isArray(client) && client.length) {
    try {
      const rp = reasonPatch(card, await fstate(card.id), client.map((c) => c.text));
      if (Object.keys(rp).length) await setFstate(card.id, rp);
    } catch (_) { /* не критично */ }
  }
  if (lastIsClient) {
    const st = await fstate(card.id);
    await setFstate(card.id, { lastClientAt: Date.now() });
    if (card.inNew && card.key === 'remind') {
      card = await setStage(card, st.prev && OPEN_KEYS.includes(st.prev) && st.prev !== 'remind' ? st.prev : 'consult', { by: 'reply' });
      await setFstate(card.id, { prev: null, nudges: 0, suggest: null });
    }
  }
  return { card: await cardView(card) };
}

async function setStageManual({ name, cardId, key }) {
  let card = null;
  const { funnelCards = {} } = await chrome.storage.local.get(['funnelCards']);
  card = funnelCards[cardId] || (await findCard(name));
  if (!card) throw new Error('Картку не знайдено.');
  if (key === 'paid') {
    const meta = await funnelMeta();
    const st0 = await fstate(card.id);
    if (meta.createsOrder && st0.orderId) throw new Error(`Замовлення №${st0.orderId} вже є: «Оплачено» створило б дубль. Увімкніть у воронці «Тільки зміна статусу», і J.A.R.V.I.S закриватиме такі картки сам.`);
  }
  const patch = { suggest: null };
  if (key === 'remind' && card.key !== 'remind') { patch.prev = card.key; patch.nudges = 0; patch.remindAt = Date.now(); }
  if (key !== 'remind') { patch.prev = null; patch.nudges = 0; }
  card = await setStage(card, key, { by: 'manual', communicateAt: key === 'remind' ? Date.now() : undefined });
  await setFstate(card.id, patch);
  return { card: await cardView(card) };
}

// ---------- Таймери ----------

let tickLock = false;
async function funnelTick(force = false) {
  const cfg = await funnelCfg();
  if (!cfg.on || !(await getKeycrmKey())) return { off: true };
  if (tickLock) return {};
  // Воронкою керує сервер (Railway): розширення не дублює таймери.
  if (typeof SERVER_MODE === 'undefined' && (await chrome.storage.local.get(['funnelServer'])).funnelServer) return { server: true };
  tickLock = true;
  try {
    const { funnelSyncFullAt = 0, funnelTickAt = 0 } = await chrome.storage.local.get(['funnelSyncFullAt', 'funnelTickAt']);
    if (!force && Date.now() - funnelTickAt < 30 * 60000) return {};
    await chrome.storage.local.set({ funnelTickAt: Date.now() });
    const cards = await syncFunnel(force || Date.now() - funnelSyncFullAt > 60 * 60000);
    const { funnelState = {}, funnelLog: flog = [] } = await chrome.storage.local.get(['funnelState', 'funnelLog']);
    // Коли картка востаннє міняла етап (за журналом J.A.R.V.I.S): правки товарів чи назви таймер не скидають.
    const stageAt = {};
    for (const e of flog) if (e.id && e.at > (stageAt[e.id] || 0)) stageAt[e.id] = e.at;
    let moved = 0;
    for (const card of Object.values(cards)) {
      if (!card.inNew) continue;
      const st = funnelState[card.id] || {};
      if (WAIT_KEYS.includes(card.key)) {
        // Чекаємо на клієнта від нашого останнього повідомлення. Час зміни етапу беремо, лише коли переписки не бачили:
        // інакше перенесення карток між воронками скидало б відлік.
        const known = st.lastMineAt || Math.max(card.statusAt || 0, stageAt[card.id] || 0);
        const last = known || card.changedAt || 0;
        const clientAfter = (st.lastClientAt || 0) > last;
        if (!clientAfter && last && Date.now() - last > FDAY) {
          try {
            await setStage(card, 'remind', { by: 'timer', communicateAt: Date.now() });
            // Пропозицію закрити (клієнт прямо відмовився) не скидаємо.
            const ab = {};
            // Перше нагадування після ціни: по черзі варіант A або B, щоб порівняти, який частіше веде до передоплати.
            if (card.key === 'price' && !st.abVar) {
              const { abNext = 'A' } = await chrome.storage.local.get(['abNext']);
              Object.assign(ab, { abVar: abNext, abAt: Date.now() });
              await chrome.storage.local.set({ abNext: abNext === 'A' ? 'B' : 'A' });
            }
            await setFstate(card.id, Object.assign({ prev: card.key, nudges: 0, suggest: st.suggest && STAGE[st.suggest] && STAGE[st.suggest].lost ? st.suggest : null, remindAt: Date.now() }, ab));
            moved++;
          } catch (e) { await chrome.storage.local.set({ funnelTickErr: `${card.id}: ${e.message}` }); }
        }
      } else if (card.key === 'remind') {
        if ((st.nudges || 0) >= 3 && Date.now() - (st.lastNudgeAt || 0) > LOSS_AFTER_LAST && !st.suggest) {
          await setFstate(card.id, { suggest: lossFor(st.prev, st.reason) });
        }
      }
    }
    return { moved };
  } finally { tickLock = false; }
}

chrome.alarms.onAlarm.addListener((al) => {
  if (al.name === 'mc-auto') funnelTick(false).catch(() => {});
});

// ---------- Аналітика етапів (для коуча і панелі) ----------

async function funnelStats() {
  const { funnelLog: log = [], funnelCards = {}, funnelClosed } = await chrome.storage.local.get(['funnelLog', 'funnelCards', 'funnelClosed']);
  const since = Date.now() - 30 * FDAY;
  const recent = log.filter((x) => x.at >= since);
  const reached = {};
  const byCard = {};
  for (const e of log) { (byCard[e.id] = byCard[e.id] || []).push(e); }
  for (const [id, evs] of Object.entries(byCard)) {
    if (!evs.some((e) => e.at >= since)) continue;
    const best = new Set();
    for (const e of evs) {
      const k = e.to;
      if (STAGE[k] && STAGE[k].rank >= 0) for (const s of FUNNEL_STAGES) if (s.rank >= 0 && s.rank <= STAGE[k].rank) best.add(s.key);
      if (STAGE[k] && STAGE[k].lost) best.add(k);
    }
    for (const k of best) reached[k] = (reached[k] || 0) + 1;
  }
  // Час на етапі: від входу до наступного переходу.
  const dwell = {};
  for (const evs of Object.values(byCard)) {
    evs.sort((a, b) => a.at - b.at);
    for (let i = 0; i < evs.length - 1; i++) {
      const k = evs[i].to;
      if (!STAGE[k] || evs[i].at < since) continue;
      (dwell[k] = dwell[k] || []).push(evs[i + 1].at - evs[i].at);
    }
  }
  const avgH = (a) => (a && a.length ? Math.round(a.reduce((s, x) => s + x, 0) / a.length / 3600000) : null);
  const now = {};
  const money = {};
  for (const c of Object.values(funnelCards)) {
    if (!c.inNew || !c.key) continue;
    now[c.key] = (now[c.key] || 0) + 1;
    money[c.key] = (money[c.key] || 0) + (c.total || 0);
  }
  const lost = {};
  for (const c of (funnelClosed && funnelClosed.cards) || []) if (c.key && STAGE[c.key] && (STAGE[c.key].lost || STAGE[c.key].final)) lost[c.key] = (lost[c.key] || 0) + 1;
  const chain = ['consult', 'price', 'sketch', 'sketch_sent', 'invoice', 'paid'];
  const conv = [];
  for (let i = 0; i < chain.length - 1; i++) {
    const a = reached[chain[i]] || 0;
    const b = reached[chain[i + 1]] || 0;
    conv.push({ from: STAGE[chain[i]].label, to: STAGE[chain[i + 1]].label, a, b, pct: a ? Math.round((b / a) * 100) : null });
  }
  const dwellOut = FUNNEL_STAGES.filter((s) => dwell[s.key]).map((s) => ({ label: s.label, hours: avgH(dwell[s.key]), n: dwell[s.key].length }));
  return { events: recent.length, reached, conv, dwell: dwellOut, now, money, closed: lost };
}

async function reasonStats() {
  const { funnelState = {} } = await chrome.storage.local.get(['funnelState']);
  const since = Date.now() - 30 * FDAY;
  const count = {};
  const quotes = [];
  let total = 0;
  for (const st of Object.values(funnelState)) {
    if (!st || !st.reason || (st.reasonAt || 0) < since) continue;
    count[st.reason] = (count[st.reason] || 0) + 1;
    total++;
    if (st.reasonQuote && quotes.length < 6) quotes.push(st.reasonQuote.slice(0, 70));
  }
  return { total, count, quotes };
}
HANDLERS['mc-funnel-reasons'] = () => reasonStats();

async function funnelStatsText() {
  const s = await funnelStats();
  if (!s.events && !Object.keys(s.now).length) return '';
  const lines = ['Воронка «Monoclo · Свій принт» у KeyCRM за 30 днів (рахує J.A.R.V.I.S за переходами карток):'];
  lines.push('Зараз на етапах: ' + FUNNEL_STAGES.filter((x) => s.now[x.key]).map((x) => `${x.label} ${s.now[x.key]}${s.money[x.key] ? ` (${Math.round(s.money[x.key])} грн)` : ''}`).join('; '));
  lines.push('Конверсія між етапами: ' + s.conv.filter((c) => c.a).map((c) => `${c.from} → ${c.to}: ${c.b} з ${c.a}${c.pct != null ? ` (${c.pct}%)` : ''}`).join('; '));
  if (s.dwell.length) lines.push('Середній час на етапі: ' + s.dwell.map((d) => `${d.label} ${d.hours} год`).join('; '));
  const rs = await reasonStats();
  if (rs.total) lines.push(`Причини з повідомлень клієнтів (30 днів, ${rs.total} карток): ` + Object.entries(rs.count).map(([k, n]) => `${REASON_LABEL[k]} ${n}`).join('; ') + (rs.quotes.length ? `. Приклади: ${rs.quotes.map((q) => `«${q}»`).join(' ')}` : ''));
  const cl = FUNNEL_STAGES.filter((x) => s.closed[x.key]).map((x) => `${x.label} ${s.closed[x.key]}`);
  if (cl.length) lines.push('Закриті картки за 35 днів: ' + cl.join('; '));
  return lines.join('\n');
}

// ---------- Брифінг: блок воронки ----------

const _buildBriefing11 = buildBriefing;
buildBriefing = async function () {
  const text = await _buildBriefing11();
  let block = '';
  try {
    const cfg = await funnelCfg();
    if (cfg.on && (await getKeycrmKey())) {
      const { funnelCards = {}, funnelState = {} } = await chrome.storage.local.get(['funnelCards', 'funnelState']);
      const cards = Object.values(funnelCards).filter((c) => c.inNew);
      const nm = (c) => c.title.replace(HOT_MARK, '').replace(/^Чат з\s+/i, '');
      const due = cards.filter((c) => c.key === 'remind' && ((funnelState[c.id] || {}).nudges || 0) < 3 && !(funnelState[c.id] || {}).suggest);
      const sketchWait = cards.filter((c) => c.key === 'sketch_sent' && Date.now() - c.changedAt > 12 * 3600000);
      const invWait = cards.filter((c) => c.key === 'invoice' && Date.now() - c.changedAt > 12 * 3600000);
      const longSketch = cards.filter((c) => c.key === 'sketch' && Date.now() - c.changedAt > 2 * FDAY);
      const toClose = cards.filter((c) => (funnelState[c.id] || {}).suggest && STAGE[(funnelState[c.id] || {}).suggest].lost);
      const toPay = cards.filter((c) => (funnelState[c.id] || {}).suggest === 'paid' && !(funnelState[c.id] || {}).orderId);
      const hasOrder = cards.filter((c) => (funnelState[c.id] || {}).orderPaid);
      const hotSum = cards.filter((c) => HOT_KEYS.includes(c.key)).reduce((s, c) => s + (c.total || 0), 0);
      const lines = ['<b>🎯 Воронка Monoclo</b>'];
      const L = (label, list) => { if (list.length) lines.push(`• ${label}: <b>${list.length}</b>\n  ${esc(shortList(list.map(nm)))}`); };
      L('Нагадати сьогодні', due);
      L('Ескіз без відповіді', sketchWait);
      L('Рахунок без оплати', invWait);
      L('Ескіз робиться понад 2 дні', longSketch);
      L('Підтвердити оплату', toPay);
      L('Оплачено, замовлення вже є (закрийте картку)', hasOrder);
      L('Закрити як втрачені', toClose);
      const objections = cards.filter((c) => { const st = funnelState[c.id] || {}; return st.reason && st.reason !== 'think' && OPEN_KEYS.includes(c.key) && !(st.suggest && STAGE[st.suggest] && STAGE[st.suggest].lost); });
      L('Заперечення, ще можна відпрацювати', objections.map((c) => Object.assign({}, c, { title: `${nm(c)} (${REASON_LABEL[funnelState[c.id].reason]})` })));
      if (hotSum) lines.push(`• У гарячих картках: ${Math.round(hotSum).toLocaleString('uk-UA')} грн`);
      if (lines.length === 1) lines.push('• Усі картки на своїх місцях.');
      block = lines.join('\n');
    }
  } catch (e) { block = `<b>🎯 Воронка Monoclo</b>\nНе вдалося зібрати: ${esc(e.message)}`; }
  if (!block) return text;
  const i = text.indexOf('<b>✅ На сьогодні</b>');
  return i > 0 ? text.slice(0, i) + block + '\n\n' + text.slice(i) : text + '\n\n' + block;
};

// ---------- Чернетки: ціна з картки головніша за скрипт ----------

function installmentsText(total) {
  if (!total) return '';
  return [3, 5, 7, 10].map((n) => `${n} по ${Math.round(total / n)}`).join(', ');
}

const _generate11 = generate;
generate = async function (msg) {
  let ctx = '';
  try {
    const cfg = await funnelCfg();
    if (cfg.on && msg.cname && (await getKeycrmKey())) {
      const card = await findCard(msg.cname);
      if (card) {
        const st = await fstate(card.id);
        const parts = [`Воронка KeyCRM: картка на етапі «${card.key && STAGE[card.key] ? STAGE[card.key].label : 'стара воронка'}».`];
        if (card.key === 'remind') parts.push(`Нагадувань уже надіслано: ${st.nudges || 0} з 3.`);
        if (st.reason) {
          const how = { lost_expensive: 'клієнту дорого. Не знижуй ціну і не обіцяй знижок без Юрія: покажи цінність (тканина, DTF-друк, ескіз під клієнта), запропонуй частини monobank із сумою одного платежу або дешевший виріб (футболка замість худі)', lost_size: 'клієнт сумнівається в розмірі. Дай заміри з розмірної сітки, спитай зріст і звичний розмір, нагадай про оверсайз-крій', lost_other: 'клієнт відмовився. Подякуй, не тисни, залиш двері відчиненими одним коротким питанням', think: 'клієнт хоче подумати. Дізнайся, що саме зупиняє, і запропонуй найменший наступний крок (передоплата 200 грн, ескіз без зобов\'язань щодо пошиття)' }[st.reason];
          if (how) parts.push(`Заперечення з чату: «${st.reasonQuote || ''}». Що робити: ${how}.`);
        }
        const own = manualProducts(card);
        if (own.length) {
          const total = own.reduce((s2, p) => s2 + p.price * (p.quantity || 1), 0);
          parts.push('У картці товари з цінами, які поставив Юрій. Ці ціни головніші за скрипт, називай саме їх: ' +
            own.map((p) => `${p.name} ${p.price} грн${p.quantity > 1 ? ` × ${p.quantity}` : ''}`).join('; ') + '.');
          if (total) parts.push(`Разом ${total} грн. Частинами monobank без переплати: ${installmentsText(total)} грн.`);
        }
        ctx = parts.join(' ');
      }
    }
  } catch (_) { ctx = ''; }
  return _generate11(Object.assign({}, msg, { context: [msg.context, ctx].filter(Boolean).join('\n\n') }));
};
HANDLERS['mc-draft'] = (m) => generate(m);

// ---------- Квитанція: 200 грн → «Ескіз у роботі», повна сума → пропозиція «Оплачено» ----------

const _receipt11 = HANDLERS['mc-receipt-check'];
HANDLERS['mc-receipt-check'] = async (m) => {
  const r = await _receipt11(m);
  try {
    const q = (r && r.receipt) || {};
    const cfg = await funnelCfg();
    if (cfg.on && m.cname && q.verdict === 'ok' && q.recipient_ok !== false && Number(q.amount) > 0) {
      let card = await findCard(m.cname);
      if (card) {
        const amt = Number(q.amount);
        if (amt <= 300 && (!card.key || STAGE[card.key].rank < STAGE.sketch.rank || card.key === 'remind' || !card.inNew)) {
          card = await setStage(card, 'sketch', { by: 'receipt' });
          await setFstate(card.id, { prev: null, nudges: 0, suggest: null });
          r.funnel = 'Передоплату видно: картка перейшла в «Ескіз у роботі».';
        } else if (amt > 300) {
          await setFstate(card.id, { suggest: 'paid' });
          r.funnel = 'Схоже на повну оплату: підтвердіть «Оплачено» в рядку воронки.';
        }
      }
    }
  } catch (_) { /* воронка не критична */ }
  return r;
};

// ---------- Обробники ----------

Object.assign(HANDLERS, {
  'mc-funnel-open': (m) => onChatOpen(m),
  'mc-funnel-sent': (m) => onMineSent(m),
  'mc-funnel-image': (m) => onMineImage(m),
  'mc-funnel-history': (m) => onHistory(m),
  'mc-history-now': async () => {
    const tabs = await chrome.tabs.query({ url: 'https://*.keycrm.app/*' });
    if (!tabs.length) throw new Error('Відкрийте KeyCRM у вкладці Chrome і натисніть ще раз.');
    for (const t of tabs) {
      try { await chrome.tabs.sendMessage(t.id, { type: 'mc-history-now' }); return {}; } catch (_) { /* стара версія в цій вкладці */ }
    }
    throw new Error('Вкладка KeyCRM ще зі старою версією J.A.R.V.I.S: оновіть її (Cmd+R) і натисніть ще раз.');
  },
  'mc-funnel-cardlist': async () => {
    const cfg = await funnelCfg();
    if (!cfg.on) return { off: true };
    const { funnelCards = {} } = await chrome.storage.local.get(['funnelCards']);
    // Нова воронка першою; зі старої лише картки Monoclo, які вже в кеші (джерело Monoclo).
    const all = Object.values(funnelCards).sort((a, b) => (b.inNew - a.inNew) || (b.changedAt - a.changedAt));
    return { ids: all.slice(0, 60).map((c) => c.id) };
  },
  'mc-funnel-preview': (m) => onPreview(m),
  'mc-funnel-set': (m) => setStageManual(m),
  'mc-funnel-sync': async () => {
    const meta = await funnelMeta(true);
    await chrome.storage.local.set({ funnelTickAt: 0 });
    const r = await funnelTick(true);
    const { funnelCards = {} } = await chrome.storage.local.get(['funnelCards']);
    const all = Object.values(funnelCards);
    return { createsOrder: meta.createsOrder, targetType: meta.targetType, pipeline: meta.pipelineName, missing: meta.missing, sources: meta.sources, cards: all.filter((c) => c.inNew).length, oldCards: all.filter((c) => !c.inNew).length, moved: (r && r.moved) || 0 };
  },
  'mc-funnel-stats': async () => ({ stats: await funnelStats(), text: await funnelStatsText() })
});
