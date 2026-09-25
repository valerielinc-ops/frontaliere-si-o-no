/**
 * Sector-hub cross-linking topology — single source of truth for the two
 * internal-link improvements that wire the 49 sector hubs into the BFS graph:
 *
 *  1. {@link TOP_DEMAND_SECTORS} — the highest-demand sector hubs that get an
 *     anchor on the 4 job-board root hubs (`sectorHubLinksPlugin`). Today the
 *     root hub links the sector INDEX once but none of the 49 sector-hub
 *     canonicals, so ~37 of them are orphaned (live HTTP 200 but ~0 internal
 *     links → no GSC impressions). This list surfaces the strongest clusters
 *     directly on the hub.
 *
 *  2. {@link SECTOR_HUB_SIBLINGS} — per-sector sibling map so each hub page
 *     links its 3-5 nearest siblings (`jobSectorPagesPlugin` rail). Keeps the
 *     verticals mutually reachable (healthcare ↔ healthcare, trades ↔ trades),
 *     spreading authority from the 3 winners (infermieri / case-anziani /
 *     educatori = 582 clicks/28d) to their orphaned neighbours.
 *
 * Demand ranking is derived from the 2026-06 GSC + GA4 data pack:
 *  - GA4 internalSearchTerms: infermiere, autista, assistente sociale,
 *    ingegnere, educatore, contabile, logopedista.
 *  - GSC orphan-query clusters: case-anziani, educatori, nurses/infermiers/
 *    pflegepersonal, ristorazione, sviluppatori/entwickler/developers,
 *    autisti/fahrer/chauffeurs, ingegneri, logistica, architetti,
 *    fisioterapisti, medici (IT/DE/FR/EN).
 *
 * Both structures are keyed on {@link SectorHubKey}, so every entry is a real
 * hub that {@link buildSectorHubPath} can resolve to a trailing-slash URL in
 * any of the 4 locales — labels come from SECTOR_HUB_DISPLAY. No new pages are
 * created: this only adds internal links to pages that already exist in
 * `sitemap-sector.xml`.
 */

import type { SectorHubKey } from '../jobSectorLanding';

/**
 * The ~15 highest-demand sector hubs, ordered by aggregate GSC/GA4 demand
 * (healthcare + trades + education + engineering clusters lead). Rendered on
 * the 4 job-board root hubs so the strongest orphans get a depth-2 internal
 * link from the homepage's most-crawled page.
 */
export const TOP_DEMAND_SECTORS: readonly SectorHubKey[] = [
  'infermieri', // nurses — 252 clicks/28d, GA4 search "infermiere" ×360
  'case-anziani', // elderly care — 213 clicks/28d, pos 6.6
  'educatori', // educators — 117 clicks/28d, GA4 "educatore ticino" ×141
  'oss', // healthcare assistants — healthcare cluster
  'medici', // doctors — healthcare cluster
  'fisioterapisti', // physiotherapists — GSC orphan cluster
  'ingegneri', // engineers — GA4 "ingegnere" ×183
  'sviluppatori', // developers — GSC entwickler/developers cluster
  'autisti', // drivers — GA4 "autista" ×214
  'ristorazione', // restaurants — GSC ristorazione cluster
  'logistica', // logistics — GSC logistica cluster
  'contabili', // accountants — GA4 "contabile" ×128
  'elettricisti', // electricians — trades cluster
  'edilizia', // construction — trades cluster
  'architetti', // architects — GSC architetti cluster
] as const;

/**
 * Per-sector sibling map for the on-page rail. Each entry lists 3-5 sectors
 * in the same vertical so a visitor (and crawler) on one hub can reach its
 * nearest neighbours. Only the curated, high-demand hubs are mapped; sectors
 * without an explicit entry fall back to no rail (the caller renders nothing),
 * which keeps the long tail from emitting weak/irrelevant cross-links.
 */
export const SECTOR_HUB_SIBLINGS: Partial<Record<SectorHubKey, readonly SectorHubKey[]>> = {
  // ── Healthcare cluster ───────────────────────────────────────────────
  infermieri: ['case-anziani', 'oss', 'medici', 'fisioterapisti'],
  'case-anziani': ['infermieri', 'oss', 'medici', 'fisioterapisti'],
  oss: ['infermieri', 'case-anziani', 'medici', 'fisioterapisti'],
  medici: ['infermieri', 'fisioterapisti', 'oss', 'farmacisti'],
  fisioterapisti: ['infermieri', 'medici', 'oss', 'case-anziani'],
  farmacisti: ['medici', 'infermieri', 'chimica', 'farmaceutica'],

  // ── Education / social cluster ───────────────────────────────────────
  educatori: ['scuola', 'oss', 'infermieri'],
  scuola: ['educatori', 'oss'],

  // ── Engineering / tech cluster ───────────────────────────────────────
  ingegneri: ['sviluppatori', 'architetti', 'tecnici', 'data-scientist'],
  sviluppatori: ['ingegneri', 'data-scientist', 'cybersecurity', 'project-manager'],
  'data-scientist': ['sviluppatori', 'ingegneri', 'cybersecurity'],
  cybersecurity: ['sviluppatori', 'data-scientist', 'ingegneri'],
  'project-manager': ['sviluppatori', 'ingegneri', 'consulenza'],
  tecnici: ['ingegneri', 'meccanici', 'elettricisti'],
  architetti: ['ingegneri', 'edilizia', 'designer'],

  // ── Trades / building cluster ────────────────────────────────────────
  elettricisti: ['idraulici', 'meccanici', 'edilizia', 'tecnici'],
  idraulici: ['elettricisti', 'edilizia', 'meccanici'],
  meccanici: ['elettricisti', 'tecnici', 'industria'],
  edilizia: ['idraulici', 'elettricisti', 'falegnami', 'architetti'],
  falegnami: ['edilizia', 'meccanici'],
  industria: ['meccanici', 'magazzino', 'logistica'],

  // ── Transport / logistics cluster ────────────────────────────────────
  autisti: ['logistica', 'trasporti', 'magazzino'],
  logistica: ['autisti', 'trasporti', 'magazzino'],
  trasporti: ['autisti', 'logistica', 'magazzino'],
  magazzino: ['logistica', 'trasporti', 'autisti'],

  // ── Hospitality / food cluster ───────────────────────────────────────
  ristorazione: ['cuochi', 'camerieri', 'hotel'],
  cuochi: ['ristorazione', 'camerieri', 'hotel'],
  camerieri: ['ristorazione', 'cuochi', 'hotel'],
  hotel: ['ristorazione', 'camerieri', 'pulizie'],

  // ── Business / finance cluster ───────────────────────────────────────
  contabili: ['banca', 'consulenza', 'assicurazioni'],
  banca: ['contabili', 'assicurazioni', 'consulenza'],
  assicurazioni: ['banca', 'contabili', 'consulenza'],
  consulenza: ['contabili', 'banca', 'project-manager'],
};
