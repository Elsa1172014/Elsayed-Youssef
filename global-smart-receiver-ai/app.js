// GLOBAL SMART RECEIVER AI — Phase 1 shell (dependency-free). Implemented: Home, Short Dramas, Favorites, language/RTL.
const I18N = {
  ar: {
    dir: "rtl", other: "EN",
    nav: { home: "الرئيسية", live: "البث المباشر", countries: "الدول", languages: "اللغات", satellites: "الأقمار", movies: "الأفلام", series: "المسلسلات", shorts: "مسلسلات قصيرة", guide: "دليل البرامج", favs: "المفضلة", ai: "المساعد", receiver: "الرسيفر", subs: "الاشتراكات", settings: "الإعدادات" },
    soon: "قيد التطوير", soonMsg: "هذا القسم غير مُنفَّذ بعد في هذه النسخة.",
    homeTitle: "مرحبًا بك في GLOBAL SMART RECEIVER AI",
    homeMsg: "لا توجد قنوات بث مباشر في هذه النسخة بعد؛ محرك الاستيراد قيد البناء. القسم المتاح الآن: المسلسلات القصيرة.",
    shortsTitle: "قناة المسلسلات القصيرة",
    shortsNote: "المنصات الرائجة (ReelShort وDramaBox وغيرها) محتوى مرخّص ولا يجوز تضمينه أو إعادة بثه. هذه القناة تعرض دليلًا بالمنصات الرسمية وتفتح موقع كل منصة؛ وتعرض أي حلقات عمودية مرخّصة يضيفها المالك فقط.",
    providers: "المنصات الرسمية", open: "فتح الموقع الرسمي", unverified: "الرابط لم يُتحقق منه بعد", freemium: "مجاني جزئيًا / مدفوع",
    ownTitle: "حلقات مرخّصة (محتوى خاص)", ownEmpty: "لا توجد حلقات مضافة. أضف حلقاتك المرخّصة في data/short-dramas-own.json.",
    search: "ابحث...", favsEmpty: "لا توجد عناصر مفضلة بعد.", fav: "إضافة للمفضلة", ep: "حلقة"
  },
  en: {
    dir: "ltr", other: "ع",
    nav: { home: "Home", live: "Live TV", countries: "Countries", languages: "Languages", satellites: "Satellites", movies: "Movies", series: "Series", shorts: "Short Dramas", guide: "TV Guide", favs: "Favorites", ai: "AI Assistant", receiver: "Receiver", subs: "Subscriptions", settings: "Settings" },
    soon: "In development", soonMsg: "This section is not implemented in this build yet.",
    homeTitle: "Welcome to GLOBAL SMART RECEIVER AI",
    homeMsg: "No live channels in this build yet; the import engine is still being built. Available now: Short Dramas.",
    shortsTitle: "Short Dramas Channel",
    shortsNote: "Popular platforms (ReelShort, DramaBox, etc.) carry licensed, paid content that cannot be embedded or re-streamed. This channel is a directory of the official platforms that opens each provider's own site, and shows only licensed vertical episodes the owner adds.",
    providers: "Official platforms", open: "Open official site", unverified: "Link not yet verified", freemium: "Freemium / paid",
    ownTitle: "Licensed episodes (own content)", ownEmpty: "No episodes added. Put your licensed episodes in data/short-dramas-own.json.",
    search: "Search...", favsEmpty: "No favorites yet.", fav: "Add to favorites", ep: "Episode"
  }
};
const NAV = [["home", 1], ["live"], ["countries"], ["languages"], ["satellites"], ["movies"], ["series"], ["shorts", 1], ["guide"], ["favs", 1], ["ai"], ["receiver"], ["subs"], ["settings"]];

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } }
};
let lang = store.get("lang", "ar");
let favs = new Set(store.get("favs", []));
const app = document.getElementById("app");
const t = () => I18N[lang];
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function safeHttpUrl(u) {
  try { const x = new URL(u); return x.protocol === "https:" ? x.href : null; } catch { return null; }
}

async function getJson(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(path + " " + r.status);
  return r.json();
}

function renderNav(route) {
  document.getElementById("nav").innerHTML = NAV.map(([k, ok]) =>
    `<a href="#/${k}" class="${route === k ? "on" : ""} ${ok ? "" : "soon"}">${esc(t().nav[k])}</a>`).join("");
}

function toggleFav(id) { favs.has(id) ? favs.delete(id) : favs.add(id); store.set("favs", [...favs]); }

const views = {
  home: async () => `<h1>${esc(t().homeTitle)}</h1><p class="note">${esc(t().homeMsg)}</p>`,
  async shorts() {
    const [prov, own] = await Promise.all([getJson("data/short-drama-providers.json"), getJson("data/short-dramas-own.json")]);
    const cards = prov.providers.map(p => {
      const url = safeHttpUrl(p.url);
      if (!url) return "";
      const id = "prov:" + p.id;
      return `<article class="card"><button class="fav ${favs.has(id) ? "on" : ""}" data-fav="${esc(id)}" aria-label="${esc(t().fav)}">♥</button>
        <h3>${esc(p.name)}</h3><span class="tag">${esc(t().freemium)}</span><span class="tag">${esc(p.languages.join(" · "))}</span>
        ${p.verified ? "" : `<span class="tag warn">${esc(t().unverified)}</span>`}
        <a class="go" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(t().open)}</a></article>`;
    }).join("");
    const ownHtml = own.series.length
      ? own.series.map(s => `<h3>${esc(s.title)}</h3><p>${esc(s.synopsis || "")}</p><div class="reel">${s.episodes.map(e => {
        const src = safeHttpUrl(e.src);
        return src ? `<video controls playsinline preload="none" src="${esc(src)}" aria-label="${esc(t().ep)} ${esc(e.n)}"></video>` : "";
      }).join("")}</div>`).join("")
      : `<p class="note">${esc(t().ownEmpty)}</p>`;
    return `<h1>${esc(t().shortsTitle)}</h1><p class="note">${esc(t().shortsNote)}</p>
      <input type="search" id="q" placeholder="${esc(t().search)}" aria-label="${esc(t().search)}">
      <h2>${esc(t().providers)}</h2><div class="grid" id="grid">${cards}</div>
      <h2>${esc(t().ownTitle)}</h2>${ownHtml}`;
  },
  async favs() {
    const prov = (await getJson("data/short-drama-providers.json")).providers.filter(p => favs.has("prov:" + p.id));
    return `<h1>${esc(t().nav.favs)}</h1>` + (prov.length
      ? `<div class="grid">${prov.map(p => `<article class="card"><h3>${esc(p.name)}</h3><a class="go" href="${esc(safeHttpUrl(p.url) || "#")}" target="_blank" rel="noopener noreferrer">${esc(t().open)}</a></article>`).join("")}</div>`
      : `<p class="note">${esc(t().favsEmpty)}</p>`);
  }
};

async function render() {
  const route = (location.hash.replace(/^#\//, "") || "home");
  document.documentElement.lang = lang; document.documentElement.dir = t().dir;
  document.getElementById("lang").textContent = t().other;
  renderNav(route);
  try {
    app.innerHTML = views[route] ? await views[route]() : `<h1>${esc(t().nav[route] || route)}</h1><p class="note"><b>${esc(t().soon)}</b> — ${esc(t().soonMsg)}</p>`;
  } catch (e) {
    app.innerHTML = `<p class="note" role="alert">${esc(String(e.message))}</p>`;
  }
  app.querySelectorAll("[data-fav]").forEach(b => b.addEventListener("click", () => { toggleFav(b.dataset.fav); b.classList.toggle("on"); }));
  const q = document.getElementById("q");
  if (q) q.addEventListener("input", () => {
    const v = q.value.trim().toLowerCase();
    document.querySelectorAll("#grid .card").forEach(c => { c.hidden = !c.textContent.toLowerCase().includes(v); });
  });
}

document.getElementById("lang").addEventListener("click", () => { lang = lang === "ar" ? "en" : "ar"; store.set("lang", lang); render(); });
addEventListener("hashchange", render);
render();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
