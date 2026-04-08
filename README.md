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
