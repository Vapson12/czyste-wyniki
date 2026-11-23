const api = globalThis.browser ?? globalThis.chrome;

const DEFAULTS = {
  enabled: true,
  hidePromoted: true,
  hideSponsored: true,
  mode: "hide",
  fillPages: true,
  maxExtraPages: 2,
  blockedPhrases: "",
  sortByTotal: false,
  sortBy: "price",
  showUnitPrice: true,
  showSavings: true,
  maxDeliveryDays: 0,
  minRating: 0,
  minReviews: 0,
  hideClutter: true,
  showBadge: true
};

const SWITCHES = ["enabled", "hidePromoted", "hideSponsored", "hideClutter", "fillPages", "showUnitPrice", "showSavings", "showBadge"];
const MODE_HINTS = {
  hide: "Reklamy znikają, zwykłe oferty wskakują na ich miejsce.",
  dim: "Reklamy zostają, ale wyblakłe i podpisane.",
  fair: "Reklamy zostają, a wszystko jest ułożone ściśle po cenie."
};

const $ = (id) => document.getElementById(id);
const zl = (n) => n.toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " zł";
let settings = { ...DEFAULTS };

function save(patch) {
  Object.assign(settings, patch);
  api.storage.sync.set(patch);
  render();
}

// ---------- rysowanie stanu ----------

function render() {
  document.body.classList.toggle("off", !settings.enabled);
  for (const key of SWITCHES) $(key).checked = !!settings[key];

  // stare ustawienie z wersji 0.2
  const sortBy = settings.sortBy !== "price" ? settings.sortBy : settings.sortByTotal ? "total" : "price";
  const values = { ...settings, sortBy };
  for (const seg of document.querySelectorAll(".seg")) {
    const current = String(values[seg.dataset.key]);
    for (const b of seg.querySelectorAll("button")) {
      b.setAttribute("aria-pressed", String(b.dataset.value === current));
    }
  }
  $("modeHint").textContent = MODE_HINTS[settings.mode] || "";
  $("fieldExtraPages").classList.toggle("disabled", !settings.fillPages);
  renderChips();
}

// ---------- frazy ----------

const phrasesList = () =>
  (settings.blockedPhrases || "").split(/[,;\n]/).map((p) => p.trim()).filter(Boolean);

function renderChips() {
  const box = $("chips");
  const input = $("phraseInput");
  box.querySelectorAll(".chip").forEach((c) => c.remove());
  for (const phrase of phrasesList()) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.append(document.createTextNode(phrase));
    const x = document.createElement("button");
    x.type = "button";
    x.textContent = "×";
    x.setAttribute("aria-label", `Usuń „${phrase}”`);
    x.addEventListener("click", () => {
      save({ blockedPhrases: phrasesList().filter((p) => p !== phrase).join(", ") });
      input.focus();
    });
    chip.append(x);
    box.insertBefore(chip, input);
  }
}

function addPhrases(text) {
  const fresh = text.split(/[,;\n]/).map((p) => p.trim()).filter(Boolean);
  if (!fresh.length) return;
  const all = phrasesList();
  for (const p of fresh) if (!all.some((q) => q.toLowerCase() === p.toLowerCase())) all.push(p);
  save({ blockedPhrases: all.join(", ") });
}

$("phraseInput").addEventListener("keydown", (e) => {
  const input = e.target;
  if (e.key === "Enter" || e.key === ",") {
    e.preventDefault();
    addPhrases(input.value);
    input.value = "";
  } else if (e.key === "Backspace" && !input.value) {
    const all = phrasesList();
    if (all.length) save({ blockedPhrases: all.slice(0, -1).join(", ") });
  }
});
$("phraseInput").addEventListener("blur", (e) => {
  if (e.target.value.trim()) {
    addPhrases(e.target.value);
    e.target.value = "";
  }
});
$("chips").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) $("phraseInput").focus();
});

// ---------- przełączniki i segmenty ----------

for (const key of SWITCHES) {
  $(key).addEventListener("change", (e) => save({ [key]: e.target.checked }));
}

for (const seg of document.querySelectorAll(".seg")) {
  seg.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    const key = seg.dataset.key;
    const value = seg.dataset.type === "number" ? parseFloat(b.dataset.value) : b.dataset.value;
    const patch = { [key]: value };
    if (key === "sortBy") patch.sortByTotal = false;
    save(patch);
  });
}

// ---------- zakładki ----------

const tabs = [...document.querySelectorAll('[role="tab"]')];
function selectTab(tab, focus) {
  for (const t of tabs) {
    const on = t === tab;
    t.setAttribute("aria-selected", String(on));
    t.tabIndex = on ? 0 : -1;
    $(t.getAttribute("aria-controls")).hidden = !on;
  }
  if (focus) tab.focus();
  try { localStorage.setItem("cw-tab", tab.id); } catch (_) {}
}
tabs.forEach((t) => t.addEventListener("click", () => selectTab(t)));
document.querySelector('[role="tablist"]').addEventListener("keydown", (e) => {
  const i = tabs.indexOf(document.activeElement);
  if (i < 0) return;
  if (e.key === "ArrowRight") selectTab(tabs[(i + 1) % tabs.length], true);
  if (e.key === "ArrowLeft") selectTab(tabs[(i - 1 + tabs.length) % tabs.length], true);
});

// ---------- paragon ----------

async function loadReceipt() {
  const { totalHidden = 0, lastPage } = await api.storage.local.get(["totalHidden", "lastPage"]);
  $("total").textContent = totalHidden.toLocaleString("pl-PL");
  if (!lastPage || Date.now() - lastPage.at > 30 * 60 * 1000) return;

  $("receipt").hidden = false;
  $("receiptEmpty").hidden = true;
  $("pageAds").textContent = (lastPage.promoted || 0) + (lastPage.sponsored || 0);
  $("pageFiltered").textContent = lastPage.filtered || 0;

  const { cheapestPlain: p, cheapestAd: a } = lastPage;
  $("rowPlain").hidden = p == null;
  $("rowAd").hidden = a == null;
  if (p != null) $("cheapestPlain").textContent = zl(p);
  if (a != null) $("cheapestAd").textContent = zl(a);
  if (p != null && a != null && a - p >= 0.01) {
    $("savings").textContent = zl(a - p);
    $("rowSavings").hidden = false;
  }
}

// ---------- start ----------

(async () => {
  settings = { ...DEFAULTS, ...(await api.storage.sync.get(DEFAULTS)) };
  render();
  let saved = null;
  try { saved = localStorage.getItem("cw-tab"); } catch (_) {}
  selectTab($(saved) && tabs.includes($(saved)) ? $(saved) : tabs[0]);
  loadReceipt();
})();
