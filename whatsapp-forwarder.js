#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');

const ROOT_DIR = __dirname;
const CONFIG_PATH = path.join(ROOT_DIR, 'config.json');
const LOG_DIR = path.join(ROOT_DIR, 'message_logs');
const LIST_CHATS_ONLY = process.argv.includes('--list-chats');

const DEFAULT_CONFIG = {
  sessionName: 'whtspp-forwarder',
  mode: 'filtered',
  timezone: 'Asia/Tashkent',
  authTimeoutMs: 120000,
  historyLimitPerChat: 100,
  historyFetchRetries: 2,
  historyFetchRetryDelayMs: 1500,
  maxMessageLength: 300,
  processingConcurrency: 2,
  logFlushIntervalMs: 250,
  logFlushBatchSize: 50,
  sourceChats: [],
  targetChat: '',
  includePattern: '',
  excludePattern: '',
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
  inFlightIds: new Set(),
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

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    if (LIST_CHATS_ONLY) {
      return { ...DEFAULT_CONFIG };
    }

    throw new Error(
      `config.json topilmadi. Avval ${CONFIG_PATH} faylini config.example.json asosida yarating.`
    );
  }

  const userConfig = readJson(CONFIG_PATH);
  const config = {
    ...DEFAULT_CONFIG,
    ...userConfig,
    puppeteer: {
      ...DEFAULT_CONFIG.puppeteer,
      ...(userConfig.puppeteer || {}),
    },
  };

  config.mode = String(config.mode || 'filtered').trim().toLowerCase();
  config.sourceChats = normalizeChatSpecs(config.sourceChats);
  config.historyFetchRetries = Math.max(0, Number(config.historyFetchRetries) || 0);
  config.historyFetchRetryDelayMs = Math.max(250, Number(config.historyFetchRetryDelayMs) || 1500);
  config.processingConcurrency = Math.max(1, Number(config.processingConcurrency) || 1);
  config.logFlushIntervalMs = Math.max(50, Number(config.logFlushIntervalMs) || 250);
  config.logFlushBatchSize = Math.max(1, Number(config.logFlushBatchSize) || 50);

  if (!LIST_CHATS_ONLY) {
    if (!Array.isArray(config.sourceChats) || config.sourceChats.length === 0) {
      throw new Error('config.json ichida sourceChats bo`sh bo`lmasligi kerak.');
    }

    if (!config.targetChat || typeof config.targetChat !== 'string') {
      throw new Error('config.json ichida targetChat to`ldirilishi kerak.');
    }

    if (config.mode === 'filtered' && (!config.includePattern || typeof config.includePattern !== 'string')) {
      throw new Error('config.json ichida includePattern to`ldirilishi kerak.');
    }
  }

  if (!['filtered', 'all'].includes(config.mode)) {
    throw new Error("mode faqat 'filtered' yoki 'all' bo`lishi mumkin.");
  }

  if (!/^[A-Za-z0-9_-]+$/.test(config.sessionName)) {
    throw new Error('sessionName faqat harf, raqam, "_" yoki "-" dan iborat bo`lishi kerak.');
  }

  return config;
}

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
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
  runtimeState.inFlightIds = new Set();
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
    `[STATE] ${todayKey} uchun loglar yuklandi. IDs=${runtimeState.forwardedIds.size}, hashes=${runtimeState.forwardedHashes.size}`
  );

  return runtimeState;
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

function isChatId(value) {
  return /@(?:g\.us|c\.us|lid|newsletter|broadcast)$/.test(value);
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

function recordProcessed(messageId, textHash) {
  if (!runtimeState.forwardedIds.has(messageId)) {
    runtimeState.forwardedIds.add(messageId);
    runtimeState.forwardedIdsWriter?.append(messageId);
  }

  if (!runtimeState.forwardedHashes.has(textHash)) {
    runtimeState.forwardedHashes.add(textHash);
    runtimeState.hashesWriter?.append(textHash);
  }
}

function formatFallbackText(sourceChat, message, timezone) {
  return [
    `Sana: ${formatMessageDate(messageTimestamp(message), timezone)}`,
    '',
    messageText(message),
  ].join('\n');
}

function formatSourceHeader(sourceChat) {
  return `Guruh: ${chatLabel(sourceChat)}`;
}

function shouldHandleMessage(message, config, includeRegex, excludeRegex) {
  refreshDailyState(config);

  const text = messageText(message);
  if (!text) {
    return { ok: false, reason: 'empty' };
  }

  if (message.fromMe) {
    return { ok: false, reason: 'from_me' };
  }

  if (config.mode !== 'all' && text.length > config.maxMessageLength) {
    return { ok: false, reason: 'too_long' };
  }

  const msgDate = messageTimestamp(message);
  if (getDateKey(msgDate, config.timezone) !== runtimeState.dayKey) {
    return { ok: false, reason: 'not_today' };
  }

  const id = messageKey(message);
  const hash = getMessageHash(text);

  if (runtimeState.forwardedIds.has(id) || runtimeState.inFlightIds.has(id)) {
    return { ok: false, reason: 'duplicate_id' };
  }

  if (runtimeState.forwardedHashes.has(hash)) {
    return { ok: false, reason: 'duplicate_hash' };
  }

  if (config.mode !== 'all' && excludeRegex && excludeRegex.test(text)) {
    return { ok: false, reason: 'excluded' };
  }

  if (config.mode !== 'all' && includeRegex && !includeRegex.test(text)) {
    return { ok: false, reason: 'no_match' };
  }

  return { ok: true, id, hash, text };
}

async function forwardOrFallback(client, targetChat, sourceChat, message, config) {
  const sourceHeader = formatSourceHeader(sourceChat);
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

async function processCandidate(client, sourceChat, targetChat, message, config, includeRegex, excludeRegex) {
  const decision = shouldHandleMessage(message, config, includeRegex, excludeRegex);
  if (!decision.ok) {
    return { forwarded: false, reason: decision.reason };
  }

  runtimeState.inFlightIds.add(decision.id);

  try {
    const mode = await forwardOrFallback(client, targetChat, sourceChat, message, config);
    recordProcessed(decision.id, decision.hash);

    console.log(
      `[OK] ${chatLabel(sourceChat)} | ${mode} | ${decision.id} | ${decision.text.slice(0, 120)}`
    );

    return { forwarded: true, reason: mode };
  } catch (error) {
    console.error(`[ERROR] ${chatLabel(sourceChat)} | ${decision.id} | ${error.message}`);
    return { forwarded: false, reason: error.message };
  } finally {
    runtimeState.inFlightIds.delete(decision.id);
  }
}

async function processHistoryForChat(client, sourceChat, targetChat, config, includeRegex, excludeRegex) {
  console.log(`\n[SCAN] ${chatLabel(sourceChat)} dan history tekshirilmoqda...`);

  const messages = await fetchMessagesWithRetry(client, sourceChat, config);
  if (!messages) {
    console.warn(`[SCAN] ${chatLabel(sourceChat)} history olinmadi, live kuzatish davom etadi.`);
    return;
  }

  let forwardedCount = 0;

  for (const message of messages.slice().reverse()) {
    const result = await processCandidate(
      client,
      sourceChat,
      targetChat,
      message,
      config,
      includeRegex,
      excludeRegex
    );

    if (result.forwarded) {
      forwardedCount += 1;
    }
  }

  console.log(`[SCAN] ${chatLabel(sourceChat)} | ${forwardedCount} ta xabar uzatildi.`);
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

  console.warn(`[SCAN] ${chatLabel(sourceChat)} history skip qilindi: ${lastError?.message || 'noma`lum xato'}`);
  return null;
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

  const includeRegex = compileRegex(config.includePattern, 'includePattern');
  const excludeRegex = compileRegex(config.excludePattern, 'excludePattern');
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
    console.log('[READY] WhatsApp client tayyor.');

    try {
      if (LIST_CHATS_ONLY) {
        await printChatList(client);
        await client.destroy();
        process.exit(0);
      }

      const allChats = await client.getChats();
      const targetChat = await resolveChat(client, config.targetChat, allChats);
      const sourceChats = [];
      const sourceChatById = new Map();

      for (const sourceSpec of config.sourceChats) {
        const sourceChat = await resolveChat(client, sourceSpec, allChats);
        sourceChats.push(sourceChat);
        sourceChatById.set(sourceChat.id._serialized, sourceChat);
      }

      console.log(`[READY] Target: ${chatLabel(targetChat)} -> ${targetChat.id._serialized}`);
      for (const sourceChat of sourceChats) {
        console.log(`[READY] Source: ${chatLabel(sourceChat)} -> ${sourceChat.id._serialized}`);
      }

      client.on('message', async (message) => {
        const sourceChat = sourceChatById.get(message.from);
        if (!sourceChat) {
          return;
        }

        processingQueue
          .add(() =>
            processCandidate(
              client,
              sourceChat,
              targetChat,
              message,
              config,
              includeRegex,
              excludeRegex
            )
          )
          .catch((error) => {
            console.error(`[QUEUE] ${chatLabel(sourceChat)} | ${error.message}`);
          });
      });

      console.log('\n[LISTENING] Yangi xabarlar kuzatilmoqda...');

      for (const sourceChat of sourceChats) {
        await processHistoryForChat(
          client,
          sourceChat,
          targetChat,
          config,
          includeRegex,
          excludeRegex
        );
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

  console.log('[BOOT] Client ishga tushmoqda...');
  await client.initialize();
}

main().catch((error) => {
  console.error(`[FATAL] ${error.message}`);
  closeRuntimeWriters().catch(() => {});
  process.exit(1);
});
