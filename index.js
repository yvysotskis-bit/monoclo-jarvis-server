// J.A.R.V.I.S · сервер воронки «Monoclo · Свій принт» (Railway).
// Працює без відкритої вкладки KeyCRM: раз на CYCLE_MINUTES синхронізує картки (публічний API),
// читає переписку кожної відкритої картки від імені технічного користувача (внутрішній API KeyCRM),
// рухає етапи, ставить «Нагадування», знаходить причини відмов і шле в Telegram кнопки «Закрити» / «Оплачено».
// Логіка воронки — той самий funnel.js, що й у розширенні (npm run sync копіює його з ../funnel.js).

'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const vm = require('vm');

const ENV = process.env;
const SUB = (ENV.KEYCRM_SUB || 'morningstar').trim();
const OPENAPI = 'https://openapi.keycrm.app/v1';
const INTERNAL = `https://${SUB}.api.keycrm.app`;
const DATA_DIR = ENV.DATA_DIR || path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const CYCLE_MIN = Math.max(3, Number(ENV.CYCLE_MINUTES) || 10);
const TG = ENV.TG_BOT_TOKEN ? `https://api.telegram.org/bot${ENV.TG_BOT_TOKEN.trim()}` : '';
const TG_CHAT = String(ENV.TG_CHAT_ID || '').trim();

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Сховище (замість chrome.storage.local) ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
let store = {};
try { store = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (_) { store = {}; }
let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(store));
      fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
    } catch (e) { log('state save failed', e.message); }
  }, 300);
}
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const chrome = {
  storage: {
    local: {
      async get(keys) {
        const list = keys == null ? Object.keys(store) : Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys);
        const out = {};
        for (const k of list) if (store[k] !== undefined) out[k] = clone(store[k]);
        return out;
      },
      async set(obj) { Object.assign(store, clone(obj)); persist(); },
      async remove(keys) { for (const k of [].concat(keys)) delete store[k]; persist(); }
    }
  },
  alarms: { onAlarm: { addListener() {} }, create() {} },
  tabs: { async query() { return []; }, async sendMessage() {} },
  runtime: { onMessage: { addListener() {} } }
};

// Налаштування воронки за замовчуванням (як у розширенні).
store.funnelOn = true;
if (ENV.FUNNEL_NAME) store.funnelName = ENV.FUNNEL_NAME;
if (store.funnelCreatesOrder === undefined) store.funnelCreatesOrder = false;   // у воронці «Тільки зміна статусу»

// ---------- Публічний API KeyCRM ----------
const kcCalls = [];
let kcQueue = Promise.resolve();
function kcSlot() {
  const next = kcQueue.then(async () => {
    for (;;) {
      const now = Date.now();
      while (kcCalls.length && now - kcCalls[0] > 60000) kcCalls.shift();
      if (kcCalls.length < 20) { kcCalls.push(now); return; }
      await sleep(60000 - (now - kcCalls[0]) + 200);
    }
  });
  kcQueue = next.catch(() => {});
  return next;
}
async function getKeycrmKey() { return (ENV.KEYCRM_API_KEY || '').trim(); }
async function keycrmOnce(p, { method = 'GET', body } = {}) {
  const k = await getKeycrmKey();
  if (!k) throw new Error('Немає KEYCRM_API_KEY.');
  await kcSlot();
  const res = await fetch(OPENAPI + p, {
    method,
    headers: { authorization: 'Bearer ' + k, accept: 'application/json', 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  let data = null;
  try { data = await res.json(); } catch (_) { /* порожня відповідь */ }
  if (!res.ok) {
    if (res.status === 429) { const e = new Error('KeyCRM 429'); e.code = 429; throw e; }
    const msg = data && (data.message || (data.errors && JSON.stringify(data.errors)));
    throw new Error(`KeyCRM ${res.status}: ${msg || ''}`);
  }
  return data;
}
async function keycrm(p, opts = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return await keycrmOnce(p, opts); } catch (e) {
      if (e && e.code === 429 && attempt < 2) { await sleep(15000); continue; }
      throw e;
    }
  }
}
async function keycrmOffer(sku) {
  const data = await keycrm(`/offers?filter[sku]=${encodeURIComponent(sku)}&include=product&limit=5`);
  const rows = (data && data.data) || [];
  return rows.find((o) => String(o.sku) === String(sku)) || null;
}
function kcTime(v) {
  if (!v) return 0;
  const s = String(v).trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)(\.\d+)?$/);
  const d = new Date(m ? `${m[1]}T${m[2]}${m[3] || ''}Z` : s);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

// ---------- Telegram ----------
function esc(t) { return String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function shortList(items, n = 6) {
  const head = items.slice(0, n).join(', ');
  return items.length > n ? `${head} і ще ${items.length - n}` : head;
}
async function tgCall(method, body) {
  if (!TG) throw new Error('Немає TG_BOT_TOKEN.');
  const res = await fetch(`${TG}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const d = await res.json().catch(() => ({ ok: false }));
  if (!d.ok) throw new Error('Telegram: ' + (d.description || method));
  return d.result;
}
async function tgSend(text, _cfg, html = false, extra = {}) {
  if (!TG || !TG_CHAT) return 0;
  const body = Object.assign({ chat_id: TG_CHAT, text: String(text).slice(0, 4000), disable_web_page_preview: true }, html ? { parse_mode: 'HTML' } : {}, extra);
  await tgCall('sendMessage', body);
  return 1;
}

// ---------- Заглушки для частин розширення, яких на сервері немає ----------
const HANDLERS = {};
let buildBriefing = async () => '';
let generate = async () => ({});
async function designerBrief() { throw new Error('ТЗ дизайнеру на сервері не готується'); }

globalThis.SERVER_MODE = true;
Object.assign(globalThis, { chrome, keycrm, keycrmOffer, kcTime, getKeycrmKey, tgSend, esc, shortList, HANDLERS, designerBrief });
globalThis.buildBriefing = buildBriefing;
globalThis.generate = generate;

// ---------- Логіка воронки з розширення ----------
const FUNNEL_EXPORTS = 'syncFunnel, onHistory, funnelTick, setStageManual, fstate, setFstate, funnelMeta, funnelStatsText, STAGE, OPEN_KEYS, REASON_LABEL, HOT_MARK, nameKey';
const funnelSrc = fs.readFileSync(path.join(__dirname, 'funnel.js'), 'utf8') + `\n;globalThis.__F = { ${FUNNEL_EXPORTS} };\n`;
vm.runInThisContext(funnelSrc, { filename: 'funnel.js' });
const F = globalThis.__F;

// ---------- Внутрішній API KeyCRM (переписка) від імені технічного користувача ----------
const auth = { access: store.kcAccess || '', refresh: store.kcRefresh || '' };
function saveTokens(d) {
  const t = (d && (d.access_token ? d : d.data)) || {};
  if (!t.access_token) throw new Error('KeyCRM не повернув токен' + (d && (d.two_factor || d.need_2fa || d['2fa']) ? ': увімкнено двофакторну перевірку, вимкніть її для технічного користувача' : ''));
  auth.access = t.access_token;
  auth.refresh = t.refresh_token || auth.refresh;
  store.kcAccess = auth.access; store.kcRefresh = auth.refresh; persist();
}
async function internalLogin() {
  if (!ENV.KEYCRM_USER || !ENV.KEYCRM_PASS) throw new Error('Немає KEYCRM_USER / KEYCRM_PASS.');
  const res = await fetch(`${INTERNAL}/auth/login`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ username: ENV.KEYCRM_USER.trim(), password: ENV.KEYCRM_PASS })
  });
  const d = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Вхід у KeyCRM не вдався (${res.status})${d && d.message ? ': ' + d.message : ''}`);
  saveTokens(d);
  log('internal: logged in');
}
async function internalRefresh() {
  if (!auth.refresh) return internalLogin();
  const res = await fetch(`${INTERNAL}/auth/refresh`, {
    method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ token: auth.refresh })
  });
  if (!res.ok) return internalLogin();
  saveTokens(await res.json());
}
async function internalGet(p, retry = true) {
  if (!auth.access) await internalLogin();
  const res = await fetch(INTERNAL + p, { headers: { accept: 'application/json', authorization: 'Bearer ' + auth.access } });
  if (res.status === 401 && retry) { await internalRefresh(); return internalGet(p, false); }
  if (!res.ok) { const e = new Error(`internal ${res.status}`); e.status = res.status; throw e; }
  return res.json();
}

// Нормалізація повідомлень (як у funnel-content.js).
function pickBool(m) {
  for (const k of ['is_outgoing', 'outgoing', 'from_me', 'is_me', 'is_manager', 'by_manager', 'is_operator']) if (typeof m[k] === 'boolean') return m[k];
  for (const k of ['is_incoming', 'incoming', 'from_client', 'is_client']) if (typeof m[k] === 'boolean') return !m[k];
  const dir = m.direction || m.type || m.message_type;
  if (typeof dir === 'string' && /^(out|outgoing|outbound|sent)$/i.test(dir)) return true;
  if (typeof dir === 'string' && /^(in|incoming|inbound|received)$/i.test(dir)) return false;
  const st = m.sender_type || m.author_type || (m.sender && m.sender.type) || (m.author && m.author.type);
  if (typeof st === 'string') return /user|manager|operator|employee|admin|agent|bot/i.test(st) && !/client|contact|customer/i.test(st);
  if (m.user_id || m.manager_id || m.operator_id) return true;
  return undefined;
}
function normMsgs(d) {
  const arr = Array.isArray(d) ? d : (d && (Array.isArray(d.data) ? d.data : Array.isArray(d.messages) ? d.messages : d.data && Array.isArray(d.data.data) ? d.data.data : [])) || [];
  return arr.map((m) => {
    const raw = m.message_body ?? m.text ?? m.message ?? m.body ?? m.content ?? (m.payload && m.payload.text) ?? '';
    const text = typeof raw === 'string' ? raw.replace(/<[^>]+>/g, ' ').trim() : '';
    const files = [].concat(m.attachments || [], m.files || [], m.media || []);
    const img = /image|photo|picture/i.test(String(m.message_type || '')) || files.some((f) => /image|photo|jpe?g|png|webp/i.test(String((f && (f.type || f.mime_type || f.mime || f.url || f.file_url)) || f)));
    return { mine: pickBool(m), text, img, at: kcTime(m.created_at || m.date || m.sent_at || m.timestamp) };
  }).sort((a, b) => a.at - b.at);
}

// ---------- Цикл ----------
const status = { startedAt: Date.now(), lastCycleAt: 0, lastOkAt: 0, lastError: '', cards: 0, read: 0, moved: 0 };

const nm = (c) => String(c.title || '').replace(F.HOT_MARK, '').replace(/^Чат з\s+/i, '').trim() || `картка ${c.id}`;

async function notifyChanges(before) {
  const { funnelState = {}, funnelCards = {} } = await chrome.storage.local.get(['funnelState', 'funnelCards']);
  const reminds = [];
  for (const [id, st] of Object.entries(funnelState)) {
    const card = funnelCards[id];
    if (!card) continue;
    const old = before.state[id] || {};
    // Нова пропозиція закрити або «Оплачено»: окреме повідомлення з кнопками.
    if (st.suggest && st.suggest !== old.suggest && F.STAGE[st.suggest]) {
      const label = F.STAGE[st.suggest].label;
      const why = st.reasonQuote ? `Клієнт написав: «${esc(st.reasonQuote)}»` : st.suggest === 'paid' ? 'Схоже, клієнт оплатив.' : '3 нагадування без відповіді.';
      const btn = st.suggest === 'paid' ? `✅ Оплачено` : `✖️ Закрити: ${label}`;
      try {
        await tgSend(`🎯 <b>${esc(nm(card))}</b>\n${why}\nПеревести картку в «${esc(label)}»?`, null, true, {
          reply_markup: { inline_keyboard: [[{ text: btn, callback_data: `s:${id}:${st.suggest}` }, { text: 'Лишити', callback_data: `x:${id}` }]] }
        });
      } catch (e) { log('tg', e.message); }
    }
    // Щойно перейшла в «Нагадування».
    const prevCard = before.cards[id];
    if (card.key === 'remind' && prevCard && prevCard.key !== 'remind') reminds.push(nm(card));
  }
  if (reminds.length) {
    try { await tgSend(`⏰ <b>Нагадати сьогодні</b> (мовчать понад добу після нашої відповіді):\n${esc(reminds.join(', '))}`, null, true); } catch (e) { log('tg', e.message); }
  }
}

let cycling = false;
async function cycle() {
  if (cycling) return;
  cycling = true;
  status.lastCycleAt = Date.now();
  try {
    const before = { state: clone(store.funnelState || {}), cards: clone(store.funnelCards || {}) };
    const cards = await F.syncFunnel(true);
    const list = Object.values(cards);
    status.cards = list.length;
    let read = 0;
    for (const c of list) {
      try {
        const msgs = normMsgs(await internalGet(`/conversations/messages/by_lead/${c.id}`));
        if (msgs.length) { await F.onHistory({ cardId: c.id, messages: msgs }); read++; }
      } catch (e) {
        if (/Вхід|токен|KEYCRM_USER/.test(e.message)) throw e;   // без входу далі немає сенсу
        log('history', c.id, e.message);
      }
      await sleep(400);
    }
    status.read = read;
    before.cards = clone(store.funnelCards || {});   // етапи після читання історії: так видно, кого перевів саме таймер
    store.funnelTickAt = 0;
    store.funnelTickErr = null; store.funnelLastPutErr = null;
    const t = await F.funnelTick(true);
    status.moved = (t && t.moved) || 0;
    await notifyChanges(before);
    // Діагностика таймера: чому картки, що чекають на клієнта, ще не в «Нагадуванні».
    try {
      const fl = store.funnelLog || [];
      const stageAt = {};
      for (const e of fl) if (e.id && e.at > (stageAt[e.id] || 0)) stageAt[e.id] = e.at;
      const iso = (t) => (t ? new Date(t).toISOString().slice(5, 16) : '-');
      const rows = Object.values(store.funnelCards || {}).filter((c) => c.inNew && ['price', 'sketch_sent', 'invoice'].includes(c.key)).map((c) => {
        const st = (store.funnelState || {})[c.id] || {};
        return `${c.id}:${c.key} mine=${iso(st.lastMineAt)} client=${iso(st.lastClientAt)} statusAt=${iso(c.statusAt)} stageAt=${iso(stageAt[c.id])} changed=${iso(c.changedAt)}`;
      });
      log('wait-cards ' + rows.length + '\n' + rows.join('\n'));
    } catch (e) { log('diag', e.message); }
    status.lastOkAt = Date.now();
    status.lastError = '';
    log(`cycle ok: cards ${list.length}, read ${read}, moved ${status.moved}` + (store.funnelTickErr ? ` · tick error ${store.funnelTickErr}` : '') + (store.funnelLastPutErr ? ` · put error ${store.funnelLastPutErr}` : ''));
  } catch (e) {
    status.lastError = e.message;
    log('cycle error:', e.message);
    if (!store.lastErrorSentAt || Date.now() - store.lastErrorSentAt > 6 * 3600 * 1000) {
      store.lastErrorSentAt = Date.now(); persist();
      try { await tgSend(`⚠️ J.A.R.V.I.S (сервер воронки): ${e.message}`); } catch (_) { /* ignore */ }
    }
  } finally { cycling = false; }
}

// ---------- Ранковий звіт воронки ----------
function kyivHM() {
  const s = new Date().toLocaleTimeString('uk-UA', { timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit', hour12: false });
  const day = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Kyiv' });
  return { hm: s, day };
}
async function maybeBrief() {
  const want = (ENV.BRIEF_TIME || '09:30').trim();
  const { hm, day } = kyivHM();
  if (store.briefDay === day || hm < want) return;
  store.briefDay = day; persist();
  try {
    const text = await globalThis.buildBriefing();
    const stats = await F.funnelStatsText().catch(() => '');
    await tgSend(`${text.trim()}${stats ? `\n\n<i>${esc(stats)}</i>` : ''}`, null, true);
  } catch (e) { log('brief', e.message); }
}

// ---------- Кнопки в Telegram ----------
let tgOffset = store.tgOffset || 0;
async function pollTelegram() {
  if (!TG) return;
  for (;;) {
    try {
      const res = await fetch(`${TG}/getUpdates?timeout=50&offset=${tgOffset}&allowed_updates=${encodeURIComponent('["callback_query"]')}`);
      const d = await res.json();
      for (const u of (d.result || [])) {
        tgOffset = u.update_id + 1; store.tgOffset = tgOffset; persist();
        const q = u.callback_query;
        if (!q || String(q.message && q.message.chat && q.message.chat.id) !== TG_CHAT) continue;
        const [act, cardId, key] = String(q.data || '').split(':');
        let note = '';
        try {
          if (act === 's') {
            const r = await F.setStageManual({ cardId: Number(cardId), key });
            note = `Готово: «${F.STAGE[key].label}»`;
            log('tg set', cardId, key, r && r.card && r.card.key);
          } else if (act === 'x') {
            await F.setFstate(Number(cardId), { suggest: null });
            note = 'Лишив як є';
          }
        } catch (e) { note = 'Помилка: ' + e.message; }
        try {
          await tgCall('answerCallbackQuery', { callback_query_id: q.id, text: note.slice(0, 190) });
          await tgCall('editMessageReplyMarkup', { chat_id: TG_CHAT, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } });
          await tgCall('sendMessage', { chat_id: TG_CHAT, text: note, reply_to_message_id: q.message.message_id });
        } catch (_) { /* ignore */ }
      }
    } catch (e) { log('tg poll', e.message); await sleep(5000); }
  }
}

// ---------- HTTP (перевірка стану для Railway) ----------
http.createServer((req, res) => {
  const body = {
    ok: !status.lastError,
    startedAt: new Date(status.startedAt).toISOString(),
    lastCycleAt: status.lastCycleAt ? new Date(status.lastCycleAt).toISOString() : null,
    lastOkAt: status.lastOkAt ? new Date(status.lastOkAt).toISOString() : null,
    lastError: status.lastError || null,
    cards: status.cards, historyRead: status.read, movedToRemind: status.moved, cycleMinutes: CYCLE_MIN,
    tickError: store.funnelTickErr || null, putError: store.funnelLastPutErr || null
  };
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body, null, 2));
}).listen(Number(ENV.PORT) || 3000, () => log('http on', Number(ENV.PORT) || 3000));

// ---------- Старт ----------
(async () => {
  const missing = ['KEYCRM_API_KEY', 'KEYCRM_USER', 'KEYCRM_PASS'].filter((k) => !ENV[k]);
  if (missing.length) log('УВАГА: не задано', missing.join(', '));
  if (!TG || !TG_CHAT) log('УВАГА: Telegram не налаштовано, сповіщень не буде');
  pollTelegram();
  await cycle();
  setInterval(cycle, CYCLE_MIN * 60000);
  setInterval(maybeBrief, 60000);
})();
