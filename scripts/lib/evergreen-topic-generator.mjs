/**
 * evergreen-topic-generator.mjs — programmatic evergreen keyword candidates.
 *
 * Structural fix (2026-07-18) for PRIORITY_EVERGREEN_TOPICS /
 * buildDynamicEvergreenTopics() in create-article.mjs repeatedly saturating
 * against the published corpus: those are hand-written batches (added
 * 2026-07-01 #3138, 2026-07-08, 2026-07-17 — roughly weekly) that re-exhaust
 * as the corpus grows. Instead of another hand batch, this derives
 * candidates from two canonical datasets that are already far larger than
 * anything hand-listed so far:
 *  - PROFESSION_TAXONOMY (70+ professions) — only ~13 are named in the
 *    hand-written pool.
 *  - MUNICIPALITIES (518 Italian border comuni) — only 5 are named.
 *
 * Output shape matches PRIORITY_EVERGREEN_TOPICS ({keyword, angle}) so it
 * can be spread straight into the existing topicPool — candidates flow
 * through the existing preFlightEvergreenCheck / evergreenRejectedTracker
 * machinery unchanged (see create-article.mjs Fase 2).
 */
import { PROFESSION_TAXONOMY } from './profession-taxonomy.mjs';
// These two are the article generator's last tie to site data, and the reason
// four site datasets sit in its transitive closure (#4974 item 3). They are
// site core — 20+ and 25+ consumers respectively — so they cannot move to the
// articles repo, and duplicating them would drift.
//
// The way out is that only the RESULT needs to travel: buildComuneEvergreenTopics
// prefers public/evergreen-comune-topics.json when it is present, and never
// touches these. The imports stay for the fallback path, and to keep this repo's
// own callers working; they come out when the generator actually moves, at which
// point the published file is the only source.
import { MUNICIPALITIES } from '../../data/municipalities.ts';
import { borderCrossings } from '../../data/borderCrossings.ts';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLISHED_TOPICS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../public/evergreen-comune-topics.json',
);

/**
 * The precomputed topics, if they have been published. Returns null when the
 * file is absent or unusable, so the caller falls back to computing them.
 * @returns {Array<{keyword: string, angle: string}> | null}
 */
function readPublishedComuneTopics() {
  try {
    if (!fs.existsSync(PUBLISHED_TOPICS)) return null;
    const parsed = JSON.parse(fs.readFileSync(PUBLISHED_TOPICS, 'utf-8'));
    const topics = parsed?.topics;
    // A short list means the file is truncated or the datasets collapsed;
    // computing is better than publishing a silently narrowed pool.
    if (!Array.isArray(topics) || topics.length < 100) return null;
    return topics;
  } catch {
    return null;
  }
}
// From the leaf, not events-utils: this is the only thing needed from there,
// and going through the big module would pull data/canton-url-slugs.json into
// the article generator's transitive closure for no reason (#4974 item 3).
import { haversineKm } from './haversine.mjs';

/** "Pittore / imbianchino" → "pittore"; "Operatore socio sanitario (OSS)" → "operatore socio sanitario". */
function cleanProfessionLabel(label) {
  return String(label || '')
    .split('/')[0]
    .replace(/\s*\([^)]*\)\s*$/, '')
    .trim()
    .toLowerCase();
}

export function buildProfessionEvergreenTopics(taxonomy = PROFESSION_TAXONOMY) {
  const out = [];
  const seen = new Set();
  for (const prof of taxonomy) {
    const label = cleanProfessionLabel(prof?.label);
    if (!label || seen.has(label)) continue;
    seen.add(label);
    out.push({
      keyword: `frontaliere ${label} ticino stipendio requisiti`,
      angle: `Lavorare come ${label} in Ticino da frontaliere: stipendio medio, requisiti, eventuale riconoscimento del titolo di studio, permesso G.`,
    });
    out.push({
      keyword: `quanto guadagna un ${label} frontaliere in ticino`,
      angle: `Stipendio reale di un ${label} frontaliere in Ticino: fascia salariale, differenze rispetto all'Italia, fattori che incidono sulla retribuzione.`,
    });
  }
  return out;
}

// Italian border provinces mapped to the Swiss canton their frontalieri
// commute into. Only unambiguous province→canton pairs — an entire Italian
// province doesn't reliably tell you which single Swiss canton its
// frontalieri commute into, so this list is intentionally short.
const PROVINCE_CANTON = {
  CO: 'Ticino', VA: 'Ticino', VB: 'Ticino',
  SO: 'Grigioni',
  AO: 'Vallese', VC: 'Vallese',
};

// The remaining 5 provinces (MB/BG/BS/TN/BZ, 35 comuni) sit on the official
// ti.ch frontier list too, but province alone can't resolve their canton —
// unlike CO/VA/VB/SO/AO/VC above, none of these provinces is unambiguously
// tied to one canton. Instead of guessing, each comune is geo-resolved
// individually against data/borderCrossings.ts (real official IT-CH border
// crossings, each already tagged with its actual Swiss `canton`): find the
// nearest crossing via haversine and accept the match only if it's both
// close enough to be a plausible commute AND clearly closer than the
// nearest crossing of a *different* canton.
//
// Important dataset limitation: borderCrossings.ts only carries Ticino (27
// crossings) and one Vallese crossing (Sempione/Iselle-Gondo) — it has zero
// Grigioni entries. That means this fallback can only ever confidently
// resolve a comune to Ticino or Vallese, never Grigioni, no matter how
// close a comune actually sits to the real Graubünden border. Concretely,
// this resolves all 9 Monza e Brianza (MB) comuni to Ticino (17.7-21.1km
// from a real crossing, ~80km+ clear of the nearest Vallese one — the
// Brianza plain immediately south of the Chiasso/Mendrisio corridor). It
// does NOT resolve any of the 26 BG/BS/TN/BZ comuni: every one of them is
// 76-206km from the nearest crossing in this dataset (Val di Scalve, Val
// Camonica, Val di Sole and Alta Val Venosta are nowhere near a Ticino or
// Vallese crossing), even though some — Alta Val Venosta comuni like Tubre
// in particular — plausibly border Graubünden in reality. Without a
// canton-tagged crossing for that border segment there's no data-driven way
// to confirm it here, so per the same "exclude rather than risk a wrong
// claim" rule as above, they stay unmapped. A future PR that adds Grigioni
// crossings to borderCrossings.ts could revisit this.
const GEO_RESOLVE_MAX_KM = 30; // MB's farthest comune is 21.1km; BG/BS/TN/BZ's nearest is 76km — huge margin either side of this cutoff.
const GEO_RESOLVE_MIN_MARGIN_KM = 20; // nearest different-canton crossing must be at least this much farther, or the comune is treated as ambiguous.

const CANTON_CODE_TO_NAME = { TI: 'Ticino', GR: 'Grigioni', VS: 'Vallese' };

/**
 * Resolve a comune to a canton by proximity to the nearest tagged border
 * crossing. Returns null when there's no crossing within commuting range, or
 * when the nearest crossing of a different canton is too close to call.
 */
function resolveCantonByBorderProximity(m, crossings = borderCrossings) {
  if (typeof m?.lat !== 'number' || typeof m?.lng !== 'number') return null;
  const distances = crossings
    .map((c) => ({ canton: c.canton, km: haversineKm(m.lat, m.lng, c.lat, c.lng) }))
    .sort((a, b) => a.km - b.km);
  const nearest = distances[0];
  if (!nearest || nearest.km > GEO_RESOLVE_MAX_KM) return null;
  const nearestOtherCanton = distances.find((d) => d.canton !== nearest.canton);
  if (nearestOtherCanton && nearestOtherCanton.km - nearest.km < GEO_RESOLVE_MIN_MARGIN_KM) return null;
  return CANTON_CODE_TO_NAME[nearest.canton] ?? null;
}

/** Canton for a comune: unambiguous province mapping first, then geo fallback. */
export function resolveComuneCanton(m) {
  return PROVINCE_CANTON[m?.province] ?? resolveCantonByBorderProximity(m);
}

// NB: the 9 MB comuni now resolve into the Ticino bucket above, but their
// distanceKm (19-22km) is farther than the closest ~40 CO/VA/VB comuni
// (which run 0-4km), so under today's cap they don't currently place in the
// output — same distance-based prioritization every other comune goes
// through, not a regression specific to MB. They'll surface automatically
// if the cap ever grows or the closer comuni get exhausted upstream.
const COMUNE_CAP_PER_CANTON = { Ticino: 40, Grigioni: 25, Vallese: 20 };

export function buildComuneEvergreenTopics(municipalities) {
  // Published file first, and only when the caller did not pass its own data —
  // an explicit argument means someone is testing a specific dataset and must
  // get an answer derived from it, not a cached one.
  if (municipalities === undefined) {
    const published = readPublishedComuneTopics();
    if (published) return published;
    municipalities = MUNICIPALITIES;
  }
  const byCanton = new Map();
  for (const m of municipalities) {
    const canton = resolveComuneCanton(m);
    if (!canton || !m?.name) continue;
    if (!byCanton.has(canton)) byCanton.set(canton, []);
    byCanton.get(canton).push(m);
  }

  const out = [];
  for (const [canton, list] of byCanton) {
    const cap = COMUNE_CAP_PER_CANTON[canton] ?? 20;
    // Closest comuni first — nearest to the border correlates with the
    // largest frontaliere population and therefore real search intent.
    const picked = [...list].sort((a, b) => a.distanceKm - b.distanceKm).slice(0, cap);
    for (const m of picked) {
      out.push({
        keyword: `vivere a ${m.name} e lavorare in ${canton} da frontaliere`,
        angle: `Pendolarismo ${m.name}-${canton} per frontalieri: collegamenti, tempi di percorrenza, costo della vita, zone consigliate.`,
      });
      out.push({
        keyword: `trasferirsi a ${m.name} da frontaliere pro e contro`,
        angle: `Vivere a ${m.name} lavorando in ${canton} da frontaliere: vantaggi, svantaggi, tempi di spostamento, cosa considerare prima di trasferirsi.`,
      });
    }
  }
  return out;
}

export function buildStructuralEvergreenTopics() {
  return [...buildProfessionEvergreenTopics(), ...buildComuneEvergreenTopics()];
}
