import { readFileSync } from "node:fs";
import { checkStreamHealth, syncIptvOrg, syncOfficial } from "./catalog";
import { openDb } from "../openDb";
import { createSafeFetch } from "../safeFetch";
import { Store } from "../store";

// Usage: tsx src/jobs/cli.ts <sync-iptv-org | sync-official <file> | check-health | block <catalogId>>
const [cmd, arg] = process.argv.slice(2);
const store = new Store(await openDb());
const fetcher = createSafeFetch();

switch (cmd) {
  case "sync-iptv-org":
    console.log(await syncIptvOrg(store, fetcher));
    break;
  case "sync-official":
    if (!arg) throw new Error("usage: sync-official <file.json>");
    console.log(await syncOfficial(store, JSON.parse(readFileSync(arg, "utf8"))));
    break;
  case "check-health":
    console.log(await checkStreamHealth(store, fetcher));
    break;
  case "block": // takedown hook for rights-holder requests
    if (!arg) throw new Error("usage: block <catalogId>");
    console.log({ blocked: await store.setCatalogStatus(arg, "blocked") });
    break;
  default:
    throw new Error("unknown command");
}
process.exit(0);
