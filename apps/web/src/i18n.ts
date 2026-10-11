export type Lang = "en" | "ar";

const dict = {
  en: {
    live: "Live", guide: "Guide", catalog: "Free channels", manage: "My channels & sources",
    search: "Search channels or what's on", forYou: "For you", now: "Now", next: "Next", pick: "Select a channel to start watching.",
    attest: "I own or am entitled to use the playlists and accounts I add.", add: "Add", sync: "Sync", delete: "Delete", hide: "Hide", show: "Show",
    accept: "Accept", exportM3U: "Export my playlist (M3U)", clearHistory: "Delete my viewing history", addToMine: "Add to my channels",
    suggested: "Suggested guide matches", legal: "Free, legal channels only: official broadcasts, free ad-supported channels, open directories, and sources you own.",
    signOut: "Sign out", signIn: "Sign in", register: "Create account", username: "Username", password: "Password", newPassword: "New password (min 10 characters)",
    changePassword: "Change password", deleteAccount: "Delete my account and data", confirmPassword: "Your password",
    country: "Country", category: "Category", language: "Language", channelsFound: "free channels", addAll: "Add all to my channels", added: "added", skipped: "already there", more: "Show more",
    name: "Name", url: "URL", type: "Type", importM3U: "Import M3U", importEpg: "Import XMLTV guide",
  },
  ar: {
    live: "مباشر", guide: "الدليل", catalog: "قنوات مجانية", manage: "قنواتي ومصادري",
    search: "ابحث عن قناة أو برنامج", forYou: "مقترح لك", now: "الآن", next: "التالي", pick: "اختر قناة لبدء المشاهدة.",
    attest: "أقرّ بأنني أملك أو يحق لي استخدام القوائم والحسابات التي أضيفها.", add: "إضافة", sync: "مزامنة", delete: "حذف", hide: "إخفاء", show: "إظهار",
    accept: "قبول", exportM3U: "تصدير قائمتي (M3U)", clearHistory: "حذف سجل المشاهدة", addToMine: "أضف إلى قنواتي",
    suggested: "ربط مقترح بالدليل", legal: "قنوات مجانية وقانونية فقط: البث الرسمي، والقنوات المجانية الممولة بالإعلانات، والأدلة المفتوحة، ومصادرك الخاصة.",
    signOut: "تسجيل الخروج", signIn: "تسجيل الدخول", register: "إنشاء حساب", username: "اسم المستخدم", password: "كلمة المرور", newPassword: "كلمة مرور جديدة (10 أحرف على الأقل)",
    changePassword: "تغيير كلمة المرور", deleteAccount: "حذف حسابي وبياناتي", confirmPassword: "كلمة مرورك",
    country: "الدولة", category: "الفئة", language: "اللغة", channelsFound: "قناة مجانية", addAll: "أضف الكل إلى قنواتي", added: "أُضيفت", skipped: "موجودة مسبقاً", more: "عرض المزيد",
    name: "الاسم", url: "الرابط", type: "النوع", importM3U: "استيراد M3U", importEpg: "استيراد دليل XMLTV",
  },
};

export type Strings = Record<keyof (typeof dict)["en"], string>;
export const t = (lang: Lang): Strings => dict[lang];
