// Wszystko, co zależy od wyglądu strony Allegro, jest w tym jednym pliku.
// Gdy Allegro coś zmieni, zwykle wystarczy poprawić tylko te wartości.
// Klasy CSS Allegro są generowane losowo (np. "mx7m_1"), dlatego ich nie używamy –
// opieramy się na tagach, aria-label i tekstach widocznych dla użytkownika.
globalThis.CW_SELECTORS = {
  // Pojedyncza oferta na liście wyników
  offer: "article",

  // Oferta leży w: <ul> > <li> > <article>
  offerItem: "li",
  offerList: "ul",

  // Minimalna liczba ofert w <ul>, żeby uznać go za listę wyników
  minOffersInList: 5,

  // Etykieta oferty (aria-label znacznika "Promowane" / "Sponsorowane")
  sponsoredLabel: /^\s*Sponsorowane\b/i,
  promotedLabel: /^\s*Promowane\b/i,

  // Zapasowe wykrywanie: link reklamowy przechodzący przez licznik kliknięć
  sponsoredLinkPart: "/events/clicks",

  // Nagłówki sekcji reklamowych do ukrycia
  promotedHeadings: ["Produkty promowane", "Oferty promowane", "Oferty sponsorowane"],

  // Aktualna cena w aria-label, np. "49,76 zł aktualna cena"
  priceLabel: /([\d\s]+,\d{2})\s*zł\s*aktualna cena/i,

  // Cena z dostawą w tekście karty, np. "14,98 zł z dostawą"
  totalPriceText: /([\d\s ]+,\d{2})\s*zł\s*z dostawą/i,

  // Termin dostawy w aria-label, np. "dostawa pojutrze", "dostawa czw. 26 lis.", "dostawa za 15 dni"
  deliveryLabel: /^\s*dostawa\b/i,

  // Ocena produktu w aria-label, np. "4,74 na 5, 212 ocen produktu"
  ratingLabel: /(\d+(?:,\d+)?)\s*na\s*5,\s*([\d\s\u00a0]+)\s*ocen/i,

  // Bloki reklamowe poza listą wyników: banery sponsorowane z ofertami (u góry i na dole),
  // kolumna "Sponsorowane" po lewej, reklamy wideo. UWAGA: te same selektory są w content.css.
  displayAds: '[data-box-name^="allegro.ads"], [data-box-name^="ads."], [data-box-name^="leftpanel_offers_ads"]',

  // Sekcje-śmieci do ukrycia (rekomendacje, artykuły poradnikowe)
  clutterBoxes: '[data-box-name="rekomendacje"], [data-box-name="articles"]',
  clutterHeadings: ["rekomendacje dla ciebie", "nie możesz się zdecydować", "inni kupili również", "może cię zainteresować"],

  // Cena za jednostkę, którą Allegro czasem pokazuje samo, np. "13,80 zł/100 g"
  nativeUnitPrice: /zł\s*\/\s*(\d+\s*)?(kg|g|ml|l|szt)/i,

  // Tytuł oferty
  title: "h2, h3",

  // Identyfikator oferty w linku (do usuwania duplikatów)
  offerIdFromHref: /offerId=(\d+)|-(\d{8,})(?:[?#]|$)/,

  // Strona uznawana za "zwykłą", gdy ma co najmniej tyle ofert bez etykiety reklamy
  plainPageThreshold: 10,

  // Limity zapytań przy szukaniu początku zwykłych ofert (ochrona przed blokadą)
  maxProbeRequests: 10,
  requestDelayMs: 800,

  // Gdy zwykłe oferty są rozrzucone po kilka na stronę: ile stron najwyżej przejrzeć
  maxCollectPages: 6,

  // Parametr numeru strony w adresie listingu
  pageParam: "p",

  // Ścieżki, na których dodatek działa
  listingPaths: [/^\/listing/, /^\/kategoria\//, /^\/uzytkownik\/[^/]+\/?$/, /^\/sklep\//]
};
