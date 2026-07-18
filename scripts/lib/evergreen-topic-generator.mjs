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
import { MUNICIPALITIES } from '../../data/municipalities.ts';

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
// commute into. Only unambiguous province→canton pairs — MB/BG/BS/TN/BZ
// comuni sit on the official ti.ch frontier list too, but their nearest CH
// canton isn't inferable from province alone, so they're deliberately left
// out rather than risk a wrong "lavora in <canton>" claim.
const PROVINCE_CANTON = {
  CO: 'Ticino', VA: 'Ticino', VB: 'Ticino',
  SO: 'Grigioni',
  AO: 'Vallese', VC: 'Vallese',
};

const COMUNE_CAP_PER_CANTON = { Ticino: 40, Grigioni: 25, Vallese: 20 };

export function buildComuneEvergreenTopics(municipalities = MUNICIPALITIES) {
  const byCanton = new Map();
  for (const m of municipalities) {
    const canton = PROVINCE_CANTON[m?.province];
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
