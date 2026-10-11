export type Lang = "en" | "ar";

const dict = {
  en: {
    live: "Live", guide: "Guide", catalog: "Free channels", manage: "My channels & sources",
    search: "Search channels or what's on", forYou: "For you", now: "Now", next: "Next", pick: "Select a channel to start watching.",
    attest: "I own or am entitled to use the playlists and accounts I add.", add: "Add", sync: "Sync", delete: "Delete", hide: "Hide", show: "Show",
    accept: "Accept", exportM3U: "Export my playlist (M3U)", clearHistory: "Delete my viewing history", addToMine: "Add to my channels",
    suggested: "Suggested guide matches", legal: "Free, legal channels only: official broadcasts, free ad-supported channels, open directories, and sources you own.",
    name: "Name", url: "URL", username: "Username", password: "Password", type: "Type", importM3U: "Import M3U", importEpg: "Import XMLTV guide",
  },
  ar: {
    live: "مباشر", guide: "الدليل", catalog: "قنوات مجانية", manage: "قنواتي ومصادري",
    search: "ابحث عن قناة أو برنامج", forYou: "مقترح لك", now: "الآن", next: "التالي", pick: "اختر قناة لبدء المشاهدة.",
    attest: "أقرّ بأنني أملك أو يحق لي استخدام القوائم والحسابات التي أضيفها.", add: "إضافة", sync: "مزامنة", delete: "حذف", hide: "إخفاء", show: "إظهار",
    accept: "قبول", exportM3U: "تصدير قائمتي (M3U)", clearHistory: "حذف سجل المشاهدة", addToMine: "أضف إلى قنواتي",
    suggested: "ربط مقترح بالدليل", legal: "قنوات مجانية وقانونية فقط: البث الرسمي، والقنوات المجانية الممولة بالإعلانات، والأدلة المفتوحة، ومصادرك الخاصة.",
    name: "الاسم", url: "الرابط", username: "اسم المستخدم", password: "كلمة المرور", type: "النوع", importM3U: "استيراد M3U", importEpg: "استيراد دليل XMLTV",
  },
};

export type Strings = Record<keyof (typeof dict)["en"], string>;
export const t = (lang: Lang): Strings => dict[lang];
