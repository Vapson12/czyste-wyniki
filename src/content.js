(() => {
  "use strict";

  const S = globalThis.CW_SELECTORS;
  const api = globalThis.browser ?? globalThis.chrome;

  const DEFAULTS = {
    enabled: true,
    hidePromoted: true,
    hideSponsored: true,
    mode: "hide",          // "hide" – ukryj, "dim" – przyciemnij, "fair" – zostaw, ale sortuj uczciwie po cenie
    fillPages: true,       // dociągaj zwykłe oferty z kolejnych stron
    maxExtraPages: 2,      // ile stron maksymalnie dociągnąć naraz
    minPlainOffers: 30,    // dociągaj, dopóki widać mniej zwykłych ofert
    blockedPhrases: "",    // frazy w tytule do ukrycia, oddzielone przecinkami lub enterami
    sortByTotal: false,    // (stare ustawienie z wersji 0.2 – zastąpione przez sortBy)
    sortBy: "price",       // "price" – cena, "total" – cena z dostawą, "unit" – cena za kg/l/szt.
    showUnitPrice: true,   // dopisuj na kartach cenę za kg / l / szt.
    minRating: 0,          // ukryj oferty z oceną produktu poniżej (0 = bez limitu)
    minReviews: 0,         // ukryj oferty z mniejszą liczbą ocen (0 = bez limitu)
    hideClutter: true,     // ukryj rekomendacje i artykuły poradnikowe
    showBadge: true,       // licznik ukrytych ofert na ikonie dodatku
    showSavings: true,     // pokazuj porównanie najtańszej zwykłej i promowanej oferty
    maxDeliveryDays: 0     // ukryj oferty z dłuższą dostawą (0 = bez limitu)
  };

  let settings = { ...DEFAULTS };
  let phrases = [];
  let paused = false;          // chwilowe "pokaż wszystko" z paska na stronie
  const counted = new WeakSet();
  let state = newPageState();

  // Firefox: content.fetch wysyła zapytanie jak sama strona (z ciasteczkami Allegro)
  const pageFetch =
    typeof content !== "undefined" && content && typeof content.fetch === "function"
      ? content.fetch.bind(content)
      : fetch.bind(globalThis);

  function newPageState() {
    return {
      key: pageKey(location.href),
      loadedPages: new Set(),
      loading: false,
      seenIds: new Set(),
      fairCloned: new Set(),
      stopFill: false,
      nextPage: null,    // następna strona do dociągnięcia
      skippedTo: null,   // strona, od której zaczynają się zwykłe oferty
      progress: null,
      seq: 0,            // kolejność dodawania do naszej listy
      collect: false,    // tryb zbierania: zwykłe oferty rozrzucone między reklamami na wielu stronach
      collectSep: false,
      emptyFallback: false // nic nie znaleziono – pokaż reklamy przyciemnione zamiast pustej strony
    };
  }

  // Ten sam listing bez numeru strony – zmiana filtrów/sortowania = nowy klucz
  function pageKey(href) {
    const u = new URL(href);
    u.searchParams.delete(S.pageParam);
    u.hash = "";
    return u.toString();
  }

  function currentPage() {
    const p = parseInt(new URL(location.href).searchParams.get(S.pageParam) || "1", 10);
    return Number.isFinite(p) && p > 0 ? p : 1;
  }

  function isListingPage() {
    return S.listingPaths.some((re) => re.test(location.pathname));
  }

  const isAd = (kind) => kind === "promoted" || kind === "sponsored";
  // Gdy zwykłych ofert nie ma wcale, zamiast pustej strony pokazujemy reklamy przyciemnione
  const hideMode = () => (state.emptyFallback ? "dim" : settings.mode);
  const isPriceSort = () => /^p/.test(new URL(location.href).searchParams.get("order") || "");
  const pageLimit = () => (state.collect ? S.maxCollectPages : settings.maxExtraPages);
  const fairMode = () => settings.mode === "fair";

  // ---------- odczyt danych z karty oferty ----------

  function classify(article) {
    for (const el of article.querySelectorAll("[aria-label]")) {
      const label = el.getAttribute("aria-label") || "";
      if (S.sponsoredLabel.test(label)) return "sponsored";
      if (S.promotedLabel.test(label)) return "promoted";
    }
    // zapasowo: krótki element z samym tekstem etykiety
    for (const el of article.querySelectorAll("span, div, p")) {
      if (el.childElementCount > 0) continue;
      const t = el.textContent.trim();
      if (t === "Sponsorowane") return "sponsored";
      if (t === "Promowane") return "promoted";
    }
    const link = article.querySelector("a[href]");
    if (link && link.getAttribute("href").includes(S.sponsoredLinkPart)) return "sponsored";
    return "plain";
  }

  function offerId(article) {
    for (const a of article.querySelectorAll("a[href]")) {
      const m = a.getAttribute("href").match(S.offerIdFromHref);
      if (m) return m[1] || m[2];
    }
    return null;
  }

  const toNumber = (s) => parseFloat(s.replace(/[\s ]/g, "").replace(",", "."));

  const MONTHS = { sty: 0, lut: 1, mar: 2, kwi: 3, maj: 4, cze: 5, lip: 6, sie: 7, wrz: 8, "paź": 9, paz: 9, lis: 10, gru: 11 };

  function deliveryDays(text) {
    const t = text.toLowerCase();
    if (/dzi(ś|s|siaj)/.test(t)) return 0;
    if (/pojutrze/.test(t)) return 2;
    if (/jutro/.test(t)) return 1;
    let m = t.match(/za\s+(\d+)\s+dni/);
    if (m) return parseInt(m[1], 10);
    m = t.match(/(\d{1,2})\s+(sty|lut|mar|kwi|maj|cze|lip|sie|wrz|paź|paz|lis|gru)/);
    if (m) {
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      let date = new Date(now.getFullYear(), MONTHS[m[2]], parseInt(m[1], 10));
      if (date < today) date = new Date(now.getFullYear() + 1, MONTHS[m[2]], parseInt(m[1], 10));
      return Math.round((date - today) / 86400000);
    }
    return null;
  }

  // Dane karty zapisujemy w atrybutach li, żeby nie liczyć ich ciągle od nowa
  function readInfo(li) {
    const art = li.querySelector(S.offer);
    const id = offerId(art) || "?";
    if (li.dataset.cwInfo === id) {
      return {
        price: parseFloat(li.dataset.cwPrice),
        total: parseFloat(li.dataset.cwTotal),
        days: li.dataset.cwDays === "" ? null : parseInt(li.dataset.cwDays, 10),
        title: li.dataset.cwTitle || "",
        rating: li.dataset.cwRating === "" ? null : parseFloat(li.dataset.cwRating),
        reviews: parseInt(li.dataset.cwReviews || "0", 10),
        qty: li.dataset.cwQty === "" ? null : parseFloat(li.dataset.cwQty),
        unit: li.dataset.cwUnitName || null
      };
    }
    let price = NaN;
    let days = null;
    let rating = null;
    let reviews = 0;
    for (const el of art.querySelectorAll("[aria-label]")) {
      const label = el.getAttribute("aria-label") || "";
      const pm = label.match(S.priceLabel);
      if (pm && Number.isNaN(price)) price = toNumber(pm[1]);
      if (S.deliveryLabel.test(label) && days == null) days = deliveryDays(label);
      const rm = label.match(S.ratingLabel);
      if (rm && rating == null) {
        rating = toNumber(rm[1]);
        reviews = parseInt(rm[2].replace(/[\s\u00a0]/g, ""), 10) || 0;
      }
    }
    const tm = (art.textContent || "").match(S.totalPriceText);
    const total = tm ? toNumber(tm[1]) : price;
    const title = (art.querySelector(S.title)?.textContent || "").trim();
    li.dataset.cwInfo = id;
    li.dataset.cwPrice = String(price);
    li.dataset.cwTotal = String(total);
    li.dataset.cwDays = days == null ? "" : String(days);
    li.dataset.cwTitle = title;
    const q = parseQuantity(title);
    li.dataset.cwRating = rating == null ? "" : String(rating);
    li.dataset.cwReviews = String(reviews);
    li.dataset.cwQty = q ? String(q.qty) : "";
    li.dataset.cwUnitName = q ? q.unit : "";
    return { price, total, days, title, rating, reviews, qty: q ? q.qty : null, unit: q ? q.unit : null };
  }

  const normalize = (s) =>
    s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ł/g, "l");

  // Polskie słowa się odmieniają ("gumki" / "gumek", "kabel" / "kabla"), więc dla pojedynczych
  // słów porównujemy rdzeń (bez dwóch ostatnich liter) z początkiem słów w tytule.
  // Fraza w cudzysłowie albo kilka słów = dokładne dopasowanie fragmentu tekstu.
  function parsePhrases(text) {
    return (text || "")
      .split(/[,;\n]/)
      .map((raw) => raw.trim())
      .filter((raw) => raw.replace(/"/g, "").length >= 2)
      .map((raw) => {
        const exact = /^".*"$/.test(raw) || /\s/.test(raw.replace(/"/g, "").trim());
        const p = normalize(raw.replace(/"/g, "").trim());
        if (exact) return { exact: true, p };
        const stem = p.length >= 5 ? p.slice(0, p.length - 2) : p;
        return { exact: false, p: stem };
      });
  }

  function matchesPhrase(title) {
    const t = normalize(title);
    const words = t.split(/[^a-z0-9]+/).filter(Boolean);
    return phrases.some((ph) => (ph.exact ? t.includes(ph.p) : words.some((w) => w.startsWith(ph.p))));
  }

  // ---------- cena za jednostkę ----------

  // Wyczytuje z tytułu ilość: "4 x 500 ml" -> 2 l, "500 g" -> 0,5 kg, "10 szt." -> 10 szt.
  const MEASURES = { kg: ["kg", 1], g: ["kg", 0.001], gr: ["kg", 0.001], dag: ["kg", 0.01], l: ["l", 1], ml: ["l", 0.001] };
  function parseQuantity(title) {
    const t = title.toLowerCase().replace(/(\d),(\d)/g, "$1.$2");
    const unitRe = "(kg|dag|gr|g|ml|l|litr(?:y|ów|a)?)";
    const toMeasure = (n, u) => {
      const key = u.startsWith("litr") ? "l" : u;
      const [unit, factor] = MEASURES[key];
      return { qty: n * factor, unit };
    };
    // wielopak: "4 x 500 ml", "6x1,5l"
    let m = t.match(new RegExp("(\\d+)\\s*[x×]\\s*(\\d+(?:\\.\\d+)?)\\s*" + unitRe + "(?![a-ząćęłńóśźż])"));
    if (m) return toMeasure(parseInt(m[1], 10) * parseFloat(m[2]), m[3]);
    // pojedyncza miara: "500 g", "1.5 l"
    m = t.match(new RegExp("(\\d+(?:\\.\\d+)?)\\s*" + unitRe + "(?![a-ząćęłńóśźż0-9])"));
    if (m) {
      const n = parseFloat(m[1]);
      // "5G", "4G" to sieć komórkowa, nie gramy
      if (!((m[2] === "g" || m[2] === "gr") && n < 10 && !m[1].includes("."))) return toMeasure(n, m[2]);
    }
    // sztuki: "10 szt.", "50 sztuk", "12 pcs", "6-pak"
    m = t.match(/(\d+)\s*(?:szt\b|szt\.|sztuk|pcs\b|-?pak\b)/);
    if (m && parseInt(m[1], 10) > 1) return { qty: parseInt(m[1], 10), unit: "szt." };
    return null;
  }

  const unitPrice = (info) =>
    info.qty && Number.isFinite(info.price) ? info.price / info.qty : null;

  function unitLabel(info) {
    const up = unitPrice(info);
    if (up == null) return null;
    return `${up.toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} zł/${info.unit}`;
  }

  // Zwraca powód odfiltrowania albo null
  function filterReason(info) {
    if (settings.minRating > 0 && info.rating != null && info.rating < settings.minRating) {
      return "ocena";
    }
    if (settings.minReviews > 0 && info.reviews < settings.minReviews) {
      return "mało ocen";
    }
    if (phrases.length) {
      if (matchesPhrase(info.title)) return "fraza";
    }
    if (settings.maxDeliveryDays > 0 && info.days != null && info.days > settings.maxDeliveryDays) {
      return "dostawa";
    }
    return null;
  }

  // Sortowanie: stare "sortByTotal" z wersji 0.2 nadal działa
  const sortBy = () => (settings.sortBy && settings.sortBy !== "price" ? settings.sortBy : settings.sortByTotal ? "total" : "price");
  // Klucz do porównania cen (oszczędności). Dla "unit" porównujemy zwykłą cenę.
  const sortKey = (info) => (sortBy() === "total" ? info.total : info.price);

  // ---------- szukanie list ofert ----------

  function findListings(root) {
    const lists = new Set();
    for (const art of root.querySelectorAll(S.offer)) {
      const li = art.parentElement;
      if (!li || li.tagName.toLowerCase() !== S.offerItem) continue;
      const ul = li.parentElement;
      if (!ul || ul.tagName.toLowerCase() !== S.offerList) continue;
      lists.add(ul);
    }
    return [...lists].filter(
      (ul) => ul.querySelectorAll(`:scope > ${S.offerItem} > ${S.offer}`).length >= S.minOffersInList
    );
  }

  function offersIn(ul) {
    return [...ul.querySelectorAll(`:scope > ${S.offerItem} > ${S.offer}`)];
  }

  // ---------- ukrywanie ----------

  function adHidden(kind) {
    if (!settings.enabled || paused || !isAd(kind)) return false;
    return kind === "promoted" ? settings.hidePromoted : settings.hideSponsored;
  }

  // Ustawia widoczność elementu przez atrybuty data- (React Allegro nadpisuje className)
  function setHide(li, how, badge) {
    if (how) li.dataset.cwHide = how;
    else delete li.dataset.cwHide;
    if (badge) li.dataset.cwBadge = badge;
    else delete li.dataset.cwBadge;
  }

  const badgeFor = (kind) => (kind === "sponsored" ? "Sponsorowane" : "Promowane");

  function hideHeadings(ul) {
    for (const li of ul.querySelectorAll(`:scope > ${S.offerItem}`)) {
      if (li.querySelector(S.offer)) continue;
      const h = li.querySelector("h2, h3");
      if (!h) continue;
      if (S.promotedHeadings.includes(h.textContent.trim())) {
        const hide = settings.enabled && !paused && (settings.hidePromoted || fairMode());
        setHide(li, hide ? "hide" : null);
      }
    }
  }

  // ---------- pasek informacyjny nad listą ----------

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  function ensureBar(anchor) {
    let bar = document.getElementById("cw-bar");
    if (!bar) {
      bar = el("div");
      bar.id = "cw-bar";
      const toggle = el("button", "cw-toggle");
      toggle.type = "button";
      toggle.addEventListener("click", () => {
        paused = !paused;
        run();
      });
      const next = el("a", "cw-next");
      next.hidden = true;
      const actions = el("span", "cw-actions");
      actions.append(toggle, next);
      const savings = el("div", "cw-savings");
      savings.hidden = true;
      const logo = el("span", "cw-logo");
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 32 32");
      svg.setAttribute("aria-hidden", "true");
      const shapes = [
        ["rect", { width: 32, height: 32, rx: 8, fill: "#13795b" }],
        ["path", { d: "M9 11h14M9 16h9M9 21h14", stroke: "#fff", "stroke-width": 2.4, "stroke-linecap": "round" }],
        ["path", { d: "M20 16l1.6 1.6L25 14.2", stroke: "#ffd84d", "stroke-width": 2.2, fill: "none", "stroke-linecap": "round", "stroke-linejoin": "round" }]
      ];
      for (const [tag, attrs] of shapes) {
        const n = document.createElementNS("http://www.w3.org/2000/svg", tag);
        for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
        svg.append(n);
      }
      logo.append(svg, el("span", null, "Czyste Wyniki"));
      bar.append(logo, el("span", "cw-text"), actions, savings);
    }
    if (bar.nextElementSibling !== anchor) anchor.before(bar);
    return bar;
  }

  const zl = (n) => n.toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " zł";

  // parts: tablica fragmentów; fragment to tekst albo { b: tekst } (pogrubienie)
  function renderParts(target, parts) {
    const nodes = [];
    // każdy fragment to osobny element; odstępy robi CSS (bez kropek między nimi)
    for (const part of parts) {
      const span = el("span", "cw-part");
      for (const piece of part) {
        if (typeof piece === "string") span.append(document.createTextNode(piece));
        else span.append(el("b", null, String(piece.b)));
      }
      nodes.push(span);
    }
    target.replaceChildren(...nodes);
  }

  function updateBar(anchor, stats) {
    const bar = ensureBar(anchor);
    const parts = [];
    if (paused) {
      parts.push(["pokazuję wszystkie oferty tak, jak ułożyło je Allegro"]);
    } else {
      if (fairMode()) {
        parts.push([{ b: stats.promoted + stats.sponsored }, " reklam ułożonych uczciwie po cenie razem ze zwykłymi ofertami"]);
      } else {
        parts.push(["ukryto ", { b: stats.promoted }, " promowanych i ", { b: stats.sponsored }, " sponsorowanych"]);
        if (stats.adBlocks && settings.hideSponsored) parts.push([{ b: stats.adBlocks }, " bloków reklamowych (banery, lewa kolumna)"]);
      }
      if (stats.filtered) parts.push(["odfiltrowano ", { b: stats.filtered }, " (frazy, dostawa, oceny)"]);
      if (state.emptyFallback) {
        parts.push([{ b: "na tej stronie są same reklamy" }, " i nie znalazłem zwykłych ofert – pokazuję reklamy przyciemnione. Spróbuj zawęzić kategorię albo posortować od najtańszych"]);
      } else if (state.collect && state.loadedPages.size) {
        const pages = [...state.loadedPages].sort((a, b) => a - b);
        parts.push(["Allegro miesza tu zwykłe oferty z reklamami – zebrałem je ze str. ", { b: pages.length > 1 ? `${pages[0]}–${pages[pages.length - 1]}` : String(pages[0]) }]);
      } else if (state.skippedTo) {
        parts.push(["zwykłe oferty zaczynają się dopiero na ", { b: `str. ${state.skippedTo}` }, " – pokazuję je tutaj"]);
      } else if (state.loadedPages.size) {
        const pages = [...state.loadedPages].sort((a, b) => a - b).join(", ");
        parts.push([`dociągnięto zwykłe oferty ze str. ${pages}`]);
      }
      if (sortBy() === "total") parts.push(["sortuję po cenie ", { b: "z dostawą" }]);
      if (sortBy() === "unit") parts.push(["sortuję po cenie ", { b: "za jednostkę" }]);
      if (state.progress) parts.push([state.progress]);
    }
    renderParts(bar.querySelector(".cw-text"), parts);
    bar.querySelector(".cw-toggle").textContent = paused ? "Włącz porządki" : "Pokaż wszystko";

    // Porównanie: najtańsza zwykła oferta kontra najtańsza reklama
    const savings = bar.querySelector(".cw-savings");
    const { cheapestPlain, cheapestAd } = stats;
    // Pokazujemy tylko prawdziwą oszczędność (przy sortowaniu "trafność" porównanie nie ma sensu)
    if (!paused && settings.showSavings && cheapestPlain != null && cheapestAd != null &&
        cheapestAd - cheapestPlain >= 0.01) {
      const label = sortBy() === "total" ? " (z dostawą)" : "";
      const pct = Math.round(((cheapestAd - cheapestPlain) / cheapestAd) * 100);
      renderParts(savings, [
        ["Oszczędzasz ", { b: `${zl(cheapestAd - cheapestPlain)}` }, ` (${pct}%)`],
        [`najtańsza zwykła oferta ${zl(cheapestPlain)} zamiast ${zl(cheapestAd)} w reklamach${label}`]
      ]);
      savings.hidden = false;
    } else {
      savings.hidden = true;
    }

    // Link "dalej" pomija strony, które już dociągnęliśmy
    const next = bar.querySelector(".cw-next");
    if (!paused && state.loadedPages.size && state.nextPage) {
      const u = new URL(location.href);
      u.searchParams.set(S.pageParam, String(state.nextPage));
      next.href = u.toString();
      next.textContent = `Następna strona (${state.nextPage})`;
      next.hidden = false;
    } else {
      next.hidden = true;
    }
  }

  // ---------- nasza lista (dociągnięte oferty i kopie w trybie uczciwym) ----------

  // Trzymamy ją obok listy Allegro, żeby nie mieszać się w elementy zarządzane przez Reacta.
  function getPool(ul, create) {
    let pool = document.getElementById("cw-extra");
    if (!pool && create) {
      pool = document.createElement("ul");
      pool.id = "cw-extra";
      pool.className = ul.className;
      // Skopiowane karty nie mają skryptów Allegro, więc przyciski
      // ("Dodaj do koszyka", ulubione, porównanie) przenoszą na stronę oferty.
      pool.addEventListener("click", (e) => {
        const btn = e.target.closest("button");
        if (!btn) return;
        const link = btn.closest(S.offer)?.querySelector('a[href*="allegro.pl/"]');
        if (!link) return;
        e.preventDefault();
        e.stopPropagation();
        location.href = link.href;
      });
      ul.before(pool);
    }
    return pool;
  }

  // Nasza lista idzie nad listę Allegro, gdy na stronie nie zostało prawie nic
  // (albo w trybie uczciwym), a pod nią, gdy na stronie są zwykłe oferty.
  function placePool(pool, ul, before) {
    if (before && pool.nextElementSibling !== ul) ul.before(pool);
    if (!before && ul.nextElementSibling !== pool) ul.after(pool);
  }

  function addToPool(ul, li, kind, page) {
    const pool = getPool(ul, true);
    const node = li.ownerDocument === document && li.isConnected ? li.cloneNode(true) : document.importNode(li, true);
    node.dataset.cwKind = kind;
    node.dataset.cwFrom = String(page);
    node.dataset.cwSeq = String(state.seq++);
    // atrybuty z oryginału (cwHide itp.) nie mogą przejść na kopię
    delete node.dataset.cwHide;
    delete node.dataset.cwBadge;
    pool.appendChild(node);
    return node;
  }

  function addSeparator(ul, page) {
    const pool = getPool(ul, true);
    const sep = el("li", "cw-separator", `Zwykłe oferty ze strony ${page}`);
    sep.dataset.cwSeq = String(state.seq++);
    pool.appendChild(sep);
  }

  // Ustawia kolejność w naszej liście: po cenie (tryb uczciwy / z dostawą) albo w kolejności stron
  function orderPool(pool) {
    const mode = sortBy();
    const sorted = fairMode() || mode !== "price";
    const items = [...pool.children];
    // Przy sortowaniu po cenie za jednostkę porównujemy tylko oferty z tą samą jednostką
    // (najczęstszą na liście); pozostałe idą na koniec.
    let dominant = null;
    if (mode === "unit") {
      const counts = {};
      for (const li of items) {
        if (li.classList.contains("cw-separator") || li.dataset.cwHide) continue;
        const u = readInfo(li).unit;
        if (u) counts[u] = (counts[u] || 0) + 1;
      }
      dominant = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || null;
    }
    for (const li of items) {
      if (li.classList.contains("cw-separator")) setHide(li, sorted ? "hide" : null);
    }
    const keyed = items.map((li) => {
      const seq = parseInt(li.dataset.cwSeq || "0", 10);
      if (!sorted || li.classList.contains("cw-separator")) return { li, k: [0, seq] };
      const info = readInfo(li);
      let v;
      if (mode === "unit") v = info.unit === dominant ? unitPrice(info) : null;
      else v = sortKey(info);
      return { li, k: [Number.isFinite(v) ? v : Infinity, seq] };
    });
    keyed.sort((a, b) => a.k[0] - b.k[0] || a.k[1] - b.k[1]);
    const inOrder = keyed.every((x, i) => x.li === items[i]);
    if (!inOrder) pool.append(...keyed.map((x) => x.li));
  }

  // ---------- dociąganie zwykłych ofert z kolejnych stron ----------

  const pageCache = new Map();
  async function fetchPage(page) {
    const key = state.key + "#" + page;
    if (pageCache.has(key)) return pageCache.get(key);
    const u = new URL(location.href);
    u.searchParams.set(S.pageParam, String(page));
    const res = await pageFetch(u.toString(), { credentials: "include" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const doc = new DOMParser().parseFromString(await res.text(), "text/html");
    const lists = findListings(doc);
    const result = { page, offers: 0, plain: [], blocked: false };
    if (!lists.length) {
      // brak listy: koniec wyników albo strona weryfikacji (CAPTCHA)
      result.blocked = !doc.querySelector(S.offer);
    }
    for (const list of lists) {
      for (const art of offersIn(list)) {
        result.offers++;
        if (classify(art) === "plain" && offerId(art)) result.plain.push(art.parentElement);
      }
    }
    pageCache.set(key, result);
    return result;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function setProgress(text) {
    state.progress = text;
    run();
  }

  // Allegro przy sortowaniu po cenie pokazuje najpierw setki ofert promowanych,
  // a zwykłe oferty zaczynają się dopiero na dalekiej stronie. Szukamy tej strony:
  // najpierw skoki coraz dalej (+1, +2, +4, +8…), potem dzielenie przedziału na pół.
  async function findFirstPlainPage(fromPage, keyAtStart) {
    const cacheKey = "cw-first-plain:" + state.key;
    try {
      const cached = parseInt(sessionStorage.getItem(cacheKey) || "", 10);
      if (cached > fromPage) return cached;
    } catch (_) {}

    const isPlainPage = (r) => r.plain.length >= S.plainPageThreshold;
    let lo = fromPage;
    let hi = null;
    let step = 1;
    let requests = 0;

    while (requests < S.maxProbeRequests) {
      const p = fromPage + step;
      setProgress(`szukam zwykłych ofert… (sprawdzam str. ${p})`);
      const r = await fetchPage(p);
      requests++;
      if (state.key !== keyAtStart) return null;
      if (r.blocked) { state.stopFill = true; return null; }
      if (r.offers === 0 || isPlainPage(r)) { hi = p; break; }
      lo = p;
      step *= 2;
      await sleep(S.requestDelayMs);
    }
    if (hi === null) return null;

    while (hi - lo > 1 && requests < S.maxProbeRequests) {
      const mid = Math.floor((lo + hi) / 2);
      setProgress(`szukam zwykłych ofert… (sprawdzam str. ${mid})`);
      await sleep(S.requestDelayMs);
      const r = await fetchPage(mid);
      requests++;
      if (state.key !== keyAtStart) return null;
      if (r.blocked) { state.stopFill = true; return null; }
      if (r.offers > 0 && isPlainPage(r)) hi = mid;
      else lo = mid;
    }
    try { sessionStorage.setItem(cacheKey, String(hi)); } catch (_) {}
    return hi;
  }

  async function fillFromNextPages(ul, visiblePlain) {
    if (!settings.enabled || paused || !settings.fillPages) return;
    if (state.loading || state.stopFill) return;
    if (visiblePlain >= settings.minPlainOffers) return;
    if (state.loadedPages.size >= pageLimit()) return;

    const keyAtStart = state.key;
    state.loading = true;
    run();

    try {
      // Pierwszy raz: ustal, od której strony zaczynają się zwykłe oferty
      if (state.nextPage == null) {
        const first = await fetchPage(currentPage() + 1);
        if (state.key !== keyAtStart) return;
        if (first.blocked || first.offers === 0) { state.stopFill = true; return; }
        if (first.plain.length >= S.plainPageThreshold) {
          state.nextPage = currentPage() + 1;
        } else if (isPriceSort()) {
          // sortowanie po cenie: reklamy idą blokiem na początku – szukamy, gdzie się kończą
          await sleep(S.requestDelayMs);
          const found = await findFirstPlainPage(currentPage() + 1, keyAtStart);
          if (state.key !== keyAtStart) return;
          if (found != null) {
            state.nextPage = found;
            state.skippedTo = found;
          } else {
            state.collect = true;
            state.nextPage = currentPage() + 1;
          }
        } else {
          // inne sortowanie: zwykłe oferty są rozrzucone po kilka na stronę – zbieramy je z kolejnych stron
          state.collect = true;
          state.nextPage = currentPage() + 1;
        }
      }

      const page = state.nextPage;
      setProgress(`wczytuję str. ${page}…`);
      const r = await fetchPage(page);
      if (state.key !== keyAtStart) return;
      if (r.blocked || r.offers === 0) { state.stopFill = true; return; }

      const fresh = r.plain.filter((li) => {
        const id = offerId(li.querySelector(S.offer));
        if (state.seenIds.has(id)) return false;
        state.seenIds.add(id);
        return true;
      });
      state.loadedPages.add(page);
      state.nextPage = page + 1;
      if (!fresh.length) return;

      if (state.collect) {
        if (!state.collectSep) {
          state.collectSep = true;
          const pool = getPool(ul, true);
          const sep = el("li", "cw-separator", "Zwykłe oferty zebrane z kolejnych stron (Allegro miesza je tu z reklamami)");
          sep.dataset.cwSeq = String(state.seq++);
          pool.appendChild(sep);
        }
      } else {
        addSeparator(ul, page);
      }
      for (const li of fresh) addToPool(ul, li, "plain", page);
    } catch (err) {
      console.warn("[Czyste Wyniki] Nie udało się dociągnąć ofert", err);
      state.stopFill = true;
    } finally {
      state.loading = false;
      state.progress = null;
      if (state.key === keyAtStart) setTimeout(run, S.requestDelayMs);
    }
  }

  // ---------- główna pętla ----------

  let newlyHidden = 0;

  // Plakietki nie pokazujemy, gdy Allegro samo podaje cenę za jednostkę (np. "13,80 zł/100 g")
  function setUnit(li, info, active) {
    const native = S.nativeUnitPrice.test(li.querySelector(S.offer)?.textContent || "");
    const label = active && settings.showUnitPrice && !native ? unitLabel(info) : null;
    if (label) li.dataset.cwUnit = label;
    else delete li.dataset.cwUnit;
  }

  // Rekomendacje, artykuły poradnikowe itp. – ukrywamy najwyższy element sekcji,
  // który nie zawiera listy wyników (żeby nie ukryć niechcący całej strony).
  function hideClutter(main, enabled) {
    const marked = document.querySelectorAll("[data-cw-clutter]");
    if (!enabled) {
      marked.forEach((n) => { delete n.dataset.cwClutter; setHide(n, null); });
      return;
    }
    const starts = [...document.querySelectorAll(S.clutterBoxes)];
    for (const h of document.querySelectorAll("h2, h3")) {
      const text = h.textContent.trim().toLowerCase();
      if (S.clutterHeadings.some((c) => text.startsWith(c))) starts.push(h);
    }
    for (const start of starts) {
      if (start.contains(main) || start.closest("#cw-bar, #cw-extra")) continue;
      let node = start;
      for (let i = 0; i < 10; i++) {
        const parent = node.parentElement;
        if (!parent || parent === document.body || parent.contains(main) ||
            parent.querySelector("#cw-bar, #cw-extra")) break;
        node = parent;
      }
      node.dataset.cwClutter = "1";
      setHide(node, "hide");
    }
  }

  // Licznik na ikonie dodatku (ustawia go skrypt w tle)
  let lastBadge;
  function updateBadge(count, fair) {
    const text = !settings.showBadge || count == null || fair ? "" : count > 999 ? "999+" : String(count || "");
    if (text === lastBadge) return;
    lastBadge = text;
    try {
      const r = api.runtime.sendMessage({ type: "cw-badge", text });
      if (r && typeof r.catch === "function") r.catch(() => {});
    } catch (_) { /* tło jeszcze nie działa – pominięcie licznika nic nie psuje */ }
  }

  // Reklamy poza główną listą (np. karuzele i siatki "polecanych" w środku wyników),
  // gdzie karta jest zagnieżdżona głębiej: ul > li > div > … > article.
  function hideLooseAds(stats, active) {
    for (const art of document.querySelectorAll(S.offer)) {
      const li = art.closest(S.offerItem);
      if (!li || li === art.parentElement || art.closest("#cw-extra, #cw-bar")) continue;
      const kind = classify(art);
      if (!isAd(kind)) continue;
      stats[kind]++;
      const hide = active && !fairMode() && adHidden(kind);
      setHide(li, hide ? (hideMode() === "dim" ? "dim" : "hide") : null,
        hide && hideMode() === "dim" ? badgeFor(kind) : null);
      if (hide && !counted.has(art)) {
        counted.add(art);
        newlyHidden++;
      }
    }
  }

  // Banery i kolumny reklamowe ukrywa CSS (działa też na bloki doładowane później);
  // tu tylko przełączamy klasę i liczymy bloki do paska.
  function handleDisplayAds(stats, active) {
    const on = active && settings.hideSponsored && !fairMode();
    const root = document.documentElement;
    root.classList.toggle("cw-ads-hide", on && hideMode() !== "dim");
    root.classList.toggle("cw-ads-dim", on && hideMode() === "dim");
    const blocks = [...document.querySelectorAll(S.displayAds)].filter(
      (e) => !e.parentElement?.closest(S.displayAds) && e.textContent.trim().length > 0
    );
    stats.adBlocks = blocks.length;
  }

  function resetPool() {
    document.getElementById("cw-extra")?.remove();
  }

  function run() {
    if (state.key !== pageKey(location.href)) {
      state = newPageState();
      resetPool();
    }
    if (!isListingPage()) return;

    const lists = findListings(document).filter((ul) => ul.id !== "cw-extra");
    if (!lists.length) return;
    const main = lists.reduce((a, b) => (offersIn(b).length > offersIn(a).length ? b : a));
    const active = settings.enabled && !paused;
    const fair = active && fairMode();

    // Tryb uczciwy wyłączony – usuń kopie reklam z naszej listy
    if (!fair && state.fairCloned.size) {
      document.querySelectorAll('#cw-extra > [data-cw-from="0"]').forEach((n) => n.remove());
      state.fairCloned.clear();
    }

    const stats = { promoted: 0, sponsored: 0, plain: 0, plainOnPage: 0, filtered: 0, cheapestPlain: null, cheapestAd: null };
    let visiblePlain = 0;
    const consider = (field, v) => {
      if (Number.isFinite(v) && (stats[field] == null || v < stats[field])) stats[field] = v;
    };

    // 1) Oferty Allegro na tej stronie
    for (const ul of lists) {
      for (const art of offersIn(ul)) {
        const li = art.parentElement;
        const kind = classify(art);
        li.dataset.cwKind = kind;
        const id = offerId(art);
        if (kind === "plain" && id) state.seenIds.add(id);
        stats[kind]++;
        const info = readInfo(li);
        const reason = active ? filterReason(info) : null;
        setUnit(li, info, active);

        if (isAd(kind)) consider("cheapestAd", sortKey(info));

        if (fair && ul === main && id) {
          // w trybie uczciwym wszystko z głównej listy trafia jako kopia do naszej, posortowanej listy
          if (!state.fairCloned.has(id)) {
            state.fairCloned.add(id);
            addToPool(main, li, kind, 0);
          }
          setHide(li, "hide");
          continue;
        }

        if (reason) {
          stats.filtered++;
          setHide(li, hideMode() === "dim" ? "dim" : "hide", hideMode() === "dim" ? `Ukryte: ${reason}` : null);
        } else if (adHidden(kind)) {
          setHide(li, hideMode() === "dim" ? "dim" : "hide", hideMode() === "dim" ? badgeFor(kind) : null);
          if (!counted.has(art)) {
            counted.add(art);
            newlyHidden++;
          }
        } else {
          setHide(li, null);
          if (kind === "plain") {
            visiblePlain++;
            stats.plainOnPage++;
            consider("cheapestPlain", sortKey(info));
          }
        }
      }
      hideHeadings(ul);
    }

    // 2) Nasza lista: filtry, oznaczenia reklam, kolejność
    const pool = getPool(main, false);
    if (pool) {
      pool.hidden = !active;
      for (const li of pool.querySelectorAll(":scope > li")) {
        if (li.classList.contains("cw-separator")) continue;
        const info = readInfo(li);
        const kind = li.dataset.cwKind;
        const reason = filterReason(info);
        setUnit(li, info, active);
        if (reason) {
          stats.filtered++;
          setHide(li, "hide");
        } else {
          setHide(li, null, isAd(kind) ? badgeFor(kind) : null);
          if (kind === "plain") {
            visiblePlain++;
            consider("cheapestPlain", sortKey(info));
          }
        }
      }
      orderPool(pool);
      placePool(pool, main, fair || stats.plainOnPage < 5);
    }

    // Nic nie zostało i nie ma już czego dociągać – nie zostawiamy pustej strony
    const fillDone = !settings.fillPages || state.stopFill || state.loadedPages.size >= pageLimit();
    if (active && !fair && !state.emptyFallback && visiblePlain === 0 && !state.loading && fillDone &&
        stats.promoted + stats.sponsored > 0) {
      state.emptyFallback = true;
      setTimeout(run, 0);
    }

    hideLooseAds(stats, active);
    handleDisplayAds(stats, active);
    hideClutter(main, active && settings.hideClutter);
    updateBadge(active ? stats.promoted + stats.sponsored + stats.filtered + (settings.hideSponsored ? stats.adBlocks || 0 : 0) : null, fair);

    document.documentElement.classList.toggle("cw-active", settings.enabled);
    if (settings.enabled) {
      const anchor = pool && !pool.hidden && pool.nextElementSibling === main ? pool : main;
      updateBar(anchor, stats);
      fillFromNextPages(main, visiblePlain);
    } else {
      document.getElementById("cw-bar")?.remove();
    }
    saveStats(stats);
  }

  let statsTimer = null;
  function saveStats(stats) {
    clearTimeout(statsTimer);
    statsTimer = setTimeout(async () => {
      try {
        const { totalHidden = 0 } = await api.storage.local.get("totalHidden");
        await api.storage.local.set({
          totalHidden: totalHidden + newlyHidden,
          lastPage: {
            promoted: stats.promoted,
            sponsored: stats.sponsored,
            filtered: stats.filtered,
            cheapestPlain: stats.cheapestPlain,
            cheapestAd: stats.cheapestAd,
            extraPages: state.loadedPages.size,
            at: Date.now()
          }
        });
        newlyHidden = 0;
      } catch (_) { /* np. po aktualizacji dodatku – bez znaczenia */ }
    }, 800);
  }

  // Allegro zmienia wyniki bez przeładowania strony – obserwujemy DOM.
  // m.target to element, w którym zaszła zmiana – zmiany w naszym pasku i liście pomijamy.
  let scheduled = null;
  const observer = new MutationObserver((mutations) => {
    const ours = mutations.every(
      (m) => m.target.nodeType === 1 && !!m.target.closest("#cw-bar, #cw-extra")
    );
    if (ours) return;
    clearTimeout(scheduled);
    scheduled = setTimeout(run, 250);
  });

  async function init() {
    try {
      const stored = await api.storage.sync.get(DEFAULTS);
      settings = { ...DEFAULTS, ...stored };
    } catch (_) { /* domyślne ustawienia */ }
    phrases = parsePhrases(settings.blockedPhrases);

    api.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync") return;
      for (const [k, v] of Object.entries(changes)) settings[k] = v.newValue;
      if (changes.blockedPhrases) phrases = parsePhrases(settings.blockedPhrases);
      if (changes.fillPages || changes.maxExtraPages || changes.enabled) state.stopFill = false;
      run();
    });

    run();
    observer.observe(document.body, { childList: true, subtree: true });
  }

  init();
})();
