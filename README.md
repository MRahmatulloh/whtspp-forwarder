# WhatsApp Forwarder

Bu skript `whatsapp-web.js` asosida yozilgan va Telegram skriptingizdagi oqimga yaqin ishlaydi:

- bir nechta source chat/grouplarni kuzatadi
- `includePattern` bo'yicha mos xabarlarni ajratadi
- `excludePattern` bo'yicha istisno qiladi
- bir kunlik `message_logs/` ichida ID va hash orqali dublikatlarni ushlaydi
- har bir uzatiladigan xabardan oldin source guruh nomini alohida yuboradi
- imkon bo'lsa xabarni `forward` qiladi
- `forward` ishlamasa, sana bilan oddiy matn yuboradi

## Talablar

- Node.js `18+`
- hostingda Chromium/Puppeteer ishlashi kerak
- birinchi ishga tushirishda QR skan qilish kerak
- agar serverda system Chrome bo'lmasa, `npx puppeteer browsers install chrome` bilan lokal browser yuklash kerak bo'lishi mumkin

## Ishga tushirish

1. `config.json` fayli kerak bo'ladi. Strukturasi uchun [config.example.json](/C:/OSPanel/home/whtspp/config.example.json) dan foydalaning.
2. Paketlarni o'rnating:

```bash
npm install
```

3. Avval chat ID larni ko'rib olish qulay:

```bash
npm run list-chats
```

4. Keyin asosiy skriptni ishga tushiring:

```bash
npm start
```

## PM2 bilan ishlatish

Bir martalik start:

```bash
pm2 start ecosystem.config.cjs
```

Holatini ko'rish:

```bash
pm2 status
pm2 logs whtspp-forwarder
```

Config yoki kod o'zgarsa restart:

```bash
pm2 restart whtspp-forwarder
```

Server rebootdan keyin ham qayta turishi uchun:

```bash
pm2 save
pm2 startup
```

## Shared Hosting Eslatma

Ba'zi shared hostinglarda `google-chrome` yoki `chromium` PATH ichida bo'lmaydi. Bu holatda Puppeteer uchun browserni loyiha ichidagi cache'ga yuklab ko'ring:

```bash
npx puppeteer browsers install chrome
```

Agar yuklangan browserni tekshirmoqchi bo'lsangiz:

```bash
npx @puppeteer/browsers list
```

Loyiha ichida `.puppeteerrc.cjs` bor, shu sabab browser cache `.cache/puppeteer` ichiga tushadi.

## Konfiguratsiya

- `sourceChats`: source gruppalar yoki chatlar. ID yoki exact nom yozsa bo'ladi.
- `targetChat`: forward yuboriladigan chat ID yoki exact nom.
- `mode`: `filtered` yoki `all`.
- `filtered`: `includePattern`, `excludePattern` va `maxMessageLength` ishlaydi.
- `all`: har qanday xabar forward qilinadi, `includePattern`, `excludePattern` va `maxMessageLength` e'tiborga olinmaydi.
- `includePattern`: `filtered` rejimida mos kelishi kerak bo'lgan regex.
- `excludePattern`: `filtered` rejimida chiqarib tashlanadigan regex.
- `historyLimitPerChat`: start paytida har bir chatdan nechta oxirgi xabar tekshirilishi.
- `maxMessageLength`: bundan uzun matnlar o'tkazib yuboriladi.
- `timezone`: kunlik log va sana filtri uchun timezone.
- `authTimeoutMs`: WhatsApp auth/ready jarayoni uchun timeout.
- `puppeteer.timeout`: browser launch timeout.
- `puppeteer.protocolTimeout`: Chrome DevTools command timeout.

## Hosting uchun eslatma

- `whatsapp-web.js` norasmiy yechim. WhatsApp bunday avtomatizatsiyani to'liq qo'llab-quvvatlamaydi.
- Uzoq ishlatish uchun odatda `pm2` bilan ko'tariladi.
- Agar serverda sandbox muammosi bo'lsa, `puppeteer.args` ichidagi `--no-sandbox` saqlab qoling.

## Ehtiyot bo'ling

- Sessiya `.wwebjs_auth/` papkada saqlanadi.
- `config.json` ichida private chat nomlari yoki ID lari bo'lishi mumkin, shu sabab `.gitignore` ga qo'shilgan.
