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
    // computing is better than reading a silently narrowed pool.
    //
    // The floor tracks the real value or it stops being a guard. It was 50,
    // set when the published file held 85 — about 59% of real, a sane
    // tripwire. The commute-radius change took the file to 437, which left
    // that same 50 covering 11%: the file could lose 89% of its content and
    // still be accepted. Concretely, a revert of the published file to its
    // old 85 entries — the exact starvation this is meant to catch — would
    // have passed. 300 restores roughly the original ratio.
    //
    // Keep this in step with the twin floors in
    // scripts/build-evergreen-comune-topics.mjs (which refuses to WRITE a
    // short file) and tests/evergreen-comune-topics-published.test.ts.
    if (!Array.isArray(topics) || topics.length < 300) return null;
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

// One candidate per profession, not two: "stipendio requisiti" and "quanto
// guadagna" used to ship as separate near-duplicate keywords with
// overlapping angles (#5563) — the pool declared double what it could
// actually turn into distinct articles. The angle below folds both framings
// (requirements AND actual pay) into the one candidate that survives.
export function buildProfessionEvergreenTopics(taxonomy = PROFESSION_TAXONOMY) {
  const out = [];
  const seen = new Set();
  for (const prof of taxonomy) {
    const label = cleanProfessionLabel(prof?.label);
    if (!label || seen.has(label)) continue;
    seen.add(label);
    out.push({
      keyword: `frontaliere ${label} ticino stipendio requisiti`,
      angle: `Lavorare come ${label} in Ticino da frontaliere: quanto si guadagna realmente (fascia salariale, differenze rispetto all'Italia), requisiti, eventuale riconoscimento del titolo di studio, permesso G.`,
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
// This resolves all 9 Monza e Brianza (MB) comuni to Ticino (17.7-21.1km from
// a real crossing, ~80km+ clear of the nearest Vallese one — the Brianza plain
// immediately south of the Chiasso/Mendrisio corridor), and 25 of the 26
// BG/BS/TN/BZ comuni to Grigioni. Only Rabbi (TN) stays unresolved.
//
// This paragraph used to say the opposite — that borderCrossings.ts "only
// carries Ticino (27 crossings) and one Vallese crossing … zero Grigioni
// entries", and therefore "does NOT resolve any of the 26 BG/BS/TN/BZ comuni".
// That went stale and was believed for a while, on both copies of this file.
// Measured 2026-08-18 on both: 143 crossings across 13 cantons, including 9
// Grigioni (Umbrail, Munt La Schera, Martina-Nauders, Samnaun-Spiss, Forcola
// di Livigno among them), and the 25/26 above.
//
// Worth knowing WHY it survived: the site has a test asserting the correct
// behaviour (`tests/evergreen-topic-generator.test.ts`), and this repo does
// not. A comment can only go stale unnoticed on the side where nothing
// executes the claim — which is the same blind spot the loop drift check has,
// since it compares files one by one and cannot see a test missing from one
// side.
const GEO_RESOLVE_MAX_KM = 30; // MB's farthest comune is 21.1km. NB: this is haversine-to-crossing, a different measurement from the dataset's own `distanceKm` used further down — see COMUNE_MAX_DISTANCE_KM.
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

// The selection bar is a COMMUTE RADIUS, not a per-canton head count.
//
// It used to be `{ Ticino: 40, Grigioni: 25, Vallese: 20 }` = 85 comuni, while
// the dataset resolves 506 of its 518 rows to a canton (Ticino 343, Grigioni
// 99, Vallese 64 — the same on both copies since #211 was ported to the site;
// see the note under the table). That left 421 comuni unused, and the
// resulting pool was too small to keep the `frontaliere` section fed: with
// the profession half also
// halved by #5563, `buildStructuralEvergreenTopics()` fell 310 → 155 in
// 7045b166 (2026-08-14), the runtime pool went 537 → 382, and the section
// saturated outright — `EVERGREEN_POOL_OUTCOME saturated=1 pool=382
// checked=382 status=skipped`, 32 dispatch out of 32, zero free keywords,
// against `svizzera`'s `saturated=0 pool=610 status=generated` 8 out of 8.
//
// A head count was the wrong instrument for what the sort below is actually
// doing. The list is ordered by distance because distance is the proxy for
// search intent, so a count cap IS a distance cap — just an implicit one whose
// threshold is different in every canton and drifts whenever the dataset
// changes. At 40/25/20 the bar sat at ~5km in Ticino but ~20km in Vallese:
// the same keyword quality was being accepted and rejected at four times the
// distance depending only on how many comuni happened to share its canton.
// Stating the radius directly makes the bar uniform and dataset-stable.
//
// 30km is borrowed, not invented: GEO_RESOLVE_MAX_KM above is this file's
// already-committed answer to "close enough to be a plausible commute", and
// starting from the same number rather than a fresh guess is the point.
//
// But the two are NOT the same measurement, and the difference is bigger than
// it looks. GEO_RESOLVE_MAX_KM is haversine to the nearest tagged crossing;
// this one is the dataset's own `distanceKm`. They match on the MB comuni
// (17.7-21.1km haversine vs 19-22km `distanceKm`) — which is where the
// agreement was first checked — but that sample is not representative.
// Measured across all 506 resolved comuni on the corpus copy: median gap
// -1.1km, range -20.8 to +20.9km; and in the 25-35km band that this cutoff
// actually decides, median -4.5km with a floor of -20.5km. Swapping one metric
// for the other would move 37 of the 506 across the line — Civo
// (`distanceKm` 41, haversine 20), Val Masino (34 vs 13), Curon Venosta
// (31 vs 11): Valtellina and Val Venosta comuni where the road out of the
// valley is nothing like the straight line to a crossing.
//
// `distanceKm` is the right one HERE: it is the field the sort has always
// used, and road distance is what a commuter actually pays. Haversine is the
// right one THERE: canton attribution is a question about which border you
// are near, not how long the drive is. Don't unify them on the strength of
// their sharing a number today.
//
// They are deliberately kept as SEPARATE constants, and must stay that way:
// they answer different questions and are allowed to diverge. GEO_RESOLVE_MAX_KM
// decides WHICH CANTON a comune belongs to; raising it re-labels comuni and
// changes `resolveComuneCanton` for everything downstream. COMUNE_MAX_DISTANCE_KM
// only decides which already-labelled comuni are worth a keyword, and the table
// below is an explicit plan to raise IT alone. Merging them into one constant
// would silently turn each widening step into a canton-resolution change — a far
// larger blast radius than the widening intends.
//
// Measured 2026-08-18, and now the same on both copies — comuni selected per
// canton, and the resulting structural pool including the 70 professions:
//
//     radius   Ticino  Grigioni  Vallese   comuni   structural pool
//      20km     251       50       27       328          398
//      25km     309       65       31       405          475
//   →  30km     326       75       36       437          507
//      35km     342       83       41       466          536
//      40km     343       95       46       484          554
//     no cap    343       99       64       506          576
//
// So this moves the structural pool 155 → 507 and the runtime pool 382 → 734,
// well past the 537 the section had before the collapse.
//
// This file is `mode: identical` and ships to both repos. The datasets it
// reads — municipalities.ts, borderCrossings.ts — are NOT manifest-governed,
// so they can drift without anything noticing, and they had: the site was
// missing the #211 SO→LC province fix, and the same radius gave 446 comuni
// there against 437 here.
//
// That gap was not cosmetic. The 25 mislabelled rows are Lecco-shore comuni
// that `PROVINCE_CANTON` sent to Grigioni, an unreachable commute; under the
// old count cap only 3 of them reached the pool, and widening the radius took
// that to 23 published keywords of the form "vivere a <Lecco comune> e
// lavorare in Grigioni da frontaliere". The cap had been hiding the defect
// rather than containing it. #211 was ported to the site in the same change
// that widened the radius, so both sides now select the same 437.
//
// Why 30km and not "take all 506": the last 69 comuni are the ones with the
// least plausible search intent. They split Vallese 28 / Grigioni 24 /
// Ticino 17 — a Vallese plurality, not a Vallese monopoly — and the extreme
// cases are Gaby (59km, 405 residents), Rassa (54km, 68 residents),
// Piode (53km, 188), Campertogno (50km, 231). A keyword like "vivere a Rassa e lavorare in
// Vallese da frontaliere" addresses a 68-person alpine comune an hour and a
// half from the border; publishing it costs a generation slot and returns
// nothing. Spending the whole dataset at once would also leave no graduated
// next step: keeping the tail in reserve means the table above is the
// widening plan when this pool saturates again, one measured number at a time.
const COMUNE_MAX_DISTANCE_KM = 30;

// NB: the 9 MB comuni (distanceKm 19-22km) now DO place in the output — under
// the old count cap they were crowded out by the closest ~40 CO/VA/VB comuni
// (which run 0-4km), and the note here used to say they would surface "if the
// cap ever grows". This is that growth.

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
    // Within commuting range only — nearest to the border correlates with the
    // largest frontaliere population and therefore real search intent. Still
    // sorted closest-first so the pool's rotation order stays stable and the
    // strongest keywords are reached first; a comune with no usable
    // distanceKm is dropped rather than sorted as if it were at the border.
    const picked = [...list]
      .filter((m) => typeof m.distanceKm === 'number' && m.distanceKm <= COMUNE_MAX_DISTANCE_KM)
      .sort((a, b) => a.distanceKm - b.distanceKm);
    for (const m of picked) {
      // One candidate per comune, not two: "vivere a / lavorare in" and
      // "trasferirsi ... pro e contro" used to ship as separate near-duplicate
      // keywords whose angles overlapped (commute mechanics vs relocation
      // pro/cons, #5563) — the pool declared double what it could actually
      // turn into distinct articles. The angle below folds both framings
      // into the one candidate that survives.
      out.push({
        keyword: `vivere a ${m.name} e lavorare in ${canton} da frontaliere`,
        angle: `Vivere a ${m.name} e lavorare in ${canton} da frontaliere: collegamenti, tempi di percorrenza, costo della vita, zone consigliate, vantaggi e svantaggi del trasferimento, cosa considerare prima di trasferirsi.`,
      });
    }
  }
  return out;
}

export function buildStructuralEvergreenTopics() {
  return [...buildProfessionEvergreenTopics(), ...buildComuneEvergreenTopics()];
}
