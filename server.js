// ===== ЗАВИСИМОСТИ =====
const express = require('express');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ===== НАСТРОЙКИ =====
const CLIENT_ID = 'local.6a6b41bc9b4dc1.98807350';
const CLIENT_SECRET = 'amY4l0Mely36FfYAdbMzieSm6U4MNTMk1AZBmbHPIRSBKj7ehS';
const ALLOWED_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'mp4', 'mov', 'avi', 'mkv', 'pdf'];
const FIELD_CODE_CAMEL = 'ufCrm_1785410870';
const TEST_DEAL_ID = 9405; // сделка для тестового режима
const PORT = 5000;

const TOKENS_FILE = path.join(__dirname, 'tokens.json');
const CURSORS_FILE = path.join(__dirname, 'cursors.json');
const ATTACHED_FILE = path.join(__dirname, 'attached.json');
const KNOWN_CHATS_FILE = path.join(__dirname, 'known_chats.json');

// ===== ХРАНЕНИЕ ТОКЕНОВ И КУРСОРОВ (локальные json-файлы вместо PropertiesService) =====
function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}
function saveJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function getTokens() {
  return loadJson(TOKENS_FILE, {});
}
function saveTokens(data) {
  saveJson(TOKENS_FILE, data);
}
function getCursors() {
  return loadJson(CURSORS_FILE, {});
}
function saveCursors(data) {
  saveJson(CURSORS_FILE, data);
}
function getAttached() {
  return loadJson(ATTACHED_FILE, {});
}
function saveAttached(data) {
  saveJson(ATTACHED_FILE, data);
}
function getKnownChats() {
  // Формат: { deals: { "9405": ["4979"] }, lastFullScan: 0 }
  return loadJson(KNOWN_CHATS_FILE, { deals: {}, lastFullScan: 0 });
}
function saveKnownChats(data) {
  saveJson(KNOWN_CHATS_FILE, data);
}

// ===== ПРИЁМ УСТАНОВКИ ПРИЛОЖЕНИЯ ОТ БИТРИКСА =====
// Bitrix шлёт сюда AUTH_ID/REFRESH_ID при установке/переустановке приложения.
// В настройках приложения в Битриксе укажи ngrok-адрес + этот путь, например:
// https://xxxx.ngrok-free.app/install
function handleInstall(req, res) {
  const p = req.body;
  console.log('Получен POST-запрос установки:', JSON.stringify(p));
  if (p.AUTH_ID && p.REFRESH_ID) {
    saveTokens({
      AUTH_ID: p.AUTH_ID,
      REFRESH_ID: p.REFRESH_ID,
      DOMAIN: p.DOMAIN || null,
      // Если DOMAIN не пришёл — временно используем SERVER_ENDPOINT.
      // В любом случае реальный CLIENT_ENDPOINT будет получен и перезаписан
      // при первом вызове refreshToken() перед любым тестом/опросом.
      CLIENT_ENDPOINT: p.DOMAIN ? `https://${p.DOMAIN}/rest/` : (p.SERVER_ENDPOINT || null)
    });
    console.log('Установка сохранена:', p.DOMAIN || '(домен не передан, будет получен при следующем refreshToken)');
    return res.send('OK, установка сохранена');
  }
  res.send('OK');
}

app.post('/install', handleInstall);
app.post('/', handleInstall); // дублируем на корень — на случай если Битрикс шлёт запрос без /install

// Для проверки статуса в браузере
app.get('/', (req, res) => {
  res.json({ tokens: getTokens(), cursors: getCursors() });
});

// ===== ОБНОВЛЕНИЕ ТОКЕНА =====
async function refreshToken() {
  const tokens = getTokens();
  const url = `https://oauth.bitrix.info/oauth/token/`
    + `?grant_type=refresh_token`
    + `&client_id=${CLIENT_ID}`
    + `&client_secret=${CLIENT_SECRET}`
    + `&refresh_token=${tokens.REFRESH_ID}`;

  const response = await fetch(url);
  const data = await response.json();

  if (data.access_token) {
    saveTokens({
      ...tokens,
      AUTH_ID: data.access_token,
      REFRESH_ID: data.refresh_token,
      CLIENT_ENDPOINT: data.client_endpoint
    });
  } else {
    console.error('Ошибка обновления токена:', data);
  }
  return data;
}

// ===== ВЫЗОВ МЕТОДА БИТРИКСА (JSON, с паузой и повтором при сбое) =====
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callMethod(base, method, token, params, retries = 0) {
  const body = { ...params, auth: token };
  try {
    const response = await fetch(base + method + '.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    await sleep(300); // пауза, чтобы не перегружать портал запросами
    return await response.json();
  } catch (e) {
    if (retries < 3) {
      await sleep(2000);
      return callMethod(base, method, token, params, retries + 1);
    }
    console.error(`Не удалось вызвать ${method} после 3 попыток:`, e.message);
    return { error: 'NETWORK_ERROR', error_description: e.message };
  }
}

// ===== ВСПОМОГАТЕЛЬНОЕ: скачать бинарный файл и получить base64 =====
async function downloadFileAsBase64(url) {
  const response = await fetch(url);
  const buffer = await response.buffer();
  return buffer.toString('base64');
}

// Пишет строку и в массив log (для ответа по HTTP), и сразу в консоль (для наблюдения в реальном времени)
function emit(log, line) {
  log.push(line);
  console.log('  ' + line);
}

// ===== ПОИСК ЧАТОВ ДЛЯ СДЕЛКИ (используется только при полном сканировании) =====
async function findDealChats(base, token, dealId, log) {
  const chatsResult = await callMethod(base, 'imopenlines.crm.chat.get', token, {
    CRM_ENTITY_TYPE: 'deal',
    CRM_ENTITY: dealId,
    ACTIVE_ONLY: 'N'
  });
  if (chatsResult.error) {
    emit(log, `Deal ${dealId}: ошибка запроса чата — ${chatsResult.error_description || chatsResult.error}`);
    return null; // null = ошибка, не путать с "чатов нет"
  }
  return chatsResult.result || [];
}

// ===== ОБРАБОТКА СООБЩЕНИЙ УЖЕ ИЗВЕСТНОГО ЧАТА =====
// onlyNew = true  -> берём только сообщения после сохранённого курсора (обычный режим)
// onlyNew = false -> полностью сканируем всю историю чата (для теста / первого прогона)
async function processChatMessages(base, token, dealId, chatId, onlyNew, log) {
  const cursors = getCursors();
  const cursorKey = `${dealId}_${chatId}`;
  const cursor = cursors[cursorKey];

  const history = await callMethod(base, 'imopenlines.session.history.get', token, {
    CHAT_ID: chatId
  });
  if (history.error || !history.result) {
    emit(log, `Deal ${dealId} chat ${chatId}: ошибка истории — ${JSON.stringify(history)}`);
    return;
  }

  const messages = history.result.message || {};
  const files = history.result.files || {};
  const msgIds = Object.keys(messages).map(Number).sort((a, b) => a - b);
  if (msgIds.length === 0) return;
  const maxId = msgIds[msgIds.length - 1];

  if (onlyNew && cursor === undefined) {
    cursors[cursorKey] = maxId;
    saveCursors(cursors);
    emit(log, `Deal ${dealId} chat ${chatId}: инициализация курсора на ${maxId}`);
    return;
  }

  const cursorNum = onlyNew ? cursor : -1;

  const candidateFileIds = [];
  msgIds.forEach((msgId) => {
    if (msgId <= cursorNum) return;
    const msg = messages[msgId];
    const fileIds = (msg.params && msg.params.fileId) || [];
    fileIds.forEach((fid) => {
      const fileInfo = files[fid];
      if (!fileInfo) return;
      const ext = (fileInfo.extension || '').toLowerCase();
      if (ALLOWED_EXT.includes(ext)) {
        candidateFileIds.push(fid);
      }
    });
  });

  if (candidateFileIds.length === 0) {
    cursors[cursorKey] = maxId;
    saveCursors(cursors);
    return;
  }

  const itemResult = await callMethod(base, 'crm.item.get', token, {
    entityTypeId: 2,
    id: dealId
  });
  const currentValueRaw = (itemResult.result && itemResult.result.item && itemResult.result.item[FIELD_CODE_CAMEL]) || [];
  const currentValue = Array.isArray(currentValueRaw) ? currentValueRaw : (currentValueRaw ? [currentValueRaw] : []);

  const payload = currentValue.map((f) => {
    const oldId = (typeof f === 'object' && f.id) ? f.id : f;
    return { id: oldId };
  });

  const attached = getAttached();
  const dealKey = String(dealId);
  if (!attached[dealKey]) attached[dealKey] = [];

  let addedCount = 0;
  let skippedCount = 0;

  for (const diskId of candidateFileIds) {
    const alreadyAttached = attached[dealKey].some((a) => String(a.diskId) === String(diskId));
    if (alreadyAttached) {
      skippedCount++;
      emit(log, `Deal ${dealId}: пропущен дубль disk id ${diskId} — уже прикреплялся ранее`);
      continue;
    }

    const fileMeta = await callMethod(base, 'disk.file.get', token, { id: diskId });
    if (!fileMeta.result || !fileMeta.result.DOWNLOAD_URL) continue;

    const fileName = fileMeta.result.NAME;
    const fileSize = fileMeta.result.SIZE;

    const isDuplicateByNameSize = attached[dealKey].some(
      (a) => a.name === fileName && String(a.size) === String(fileSize)
    );
    if (isDuplicateByNameSize) {
      skippedCount++;
      emit(log, `Deal ${dealId}: пропущен дубль "${fileName}" (${fileSize} байт) — совпадение по имени и размеру`);
      continue;
    }

    const base64Content = await downloadFileAsBase64(fileMeta.result.DOWNLOAD_URL);
    payload.push([fileName, base64Content]);
    attached[dealKey].push({ diskId, name: fileName, size: fileSize });
    addedCount++;
    emit(log, `Deal ${dealId}: новый файл "${fileName}" (${fileSize} байт)`);
  }

  if (addedCount > 0) {
    const fieldsObj = {};
    fieldsObj[FIELD_CODE_CAMEL] = payload;

    const updateResult = await callMethod(base, 'crm.item.update', token, {
      id: dealId,
      entityTypeId: 2,
      fields: fieldsObj
    });
    emit(log, `Deal ${dealId}: обновление поля — ${updateResult.result ? 'успешно' : JSON.stringify(updateResult)}`);
  } else if (skippedCount > 0) {
    emit(log, `Deal ${dealId}: новых файлов нет (пропущено дублей: ${skippedCount})`);
  }
  saveAttached(attached);

  cursors[cursorKey] = maxId;
  saveCursors(cursors);
}

// Обёртка для тестового режима: ищет чаты сделки "на лету" и сразу обрабатывает (без кэша)
async function processDeal(base, token, dealId, onlyNew, log) {
  const chats = await findDealChats(base, token, dealId, log);
  if (!chats || chats.length === 0) {
    emit(log, `Deal ${dealId}: нет привязанного чата`);
    return;
  }
  for (const chat of chats) {
    await processChatMessages(base, token, dealId, chat.CHAT_ID, onlyNew, log);
  }
}

// ===== ПОЛУЧИТЬ ВСЕ СДЕЛКИ (с постраничной загрузкой) =====
async function getAllDeals(base, token) {
  let allDeals = [];
  let start = 0;
  while (true) {
    const result = await callMethod(base, 'crm.deal.list', token, {
      select: ['ID'],
      start
    });
    const batch = result.result || [];
    allDeals = allDeals.concat(batch);
    if (!result.next) break;
    start = result.next;
  }
  return allDeals;
}

// ===== ПОЛНЫЙ ЧИСТЫЙ СБРОС ТЕСТОВОЙ СДЕЛКИ (поле в Битриксе + локальный журнал) =====
// Открой в браузере: http://localhost:5000/reset-test-deal
app.get('/reset-test-deal', async (req, res) => {
  try {
    const data = await refreshToken();
    const tokens = getTokens();
    const fieldsObj = {};
    fieldsObj[FIELD_CODE_CAMEL] = [];
    const result = await callMethod(tokens.CLIENT_ENDPOINT, 'crm.item.update', data.access_token, {
      id: TEST_DEAL_ID,
      entityTypeId: 2,
      fields: fieldsObj
    });

    const attached = getAttached();
    attached[String(TEST_DEAL_ID)] = [];
    saveAttached(attached);

    res.json({ message: 'Поле и журнал сброшены', result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== ОЧИСТКА ПОЛЯ ТЕСТОВОЙ СДЕЛКИ (для повторных чистых тестов) =====
// Открой в браузере: http://localhost:5000/clear-test-deal
app.get('/clear-test-deal', async (req, res) => {
  try {
    const data = await refreshToken();
    const tokens = getTokens();
    const fieldsObj = {};
    fieldsObj[FIELD_CODE_CAMEL] = [];
    const result = await callMethod(tokens.CLIENT_ENDPOINT, 'crm.item.update', data.access_token, {
      id: TEST_DEAL_ID,
      entityTypeId: 2,
      fields: fieldsObj
    });
    res.json({ result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== ТЕСТОВЫЙ ЭНДПОИНТ: только одна сделка =====
// Открой в браузере: http://localhost:5000/test-deal
// (или через ngrok-адрес, если тестируешь удалённо)
app.get('/test-deal', async (req, res) => {
  const log = [];
  try {
    const data = await refreshToken();
    if (!data.access_token) {
      return res.json({ error: 'Не удалось получить токен', data });
    }
    const tokens = getTokens();
    await processDeal(tokens.CLIENT_ENDPOINT, data.access_token, TEST_DEAL_ID, false, log);
    res.json({ log });
  } catch (e) {
    res.status(500).json({ error: e.message, log });
  }
});

// ===== ПОЛНОЕ СКАНИРОВАНИЕ: ищет у каких сделок вообще есть чаты (ДОЛГАЯ операция) =====
// Нужно запускать редко (вручную или раз в сутки) — не каждые 5 минут, иначе перегрузит портал.
// Результат сохраняется в known_chats.json и используется быстрым регулярным опросом.
async function fullScanForChats() {
  const log = [];
  const data = await refreshToken();
  if (!data.access_token) {
    emit(log, 'Не удалось получить токен: ' + JSON.stringify(data));
    return log;
  }
  const token = data.access_token;
  const tokens = getTokens();
  const base = tokens.CLIENT_ENDPOINT;

  const deals = await getAllDeals(base, token);
  emit(log, `Всего сделок: ${deals.length}`);

  const known = getKnownChats();
  let foundCount = 0;

  for (const deal of deals) {
    const chats = await findDealChats(base, token, deal.ID, log);
    if (chats && chats.length > 0) {
      known.deals[String(deal.ID)] = chats.map((c) => c.CHAT_ID);
      foundCount++;
    }
  }

  known.lastFullScan = Date.now();
  saveKnownChats(known);
  emit(log, `Полное сканирование завершено. Сделок с чатами: ${foundCount}`);
  return log;
}

// ===== БЫСТРЫЙ РЕГУЛЯРНЫЙ ОПРОС: только уже известные чаты (используется таймером) =====
async function pollKnownChats() {
  const log = [];
  try {
    const data = await refreshToken();
    if (!data.access_token) {
      emit(log, 'Не удалось получить токен: ' + JSON.stringify(data));
      return log;
    }
    const token = data.access_token;
    const tokens = getTokens();
    const base = tokens.CLIENT_ENDPOINT;

    const known = getKnownChats();
    const dealIds = Object.keys(known.deals);
    emit(log, `Известных сделок с чатами: ${dealIds.length}`);
    console.log(`  → Начинаю проверку ${dealIds.length} сделок...`);

    const startTime = Date.now();
    let processed = 0;

    for (const dealId of dealIds) {
      const chatIds = known.deals[dealId];
      for (const chatId of chatIds) {
        await processChatMessages(base, token, Number(dealId), chatId, true, log);
      }
      processed++;
      // Печатаем прогресс каждые 100 сделок, чтобы было видно, что скрипт живой и работает
      if (processed % 100 === 0 || processed === dealIds.length) {
        const elapsedSec = Math.round((Date.now() - startTime) / 1000);
        console.log(`  → Проверено ${processed} из ${dealIds.length} сделок (прошло ${elapsedSec} сек)`);
      }
    }
  } catch (e) {
    emit(log, 'Ошибка опроса: ' + e.message);
  }
  return log;
}

// ===== ПОЛНОЕ СКАНИРОВАНИЕ (запускать редко, вручную — долгая операция) =====
// Открой в браузере: http://localhost:5000/full-scan
app.get('/full-scan', async (req, res) => {
  const log = await fullScanForChats();
  res.json({ log });
});

// ===== БЫСТРЫЙ ОПРОС ИЗВЕСТНЫХ ЧАТОВ (то же самое, что делает автотаймер) =====
// Открой в браузере: http://localhost:5000/poll-all
app.get('/poll-all', async (req, res) => {
  const log = await pollKnownChats();
  res.json({ log });
});

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 минут
let isPolling = false; // защита от наложения: не запускать новый опрос, пока предыдущий не завершился

app.listen(PORT, () => {
  console.log(`Сервер запущен на http://localhost:${PORT}`);
  console.log(`Для установки приложения в Битриксе используй ngrok-адрес + /install`);
  console.log(`Тест одной сделки: GET /test-deal`);
  console.log(`Полное сканирование (искать новые чаты, долгая операция): GET /full-scan`);
  console.log(`Быстрый опрос известных чатов: GET /poll-all`);
  console.log(`Автоматический быстрый опрос запущен, интервал: 5 минут`);

  const known = getKnownChats();
  if (Object.keys(known.deals).length === 0) {
    console.log(`ВНИМАНИЕ: известных чатов пока нет. Сначала запусти GET /full-scan вручную, иначе автоопрос ничего не найдёт.`);
  }

  const runPoll = async () => {
    if (isPolling) {
      console.log(`[${new Date().toLocaleTimeString()}] Пропуск: предыдущий опрос ещё не завершился`);
      return;
    }
    isPolling = true;
    console.log(`[${new Date().toLocaleTimeString()}] Автоматический опрос запущен...`);
    try {
      await pollKnownChats();
    } finally {
      isPolling = false;
      console.log(`[${new Date().toLocaleTimeString()}] Автоматический опрос завершён`);
    }
  };

  runPoll();
  setInterval(runPoll, POLL_INTERVAL_MS);
});
