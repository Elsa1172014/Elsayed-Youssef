import type { ArchiveClient, SportsDbClient, TmdbClient } from "./clients";
import type { HubStore } from "./store";

export interface HubClients {
  tmdb?: TmdbClient;
  sports: SportsDbClient;
  archive: ArchiveClient;
  /** ISO region for "where to watch" (JustWatch via TMDB). */
  region: string;
}

/** Leagues followed by default the first time the sports job runs (operator can change them in the admin panel). */
export const DEFAULT_LEAGUES = ["4328", "4335", "4480", "4668"]; // Premier League, La Liga, UEFA Champions League, Saudi Pro League

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/api_key=[^&\s]+/gi, "api_key=[hidden]").replace(/\/json\/[^/]+\//, "/json/[key]/");

async function inBatches<T>(items: T[], size: number, fn: (x: T) => Promise<void>) {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn));
}

/** Trending movies/series from TMDB + "where to watch" for the configured region. Per-title failures are logged, not fatal. */
export async function syncTmdb(store: HubStore, c: HubClients, trigger: "cron" | "manual" = "cron") {
  const run = await store.startJob("tmdb", trigger);
  if (!c.tmdb) {
    const error = "TMDB_READ_TOKEN / TMDB_API_KEY is not configured";
    await store.logError("tmdb", error, {}, "tmdb");
    await store.finishJob(run, false, {}, error);
    return { ok: false, error };
  }
  try {
    const [genres, trending] = await Promise.all([c.tmdb.genres().catch(() => ({} as Record<number, string>)), c.tmdb.trending(2)]);
    const ids: number[] = [];
    let providers = 0;
    let failed = 0;
    await inBatches(trending.map((t, i) => ({ t, rank: i + 1 })), 6, async ({ t, rank }) => {
      try {
        const id = await store.upsertTitle(t, t.genreIds.map((g) => genres[g]).filter((g): g is string => !!g), rank);
        ids.push(id);
        const p = await c.tmdb!.watchProviders(t.kind, t.tmdbId, c.region);
        await store.setProviders(id, p, c.region);
        providers++;
      } catch (e) {
        failed++;
        await store.logError("tmdb", msg(e), { tmdbId: t.tmdbId, kind: t.kind }, "tmdb");
      }
    });
    await store.clearTrending(ids);
    const purged = await store.purgeStaleTitles();
    const stats = { trending: trending.length, saved: ids.length, providers, failed, purged };
    await store.finishJob(run, failed < trending.length || trending.length === 0, stats);
    return { ok: true, ...stats };
  } catch (e) {
    await store.logError("tmdb", msg(e), {}, "tmdb");
    await store.finishJob(run, false, {}, msg(e));
    return { ok: false, error: msg(e) };
  }
}

/** Upcoming + recent events for every followed league from TheSportsDB. */
export async function syncSports(store: HubStore, c: HubClients, trigger: "cron" | "manual" = "cron") {
  const run = await store.startJob("sports", trigger);
  try {
    let leagues = await store.leagues(true);
    if (!leagues.length && !(await store.leagues()).length) {
      for (const id of DEFAULT_LEAGUES) {
        try {
          const l = await c.sports.league(id);
          if (l) await store.addLeague(l);
        } catch (e) { await store.logError("thesportsdb", msg(e), { league: id }, "sports"); }
      }
      leagues = await store.leagues(true);
    }
    let events = 0;
    let failed = 0;
    for (const l of leagues) {
      for (const kind of ["next", "past"] as const) {
        try {
          const list = kind === "next" ? await c.sports.next(l.id) : await c.sports.past(l.id);
          await store.upsertEvents(list.map((e) => ({ ...e, idLeague: l.id })));
          events += list.length;
        } catch (e) {
          failed++;
          await store.logError("thesportsdb", msg(e), { league: l.id, kind }, "sports");
        }
      }
    }
    await store.purgeOldEvents();
    const stats = { leagues: leagues.length, events, failed, freeKey: c.sports.isFreeKey };
    await store.finishJob(run, failed < leagues.length * 2 || leagues.length === 0, stats);
    return { ok: true, ...stats };
  } catch (e) {
    await store.logError("thesportsdb", msg(e), {}, "sports");
    await store.finishJob(run, false, {}, msg(e));
    return { ok: false, error: msg(e) };
  }
}

/**
 * Open-licence film library: walks archive.org's most-viewed public-domain / Creative Commons films a page at a time
 * (cursor in hub.settings) and adds up to `max` new films per run, each with its playable MP4 and licence.
 */
export async function syncArchive(store: HubStore, c: HubClients, trigger: "cron" | "manual" = "cron", max = 15) {
  const run = await store.startJob("archive", trigger);
  try {
    let page = (await store.getSetting<number>("archive_page")) ?? 1;
    let added = 0;
    let checked = 0;
    let skipped = 0;
    for (let round = 0; round < 3 && added < max; round++) {
      const docs = await c.archive.search(page);
      if (!docs.length) { page = 1; break; } // walked the whole collection: start again (picks up newly uploaded films)
      const known = await store.existingExternal("archive", docs.map((d) => d.identifier));
      const fresh = docs.filter((d) => !known.has(d.identifier)).slice(0, max - added);
      await inBatches(fresh, 5, async (d) => {
        checked++;
        try {
          const film = await c.archive.film(d.identifier);
          if (!film) { skipped++; return; }
          const pd = /publicdomain/i.test(film.licenseUrl);
          await store.upsertOpenTitle({
            source: "archive", externalId: film.identifier, kind: "movie", title: film.title, overview: film.description, posterUrl: film.posterUrl,
            releaseYear: film.year, runtimeMin: film.runtimeMin, licenseUrl: film.licenseUrl, sourcePage: film.pageUrl, genres: [pd ? "ملكية عامة" : "رخصة مفتوحة"],
            play: { label: "الفيلم كاملًا", url: film.videoUrl, kind: "mp4", rightsHolder: pd ? "Public domain" : "Creative Commons", licenseRef: film.licenseUrl, createdBy: "archive-sync" },
          });
          added++;
        } catch (e) {
          skipped++;
          await store.logError("archive", msg(e), { identifier: d.identifier }, "archive");
        }
      });
      if (fresh.length < docs.length || added < max) page++; // this page is exhausted: move on
    }
    await store.setSetting("archive_page", page);
    const stats = { added, checked, skipped, nextPage: page };
    await store.finishJob(run, true, stats);
    return { ok: true, ...stats };
  } catch (e) {
    await store.logError("archive", msg(e), {}, "archive");
    await store.finishJob(run, false, {}, msg(e));
    return { ok: false, error: msg(e) };
  }
}

/** Daily cron entry point: both syncs, then log retention. Never throws. */
export async function runHubCron(store: HubStore, c: HubClients) {
  const tmdb = await syncTmdb(store, c, "cron").catch((e) => ({ ok: false, error: msg(e) }));
  const sports = await syncSports(store, c, "cron").catch((e) => ({ ok: false, error: msg(e) }));
  const archive = await syncArchive(store, c, "cron").catch((e) => ({ ok: false, error: msg(e) }));
  await store.pruneLogs().catch(() => undefined);
  return { tmdb, sports, archive };
}
