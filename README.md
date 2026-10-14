# OsonNasiya v1 backend

Node.js, Express va MongoDB asosidagi birinchi API bosqichi. Hozirgi mobil ilova ishlatadigan `POST /auth/login` va `GET /auth/me` javob formatlari saqlangan. Swagger UI faqat mavjud endpointlarni hujjatlashtiradi.

## Ishga tushirish

Node.js 20+ va MongoDB kerak. PowerShell terminalida:

```powershell
cd C:\Users\1\Desktop\osonNasiya_v1_backend
npm.cmd ci
Copy-Item .env.example .env
```

`.env` faylida `MONGODB_URI`, kamida 32 belgili tasodifiy `JWT_SECRET`, birinchi admin uchun `SUPER_ADMIN_LOGIN` va kamida 12 belgili `SUPER_ADMIN_PASSWORD` ni belgilang. `.env` Gitga kiritilmaydi. Eski `osonNasiya/backend` ma'lumotlar bazasini davom ettirmoqchi bo'lsangiz, o'sha `MONGODB_URI`dan foydalaning. Mavjud super-admin paroli `.env`ni o'zgartirish bilan almashtirilmaydi.

```powershell
npm.cmd run dev
```

- API holati: http://localhost:3000/health
- Swagger UI: http://localhost:3000/docs
- OpenAPI JSON: http://localhost:3000/openapi.json

Swagger sahifasida `/auth/login` orqali token oling, so'ng **Authorize** tugmasiga tokenni kiriting va `/auth/me`ni sinab ko'ring. Swagger UI fayllari pinlangan CDNdan yuklanadi, shu bois sahifani ko'rish uchun brauzerda internet kerak; OpenAPI JSON mahalliy serverdan beriladi.

## Mobil ilovaga ulash

`osonNasiya_v1_mobile/.env`dagi `EXPO_PUBLIC_API_URL` ni API manziliga sozlang. Android emulator uchun odatda `http://10.0.2.2:3000`, jismoniy telefon uchun kompyuterning Wi-Fi IP manzili ishlatiladi. Telefon va kompyuter bir tarmoqda bo'lsin; Windows Firewall 3000-portga ruxsat berishi kerak. APK boshqa tarmoqdan ishlashi uchun backendni HTTPS manzilida joylashtirish va shu manzil bilan yangi build olish kerak.

Web preview uchun ruxsat etilgan originlarni `.env`dagi `CORS_ORIGINS` ro'yxatiga qo'shing. React Native ilovasining o'zida brauzer CORS cheklovi yo'q.

## Hozirgi API

| Endpoint | Vazifa |
| --- | --- |
| `GET /health` | Server holati |
| `POST /auth/login` | Super-admin login, 12 soatlik JWT |
| `GET /auth/me` | Bearer token bo'yicha joriy foydalanuvchi |
| `GET /openapi.json` | OpenAPI hujjati |
| `GET /docs` | Swagger UI |

Keyingi bosqichda sotuvchi/oluvchi/mahsulot/savdo uchun ma'lumotlar modeli va huquqlar aniqlangach, endpointlar qo'shiladi. Ularning oqimi `osonNasiya_v1_mobile/SOTUVCHI_DESIGN_SPEC.md`da tavsiflangan.
