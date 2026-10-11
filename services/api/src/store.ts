import { randomUUID } from "node:crypto";
import type { WatchEvent, XmltvChannel, XmltvProgramme } from "@receiver/core";

export type SourceType = "m3u_url" | "m3u_file" | "xtream" | "xmltv" | "tuner";

export interface UserSource {
  id: string;
  userId: string;
  type: SourceType;
  name: string;
  enabled: boolean;
  /** Public URL only; credentials are never stored in this field. */
  url?: string;
  ownershipAttestedAt: string;
}

export interface UserChannel {
  id: string;
  userId: string;
  sourceId?: string;
  name: string;
  logoUrl?: string;
  group?: string;
  streamUrl: string;
  epgChannelId?: string;
  sortOrder: number;
  hidden: boolean;
}

/** Persistence boundary. A Postgres implementation follows migrations/001_init.sql. */
export interface Store {
  listSources(userId: string): UserSource[];
  getSource(userId: string, id: string): UserSource | undefined;
  addSource(s: Omit<UserSource, "id">): UserSource;
  updateSource(userId: string, id: string, patch: Partial<Pick<UserSource, "name" | "enabled" | "url">>): UserSource | undefined;
  deleteSource(userId: string, id: string): boolean;

  listChannels(userId: string): UserChannel[];
  getChannel(userId: string, id: string): UserChannel | undefined;
  addChannel(c: Omit<UserChannel, "id">): UserChannel;
  updateChannel(userId: string, id: string, patch: Partial<Omit<UserChannel, "id" | "userId">>): UserChannel | undefined;
  deleteChannel(userId: string, id: string): boolean;

  replaceProgrammes(userId: string, programmes: XmltvProgramme[], guideChannels?: XmltvChannel[]): void;
  listGuideChannels(userId: string): XmltvChannel[];
  addWatchEvent(userId: string, e: WatchEvent): void;
  listWatchEvents(userId: string): WatchEvent[];
  clearWatchEvents(userId: string): void;
  listProgrammes(userId: string, epgChannelId: string, fromIso: string, toIso: string): XmltvProgramme[];
}

export class MemoryStore implements Store {
  private sources = new Map<string, UserSource>();
  private channels = new Map<string, UserChannel>();
  private epg = new Map<string, XmltvProgramme[]>();
  private guide = new Map<string, XmltvChannel[]>();
  private watch = new Map<string, WatchEvent[]>();

  listSources(userId: string) {
    return [...this.sources.values()].filter((s) => s.userId === userId);
  }
  getSource(userId: string, id: string) {
    const s = this.sources.get(id);
    return s && s.userId === userId ? s : undefined;
  }
  addSource(s: Omit<UserSource, "id">) {
    const row = { ...s, id: randomUUID() };
    this.sources.set(row.id, row);
    return row;
  }
  updateSource(userId: string, id: string, patch: Partial<Pick<UserSource, "name" | "enabled" | "url">>) {
    const cur = this.getSource(userId, id);
    if (!cur) return undefined;
    const next = { ...cur, ...patch };
    this.sources.set(id, next);
    return next;
  }
  deleteSource(userId: string, id: string) {
    if (!this.getSource(userId, id)) return false;
    this.sources.delete(id);
    for (const c of this.listChannels(userId)) if (c.sourceId === id) this.channels.delete(c.id);
    return true;
  }

  listChannels(userId: string) {
    return [...this.channels.values()].filter((c) => c.userId === userId).sort((a, b) => a.sortOrder - b.sortOrder);
  }
  getChannel(userId: string, id: string) {
    const c = this.channels.get(id);
    return c && c.userId === userId ? c : undefined;
  }
  addChannel(c: Omit<UserChannel, "id">) {
    const row = { ...c, id: randomUUID() };
    this.channels.set(row.id, row);
    return row;
  }
  updateChannel(userId: string, id: string, patch: Partial<Omit<UserChannel, "id" | "userId">>) {
    const cur = this.getChannel(userId, id);
    if (!cur) return undefined;
    const next = { ...cur, ...patch };
    this.channels.set(id, next);
    return next;
  }
  deleteChannel(userId: string, id: string) {
    return this.getChannel(userId, id) ? this.channels.delete(id) : false;
  }

  replaceProgrammes(userId: string, programmes: XmltvProgramme[], guideChannels: XmltvChannel[] = []) {
    this.epg.set(userId, [...programmes].sort((a, b) => a.start.localeCompare(b.start)));
    this.guide.set(userId, guideChannels);
  }
  listGuideChannels(userId: string) {
    return this.guide.get(userId) ?? [];
  }
  addWatchEvent(userId: string, e: WatchEvent) {
    this.watch.set(userId, [...(this.watch.get(userId) ?? []), e]);
  }
  listWatchEvents(userId: string) {
    return this.watch.get(userId) ?? [];
  }
  clearWatchEvents(userId: string) {
    this.watch.delete(userId);
  }
  listProgrammes(userId: string, epgChannelId: string, fromIso: string, toIso: string) {
    return (this.epg.get(userId) ?? []).filter((p) => p.channelId === epgChannelId && p.stop > fromIso && p.start < toIso);
  }
}
