# OsonNasiya backend

## Login va sessiya

CORS barcha brauzer originlari uchun ochiq: server so'rovdagi `Origin`ni javobga qaytaradi va cookie bilan ishlaydigan so'rovlarga ruxsat beradi. `CORS_ORIGINS` sozlamasi ishlatilmaydi.

`POST /auth/login` 15 daqiqalik `accessToken` (`token` ham shu qiymat) va `expiresIn: 900` qaytaradi. Mobil ilova `clientType: "mobile"` (standart) yuboradi va javobdagi `refreshToken` ni qurilmaning xavfsiz saqlash joyida saqlaydi. Admin web ilova `clientType: "web"` yuboradi; refresh token `HttpOnly; Secure; SameSite=Strict` cookieda qaytadi. Web so'rovlarida `credentials: "include"` va HTTPS kerak.

Access token muddati tugaganda `POST /auth/refresh` chaqiriladi: mobil ilova `{ "refreshToken": "..." }` yuboradi, web ilova cookieni yuboradi. Javob yangi access token beradi; mobil ilova qaytgan **yangi** refresh tokenni eskisi o'rniga saqlaydi. Har bir refresh sessiya muddatini yana 30 kunga uzaytiradi (`refreshExpiresAt`). Masalan, ilova har ikki kunda ochilib refresh qilinsa, sessiya davom etadi. Oxirgi refreshdan keyin 30 kun o'tsa qayta login kerak. Oddiy API so'rovlari muddatni uzaytirmaydi.

Chiqishda `POST /auth/logout` ga mobil ilova oxirgi refresh tokenni yuboradi, web ilova cookieni yuboradi. Shu sessiyaga tegishli access token ham bekor bo'ladi. Avval berilgan 12 soatlik, sessiya ID si bo'lmagan tokenlar muddatigacha ishlaydi.

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

## To‘liq demo ma’lumotlar

`.env` sozlangan va MongoDB ishlayotgan bo‘lsa, `npm run seed:demo -- --apply` buyrug‘i demo ma’lumotlarni yaratadi. `--count=80` bilan mijozlar sonini 1–500 oralig‘ida tanlash mumkin; standart 40 ta. Seed lokal standalone MongoDBda ham ishlaydi; API orqali yangi to‘lov yozish uchun esa replica set yoki Atlas kerak. Seed avval super adminni (yo‘q bo‘lsa `.env` orqali), uch demo xodimni (`test12`, `demo_sotuvchi`, `demo_yiguvchi`), 20 hududni, 7 guruh/70 bo‘lim/350 mahsulotni va to‘lov ilovalari katalogini tayyorlaydi. Keyin mijozlar, boshlang‘ich va oylik to‘lovlar, audit tarixi, qisman to‘lov, kechikkan qarz hamda sabab bilan bekor qilingan to‘lov namunalarini qo‘shadi. Mijoz telefonlari sun’iy `+998 00 000 ...` formatida; mahsulot rasmlari yaratilmaydi.

Yangi xodimlarning 5 xonali parollari faqat birinchi ishga tushganda terminalda chiqadi; ularni saqlab qo‘ying. Qayta ishga tushirish mavjud demo mijozlar/to‘lovlarni dublikat qilmaydi yoki o‘zgartirmaydi. `--count` oshirilsa faqat yangi raqamdagi demo mijozlar qo‘shiladi. Demo mijozlar `demoSeedKey`, yangi xodimlar va to‘lovlar `demoSeed` bilan belgilanadi; hisobotlar ularni odatiy ma’lumot sifatida hisoblaydi. Ishlab turgan haqiqiy baza o‘rniga alohida sinov bazasida ishlating. Login so‘rovlari, sessiyalar va `payment_requests` operatsion yozuvlari seed qilinmaydi; ular faqat tegishli API so‘rovlari bajarilganda yaratiladi.

Mijozlar ro‘yxati `GET /customers` orqali olinadi (Bearer token kerak). Masalan, `GET /customers?regionId=<id>&name=Ali&hasDebt=true&page=1&limit=20`. `phoneNumber` filtri asosiy va qo‘shimcha telefon raqamlarining ikkalasidan ham qidiradi: `GET /customers?phoneNumber=90123`. Javobda `customers`, `total`, `page`, `limit` qaytadi. Barcha filtrlar, jumladan narx oralig‘i (`totalPriceMin`, `totalPriceMax`), sana (`createdFrom`, `createdTo`) va to‘lov filtrlari Swagger `/docs` sahifasida ko‘rsatilgan.

Yaqin mijozlarni olish uchun `GET /customers/nearby?lat=41.2995&long=69.2401&radiusMeters=1000` yuboring (Bearer token kerak). `radiusMeters` metrda butun son (`1000` = 1 km, `12345` = 12.345 km); javobda `customers` va `total`, har bir mijozda `distanceKm` kilometrda qaytadi. Masofa to‘g‘ri chiziq bo‘yicha hisoblanadi va natijalar eng yaqindan tartiblanadi.

Har bir mijozga `mijoz_id` soni avtomatik beriladi. Mijoz API javoblarida MongoDB `_id` ko‘rsatilmaydi: `GET /customers?mijoz_id=1` bilan ro‘yxatni filtrlang, `GET /customers/1` bilan bitta mijozni oling va `POST /customers/1/payments` orqali to‘lov yozing. `npm run migrate:customer-ids` eski mijozlarni yaratilgan vaqt bo‘yicha raqamlaydi; server ishga tushganda ham shu migratsiya tekshiriladi. Counter saqlangani uchun raqamlar qayta ishlatilmaydi; muvaffaqiyatsiz yaratishdan so‘ng orada bo‘sh raqam qolishi mumkin.

Har bir to‘lovga `paymentId` avtomatik beriladi: `POST /customers/{mijoz_id}/payments` javobida yuqori darajadagi `paymentId` va `payment.paymentId` qaytadi. `POST /customers` ning boshlang‘ich to‘lovi ham `customer.payments[0].paymentId` bilan qaytadi. Eski `id` kaliti moslik uchun saqlangan va `paymentId` bilan bir xil; `GET /customers?paymentId=<id>` filtri ishlaydi.

To‘lov usuli `cash` (naqd), `transfer` (eski o‘tkazma turi), `card` (bank kartasi) yoki `payment_app` (to‘lov ilovasi) bo‘ladi. `GET /payments/options` (Bearer token kerak) ilova tanlovi uchun usullarni va `payment_apps` collectiondagi 48 ta ilovani 5 kategoriyada qaytaradi. `POST /customers` dagi `paymentMethod` ham, `POST /customers/{mijoz_id}/payments` dagi `method` ham shu turlardan foydalanadi. Karta to‘lovi uchun `cardNumber` yuboriladi; baza va API javobida faqat `cardLast4` saqlanadi. Ilova to‘lovi uchun GET javobidagi `provider` kodi yuboriladi (masalan, `click`, `payme`, `paynet`); ro‘yxatda yo‘q ilova uchun `provider: "other"` va `providerName` yuboring. `npm run seed:payment-apps` ro‘yxatni bazaga takrorlamasdan yozadi; server ishga tushganda ham seed yangilanadi. Bu faqat qabul qilingan to‘lovni qayd etadi, provayder orqali avtomatik pul yechmaydi.

`payment_app` to‘lovida `provider` bilan birga pul yuborilgan `cardNumber` ham majburiy: masalan, `{"amount":100000,"method":"payment_app","provider":"click","cardNumber":"8600 1234 1234 5678","forMonth":"2026-06"}`. Boshlang‘ich to‘lovda ham `paymentMethod: "payment_app"`, `provider` va `cardNumber` birga yuboriladi. To‘liq raqam qaytarilmaydi va saqlanmaydi; javobda `cardLast4: "5678"` bo‘ladi. Eski ilova to‘lovlarida `cardLast4: null` bo‘lishi mumkin.

To‘lovlar alohida `payments` collectionda saqlanadi. Har bir yozuvda `customerId` (MongoDB mijoz IDsi), `mijoz_id`, `type`, `amount`, `method`, `receivedBy` va `paidAt` bor. Mijoz API javobidagi `payments` tarixi shu collectiondan olinadi. Server ishga tushganda eski `customers.payments` yozuvlarini takrorlamasdan ko‘chiradi; kerak bo‘lsa `npm run migrate:payments` buyrug‘ini alohida bajaring. Yangi mijozning boshlang‘ich to‘lovi va keyingi to‘lovlar mijoz balansi bilan MongoDB tranzaksiyasida yoziladi; baza replica set yoki MongoDB Atlas bo‘lishi kerak.

`termMonths` kelishilgan muddatni bildiradi, ammo to‘lov summasi yoki sanasiga qattiq cheklov qo‘ymaydi. Masalan, 1 200 000 so‘m qarz va 12 oy muddatda birinchi oy 300 000, ikkinchi oy 0, uchinchi oy 50 000 so‘m to‘lash mumkin: faqat haqiqiy to‘lovlar `payments`ga yoziladi va qoldiq 850 000 so‘m bo‘ladi. 12 oydan keyin ham qoldiqni to‘lash mumkin. Har bir kiritilgan summa musbat butun so‘m bo‘lishi va qolgan qarzdan oshmasligi kerak; oxirgi to‘lov istalgancha kichik bo‘lishi mumkin.

Keyingi to‘lovda `forMonth` qaysi oy uchun to‘langanini bildiradi: `POST /customers/1/payments` ga `{"amount":100000,"method":"cash","forMonth":"2026-06"}` yuborish mumkin. `paidAt` haqiqiy qabul qilingan sana bo‘lib qoladi, shuning uchun oktabrda iyun yoki iyul qarzini yopish mumkin. Ikkala oy uchun alohida to‘lov yoziladi; bir oyga bir necha qisman to‘lov ham mumkin. `GET /customers?paymentMonth=2026-06` shu oyga tegishli to‘lovi bor mijozlarni topadi. Eski oy belgilanmagan to‘lovlar javobida `forMonth: null` qaytadi. Oy bo‘yicha avtomatik penya yoki majburiy summa hisoblanmaydi.

Mahsulotning `universalId` maydoni `UD-YYMMDDNNN` ko‘rinishida avtomatik beriladi: masalan, `UD-261015001`. Sana Toshkent vaqti bo‘yicha olinadi, tartib raqami har kuni `001`dan boshlanadi; `099`dan keyin `100`, `999`dan keyin `1000` bo‘ladi. U barcha mahsulot GET javoblarida va yaratish/yangilash javoblarida qaytadi; mavjud MongoDB `id` ham saqlanadi. `GET /products/search?search=UD-261015001` bilan qidirish mumkin. `npm run migrate:product-ids` mavjud mahsulotlarni yaratilgan sanasi bo‘yicha raqamlaydi; server ishga tushganda ham tekshiriladi.

Mahsulot yaratishda `warrantyPeriod` majburiy: `1.6` — 1 yil 6 oy. 10 yoki 11 oy uchun `"1.10"` yoki `"1.11"` matnini yuboring. Maydonni `PATCH /products/{id}` orqali yangilash mumkin; eski mahsulotlarda javob qiymati `null` bo‘ladi.

## Audit va noto'g'ri to'lovni bekor qilish

Yangi mijoz va to'lovlar yaratilganda `audit_logs` collectionga kim, qachon, qaysi yozuvni yaratgani yoziladi. To'lovni bekor qilish ham auditga oldingi va keyingi to'lov holati hamda balans bilan yoziladi. Audit va balans o'zgarishi to'lov yozuvi bilan bir MongoDB tranzaksiyasida saqlanadi. Eski amallar uchun tarix avtomatik tiklanmaydi.

Faqat `super_admin` `POST /customers/{mijoz_id}/payments/{paymentId}/void` so'roviga `{"reason":"Kassa qaydida xato"}` yuborib to'lovni bekor qiladi. Sabab 1–500 belgidan iborat bo'lishi kerak. To'lov o'chirilmaydi: `status: "voided"`, `voidedAt`, `voidedBy` va `voidReason` bilan tarixda qoladi. Balansdan ushbu summa ayriladi va qarzga qaytariladi; boshlang'ich to'lov bekor qilinsa `downPayment` ham kamayadi. Bir to'lovni qayta bekor qilish `409` qaytaradi. Eski, bekor qilinmagan to'lovlar javobida `status: "active"` bo'ladi. To'lov bo'yicha mijoz qidirish filtrlari bekor qilingan to'lovlarni hisobga olmaydi.

`GET /customers/{mijoz_id}/audit?page=1&limit=20` faqat `super_admin`ga mijozning audit tarixini yangi yozuvdan boshlab qaytaradi. Har bir yozuvda `action`, `entityType`, `entityId`, `actorId`, `actorRole`, `createdAt`, `reason`, `before` va `after` bor. Barcha endpointlar `/docs` da ham hujjatlashtirilgan.

## Hisobotlar va CSV eksport

Hisobotlarni faqat `super_admin` Bearer token bilan oladi. `from` va `to` sanalari `YYYY-MM-DD` formatida, Toshkent vaqti bo'yicha ikkala cheti ham kiritilgan oralig'ini bildiradi. Berilmasa bugungi kun olinadi. Eng uzun oralig' 3660 kun. `format=csv` qo'shilsa UTF-8 CSV fayl yuklanadi; odatiy javob JSON. CSVda formulaga o'xshash nomlar xavfsiz matn ko'rinishida chiqariladi.

- `GET /reports/revenue?from=2026-10-01&to=2026-10-31&groupBy=day` - tushum va to'lovlar soni kunlar kesimida. `groupBy=month` oylar kesimini beradi. Tushum haqiqiy `paidAt` sanasi bo'yicha olinadi; bekor qilingan to'lovlar hisoblanmaydi. JSONda `rows` va `total` qaytadi.
- `GET /reports/sales?from=2026-10-01&to=2026-10-31&groupBy=region` - hududlar bo'yicha savdo soni va summasi. `groupBy=staff` sotuvni mijozni yaratgan xodim bo'yicha guruhlaydi. Savdo sanasi mijozning `createdAt` maydoni, summa `totalPrice`; keyingi to'lovlar savdo summasini o'zgartirmaydi.
- `GET /reports/debt` - joriy umumiy qarz (`totalDebt`), taxminiy kechikkan qarz (`overdueDebt`) va tegishli mijozlar soni. Tarixiy `asOf` qabul qilinmaydi, chunki o'tmishdagi balans suratlari saqlanmagan. Eski yoki nomuvofiq yozuvlar `unclassifiedDebt` va `unclassifiedCustomers`da ko'rsatiladi.
- `GET /reports/monthly-underpaid?month=2026-10&page=1&limit=20` - shu oy uchun 0 dan ko'p, lekin hisoblangan oylik summadan kam to'lagan mijozlar. Javobda `monthlyAmount`, `paidAmount`, `shortfall`, `status: "underpaid"` va `message: "Oylik to'lovdan kam to'landi"` qaytadi. `forMonth` bo'lsa shu oyga, eski oy belgilanmagan to'lov esa `paidAt` ning Toshkent oyiga hisoblanadi. Bekor qilingan to'lov hisoblanmaydi. `format=csv` faqat so'ralgan sahifani chiqaradi. Hech qanday penya qo'shilmaydi.

Kechikkan qarz hisoblash qoidasi: `totalPrice - downPayment` `termMonths` oyga teng taqsimlanadi; birinchi ulush savdo sanasidan bir oy keyin to'lanishi kerak deb olinadi. Oy oxiridagi savdolar uchun keyingi oyning oxirgi kuni olinadi. To'langan keyingi summalar eng eski majburiyatni kamaytiradi, `forMonth` ajratmasi hisobga olinmaydi. Bu mavjud shartnoma ma'lumotlaridan hisoblangan ko'rsatkich; alohida kelishilgan to'lov jadvali bazada saqlanmaydi. Har bir endpointning CSV shakli uchun shu URLga `&format=csv` (`/reports/debt?format=csv`) qo'shing.

## Takroriy to'lovdan himoya

Mobil ilova `POST /customers/{mijoz_id}/payments` ga har bir **yangi** to'lov uchun yangi `Idempotency-Key` header yuboradi (masalan, UUID). Tarmoq xatosi sabab qayta urinishda aynan shu kalitni, mijoz ID sini va bir xil JSON mazmunini yuboradi. Kalit 8–128 belgili bo'lishi, faqat harf, raqam, `.`, `_`, `-`, `:` ishlatishi kerak. Header ixtiyoriy bo'lib, eski ilovalar ishlashda davom etadi; himoya faqat kalit yuborilgan so'rovlarga tatbiq etiladi.

Bir xodim bir xil kalit va so'rovni qayta yuborsa server avvalgi `201` javobni qaytaradi (`Idempotency-Replayed: true` header) va yangi to'lov, audit yoki balans o'zgarishi yaratmaydi. Xuddi shu xodim kalitni boshqa mijoz yoki boshqa JSON mazmuni uchun ishlatsa `409` qaytadi. Kalit xodim ID si bo'yicha ajratiladi va vaqt o'tishi bilan qayta ishlatilmaydi. Takroriy javob birinchi urinishdagi balans suratini qaytaradi; joriy balans uchun `GET /customers/{mijoz_id}` chaqiring. Server `payment_requests` collectionda kalit, so'rovning maxfiy kalit bilan hisoblangan xeshi va birinchi javobni saqlaydi; to'liq karta raqami saqlanmaydi. Yozuv to'lov, balans va audit bilan bitta MongoDB tranzaksiyasida saqlanadi.
