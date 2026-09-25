import type { SectorHubKey } from '../jobSectorLanding';

/**
 * Decorative per-sector emoji shown in the sector-hub hero eyebrow
 * (`aria-hidden`, never in the H1 — keeps the H1 keyword clean for the SERP).
 * Purely a friendly visual cue so each sector hub reads less like a generic
 * listing wall.
 *
 * Shared by the TI sector hubs (`jobSectorPagesPlugin.ts`,
 * `/cerca-lavoro-ticino/<sector>/`) and the per-canton non-TI sector hubs
 * (`jobsSeoPagesPlugin.ts`, `/cerca-lavoro-<canton>/<sector>/`) so the two
 * emit paths stay byte-consistent by construction instead of drifting via
 * copy-paste.
 *
 * NOTE: `seoHubsPlugin.ts` keeps its own broader `SECTOR_EMOJI` map (different
 * key universe / emoji choices for the canton "settori" hub) — that one is a
 * separate concern and is intentionally not unified here.
 */
export const SECTOR_HUB_EMOJI: Record<SectorHubKey, string> = {
  infermieri: '🩺',
  'case-anziani': '👵',
  educatori: '🎓',
  ingegneri: '⚙️',
  autisti: '🚚',
  sviluppatori: '💻',
  ristorazione: '🍽️',
  oss: '🧑‍⚕️',
  logistica: '📦',
  apprendistato: '🛠️',
  medici: '🩺',
  fisioterapisti: '🧑‍⚕️',
  farmacisti: '💊',
  'data-scientist': '📊',
  cybersecurity: '🔒',
  'project-manager': '📋',
  contabili: '🧮',
  banca: '🏦',
  assicurazioni: '🛡️',
  consulenza: '💼',
  avvocati: '⚖️',
  'risorse-umane': '👥',
  marketing: '📣',
  vendite: '🤝',
  commercio: '🛍️',
  trasporti: '🚆',
  magazzino: '🏭',
  meccanici: '🔧',
  elettricisti: '⚡',
  idraulici: '🚰',
  edilizia: '🏗️',
  falegnami: '🪚',
  industria: '🏭',
  orologeria: '⌚',
  farmaceutica: '🧪',
  chimica: '⚗️',
  food: '🥫',
  cuochi: '👨‍🍳',
  camerieri: '🍷',
  hotel: '🏨',
  pulizie: '🧹',
  sicurezza: '🛡️',
  scuola: '🏫',
  designer: '🎨',
  architetti: '📐',
  agricoltura: '🌱',
  energia: '🔋',
  media: '📰',
  tecnici: '🔌',
};

/** Sector-hub emoji with a neutral compass fallback for unknown keys. */
export function sectorHubEmojiFor(key: SectorHubKey | string): string {
  return SECTOR_HUB_EMOJI[key as SectorHubKey] ?? '🧭';
}
