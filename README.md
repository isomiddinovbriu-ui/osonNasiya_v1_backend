# OsonNasiya backend

Loyiha Express va CommonJS asosida ishlaydi. Ishga tushirish fayli `src/server.js`, ilovani yig‘ish fayli `src/app.js`.

```text
src/
  app.js                    Express sozlamalari va modullarni ulash
  server.js                 MongoDB ulanishi, indekslar va serverni ishga tushirish
  config/                   Muhit sozlamalari va MinIO saqlash
  constants/                Umumiy rollar
  middleware/               JWT autentifikatsiyasi va ruxsat tekshiruvi
  modules/
    auth/                   Login va super adminni boshlang‘ich yaratish
    users/                  Xodimlarni boshqarish
    regions/                Hududlarni boshqarish
    customers/              Mijozlar va to‘lovlar
    catalog/                Kategoriyalar, mahsulotlar va rasmlar
  openapi.json              API hujjati
test/                       API testlari
```

Har bir modul o‘z endpointlarini `*.api.js` ichida ro‘yxatga oladi. API javobiga aylantirish kerak bo‘lgan joylarda `*.presenter.js` ishlatiladi. Yangi modulni `src/modules/` ichida yarating va `src/app.js`da ulang. Mavjud URL va javob formatlari saqlangan.

```bash
npm install
npm run check
npm test
npm run dev
```

Ishga tushirishdan oldin `.env.example` asosida `.env` sozlanadi. API hujjati `/docs` manzilida ochiladi.
