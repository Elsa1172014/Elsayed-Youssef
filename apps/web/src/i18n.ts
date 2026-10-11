export type Lang = "en" | "ar";

const dict = {
  en: {
    live: "Live", guide: "Guide", catalog: "Free channels", manage: "My channels & sources",
    g_all: "All", g_arabic: "Arabic", g_movies: "Movies", g_entertainment: "Entertainment", g_news: "News", g_sports: "Sports", g_kids: "Kids", g_music: "Music", g_documentary: "Documentary", g_religious: "Religious", g_other: "Other", showMore: "Show more", arabicOnly: "Arabic channels only", europeOnly: "European channels only", g_europe: "Europe", g_series: "Series", allCountries: "All countries", viaRelay: "via server", viaRelayTip: "This stream is relayed through your server because the channel does not allow direct playback in a browser.",
    search: "Search channels or what's on", forYou: "For you", now: "Now", next: "Next", pick: "Select a channel to start watching.",
    attest: "I own or am entitled to use the playlists and accounts I add.", add: "Add", sync: "Sync", delete: "Delete", hide: "Hide", show: "Show",
    accept: "Accept", exportM3U: "Export my playlist (M3U)", clearHistory: "Delete my viewing history", addToMine: "Add to my channels",
    suggested: "Suggested guide matches", legal: "Free, legal channels only: official broadcasts, free ad-supported channels, open directories, and sources you own.",
    signOut: "Sign out", signIn: "Sign in", register: "Create account", username: "Username", password: "Password", newPassword: "New password (min 10 characters)",
    changePassword: "Change password", deleteAccount: "Delete my account and data", confirmPassword: "Your password",
    premium: "Premium", premiumNote: "Channels with no free stream (subscription, encrypted or regional). This is a directory only: it has no stream links and cannot unlock anything. To watch one, add a subscription you own under Manage (Xtream), then link your channel to its entry here.",
    findMine: "Find in my subscription", link: "Link", unlink: "Unlink", mySubscription: "My subscription channels", noMatches: "No similar channel in your own sources yet.", ai: "AI",
    aiSummary: "Summarize now/next", aiTranslate: "Translate", aiSimilar: "Similar channels", aiBasic: "Basic summary (AI model not configured on this server)", close: "Close",
    syncNow: "Sync now", syncing: "Syncing the channel directory, this can take up to a minute…", syncDone: "Synced", syncEmpty: "The channel directory is empty. Press Sync now to load all free channels.",
    syncRetry: "The sync was interrupted; progress is kept, press Sync now again to continue.", lastSynced: "Last synced",
    loading: "Loading your channels…", savedZero: "Your account has 0 saved channels.", catalogReady: "The free catalog has {n} channels: open Free channels and press Add all.", noChannelsYet: "No channels yet. Open Free channels and press Sync now, then add channels to your list.", noResults: "No channels match your search.",
    country: "Country", category: "Category", language: "Language", channelsFound: "free channels", addAll: "Add all to my channels", added: "added", skipped: "already there", more: "Show more",
    name: "Name", url: "URL", type: "Type", importM3U: "Import M3U", importEpg: "Import XMLTV guide",
  },
  ar: {
    live: "مباشر", guide: "الدليل", catalog: "قنوات مجانية", manage: "قنواتي ومصادري",
    g_all: "الكل", g_arabic: "عربية", g_movies: "أفلام", g_entertainment: "ترفيه", g_news: "أخبار", g_sports: "رياضة", g_kids: "أطفال", g_music: "موسيقى", g_documentary: "وثائقي", g_religious: "دينية", g_other: "أخرى", showMore: "عرض المزيد", arabicOnly: "القنوات العربية فقط", europeOnly: "القنوات الأوروبية فقط", g_europe: "أوروبا", g_series: "مسلسلات", allCountries: "كل الدول", viaRelay: "عبر الخادم", viaRelayTip: "تُبَثّ هذه القناة عبر خادمك لأن مصدرها لا يسمح بالتشغيل المباشر في المتصفح.",
    search: "ابحث عن قناة أو برنامج", forYou: "مقترح لك", now: "الآن", next: "التالي", pick: "اختر قناة لبدء المشاهدة.",
    attest: "أقرّ بأنني أملك أو يحق لي استخدام القوائم والحسابات التي أضيفها.", add: "إضافة", sync: "مزامنة", delete: "حذف", hide: "إخفاء", show: "إظهار",
    accept: "قبول", exportM3U: "تصدير قائمتي (M3U)", clearHistory: "حذف سجل المشاهدة", addToMine: "أضف إلى قنواتي",
    suggested: "ربط مقترح بالدليل", legal: "قنوات مجانية وقانونية فقط: البث الرسمي، والقنوات المجانية الممولة بالإعلانات، والأدلة المفتوحة، ومصادرك الخاصة.",
    signOut: "تسجيل الخروج", signIn: "تسجيل الدخول", register: "إنشاء حساب", username: "اسم المستخدم", password: "كلمة المرور", newPassword: "كلمة مرور جديدة (10 أحرف على الأقل)",
    changePassword: "تغيير كلمة المرور", deleteAccount: "حذف حسابي وبياناتي", confirmPassword: "كلمة مرورك",
    premium: "قنوات الاشتراك", premiumNote: "قنوات بلا بث مجاني (اشتراك أو مشفّرة أو محلية). هذا دليل فقط: لا يحتوي روابط بث ولا يفتح أي قناة. لمشاهدة قناة أضف اشتراكاً تملكه من «قنواتي ومصادري» (Xtream) ثم اربط قناتك بإدخالها هنا.",
    findMine: "ابحث في اشتراكي", link: "ربط", unlink: "فك الربط", mySubscription: "قنوات اشتراكي", noMatches: "لا توجد قناة مشابهة في مصادرك بعد.", ai: "ذكاء",
    aiSummary: "لخّص الآن/التالي", aiTranslate: "ترجمة", aiSimilar: "قنوات مشابهة", aiBasic: "ملخص بسيط (نموذج الذكاء الاصطناعي غير مُهيّأ على الخادم)", close: "إغلاق",
    syncNow: "مزامنة الآن", syncing: "جارٍ مزامنة دليل القنوات، قد يستغرق حتى دقيقة…", syncDone: "تمت المزامنة", syncEmpty: "دليل القنوات فارغ. اضغط «مزامنة الآن» لتحميل كل القنوات المجانية.",
    syncRetry: "انقطعت المزامنة؛ ما تم حفظه باقٍ، اضغط «مزامنة الآن» مجدداً للمتابعة.", lastSynced: "آخر مزامنة",
    loading: "جارٍ تحميل قنواتك…", savedZero: "لا توجد قنوات محفوظة في حسابك.", catalogReady: "الكتالوج المجاني فيه {n} قناة: افتح «القنوات المجانية» واضغط «أضف الكل».", noChannelsYet: "لا توجد قنوات بعد. افتح «القنوات المجانية» واضغط «مزامنة الآن» ثم أضف قنوات إلى قائمتك.", noResults: "لا توجد قنوات تطابق بحثك.",
    country: "الدولة", category: "الفئة", language: "اللغة", channelsFound: "قناة مجانية", addAll: "أضف الكل إلى قنواتي", added: "أُضيفت", skipped: "موجودة مسبقاً", more: "عرض المزيد",
    name: "الاسم", url: "الرابط", type: "النوع", importM3U: "استيراد M3U", importEpg: "استيراد دليل XMLTV",
  },
};

export type Strings = Record<keyof (typeof dict)["en"], string>;
export const t = (lang: Lang): Strings => dict[lang];
