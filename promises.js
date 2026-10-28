// J.A.R.V.I.S · обіцянки клієнтам («уточню завтра», «повернуся з варіантами ескізу»).
// Спільний файл для розширення (importScripts) і сервера (vm у index.js). Лише чисті функції, без сховища.
// Оригінал лежить у папці розширення; на сервер копіюється командою npm run sync.

const PROMISE_REPLY_GAP = 3 * 3600 * 1000;   // відповідь менеджера щонайменше через 3 год після обіцянки = виконано

// Дієслова, після яких клієнт чекає продовження навіть без дати.
const P_STRONG = /(^|[^\p{L}'ʼ’])(уточню|уточнимо|дізнаю(?:ся|сь)|дізнаємо(?:ся|сь)|спитаю|запитаю|перепитаю|перевірю|перевіримо|з['ʼ’]?ясую|з['ʼ’]?ясуємо|повернуся|повернусь|повернемося|повернемось|маякну|дам знати|дамо знати|відпишу|відпишемо|порахую|порахуємо|узгоджу|узгодимо)(?=$|[^\p{L}])/iu;
// Дієслова, що стають обіцянкою лише з конкретним часом («надішлю завтра»).
const P_WEAK = /(^|[^\p{L}'ʼ’])(напишу|напишемо|надішлю|надішлемо|скину|скинемо|покажу|покажемо|підготую|підготуємо|зроблю|зробимо|передам|передамо|намалюю|намалюємо|відправлю|відправимо|додам|додамо|пришлю|пришлемо)(?=$|[^\p{L}])/iu;
const P_COND = /(^|[^\p{L}])(коли|щойно|як тільки|як лише|після того|якщо)(?=$|[^\p{L}])/iu;

const P_WD = { 'понеділ': 1, 'вівтор': 2, 'серед': 3, 'четвер': 4, "п['ʼ’]?ятниц": 5, 'субот': 6, 'неділ': 0 };

function kyivDay(ts) {
  return new Date(ts).toLocaleDateString('sv-SE', { timeZone: 'Europe/Kyiv' });   // YYYY-MM-DD
}

function addDays(day, n) {
  const d = new Date(day + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function weekdayOf(day) { return new Date(day + 'T12:00:00Z').getUTCDay(); }

function nextWorkday(day) {
  let d = addDays(day, 1);
  while ([0, 6].includes(weekdayOf(d))) d = addDays(d, 1);
  return d;
}

// Коли треба виконати: за словами часу в реченні, інакше наступний робочий день.
function promiseDue(sentence, ts) {
  const s = String(sentence || '').toLowerCase();
  const today = kyivDay(ts);
  if (/післязавтра/.test(s)) return { due: addDays(today, 2), when: 'післязавтра' };
  if (/завтра/.test(s)) return { due: addDays(today, 1), when: 'завтра' };
  if (/сьогодні|ввечері|до вечора|за годин|за пару годин|за кілька годин|протягом дня|найближчим часом|зараз/.test(s)) return { due: today, when: 'сьогодні' };
  for (const [stem, wd] of Object.entries(P_WD)) {
    if (new RegExp('(^|[^\\p{L}])(в|у|до|на) ' + stem, 'iu').test(s)) {
      let d = addDays(today, 1);
      while (weekdayOf(d) !== wd) d = addDays(d, 1);
      return { due: d, when: 'до дня тижня' };
    }
  }
  if (/цього тижня|на тижні|до кінця тижня/.test(s)) {
    let d = today;
    while (weekdayOf(d) !== 5) d = addDays(d, 1);
    return { due: d, when: 'цього тижня' };
  }
  return null;
}

// Повертає обіцянку з тексту повідомлення менеджера або null.
function detectPromise(text, ts) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw) return null;
  const sentences = raw.split(/(?<=[.!?…])\s+|\s*\n+\s*/).map((x) => x.trim()).filter(Boolean);
  for (const sent of sentences) {
    if (/\?\s*$/.test(sent)) continue;                    // питання клієнту, не обіцянка
    const strong = P_STRONG.test(sent);
    const weak = !strong && P_WEAK.test(sent);
    if (!strong && !weak) continue;
    const time = promiseDue(sent, ts);
    if (weak && !time) continue;                          // «надішлю ТТН» без часу не трекаємо
    if (weak && P_COND.test(sent) && !time) continue;
    const due = time ? time.due : nextWorkday(kyivDay(ts));
    return { quote: sent.length > 180 ? sent.slice(0, 177) + '…' : sent, due, at: ts };
  }
  return null;
}

function fmtDay(day) {
  const [, m, d] = String(day).split('-');
  return `${d}.${m}`;
}

// Позначає виконаними обіцянки, після яких менеджер відповів у тому ж чаті щонайменше через 3 год.
// msgs: [{ mine, at, sender? }]; повертає кількість закритих.
function resolvePromises(list, msgs, isManager = (m) => m.mine === true) {
  let n = 0;
  for (const p of list) {
    if (p.done) continue;
    if (msgs.some((m) => isManager(m) && m.at >= p.at + PROMISE_REPLY_GAP)) { p.done = 'reply'; p.doneAt = Date.now(); n++; }
  }
  return n;
}

function duePromises(list, now = Date.now()) {
  const today = kyivDay(now);
  return list.filter((p) => !p.done && p.due <= today).sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : a.at - b.at));
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { detectPromise, resolvePromises, duePromises, promiseDue, kyivDay, addDays, nextWorkday, fmtDay, PROMISE_REPLY_GAP };
}
