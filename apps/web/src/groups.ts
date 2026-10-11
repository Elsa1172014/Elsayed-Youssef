import type { Channel } from "./api";

export type GroupId = "all" | "arabic" | "europe" | "movies" | "series" | "entertainment" | "news" | "sports" | "kids" | "music" | "documentary" | "religious" | "other";
export const GROUP_ORDER: GroupId[] = ["all", "arabic", "europe", "movies", "series", "entertainment", "news", "sports", "kids", "music", "documentary", "religious", "other"];

const ARAB_COUNTRIES = new Set("SA AE EG QA KW BH OM JO LB SY IQ YE PS LY TN DZ MA SD MR SO DJ KM".split(" "));
export const EUROPE = new Set("AL AD AT BY BE BA BG HR CY CZ DK EE FI FR DE GR HU IS IE IT XK LV LI LT LU MT MD MC ME NL MK NO PL PT RO RU SM RS SK SI ES SE CH UA GB VA".split(" "));
const BY_CATEGORY: Record<string, GroupId> = {
  movies: "movies", series: "series", classic: "movies",
  entertainment: "entertainment", comedy: "entertainment", general: "entertainment", lifestyle: "entertainment", family: "entertainment",
  culture: "entertainment", cooking: "entertainment", travel: "entertainment", shop: "entertainment", animation: "kids",
  news: "news", weather: "news", business: "news", legislative: "news", auto: "entertainment", outdoor: "entertainment", relax: "entertainment", science: "documentary",
  sports: "sports", kids: "kids", music: "music", documentary: "documentary", education: "documentary", religious: "religious",
};

/** Groups a channel belongs to (a channel can be in several, e.g. Arabic + News); everything is also in "all". */
export function groupsOf(c: Pick<Channel, "country" | "languages" | "categories" | "group">): GroupId[] {
  const out = new Set<GroupId>();
  if (c.languages?.includes("ara") || (c.country && ARAB_COUNTRIES.has(c.country.toUpperCase()))) out.add("arabic");
  if (c.country && EUROPE.has(c.country.toUpperCase())) out.add("europe");
  for (const cat of [...(c.categories ?? []), ...(c.group ? [c.group] : [])]) {
    const g = BY_CATEGORY[cat.toLowerCase()];
    if (g) out.add(g);
  }
  if (out.size === 0 || (out.size === 1 && (out.has("arabic") || out.has("europe")) && !(c.categories?.length || c.group))) out.add("other");
  return [...out];
}

export function groupCounts(channels: Channel[]): Record<GroupId, number> {
  const n = Object.fromEntries(GROUP_ORDER.map((g) => [g, 0])) as Record<GroupId, number>;
  for (const c of channels) {
    n.all++;
    for (const g of groupsOf(c)) n[g]++;
  }
  return n;
}
