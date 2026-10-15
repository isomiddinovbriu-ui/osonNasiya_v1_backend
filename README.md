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

Demo katalogni yaratish uchun bazada `test12` loginli `product_creator` bo‘lishi kerak. So‘ng `npm run seed:catalog` buyrug‘ini bajaring. Seed 7 guruh, har biriga 10 bo‘lim va har bo‘limga 5 mahsulot (jami 350 ta) qo‘shadi. Qayta bajarilganda mavjud yozuvlarni dublikat qilmaydi; mahsulot rasmlari bo‘sh qoladi.

20 ta namunaviy savdo hududini qo‘shish uchun `npm run seed:regions` buyrug‘ini bajaring. Seed mavjud `super_admin` ID sini `createdBy` ga yozadi va qayta bajarilganda hududlarni dublikat qilmaydi.

Mijozlar ro‘yxati `GET /customers` orqali olinadi (Bearer token kerak). Masalan, `GET /customers?regionId=<id>&name=Ali&hasDebt=true&page=1&limit=20`. `phoneNumber` filtri asosiy va qo‘shimcha telefon raqamlarining ikkalasidan ham qidiradi: `GET /customers?phoneNumber=90123`. Javobda `customers`, `total`, `page`, `limit` qaytadi. Barcha filtrlar, jumladan narx oralig‘i (`totalPriceMin`, `totalPriceMax`), sana (`createdFrom`, `createdTo`) va to‘lov filtrlari Swagger `/docs` sahifasida ko‘rsatilgan.

Har bir mijozga `mijoz_id` soni avtomatik beriladi. Mijoz API javoblarida MongoDB `_id` ko‘rsatilmaydi: `GET /customers?mijoz_id=1` bilan ro‘yxatni filtrlang, `GET /customers/1` bilan bitta mijozni oling va `POST /customers/1/payments` orqali to‘lov yozing. `npm run migrate:customer-ids` eski mijozlarni yaratilgan vaqt bo‘yicha raqamlaydi; server ishga tushganda ham shu migratsiya tekshiriladi. Counter saqlangani uchun raqamlar qayta ishlatilmaydi; muvaffaqiyatsiz yaratishdan so‘ng orada bo‘sh raqam qolishi mumkin.

To‘lov usuli faqat `cash` (naqd) yoki `transfer` (o‘tkazma) bo‘ladi. Bu `POST /customers` dagi `paymentMethod` va `POST /customers/{mijoz_id}/payments` dagi `method` uchun amal qiladi.

Mahsulotning `universalId` maydoni `UD-YYMMDDNNN` ko‘rinishida avtomatik beriladi: masalan, `UD-261015001`. Sana Toshkent vaqti bo‘yicha olinadi, tartib raqami har kuni `001`dan boshlanadi; `099`dan keyin `100`, `999`dan keyin `1000` bo‘ladi. U barcha mahsulot GET javoblarida va yaratish/yangilash javoblarida qaytadi; mavjud MongoDB `id` ham saqlanadi. `GET /products/search?search=UD-261015001` bilan qidirish mumkin. `npm run migrate:product-ids` mavjud mahsulotlarni yaratilgan sanasi bo‘yicha raqamlaydi; server ishga tushganda ham tekshiriladi.
