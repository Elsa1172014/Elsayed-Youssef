import type { XmltvProgramme } from "./xmltv";

export interface SourcedProgramme extends XmltvProgramme {
  /** Higher wins. e.g. official=30, provider=20, community=10. */
  priority: number;
}

/**
 * Merges programmes from several guide sources for one channel. Programmes from higher-priority
 * sources replace overlapping ones from lower-priority sources; gaps are filled from lower ones.
 */
export function mergeProgrammes(list: SourcedProgramme[]): XmltvProgramme[] {
  const sorted = [...list].sort((a, b) => b.priority - a.priority || a.start.localeCompare(b.start));
  const kept: SourcedProgramme[] = [];
  for (const p of sorted) {
    if (!kept.some((k) => k.priority > p.priority && k.start < p.stop && k.stop > p.start)) kept.push(p);
  }
  return kept
    .sort((a, b) => a.start.localeCompare(b.start))
    .map(({ priority: _p, ...rest }) => rest);
}
