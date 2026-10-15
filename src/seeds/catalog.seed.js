const { MongoClient } = require('mongodb');
const { prepareProductIds } = require('../modules/catalog/product-id.service');

// Har bir guruhda 10 ta bo'lim, har bir bo'limda 5 ta mahsulot bor.
// Narxlar demo ma'lumotlar uchun so'mda berilgan.
const catalog = [
  ['Elektronika', [
    ['Smartfonlar', 2500000, 'Samsung Galaxy A55|Xiaomi Redmi Note 13|Apple iPhone 15|Honor X9b|Infinix Note 40'],
    ['Noutbuklar', 6500000, 'Lenovo IdeaPad Slim 3|HP Pavilion 15|ASUS Vivobook 16|Acer Aspire 5|MacBook Air M2'],
    ['Planshetlar', 2800000, 'Samsung Galaxy Tab A9|Apple iPad 10|Xiaomi Pad 6|Lenovo Tab M11|Honor Pad X9'],
    ['Televizorlar', 4500000, 'Samsung Crystal UHD 43|LG UHD 50|Artel Android TV 43|Hisense QLED 55|TCL Smart TV 50'],
    ['Quloqchinlar', 350000, 'Apple AirPods 3|Samsung Galaxy Buds FE|JBL Tune 720BT|Sony WH-CH520|Anker Soundcore Q20i'],
    ['Aqlli soatlar', 700000, 'Apple Watch SE|Samsung Galaxy Watch 6|Xiaomi Redmi Watch 4|Huawei Watch Fit 3|Amazfit Bip 5'],
    ['Printerlar', 2200000, 'HP LaserJet M111w|Canon PIXMA G3410|Epson EcoTank L3250|Brother DCP-T420W|Pantum P2500W'],
    ['Monitorlar', 1800000, 'Samsung Essential 24|LG UltraGear 27|ASUS TUF Gaming 27|Acer Nitro 24|Dell P2422H'],
    ['Routerlar', 450000, 'TP-Link Archer C6|Keenetic Viva|Xiaomi Router AX3000|Tenda AC10|Mercusys MR70X'],
    ['Fotoapparatlar', 7500000, 'Canon EOS R50|Nikon Z50|Sony Alpha A6400|Fujifilm X-S20|Panasonic Lumix G100'],
  ]],
  ['Maishiy texnika', [
    ['Muzlatkichlar', 6000000, 'Samsung No Frost 350 l|LG DoorCooling 340 l|Artel HD 360 l|Beko NeoFrost 300 l|Hisense Total No Frost 330 l'],
    ['Kir yuvish mashinalari', 4800000, 'Samsung EcoBubble 8 kg|LG Direct Drive 7 kg|Artel avtomat 6 kg|Beko SteamCure 8 kg|Bosch Serie 4 7 kg'],
    ['Changyutkichlar', 1400000, 'Samsung Cyclone 1800 W|LG Kompressor 2000 W|Artel Turbo 1600 W|Philips PowerPro 1800 W|Xiaomi Robot Vacuum S10'],
    ['Konditsionerlar', 5500000, 'Artel Inverter 12|Gree Pular 12|Midea Blanc 12|Samsung WindFree 12|LG Dual Inverter 12'],
    ['Dazmollar', 450000, 'Philips Azur 2600 W|Tefal Express Steam 2400 W|Braun TexStyle 7|Artel bug‘li dazmol 2200 W|Rowenta Effective 2400 W'],
    ['Mikroto‘lqinli pechlar', 1200000, 'Samsung Solo 23 l|LG NeoChef 25 l|Artel 20 l|Midea Grill 23 l|Panasonic NN-SM33'],
    ['Idish yuvish mashinalari', 5000000, 'Bosch Serie 2 60 sm|Beko 10 komplekt|Samsung 13 komplekt|Midea 8 komplekt|Hisense 14 komplekt'],
    ['Elektr pechlar', 2100000, 'Artel elektr pech 45 l|Simfer mini pech 42 l|Beko elektr pech 60 l|Gefest elektr pech 52 l|Midea mini pech 35 l'],
    ['Suv isitgichlar', 1700000, 'Ariston 80 l|Thermex 50 l|Artel 80 l|Bosch Tronic 100 l|Atlantic 50 l'],
    ['Havo tozalagichlar', 1900000, 'Xiaomi Smart Air Purifier 4|Philips Series 800|Samsung AX40|Levoit Core 300S|Sharp Plasmacluster 40'],
  ]],
  ['Mebel va uy jihozlari', [
    ['Divanlar', 5200000, 'Uch o‘rinli kulrang divan|Burchakli yumshoq divan|Yig‘ma ikki o‘rinli divan|Modulli mehmonxona divani|Velur qoplamali divan'],
    ['Karavotlar', 3600000, 'Ikki kishilik yog‘och karavot|Yumshoq boshli karavot|Saqlash qutili karavot|Bir kishilik metall karavot|Bolalar uchun karavot'],
    ['Shkaflar', 4200000, 'Ikki eshikli kiyim shkafi|Uch eshikli kiyim shkafi|Surilma eshikli shkaf|Ko‘zguli kiyim shkafi|Burchakli kiyim shkafi'],
    ['Stollar', 1700000, 'Yozuv stoli 120 sm|Ovqatlanish stoli 4 kishilik|Kompyuter stoli tortmali|Jurnal stoli yog‘och|Buklama mehmon stoli'],
    ['Stullar', 600000, 'Yumshoq oshxona stuli|Yog‘och ovqatlanish stuli|Metall karkasli stul|Buklama ixcham stul|Baland bar stuli'],
    ['Ofis kreslolari', 1500000, 'Ergonomik ofis kreslosi|To‘r suyanchiqli kreslo|Bosh tayanchli kreslo|Bel tayanchli kreslo|Aylanma ish kreslosi'],
    ['Tokchalar', 750000, 'Besh qavatli kitob tokchasi|Devorga ilinadigan tokcha|Burchakli yog‘och tokcha|Metall saqlash tokchasi|Ochiq xonaki tokcha'],
    ['Komodlar', 1700000, 'To‘rt tortmali komod|Ko‘zguli yotoqxona komodi|Olti tortmali komod|Bolalar xonasi komodi|Kichik yo‘lak komodi'],
    ['Tumba va javonlar', 950000, 'Karavot yonidagi tumba|Televizor uchun javon|Poyabzal uchun tumba|Yo‘lak uchun tor javon|Oshxona uchun yopiq javon'],
    ['Matraslar', 2300000, 'Ortopedik matras 160x200|Prujinali matras 180x200|Bolalar matrasi 80x160|Qattiq matras 90x200|Ikki tomonlama matras 140x200'],
  ]],
  ['Oshxona anjomlari', [
    ['Blenderlar', 650000, 'Bosch qo‘l blenderi|Philips statsionar blender|Braun MultiQuick blender|Artel maydalagich blender|Moulinex mini blender'],
    ['Mikserlar', 500000, 'Bosch qo‘l mikseri|Philips qo‘l mikseri|Kenwood planetar mikser|Artel oshxona mikseri|Moulinex stend mikseri'],
    ['Choynaklar', 350000, 'Artel elektr choynak 1.7 l|Philips elektr choynak 1.7 l|Tefal elektr choynak 1.5 l|Xiaomi elektr choynak 1.5 l|Bosch elektr choynak 1.7 l'],
    ['Qahva mashinalari', 1900000, 'DeLonghi espresso mashinasi|Philips avtomatik qahva mashinasi|Nespresso kapsulali mashina|Moulinex tomchilatib qaynatgich|Beko turk qahvasi mashinasi'],
    ['Tovalar', 300000, 'Granit qoplamali tova 24 sm|Cho‘yan tova 26 sm|Yopishmaydigan tova 28 sm|Blini tova 22 sm|Gril tova 26 sm'],
    ['Qozonlar', 450000, 'Cho‘yan qozon 8 l|Alyuminiy qozon 10 l|Zanglamas po‘lat qozon 6 l|Bug‘da pishirish qozoni 5 l|Bosimli qozon 7 l'],
    ['Idishlar to‘plami', 650000, 'Olti kishilik chinni to‘plam|Shisha piyolalar to‘plami|Zanglamas po‘lat qoshiq to‘plami|Keramik likopchalar to‘plami|Choy servisi 12 buyum'],
    ['Go‘sht maydalagichlar', 1200000, 'Bosch elektr go‘sht maydalagich|Artel elektr go‘sht maydalagich|Moulinex go‘sht maydalagich|Kenwood go‘sht maydalagich|Philips go‘sht maydalagich'],
    ['Multivarkalar', 1100000, 'Redmond 5 l multivarka|Polaris 5 l multivarka|Philips 4 l multivarka|Tefal 5 l multivarka|Midea 5 l multivarka'],
    ['Suv filtrlari', 850000, 'Aquaphor uch bosqichli filtr|Barrier oshxona filtri|Brita filtrli ko‘za|Geyser teskari osmos filtri|Atoll ichimlik suvi filtri'],
  ]],
  ['Sport va hordiq', [
    ['Yugurish yo‘laklari', 6500000, 'Uy uchun yig‘ma yugurish yo‘lagi|Elektr yugurish yo‘lagi 12 km/soat|Amortizatorli yugurish yo‘lagi|Keng tasmali yugurish yo‘lagi|Ixcham yurish yo‘lagi'],
    ['Velosipedlar', 2300000, 'Tog‘ velosipedi 26 dyuym|Shahar velosipedi 28 dyuym|Buklama velosiped 20 dyuym|Ayollar velosipedi 26 dyuym|O‘smirlar velosipedi 24 dyuym'],
    ['Trenajyorlar', 3100000, 'Magnit velotrenajyor|Elliptik trenajyor|Eshkak eshish trenajyori|Ko‘p funksiyali kuch trenajyori|Uy uchun stepper'],
    ['Gantellar', 420000, 'Gantel juftligi 5 kg|Gantel juftligi 10 kg|Vazni sozlanadigan gantel|Vinil gantel juftligi 2 kg|Olti burchakli gantel 15 kg'],
    ['Fitnes gilamchalari', 180000, 'Yoga gilamchasi 6 mm|Fitnes gilamchasi 10 mm|Buklama gimnastika gilamchasi|Sirpanmaydigan pilates gilamchasi|Sayohat yoga gilamchasi'],
    ['Futbol to‘plari', 230000, 'Mashg‘ulot futbol to‘pi 5 o‘lcham|Mini futbol to‘pi 4 o‘lcham|Sun’iy maydon futbol to‘pi|Bolalar futbol to‘pi 3 o‘lcham|Professional futbol to‘pi 5 o‘lcham'],
    ['Badminton', 350000, 'Ikki raketkali badminton to‘plami|Bolalar badminton to‘plami|Mashg‘ulot badminton raketkasi|Badminton volanlari 12 dona|Portativ badminton setkasi'],
    ['Chodirlar', 1500000, 'Ikki kishilik sayohat chodiri|Uch kishilik suv o‘tkazmas chodir|To‘rt kishilik oilaviy chodir|Avtomatik ochiladigan chodir|Yengil tog‘ chodiri'],
    ['Ryukzaklar', 550000, 'Trekking ryukzagi 40 l|Sayohat ryukzagi 60 l|Shahar ryukzagi 25 l|Velosiped ryukzagi 15 l|Yomg‘irga chidamli ryukzak 30 l'],
    ['Rolik va skeytlar', 950000, 'Bolalar rolikli konkisi|Kattalar rolikli konkisi|Klassik yog‘och skeytbord|Shahar uchun longbord|Himoya bilan rolik to‘plami'],
  ]],
  ['Bolalar mahsulotlari', [
    ['Bolalar aravachalari', 2300000, 'Buklama sayr aravachasi|Yangi tug‘ilgan chaqaloq aravachasi|Egizaklar aravachasi|Uch g‘ildirakli sayr aravachasi|Yengil safar aravachasi'],
    ['Avtokreslolar', 1900000, 'Chaqaloq avtokreslosi 0+|Aylanuvchi avtokreslo 0-18 kg|ISOFIX avtokreslo 9-36 kg|Bolalar buster kreslosi|Besh nuqtali kamarli avtokreslo'],
    ['Konstruktorlar', 450000, 'Shahar uylar konstruktori|Kosmik kema konstruktori|Poyezd konstruktori|Robot konstruktori|Hayvonot bog‘i konstruktori'],
    ['Qo‘g‘irchoqlar', 280000, 'Kiyimlari bilan qo‘g‘irchoq|Gapiradigan qo‘g‘irchoq|Yumshoq matoli qo‘g‘irchoq|Qo‘g‘irchoq va aravacha to‘plami|Qo‘g‘irchoq uyi to‘plami'],
    ['O‘yinchoq mashinalar', 320000, 'Masofadan boshqariladigan mashina|Yuk mashinasi o‘yinchog‘i|Metall avtomobillar to‘plami|Qurilish texnikasi o‘yinchog‘i|Poyga trassasi to‘plami'],
    ['Rivojlantiruvchi o‘yinlar', 260000, 'Ranglarni o‘rgatuvchi o‘yin|Alifbo magnitlari to‘plami|Shakllar saralash o‘yini|Bolalar uchun mozaika|Mantiqiy kartochkalar to‘plami'],
    ['Bolalar velosipedlari', 1200000, 'Uch g‘ildirakli bolalar velosipedi|Balans velosipedi|Yordamchi g‘ildirakli velosiped 12|Bolalar velosipedi 16 dyuym|Bolalar velosipedi 20 dyuym'],
    ['O‘quv qurollari', 240000, 'Rangli qalamlar to‘plami|Akvarel bo‘yoqlar to‘plami|Maktab ruchkalari to‘plami|Rasm albomi va flomasterlar|O‘quvchi penal to‘plami'],
    ['Bolalar stollari', 750000, 'Balandligi sozlanadigan bolalar stoli|Rasm chizish uchun bolalar stoli|Bolalar stol va stul to‘plami|Buklama o‘yin stoli|Maktabgacha yosh uchun o‘quv stoli'],
    ['Beshik va krovatlar', 1750000, 'Yog‘och chaqaloq beshigi|Tebranadigan bolalar beshigi|Yon panjarali bolalar krovati|Saqlash qutili bolalar krovati|Ko‘chma sayohat krovati'],
  ]],
  ['Go‘zallik va salomatlik', [
    ['Fenlar', 550000, 'Philips soch feni 2100 W|Braun soch feni 2000 W|Remington ionli fen|Dyson Supersonic fen|Artel soch feni 1800 W'],
    ['Soch tekislagichlar', 650000, 'Philips keramik tekislagich|Remington soch tekislagich|BaByliss bug‘li tekislagich|Braun Satin Hair tekislagich|Rowenta keratinli tekislagich'],
    ['Elektr ustara', 750000, 'Philips uch boshli ustara|Braun Series 3 ustara|Panasonic nam qirish ustarasi|Xiaomi elektr ustara|Remington folgali ustara'],
    ['Elektr tish cho‘tkalari', 550000, 'Oral-B Vitality tish cho‘tkasi|Philips Sonicare tish cho‘tkasi|Xiaomi T500 tish cho‘tkasi|Colgate Hum tish cho‘tkasi|Oclean Flow tish cho‘tkasi'],
    ['Massaj uskunalari', 1100000, 'Bo‘yin uchun massaj yostig‘i|Oyoq massaj apparati|Perkussion massaj pistoleti|Bel uchun massaj kamari|Qo‘l massaj apparati'],
    ['Tonometrlar', 650000, 'Omron avtomatik tonometr|Beurer qo‘l tonometri|Microlife yelka tonometri|AND raqamli tonometr|B.Well avtomatik tonometr'],
    ['Tarozi va o‘lchagichlar', 320000, 'Xiaomi aqlli tana tarozisi|Beurer raqamli tarozi|Bosch oshxona tarozisi|Elektron bo‘y o‘lchagich|Bolalar uchun elektron tarozi'],
    ['Manikyur to‘plamlari', 400000, 'Elektr manikyur apparati|Tirnoq parvarishi 12 buyum|UV tirnoq lampasi|Pedikyur frezasi to‘plami|Professional manikyur asboblari'],
    ['Epilatorlar', 900000, 'Braun Silk-épil 5|Philips Satinelle epilator|Panasonic nam epilator|Rowenta Skin Respect epilator|Beurer IPL epilator'],
    ['Yuz parvarishi qurilmalari', 800000, 'Yuz tozalash cho‘tkasi|Ultratovushli yuz tozalagich|Yuz uchun bug‘ apparati|LED yuz niqobi|Yuz massaj roligi'],
  ]],
];

function validateCatalog() {
  if (catalog.length !== 7 || catalog.some(([, sections]) => sections.length !== 10 ||
      sections.some(([, price, names]) => !Number.isSafeInteger(price) || price <= 0 || names.split('|').length !== 5))) {
    throw new Error('Seed katalogi 7 guruh, har birida 10 bo‘lim va har bo‘limda 5 mahsulotdan iborat bo‘lishi kerak.');
  }
}

async function seedCatalog(db) {
  validateCatalog();
  const users = db.collection('users');
  const categories = db.collection('product_categories');
  const products = db.collection('products');
  const creator = await users.findOne({ login: 'test12', role: 'product_creator' });
  if (!creator) throw new Error('test12 loginli product_creator topilmadi. Avval shu foydalanuvchini yarating.');

  const counts = { groups: 0, sections: 0, products: 0 };
  async function category(name, parentId) {
    const nameKey = name.toLocaleLowerCase('uz');
    const filter = { parentId, nameKey };
    const existing = await categories.findOne(filter);
    if (existing) {
      if (!existing.createdBy?.equals(creator._id)) {
        throw new Error(`Kategoriya boshqa foydalanuvchiga tegishli: ${name}`);
      }
      return existing._id;
    }
    const result = await categories.insertOne({
      name, nameKey, parentId, createdBy: creator._id, createdAt: new Date(),
    });
    return result.insertedId;
  }

  for (const [groupName, sections] of catalog) {
    const groupId = await category(groupName, null);
    counts.groups++;
    for (const [sectionName, basePrice, names] of sections) {
      const sectionId = await category(sectionName, groupId);
      counts.sections++;
      for (const [index, name] of names.split('|').entries()) {
        const originalPrice = Math.round(basePrice * (1 + index * 0.12) / 1000) * 1000;
        await products.updateOne(
          { categoryId: sectionId, name, createdBy: creator._id },
          { $setOnInsert: {
            categoryId: sectionId, name, title: name, originalPrice,
            minSellingPrice: Math.round(originalPrice * 0.9 / 1000) * 1000,
            images: [], createdBy: creator._id, createdAt: new Date(),
          } },
          { upsert: true },
        );
        counts.products++;
      }
    }
  }
  await prepareProductIds(products, db.collection('counters'));
  return counts;
}

async function main() {
  require('dotenv').config();
  const mongoUri = process.env.MONGODB_URI?.trim();
  if (!mongoUri || !/^mongodb(\+srv)?:\/\//.test(mongoUri)) throw new Error('MONGODB_URI ni .env faylida sozlang.');
  const client = new MongoClient(mongoUri);
  try {
    await client.connect();
    const counts = await seedCatalog(client.db());
    console.log(`Katalog tayyor: ${counts.groups} guruh, ${counts.sections} bo‘lim, ${counts.products} mahsulot.`);
  } finally {
    await client.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Katalog seedi bajarilmadi:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { catalog, seedCatalog };
