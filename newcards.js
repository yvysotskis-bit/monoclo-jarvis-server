// J.A.R.V.I.S · картки для клієнтів, що пишуть знову.
// KeyCRM сама заводить картку лише для нового контакту. Якщо старий клієнт Monoclo пише ще раз,
// а відкритої картки в нього немає, сервер створює картку на етапі «Новий», прив'язану до покупця,
// тож вона з'являється в чаті («Активні картки у воронках») і далі рухається воронкою як звичайна.
'use strict';

const DAY = 86400000;

module.exports = function makeNewCards(ctx) {
  const { store, persist, internalGet, keycrm, normMsgs, kcTime, F, tgSend, esc, log } = ctx;
  const ENV = process.env;
  const CHANNEL_RE = new RegExp(ENV.MONOCLO_CHANNEL_RE || 'mono', 'i');
  const MAX_PER_CYCLE = Number(ENV.AUTO_CARDS_MAX) || 10;
  const QUIET_AFTER_CLOSE_DAYS = Number(ENV.AUTO_CARDS_AFTER_CLOSE_DAYS) || 7;
  const status = { on: ENV.AUTO_CARDS !== 'off', lastRunAt: null, created: [], skipped: {}, probe: null, error: null };

  const pick = (...v) => v.find((x) => x !== undefined && x !== null && x !== '');
  const listOf = (d) => (Array.isArray(d) ? d : Array.isArray(d && d.data) ? d.data : d && d.data && Array.isArray(d.data.data) ? d.data.data : []);

  let channelsMem = null;
  async function monocloChannels() {
    if (channelsMem && Date.now() - channelsMem.at < 6 * 3600 * 1000) return channelsMem.ids;
    const rows = listOf(await internalGet('/conversations/channels'));
    const ids = new Set(rows.filter((c) => CHANNEL_RE.test(`${c.name || ''} ${c.title || ''} ${c.alias || ''} ${c.username || ''}`)).map((c) => String(c.id)));
    channelsMem = { at: Date.now(), ids };
    status.channels = rows.map((c) => `${c.id}:${c.name || c.title || ''}${ids.has(String(c.id)) ? ' ✓' : ''}`);
    return ids;
  }

  function convFields(c) {
    const client = c.client || c.buyer || {};
    const contact = c.contact || {};
    return {
      id: c.id,
      clientId: pick(c.client_id, client.id, contact.client_id, c.buyer_id),
      name: String(pick(client.full_name, contact.full_name, contact.name, c.name, c.title, '') || '').trim(),
      channelId: String(pick(c.channel_id, c.channel && c.channel.id, '') || ''),
      at: kcTime(pick(c.last_message_at, c.last_message && c.last_message.created_at, c.updated_at))
    };
  }

  function hasOpenCard(clientId, name) {
    const k = F.nameKey(name);
    return Object.values(store.funnelCards || {}).some((c) => {
      const open = !c.inNew || F.OPEN_KEYS.includes(c.key);
      return open && ((clientId && String(c.clientId) === String(clientId)) || (k && (c.names || []).includes(k)));
    });
  }
  function closedRecently(clientId) {
    const cut = Date.now() - QUIET_AFTER_CLOSE_DAYS * DAY;
    const closed = ((store.funnelClosed && store.funnelClosed.cards) || []);
    return closed.some((c) => String(c.clientId) === String(clientId) && (c.changedAt || 0) > cut);
  }

  async function run() {
    if (!status.on) return status;
    status.lastRunAt = new Date().toISOString();
    status.created = []; status.skipped = {}; status.error = null;
    const skip = (why) => { status.skipped[why] = (status.skipped[why] || 0) + 1; };
    const now = Date.now();
    // Першого разу не чіпаємо минуле: працюємо лише з повідомленнями, що прийшли після запуску.
    if (!store.autoCardsSince) { store.autoCardsSince = now; persist(); }
    const since = Math.max(store.autoCardsSince, now - 6 * 3600 * 1000);
    store.autoCardsDone = store.autoCardsDone || {};
    for (const [k, t] of Object.entries(store.autoCardsDone)) if (now - t > 3 * DAY) delete store.autoCardsDone[k];
    try {
      const meta = await F.funnelMeta();
      if (!meta.ids.new) throw new Error('у воронці немає етапу «Новий»');
      const channels = await monocloChannels();
      const rows = [];
      for (let page = 1; page <= 2; page++) {
        const r = listOf(await internalGet(`/conversations?filters[type]=all&page=${page}`));
        rows.push(...r);
        if (r.length < 10) break;
      }
      if (rows[0] && !status.probe) status.probe = Object.keys(rows[0]).slice(0, 40);
      let made = 0;
      for (const raw of rows) {
        const c = convFields(raw);
        if (!c.channelId || !channels.has(c.channelId)) { skip('не Monoclo'); continue; }
        if (!c.clientId) { skip('без client_id'); if (!status.probeContact && raw.contact) status.probeContact = Object.keys(raw.contact).slice(0, 40); continue; }
        if (c.at && c.at < since) { skip('давно'); continue; }
        if (store.autoCardsDone[c.clientId]) { skip('вже створено'); continue; }
        if (hasOpenCard(c.clientId, c.name)) { skip('є картка'); continue; }
        if (closedRecently(c.clientId)) { skip('картку закрили нещодавно'); continue; }
        // Останнє повідомлення має бути від клієнта і свіже.
        let msgs = [];
        try { msgs = normMsgs(await internalGet(`/conversations/messages/by_client/${c.clientId}`)); } catch (e) { skip('історія недоступна'); continue; }
        const last = msgs[msgs.length - 1];
        if (!last || last.mine !== false) { skip('останнє не від клієнта'); continue; }
        if (last.at && last.at < since) { skip('давно'); continue; }
        if (made >= MAX_PER_CYCLE) { skip('ліміт циклу'); continue; }
        const name = c.name || `клієнт ${c.clientId}`;
        const body = {
          title: `Чат з ${name}`,
          pipeline_id: meta.pipelineId,
          status_id: meta.ids.new,
          contact: { full_name: name, client_id: Number(c.clientId) || c.clientId }
        };
        if (meta.sources && meta.sources.length) body.source_id = meta.sources[0];
        await keycrm('/pipelines/cards', { method: 'POST', body });
        store.autoCardsDone[c.clientId] = now; persist();
        status.created.push(name);
        made++;
        log('auto-card', c.clientId);
      }
      if (status.created.length) {
        try { await tgSend(`🆕 <b>Нові картки</b> (клієнти написали знову): ${esc(status.created.join(', '))}`, null, true); } catch (e) { log('tg', e.message); }
      }
    } catch (e) {
      status.error = e.message;
      log('auto-cards error:', e.message);
    }
    log('auto-cards ' + JSON.stringify({ created: status.created, skipped: status.skipped, error: status.error, probe: status.probe, probeContact: status.probeContact, channels: status.channels }));
    return status;
  }

  return { run, status };
};
