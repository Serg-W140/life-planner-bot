import http from 'node:http';
import fs from 'node:fs';

const BOT_TOKEN = process.env.BOT_TOKEN || 'ВСТАВЬ_СЮДА_ТОКЕН_ОТ_BOTFATHER';
const WEBAPP_URL = process.env.WEBAPP_URL || 'https://ТВОЙ_САЙТ_НА_GITHUB_PAGES';
const PORT = process.env.PORT || 3000;
const DB_FILE = './users_db.json';

let db = {};
if (fs.existsSync(DB_FILE)) {
  try {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (_) {}
}

function saveDb() {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

async function sendTelegramMessage(chatId, text) {
  const url = `https://telegram.org{BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: Array.of(
          Array.of({ text: '📱 Открыть Планер', web_app: { url: WEBAPP_URL } })
        )
      }
    })
  }).catch(() => {});
}

// HTTP-сервер для приёма расписания из Mini App
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'POST' && req.url === '/sync') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (data.chatId) {
          db[data.chatId] = {
            tzOffset: Number(data.timezoneOffsetMin) || -180,
            alarms: data.alarms || Array.of(),
            events: data.events || Array.of()
          };
          saveDb();
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      } catch (_) {
        res.writeHead(400);
        res.end('{"ok":false}');
      }
    });
    return;
  }

  res.writeHead(200);
  res.end('LifePlanner Bot is running');
});

server.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});

// Проверка расписания раз в 30 секунд
const sentCache = new Set();

setInterval(() => {
  const nowUtc = new Date();

  Object.entries(db).forEach(([chatId, user]) => {
    // Переводим UTC в локальное время пользователя
    const localMs = nowUtc.getTime() - user.tzOffset * 60000;
    const localDate = new Date(localMs);

    const yyyy = localDate.getUTCFullYear();
    const mm = String(localDate.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(localDate.getUTCDate()).padStart(2, '0');
    const dateStr = `${yyyy}-${mm}-${dd}`;
    const dayOfWeek = localDate.getUTCDay();
    const dayOfMonth = localDate.getUTCDate();
    const month = localDate.getUTCMonth() + 1;
    const currMinutes = localDate.getUTCHours() * 60 + localDate.getUTCMinutes();

    // 1. Проверка будильников
    user.alarms.forEach((alarm) => {
      const matchDay = !alarm.days || alarm.days.length === 0 || alarm.days.includes(dayOfWeek);
      if (!matchDay) return;
      const parts = (alarm.time || '08:00').split(':');
      const targetMin = Number(parts.at(0)) * 60 + Number(parts.at(1));
      const key = `${chatId}_${dateStr}_alm_${alarm.id}`;

      if (currMinutes === targetMin && !sentCache.has(key)) {
        sentCache.add(key);
        sendTelegramMessage(chatId, `⏰ <b>Будильник (${alarm.time})</b>\n${alarm.label || 'Пора вставать!'}`);
      }
    });

    // 2. Проверка событий и предварительных напоминаний
    user.events.forEach((ev) => {
      let match = false;
      if (ev.ruleType === 'once' && ev.date === dateStr) match = true;
      else if (ev.ruleType === 'weekly' && ev.days?.includes(dayOfWeek)) match = true;
      else if (ev.ruleType === 'monthly' && Number(ev.dayOfMonth) === dayOfMonth) match = true;
      else if (ev.ruleType === 'yearly' && Number(ev.month) === month && Number(ev.day) === dayOfMonth) match = true;
      else if (ev.ruleType === 'cycle' && ev.startDate) {
        const diff = Math.floor((new Date(`${dateStr}T00:00:00Z`) - new Date(`${ev.startDate}T00:00:00Z`)) / 86400000);
        if (diff >= 0 && diff % (Number(ev.gap) || 1) === 0) match = true;
      }

      if (!match) return;

      const parts = (ev.time || '09:00').split(':');
      const targetMin = Number(parts.at(0)) * 60 + Number(parts.at(1));
      const remindMin = ev.remindBefore !== undefined ? Number(ev.remindBefore) : 60;

      // Предварительное напоминание (за N минут)
      if (remindMin > 0 && currMinutes === targetMin - remindMin) {
        const remKey = `${chatId}_${dateStr}_rem_${ev.id}`;
        if (!sentCache.has(remKey)) {
          sentCache.add(remKey);
          sendTelegramMessage(chatId, `🔔 <b>Напоминание (через ${remindMin} мин, в ${ev.time})</b>\n${ev.title}`);
        }
      }

      // Точное время события
      if (currMinutes === targetMin) {
        const exactKey = `${chatId}_${dateStr}_ev_${ev.id}`;
        if (!sentCache.has(exactKey)) {
          sentCache.add(exactKey);
          sendTelegramMessage(chatId, `📌 <b>Время события (${ev.time})</b>\n${ev.title}`);
        }
      }
    });
  });
}, 30000);
