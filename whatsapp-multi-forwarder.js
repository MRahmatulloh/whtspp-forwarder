#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');

const ROOT_DIR = __dirname;
const CONFIG_PATH = path.join(ROOT_DIR, 'multi-config.json');
const LOG_DIR = path.join(ROOT_DIR, 'message_logs_multi');
const LIST_CHATS_ONLY = process.argv.includes('--list-chats');

const DEFAULT_ROUTE = {
  name: '',
  includePattern: '',
  excludePattern: '',
  maxMessageLength: 300,
};

const DEFAULT_CONFIG = {
  sessionName: 'whtspp-multi-forwarder',
  timezone: 'Asia/Tashkent',
  authTimeoutMs: 120000,
  historyLimitPerChat: 100,
  historyFetchRetries: 2,
  historyFetchRetryDelayMs: 1500,
  processingConcurrency: 2,
  logFlushIntervalMs: 250,
  logFlushBatchSize: 50,
  sourceChats: [],
  includePattern: '',
  excludePattern: '',
  maxMessageLength: 300,
  routeDefaults: { ...DEFAULT_ROUTE },
  targetRoutes: [],
  authPath: path.join(ROOT_DIR, '.wwebjs_auth'),
  puppeteer: {
    headless: true,
    timeout: 120000,
    protocolTimeout: 300000,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  },
};

const runtimeState = {
  dayKey: '',
  forwardedIdsFile: '',
  hashesFile: '',
  forwardedIds: new Set(),
  forwardedHashes: new Set(),
  inFlightRouteKeys: new Set(),
  forwardedIdsWriter: null,
  hashesWriter: null,
};

const formatterCache = new Map();

class BufferedLineWriter {
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this.flushIntervalMs = options.flushIntervalMs ?? 250;
    this.flushBatchSize = options.flushBatchSize ?? 50;
    this.buffer = [];
    this.flushTimer = null;
    this.closed = false;
    this.pendingFlush = Promise.resolve();
    this.stream = fs.createWriteStream(filePath, {
      flags: 'a',
      encoding: 'utf8',
    });
  }

  append(value) {
    if (this.closed) {
      return;
    }

    this.buffer.push(`${value}\n`);

    if (this.buffer.length >= this.flushBatchSize) {
      this.flush();
      return;
    }

    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flush();
      }, this.flushIntervalMs);

      if (typeof this.flushTimer.unref === 'function') {
        this.flushTimer.unref();
      }
    }
  }

  flush() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (this.buffer.length === 0) {
      return this.pendingFlush;
    }

    const chunk = this.buffer.join('');
    this.buffer.length = 0;

    this.pendingFlush = this.pendingFlush
      .then(
        () =>
          new Promise((resolve, reject) => {
            this.stream.write(chunk, 'utf8', (error) => {
              if (error) {
                reject(error);
                return;
              }

              resolve();
            });
          })
      )
      .catch((error) => {
        console.error(`[LOG] ${this.filePath} ga yozib bo'lmadi: ${error.message}`);
      });

    return this.pendingFlush;
  }

  async close() {
    if (this.closed) {
      return;
    }

    this.closed = true;
    await this.flush();

    await new Promise((resolve) => {
      this.stream.end(resolve);
    });
  }
}

class TaskQueue {
  constructor(concurrency) {
    this.concurrency = Math.max(1, Number(concurrency) || 1);
    this.activeCount = 0;
    this.queue = [];
    this.idleResolvers = [];
  }

  add(task) {
    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      this.drain();
    });
  }

  async onIdle() {
    if (this.activeCount === 0 && this.queue.length === 0) {
      return;
    }

    await new Promise((resolve) => {
      this.idleResolvers.push(resolve);
    });
  }

  drain() {
    while (this.activeCount < this.concurrency && this.queue.length > 0) {
      const item = this.queue.shift();
      this.activeCount += 1;

      Promise.resolve()
        .then(item.task)
        .then(item.resolve, item.reject)
        .finally(() => {
          this.activeCount -= 1;

          if (this.activeCount === 0 && this.queue.length === 0) {
            const resolvers = this.idleResolvers.splice(0);
            for (const resolve of resolvers) {
              resolve();
            }
          }

          this.drain();
        });
    }
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function loadSet(filePath) {
  if (!fs.existsSync(filePath)) {
    return new Set();
  }

  const lines = fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return new Set(lines);
}

function normalizeChatSpecs(sourceChats) {
  if (!Array.isArray(sourceChats)) {
    return [];
  }

  const seen = new Set();
  const result = [];

  for (const chat of sourceChats) {
    const normalized = String(chat || '').trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}

function getFormatter(timezone) {
  let formatter = formatterCache.get(timezone);
  if (formatter) {
    return formatter;
  }

  formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  formatterCache.set(timezone, formatter);
  return formatter;
}

function formatDateParts(date, timezone) {
  const formatter = getFormatter(timezone);

  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value])
  );

  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
  };
}

function getTodayKey(timezone) {
  const parts = formatDateParts(new Date(), timezone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function formatMessageDate(date, timezone) {
  const parts = formatDateParts(date, timezone);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function getDateKey(date, timezone) {
  const parts = formatDateParts(date, timezone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function normalizeText(text) {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getMessageHash(text) {
  return crypto.createHash('md5').update(normalizeText(text), 'utf8').digest('hex');
}

function compileRegex(pattern, label) {
  try {
    return pattern ? new RegExp(pattern, 'i') : null;
  } catch (error) {
    throw new Error(`${label} regex noto'g'ri: ${error.message}`);
  }
}

function isChatId(value) {
  return /@(?:g\.us|c\.us|lid|newsletter|broadcast)$/.test(value);
}

function chatLabel(chat) {
  return chat?.name || chat?.id?._serialized || 'Noma`lum chat';
}

function messageTimestamp(message) {
  if (typeof message.timestamp === 'number') {
    return new Date(message.timestamp * 1000);
  }

  return new Date();
}

function messageKey(message) {
  return message?.id?._serialized || `${message.from || 'unknown'}:${message.timestamp || Date.now()}`;
}

function messageText(message) {
  return typeof message.body === 'string' ? message.body.trim() : '';
}

function sanitizePhone(value) {
  const digits = String(value || '').replace(/\D+/g, '');
  return digits || '';
}

function resolveSenderId(message) {
  return (
    message?.author ||
    message?._data?.author ||
    message?.from ||
    message?._data?.from ||
    ''
  );
}

function resolveSenderName(message) {
  const candidates = [
    message?._data?.notifyName,
    message?._data?.sender?.pushname,
    message?._data?.sender?.formattedName,
    message?.notifyName,
    message?.author,
    message?.from,
  ];

  for (const candidate of candidates) {
    const normalized = String(candidate || '').trim();
    if (normalized && !/@(?:g\.us|c\.us|lid|newsletter|broadcast)$/.test(normalized)) {
      return normalized;
    }
  }

  const senderId = resolveSenderId(message);
  return sanitizePhone(senderId) || 'Noma`lum';
}

function resolveSenderContactLink(message) {
  const senderId = resolveSenderId(message);
  const phone = sanitizePhone(senderId);
  return phone ? `https://wa.me/${phone}` : '';
}

function formatMessageHeader(sourceChat, message, timezone) {
  const contactLink = resolveSenderContactLink(message);
  const lines = [
    `Guruh: ${chatLabel(sourceChat)}`,
    `Yuboruvchi: ${resolveSenderName(message)}`,
    `Sana: ${formatMessageDate(messageTimestamp(message), timezone)}`,
  ];

  if (contactLink) {
    lines.push(`Aloqa: ${contactLink}`);
  }

  return lines.join('\n');
}

function formatFallbackText(sourceChat, message, timezone) {
  return [
    formatMessageHeader(sourceChat, message, timezone),
    '',
    messageText(message),
  ].join('\n');
}

function routeLabel(route) {
  return route.name || route.targetChatSpec;
}

function routeMessageId(messageId, targetChatId) {
  return `${messageId}::${targetChatId}`;
}

function routeMessageHash(textHash, targetChatId) {
  return `${textHash}::${targetChatId}`;
}

function refreshDailyState(config) {
  const todayKey = getTodayKey(config.timezone);
  if (runtimeState.dayKey === todayKey) {
    return runtimeState;
  }

  ensureDirectory(LOG_DIR);

  const previousIdsWriter = runtimeState.forwardedIdsWriter;
  const previousHashesWriter = runtimeState.hashesWriter;

  runtimeState.dayKey = todayKey;
  runtimeState.forwardedIdsFile = path.join(LOG_DIR, `forwarded_ids_${todayKey}.txt`);
  runtimeState.hashesFile = path.join(LOG_DIR, `message_hashes_${todayKey}.txt`);
  runtimeState.forwardedIds = loadSet(runtimeState.forwardedIdsFile);
  runtimeState.forwardedHashes = loadSet(runtimeState.hashesFile);
  runtimeState.inFlightRouteKeys = new Set();
  runtimeState.forwardedIdsWriter = new BufferedLineWriter(runtimeState.forwardedIdsFile, {
    flushIntervalMs: config.logFlushIntervalMs,
    flushBatchSize: config.logFlushBatchSize,
  });
  runtimeState.hashesWriter = new BufferedLineWriter(runtimeState.hashesFile, {
    flushIntervalMs: config.logFlushIntervalMs,
    flushBatchSize: config.logFlushBatchSize,
  });

  if (previousIdsWriter) {
    previousIdsWriter.close().catch(() => {});
  }

  if (previousHashesWriter) {
    previousHashesWriter.close().catch(() => {});
  }

  console.log(
    `[STATE] ${todayKey} uchun route loglar yuklandi. IDs=${runtimeState.forwardedIds.size}, hashes=${runtimeState.forwardedHashes.size}`
  );

  return runtimeState;
}

function normalizeRoute(route, index, routeDefaults) {
  const merged = {
    ...routeDefaults,
    ...(route || {}),
  };

  return {
    index,
    name: String(merged.name || '').trim(),
    targetChatSpec: String(merged.targetChat || '').trim(),
    includePattern: String(merged.includePattern || '').trim(),
    excludePattern: String(merged.excludePattern || '').trim(),
    maxMessageLength: Math.max(1, Number(merged.maxMessageLength) || routeDefaults.maxMessageLength || 300),
  };
}

function normalizeRoutes(routes, routeDefaults) {
  if (!Array.isArray(routes)) {
    return [];
  }

  return routes.map((route, index) => normalizeRoute(route, index, routeDefaults));
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    if (LIST_CHATS_ONLY) {
      return { ...DEFAULT_CONFIG };
    }

    throw new Error(
      `multi-config.json topilmadi. Avval ${CONFIG_PATH} faylini multi-config.example.json asosida yarating.`
    );
  }

  const userConfig = readJson(CONFIG_PATH);
  const routeDefaults = {
    ...DEFAULT_ROUTE,
    ...(userConfig.routeDefaults || {}),
  };

  const config = {
    ...DEFAULT_CONFIG,
    ...userConfig,
    routeDefaults,
    puppeteer: {
      ...DEFAULT_CONFIG.puppeteer,
      ...(userConfig.puppeteer || {}),
    },
  };

  config.sourceChats = normalizeChatSpecs(config.sourceChats);
  config.includePattern = String(config.includePattern || '').trim();
  config.excludePattern = String(config.excludePattern || '').trim();
  config.maxMessageLength = Math.max(1, Number(config.maxMessageLength) || 300);
  config.targetRoutes = normalizeRoutes(config.targetRoutes, routeDefaults);
  config.historyFetchRetries = Math.max(0, Number(config.historyFetchRetries) || 0);
  config.historyFetchRetryDelayMs = Math.max(250, Number(config.historyFetchRetryDelayMs) || 1500);
  config.processingConcurrency = Math.max(1, Number(config.processingConcurrency) || 1);
  config.logFlushIntervalMs = Math.max(50, Number(config.logFlushIntervalMs) || 250);
  config.logFlushBatchSize = Math.max(1, Number(config.logFlushBatchSize) || 50);

  if (!/^[A-Za-z0-9_-]+$/.test(config.sessionName)) {
    throw new Error('sessionName faqat harf, raqam, "_" yoki "-" dan iborat bo`lishi kerak.');
  }

  if (!LIST_CHATS_ONLY) {
    if (config.sourceChats.length === 0) {
      throw new Error('multi-config.json ichida sourceChats bo`sh bo`lmasligi kerak.');
    }

    if (config.targetRoutes.length === 0) {
      throw new Error('multi-config.json ichida targetRoutes bo`sh bo`lmasligi kerak.');
    }
  }

  for (const route of config.targetRoutes) {
    if (!route.targetChatSpec) {
      throw new Error(`targetRoutes[${route.index}] ichida targetChat to'ldirilishi kerak.`);
    }

    if (!config.includePattern && !route.includePattern) {
      throw new Error(
        `targetRoutes[${route.index}] uchun includePattern topilmadi. Global includePattern yoki route includePattern kerak.`
      );
    }

    route.includeRegex = compileRegex(route.includePattern, `targetRoutes[${route.index}].includePattern`);
    route.excludeRegex = compileRegex(route.excludePattern, `targetRoutes[${route.index}].excludePattern`);
  }

  config.includeRegex = compileRegex(config.includePattern, 'includePattern');
  config.excludeRegex = compileRegex(config.excludePattern, 'excludePattern');

  return config;
}

async function resolveChat(client, chatSpec, cachedChats) {
  const value = String(chatSpec || '').trim();
  if (!value) {
    throw new Error('Bo`sh chat qiymati berildi.');
  }

  if (isChatId(value)) {
    const chat = await client.getChatById(value);
    if (!chat) {
      throw new Error(`Chat ID bo'yicha topilmadi: ${value}`);
    }

    return chat;
  }

  const normalized = value.toLowerCase();
  const exactMatches = cachedChats.filter(
    (chat) => String(chat.name || '').trim().toLowerCase() === normalized
  );

  if (exactMatches.length === 1) {
    return exactMatches[0];
  }

  if (exactMatches.length > 1) {
    const variants = exactMatches
      .map((chat) => `${chatLabel(chat)} -> ${chat.id._serialized}`)
      .join('; ');
    throw new Error(`"${value}" nomi bo'yicha bir nechta chat topildi: ${variants}`);
  }

  const similarMatches = cachedChats
    .filter((chat) => String(chat.name || '').toLowerCase().includes(normalized))
    .slice(0, 10)
    .map((chat) => `${chatLabel(chat)} -> ${chat.id._serialized}`);

  const hint = similarMatches.length > 0 ? ` O'xshashlari: ${similarMatches.join('; ')}` : '';
  throw new Error(`"${value}" chat topilmadi.${hint}`);
}

function shouldRouteMessage(message, config, route) {
  refreshDailyState(config);

  const text = messageText(message);
  if (!text) {
    return { ok: false, reason: 'empty' };
  }

  if (message.fromMe) {
    return { ok: false, reason: 'from_me' };
  }

  const routeMaxLength = Math.min(config.maxMessageLength, route.maxMessageLength);
  if (text.length > routeMaxLength) {
    return { ok: false, reason: 'too_long' };
  }

  const msgDate = messageTimestamp(message);
  if (getDateKey(msgDate, config.timezone) !== runtimeState.dayKey) {
    return { ok: false, reason: 'not_today' };
  }

  if (config.excludeRegex && config.excludeRegex.test(text)) {
    return { ok: false, reason: 'excluded_global' };
  }

  if (route.excludeRegex && route.excludeRegex.test(text)) {
    return { ok: false, reason: 'excluded' };
  }

  if (config.includeRegex && !config.includeRegex.test(text)) {
    return { ok: false, reason: 'no_global_match' };
  }

  if (route.includeRegex && !route.includeRegex.test(text)) {
    return { ok: false, reason: 'no_match' };
  }

  const baseMessageId = messageKey(message);
  const baseHash = getMessageHash(text);
  const targetChatId = route.targetChat.id._serialized;
  const routeId = routeMessageId(baseMessageId, targetChatId);
  const routeHash = routeMessageHash(baseHash, targetChatId);

  if (runtimeState.forwardedIds.has(routeId) || runtimeState.inFlightRouteKeys.has(routeId)) {
    return { ok: false, reason: 'duplicate_id' };
  }

  if (runtimeState.forwardedHashes.has(routeHash)) {
    return { ok: false, reason: 'duplicate_hash' };
  }

  return {
    ok: true,
    routeId,
    routeHash,
    text,
  };
}

function recordProcessed(routeId, routeHash) {
  if (!runtimeState.forwardedIds.has(routeId)) {
    runtimeState.forwardedIds.add(routeId);
    runtimeState.forwardedIdsWriter?.append(routeId);
  }

  if (!runtimeState.forwardedHashes.has(routeHash)) {
    runtimeState.forwardedHashes.add(routeHash);
    runtimeState.hashesWriter?.append(routeHash);
  }
}

async function forwardOrFallback(client, targetChat, sourceChat, message, config) {
  const sourceHeader = formatMessageHeader(sourceChat, message, config.timezone);
  await client.sendMessage(targetChat.id._serialized, sourceHeader);

  try {
    await message.forward(targetChat);
    return 'forwarded';
  } catch (error) {
    const fallbackText = formatFallbackText(sourceChat, message, config.timezone);
    await client.sendMessage(targetChat.id._serialized, fallbackText);
    return `copied (${error.message})`;
  }
}

async function processRoute(client, sourceChat, message, config, route) {
  const decision = shouldRouteMessage(message, config, route);
  if (!decision.ok) {
    return { forwarded: false, reason: decision.reason };
  }

  runtimeState.inFlightRouteKeys.add(decision.routeId);

  try {
    const mode = await forwardOrFallback(client, route.targetChat, sourceChat, message, config);
    recordProcessed(decision.routeId, decision.routeHash);

    console.log(
      `[OK] ${chatLabel(sourceChat)} -> ${routeLabel(route)} | ${mode} | ${decision.routeId} | ${decision.text.slice(0, 120)}`
    );

    return { forwarded: true, reason: mode };
  } catch (error) {
    console.error(
      `[ERROR] ${chatLabel(sourceChat)} -> ${routeLabel(route)} | ${decision.routeId} | ${error.message}`
    );
    return { forwarded: false, reason: error.message };
  } finally {
    runtimeState.inFlightRouteKeys.delete(decision.routeId);
  }
}

async function processMessageAcrossRoutes(client, sourceChat, message, config, routes) {
  let forwardedCount = 0;

  for (const route of routes) {
    const result = await processRoute(client, sourceChat, message, config, route);
    if (result.forwarded) {
      forwardedCount += 1;
    }
  }

  return forwardedCount;
}

async function fetchMessagesWithRetry(client, sourceChat, config) {
  let lastError = null;

  for (let attempt = 0; attempt <= config.historyFetchRetries; attempt += 1) {
    try {
      const freshChat = await client.getChatById(sourceChat.id._serialized);
      return await freshChat.fetchMessages({ limit: config.historyLimitPerChat });
    } catch (error) {
      lastError = error;
      const isLastAttempt = attempt === config.historyFetchRetries;

      console.warn(
        `[SCAN] ${chatLabel(sourceChat)} history xatosi (urinish ${attempt + 1}/${config.historyFetchRetries + 1}): ${error.message}`
      );

      if (isLastAttempt) {
        break;
      }

      await sleep(config.historyFetchRetryDelayMs);
    }
  }

  console.warn(`[SCAN] ${chatLabel(sourceChat)} history skip qilindi: ${lastError?.message || "noma'lum xato"}`);
  return null;
}

async function processHistoryForChat(client, sourceChat, config, routes) {
  if (config.historyLimitPerChat <= 0) {
    console.log(`[SCAN] ${chatLabel(sourceChat)} history scan skip qilindi (historyLimitPerChat=0).`);
    return;
  }

  console.log(`\n[SCAN] ${chatLabel(sourceChat)} dan history tekshirilmoqda...`);

  const messages = await fetchMessagesWithRetry(client, sourceChat, config);
  if (!messages) {
    console.warn(`[SCAN] ${chatLabel(sourceChat)} history olinmadi, live kuzatish davom etadi.`);
    return;
  }

  let forwardedCount = 0;

  for (const message of messages.slice().reverse()) {
    forwardedCount += await processMessageAcrossRoutes(client, sourceChat, message, config, routes);
  }

  console.log(`[SCAN] ${chatLabel(sourceChat)} | ${forwardedCount} ta route yuborish bajarildi.`);
}

async function closeRuntimeWriters() {
  const closers = [];

  if (runtimeState.forwardedIdsWriter) {
    closers.push(runtimeState.forwardedIdsWriter.close());
    runtimeState.forwardedIdsWriter = null;
  }

  if (runtimeState.hashesWriter) {
    closers.push(runtimeState.hashesWriter.close());
    runtimeState.hashesWriter = null;
  }

  await Promise.allSettled(closers);
}

async function printChatList(client) {
  const chats = await client.getChats();
  const lines = chats
    .slice()
    .sort((a, b) => chatLabel(a).localeCompare(chatLabel(b)))
    .map((chat) => {
      const type = chat.isGroup ? 'GROUP ' : 'PRIVATE';
      return `${type} | ${chatLabel(chat)} | ${chat.id._serialized}`;
    });

  console.log('\nMavjud chatlar:\n');
  for (const line of lines) {
    console.log(line);
  }
}

async function main() {
  const config = loadConfig();
  refreshDailyState(config);
  const processingQueue = new TaskQueue(config.processingConcurrency);

  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: config.sessionName,
      dataPath: config.authPath,
    }),
    authTimeoutMs: config.authTimeoutMs,
    puppeteer: config.puppeteer,
  });

  client.on('qr', (qr) => {
    console.log('\n[AUTH] QR kodni WhatsApp Linked Devices orqali skaner qiling:\n');
    qrcode.generate(qr, { small: true });
  });

  client.on('authenticated', () => {
    console.log('[AUTH] Sessiya tasdiqlandi.');
  });

  client.on('auth_failure', (message) => {
    console.error(`[AUTH] Autentifikatsiya xatoligi: ${message}`);
  });

  client.on('change_state', (state) => {
    console.log(`[STATE] WhatsApp holati: ${state}`);
  });

  client.on('disconnected', (reason) => {
    console.error(`[STATE] Ulanish uzildi: ${reason}`);
  });

  client.on('ready', async () => {
    console.log('[READY] WhatsApp multi client tayyor.');

    try {
      if (LIST_CHATS_ONLY) {
        await printChatList(client);
        await client.destroy();
        process.exit(0);
      }

      const allChats = await client.getChats();
      const sourceChats = [];
      const sourceChatById = new Map();

      for (const sourceSpec of config.sourceChats) {
        const sourceChat = await resolveChat(client, sourceSpec, allChats);
        sourceChats.push(sourceChat);
        sourceChatById.set(sourceChat.id._serialized, sourceChat);
      }

      const routes = [];
      for (const route of config.targetRoutes) {
        const targetChat = await resolveChat(client, route.targetChatSpec, allChats);
        routes.push({
          ...route,
          targetChat,
        });
      }

      for (const sourceChat of sourceChats) {
        console.log(`[READY] Source: ${chatLabel(sourceChat)} -> ${sourceChat.id._serialized}`);
      }

      for (const route of routes) {
        console.log(
          `[READY] Route: ${routeLabel(route)} | target=${chatLabel(route.targetChat)} -> ${route.targetChat.id._serialized}`
        );
      }

      client.on('message', async (message) => {
        const sourceChat = sourceChatById.get(message.from);
        if (!sourceChat) {
          return;
        }

        processingQueue
          .add(() => processMessageAcrossRoutes(client, sourceChat, message, config, routes))
          .catch((error) => {
            console.error(`[QUEUE] ${chatLabel(sourceChat)} | ${error.message}`);
          });
      });

      console.log('\n[LISTENING] Route bo‘yicha yangi xabarlar kuzatilmoqda...');

      for (const sourceChat of sourceChats) {
        await processHistoryForChat(client, sourceChat, config, routes);
      }
    } catch (error) {
      console.error(`[FATAL] ${error.message}`);
      await processingQueue.onIdle().catch(() => {});
      await closeRuntimeWriters();
      await client.destroy().catch(() => {});
      process.exit(1);
    }
  });

  process.on('SIGINT', async () => {
    console.log('\n[EXIT] To`xtatilmoqda...');
    await processingQueue.onIdle().catch(() => {});
    await closeRuntimeWriters();
    await client.destroy().catch(() => {});
    process.exit(0);
  });

  process.on('unhandledRejection', (error) => {
    console.error('[UNHANDLED_REJECTION]', error);
  });

  process.on('uncaughtException', (error) => {
    console.error('[UNCAUGHT_EXCEPTION]', error);
  });

  console.log('[BOOT] Multi client ishga tushmoqda...');
  await client.initialize();
}

main().catch((error) => {
  console.error(`[FATAL] ${error.message}`);
  closeRuntimeWriters().catch(() => {});
  process.exit(1);
});
