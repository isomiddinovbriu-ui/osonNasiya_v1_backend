const PAYMENT_APP_CATEGORIES = [
  {
    category: 'Mustaqil to‘lov tashkilotlari (Fintex ilovalar)',
    apps: [
      ['click', 'Click SuperApp'], ['payme', 'Payme'], ['paynet', 'Paynet'],
      ['alif_mobi', 'Alif Mobi'], ['oson', 'OSON'], ['payway', 'PayWay'],
      ['octo_mobile', 'Octo Mobile'], ['azo_pay', 'Azo Pay'], ['upay', 'Upay'],
      ['wooppay', 'Wooppay'], ['pulpul', 'PULPUL'], ['myuzcard', 'MyUzcard'],
      ['korona_money_transfer', 'Korona Money Transfer'],
    ],
  },
  {
    category: 'Raqamli banklar va Ekotizimlar',
    apps: [
      ['uzum_bank', 'Uzum Bank'], ['tbc_bank_uzbekistan', 'TBC Bank Uzbekistan'],
      ['anorbank', 'Anorbank'], ['avo', 'AVO'], ['uzum_nasiya', 'Uzum Nasiya'],
    ],
  },
  {
    category: 'Tijorat banklarining mobil ilovalari',
    apps: [
      ['xazna', 'Xazna (Xalq banki)'], ['milliy', 'Milliy (NBU)'],
      ['zoomrad', 'Zoomrad (Aloqabank)'], ['ipak_yuli_mobile', 'Ipak Yuli Mobile'],
      ['monix', 'MONIX'], ['tez', 'Tez (Hamkorbank)'], ['hamkor', 'Hamkor'],
      ['ipoteka_mobile', 'Ipoteka Mobile'], ['agrobank_mobile', 'Agrobank Mobile'],
      ['sqb_mobile', 'SQB MOBILE'], ['kapitalbank', 'Kapitalbank'],
      ['asakabank', 'Asakabank'], ['davr_mobile_2_0', 'Davr Mobile 2.0'],
      ['infinbank', 'InfinBank'], ['mavrid', 'MAVRID'],
      ['orient_mobile', 'Orient Mobile'], ['tenge_lite', 'Tenge Lite'],
      ['ziraat_mobile_uzbekistan', 'Ziraat Mobile Uzbekistan'], ['mkbank', 'MKBank'],
      ['trast24', 'Trast24'], ['poytaxt_mobile', 'Poytaxt Mobile'], ['madadad', 'Madadad'],
    ],
  },
  {
    category: 'Aloqa operatorlarining to‘lov tizimlari',
    apps: [
      ['beepul', 'Beepul (Beeline)'], ['mymobiuz', 'MyMobiuz'],
      ['u_tolov', 'U-to‘lov (Ucell)'],
    ],
  },
  {
    category: 'Davlat va maxsus to‘lov dasturlari',
    apps: [
      ['soliq_soliqfree', 'Soliq / SoliqFree'], ['baraka', 'Baraka'],
      ['moliyachi', 'Moliyachi'], ['domo', 'DOMO'], ['mygov', 'MyGov'],
    ],
  },
];

const PAYMENT_APP_DOCUMENTS = PAYMENT_APP_CATEGORIES.flatMap(({ category, apps }, categoryOrder) =>
  apps.map(([code, name], itemOrder) => ({ code, name, category, categoryOrder, itemOrder })));

module.exports = { PAYMENT_APP_CATEGORIES, PAYMENT_APP_DOCUMENTS };
