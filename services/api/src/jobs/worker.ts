import { checkStreamHealth, syncIptvOrg } from "./catalog";
import { openDb } from "../openDb";
import { createSafeFetch } from "../safeFetch";
import { Store } from "../store";

// Long-running background worker: keeps the free-channel catalog fresh and probes stream health.
//   CATALOG_SYNC=false        disable the iptv-org sync
//   SYNC_INTERVAL_HOURS=24    how often to re-sync the whole directory
//   HEALTH_BATCH=200          streams probed per health tick (every HEALTH_INTERVAL_MIN, default 5)
const store = new Store(await openDb());
const fetcher = createSafeFetch();
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
const syncEveryMs = Number(process.env.SYNC_INTERVAL_HOURS ?? 24) * 3600_000;
const healthBatch = Number(process.env.HEALTH_BATCH ?? 200);
const healthEveryMs = Number(process.env.HEALTH_INTERVAL_MIN ?? 5) * 60_000;
let syncing = false;
let checking = false;

async function maybeSync() {
  if (process.env.CATALOG_SYNC === "false" || syncing) return;
  syncing = true;
  try {
    const last = await store.getSyncState("iptv-org");
    if (last && Date.now() - new Date(last.updatedAt).getTime() < syncEveryMs - 60_000) return;
    log("catalog sync starting");
    log("catalog sync done", await syncIptvOrg(store, fetcher));
  } catch (e) {
    log("catalog sync failed:", (e as Error).message);
  } finally {
    syncing = false;
  }
}

async function health() {
  if (checking || syncing) return;
  checking = true;
  try {
    const r = await checkStreamHealth(store, fetcher, healthBatch);
    if (r.checked) log("health", r);
  } catch (e) {
    log("health check failed:", (e as Error).message);
  } finally {
    checking = false;
  }
}

await maybeSync();
setInterval(() => void maybeSync(), 3600_000);
setInterval(() => void health(), healthEveryMs);
log("worker running");
