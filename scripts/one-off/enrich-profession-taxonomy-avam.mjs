/**
 * enrich-profession-taxonomy-avam.mjs — one-off/rarely-rerun tool.
 *
 * Downloads SECO's public AVAM-Berufsliste (CH-ISCO-19 occupation codes,
 * gendered DE/FR/IT job titles — used by the Job-Room job-posting API,
 * https://job-room.ch) and diffs it against the hand-curated
 * PROFESSION_TAXONOMY in scripts/lib/profession-taxonomy.mjs, printing
 * candidate new aliases per entry for manual review.
 *
 * NOT wired into any build step — offline enrichment only, per the
 * discovery finding that ESCO/AVAM alt-labels can shift matchProfession's
 * longest-alias-wins tie-break, so every proposed alias needs a human
 * (or an agent standing in for one) to sanity-check before merging.
 *
 * Usage: node scripts/one-off/enrich-profession-taxonomy-avam.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PROFESSION_TAXONOMY,
  normalizeText,
  stemToken,
} from '../lib/profession-taxonomy.mjs';

/**
 * Anchor-only matcher, deliberately NOT the production matchProfession.
 * matchProfession's single-word branch has a "typing-prefix tolerance" rule
 * (token.length>=5 && aliasStem.startsWith(tokenStem)) built for on-site
 * search-as-you-type, where the alias is assumed complete and the token a
 * truncated prefix. Anchoring a bulk corpus of complete words against it
 * instead reinterprets "two different words that happen to share a short
 * prefix" as a match — e.g. "media" (stem "medi") vs "medico" (stem "medic")
 * — since both look identical to the algorithm when every input word is
 * already complete. Confirmed live: matchProfession("Manager dei media")
 * and matchProfession("Interactive Media Designer") both resolve to
 * "medico". Corpus-anchoring only needs exact-stem or full multi-word
 * matches (already specific/safe — every word of a multi-word alias must be
 * present), so this variant drops the fuzzy branch rather than touching the
 * production rule, which is live in JobBoard search (services/professionSynonyms.ts)
 * and out of scope for a taxonomy-content PR.
 */
function strictMatchProfession(text) {
  const norm = normalizeText(text);
  if (!norm) return null;
  const tokens = norm.split(' ').filter((t) => t.length >= 2);
  if (tokens.length === 0) return null;
  const stems = tokens.map(stemToken);
  let best = null;
  for (const entry of PROFESSION_TAXONOMY) {
    for (const alias of entry.aliases) {
      let matched;
      if (alias.includes(' ')) {
        const words = alias.split(' ');
        matched = words.every((w) => stems.includes(stemToken(w)));
      } else {
        matched = stems.includes(stemToken(alias));
      }
      if (matched && (!best || alias.length > best.aliasLength)) {
        best = { id: entry.id, aliasLength: alias.length };
      }
    }
  }
  return best ? best.id : null;
}

const AVAM_URL =
  'https://test-api.job-room.ch/api-docs/jobAdvertisements/v1/SECO_AVAM_JobsAPI_OccupationCodes_2025_2026.xlsx';
const SHEET_NAME_PREFIX = 'AVAM-Berufsliste_'; // current list sheet, excludes _MP_/_NEU/_GEÄNDERT/_GELÖSCHT/_Mapping variants
const HEADER_ROW = 4;

function downloadAndExtract() {
  const dir = mkdtempSync(join(tmpdir(), 'avam-'));
  const xlsxPath = join(dir, 'avam.xlsx');
  execFileSync('curl', ['-sL', '-o', xlsxPath, AVAM_URL]);
  execFileSync('unzip', ['-q', xlsxPath, '-d', dir]);
  return dir;
}

function loadSharedStrings(dir) {
  const raw = readFileSync(join(dir, 'xl', 'sharedStrings.xml'), 'utf8');
  return raw
    .split('<si>')
    .slice(1)
    .map((block) =>
      [...block.split('</si>')[0].matchAll(/<t[^>]*>([^<]*)<\/t>/g)]
        .map((m) => m[1])
        .join(''),
    );
}

function pickMainSheetFile(dir) {
  const workbook = readFileSync(join(dir, 'xl', 'workbook.xml'), 'utf8');
  const sheets = [...workbook.matchAll(/<sheet name="([^"]+)"[^/]*r:id="(rId\d+)"/g)];
  const main = sheets.find(
    ([, name]) =>
      name.includes(SHEET_NAME_PREFIX) &&
      !name.includes('_MP_') &&
      !name.includes('_NEU') &&
      !name.includes('GEÄNDERT') &&
      !name.includes('GELÖSCHT'),
  );
  if (!main) throw new Error('AVAM main sheet not found — SECO workbook layout changed, re-inspect manually');
  const rels = readFileSync(join(dir, 'xl', '_rels', 'workbook.xml.rels'), 'utf8');
  const relMatch = rels.match(new RegExp(`Id="${main[2]}"[^>]*Target="worksheets/(sheet\\d+\\.xml)"`));
  if (!relMatch) throw new Error(`No worksheet file mapped for ${main[2]}`);
  return join(dir, 'xl', 'worksheets', relMatch[1]);
}

/** Parse AVAM rows into {code, groupDE/FR/IT, mDE/FR/IT, wDE/FR/IT}. */
function parseRows(sheetPath, sst) {
  const xml = readFileSync(sheetPath, 'utf8');
  const rows = [...xml.matchAll(/<row[^>]*r="(\d+)"[^>]*>(.*?)<\/row>/gs)].filter(
    (r) => Number(r[1]) > HEADER_ROW,
  );
  const cellVal = (rowXml, col) => {
    // Capture the full attribute string (order varies: r, s=style, t=type)
    // and check `t="s"` in JS rather than positionally in the regex — a
    // greedy `[^>]*` before an optional `t="s"` group never backtracks
    // into matching it since skipping the optional group already satisfies
    // the pattern, silently losing the shared-string flag.
    const m = rowXml.match(new RegExp(`<c r="${col}\\d+"([^>]*)>(?:<v>([^<]*)</v>)?`));
    if (!m || m[2] === undefined) return '';
    return m[1].includes('t="s"') ? sst[Number(m[2])] || '' : m[2];
  };
  return rows.map(([, , rowXml]) => ({
    code: cellVal(rowXml, 'B'),
    groupDE: cellVal(rowXml, 'C'),
    groupFR: cellVal(rowXml, 'D'),
    groupIT: cellVal(rowXml, 'E'),
    mDE: cellVal(rowXml, 'F'),
    mFR: cellVal(rowXml, 'G'),
    mIT: cellVal(rowXml, 'H'),
    wDE: cellVal(rowXml, 'I'),
    wFR: cellVal(rowXml, 'J'),
    wIT: cellVal(rowXml, 'K'),
  }));
}

/** Every DE/FR/IT masc+fem title text on a row, deduped, non-empty. */
function rowTitles(row) {
  return [...new Set([row.mDE, row.mFR, row.mIT, row.wDE, row.wFR, row.wIT].filter(Boolean))];
}

function main() {
  const dir = downloadAndExtract();
  try {
    const sst = loadSharedStrings(dir);
    const sheetPath = pickMainSheetFile(dir);
    const avamRows = parseRows(sheetPath, sst);
    console.log(`Parsed ${avamRows.length} AVAM rows.`);

    // Anchor via strictMatchProfession (see above): if it resolves one of a
    // row's 6 gendered DE/FR/IT title wordforms to entry X, the row's OTHER
    // wordforms are guaranteed same-occupation siblings (AVAM rows are one
    // specific job title × 3 languages × 2 genders) — safe candidates for
    // entry X's alias list. Deliberately NOT widening to other rows sharing
    // the same broader CH-ISCO code: that grouping is occupation-*category*,
    // not occupation-identity, and produced wildly unrelated false positives
    // (e.g. roofers/acousticians under "infermiere") when tried.
    const candidatesById = new Map();
    for (const row of avamRows) {
      const titles = rowTitles(row);
      const matchedId = titles.map((t) => strictMatchProfession(t)).find(Boolean);
      if (!matchedId) continue;
      if (!candidatesById.has(matchedId)) candidatesById.set(matchedId, new Set());
      const set = candidatesById.get(matchedId);
      for (const t of titles) {
        const norm = normalizeText(t);
        if (norm) set.add(norm);
      }
    }

    // Single-word aliases match via substring/stem-containment (any token
    // of the query, anywhere in a title, matches — see tokenMatchesAlias),
    // so a short generic alias an entry already has (e.g. "docente",
    // "ingegnere", "meccanico") already catches every compound title that
    // contains that word — "docente di educazione fisica e sport" adds
    // nothing new once "docente" is aliased. That inflated entries like
    // docente/ingegnere/meccanico/consulente-clientela/impiegato into
    // hundreds of redundant candidates (every specialization sharing the
    // root word). The only candidates worth adding are strings that DON'T
    // already resolve under the entry's pre-enrichment aliases — genuinely
    // new spelling/language wordforms (or a different entry entirely,
    // which is a real collision, excluded rather than silently added).
    //
    // DE/FR trade nomenclature productively compounds a craft word with a
    // seniority morpheme (Meister, Polier, Vorarbeiter, Leiter, Chef-,
    // contremaître, maître) to name the SUPERVISOR/master-qualification
    // role, not the base tradesperson — "Bodenlegermeister" (master
    // flooring installer) is a different, more senior occupation than
    // "Bodenleger". Confirmed repeatedly across entries: institutional
    // directors/team-leaders under "medico", foremen (chefmonteur,
    // contremaître, Polier, Vorarbeiter) under "montatore"/"muratore",
    // department heads (bereichsleiter) under "addetto-pulizie". German
    // compounds these morphemes as suffixes/prefixes on a single fused
    // token (no space), so a whole-token marker list alone misses most of
    // them — hence the suffix/prefix check below. Deliberately no
    // exemption for entries whose own existing aliases mention "chef" (a
    // "pastry chef" / "chef de rang" is the base occupation itself; the
    // marker only means something when it's a MODIFIER on top of a
    // different craft word, so it's judged per-candidate, not per-entry).
    const SENIORITY_WORDS = [
      'leiter', 'leiterin', 'institutionsleiter', 'institutionsleiterin', 'teamleiter', 'teamleiterin',
      'betriebsleiter', 'betriebsleiterin', 'bereichsleiter', 'bereichsleiterin',
      'geschaftsfuhrer', 'geschaftsfuhrerin', 'projektleiter', 'projektleiterin',
      'direttore', 'direttrice', 'responsabile', 'coordinatore', 'coordinatrice', 'capo',
      'directeur', 'directrice', 'responsable', 'coordinateur', 'coordinatrice',
      'manager', 'koordinator', 'koordinatorin',
      'polier', 'polierin', 'vorarbeiter', 'vorarbeiterin', 'contremaitre', 'contremaitresse',
      'meister', 'meisterin', 'maitre', 'maitresse', 'chefmonteur', 'chefmonteurin',
    ];
    const SENIORITY_STEMS = new Set(SENIORITY_WORDS.map(stemToken));
    const SENIORITY_SUFFIXES = [
      'meister', 'meisterin', 'polier', 'polierin', 'vorarbeiter', 'vorarbeiterin',
      'leiter', 'leiterin', 'chefmonteur', 'chefmonteurin', 'koordinator', 'koordinatorin',
      'chef', 'chefin',
    ];
    const isSeniorityCompound = (normalizedText) =>
      normalizedText.split(' ').some(
        (w) => SENIORITY_STEMS.has(stemToken(w)) || w.startsWith('chef') || w.startsWith('capo') || SENIORITY_SUFFIXES.some((suf) => w.length > suf.length && w.endsWith(suf)),
      );

    // Confirmed-by-inspection cross-domain contamination the filters above
    // don't catch (different field entirely, not a seniority tier): dog
    // grooming under "estetista" (human beautician), horse care under
    // "custode" (building caretaker), and a handful of real-estate/business
    // titles under "informatico" traced to sparse-row parsing noise, not a
    // seniority pattern.
    const EXCLUDE_STRINGS = new Set(
      [
        'hundecoiffeur', 'hundecoiffeuse', 'toiletteur pour chiens', 'toiletteuse pour chiens',
        'gardien de chevaux', 'gardienne de chevaux', 'pferdekrankenpfleger', 'pferdekrankenpflegerin',
        'pferdewart', 'pferdewartin', 'samaritain pour chevaux', 'samaritaine pour chevaux',
        'developpeuse de business numerique', 'developpeuse immobiliere',
        'esperta in sviluppo immobiliare', 'esperto in sviluppo immobiliare',
        'immobilienentwickler', 'immobilienentwicklerin', 'sviluppatrice business digitale',
        // "storenmonteur(in)" (Swiss-German "awning/blind fitter", under
        // montatore) fuzzy-collides with the pre-existing "store manager"
        // alias on responsabile-negozio: tokenMatchesAlias's typing-prefix
        // rule lets the English token "store" (stem "stor") prefix-match
        // "storenmonteur" (stem unchanged, no trailing-vowel strip since it
        // ends in a consonant), and on the resulting length tie montatore
        // is earlier in PROFESSION_TAXONOMY so it wins — silently breaking
        // "store manager" search. Excluded rather than patching the shared
        // matcher (out of scope, see file header).
        'storenmonteur', 'storenmonteurin',
        // Same fuzzy-prefix shape: "operationspfleger"/"operationsschwester"
        // (under infermiere) share the "operation" stem with
        // tso-strumentista's pre-existing "operationstechnik" alias. Both
        // fuzzy-match the token "operation" inside tso-strumentista's own
        // "technicien en salle d operation" alias; being tied-or-longer
        // than "operationstechnik" they win the longest-alias tie-break
        // and silently reroute that query from tso-strumentista to
        // infermiere.
        'operationspfleger', 'operationsschwester',
      ].map(normalizeText),
    );

    // French "d'X" / Italian standalone "e"/"a" connectors normalize to a
    // lone 1-char word ("d'automobiles" → "d automobiles"). matchProfession
    // tokenizes the QUERY with a length>=2 floor, silently dropping that
    // word from the query's own token list, but a multi-word alias's
    // words.every() check still requires it present — so the alias can
    // never match its own literal text (self-mismatch to null), or a
    // shorter unrelated alias wins instead (self-mismatch to a wrong
    // entry). Confirmed via a full self-resolve pass over the final
    // taxonomy (every entry's own alias fed back through matchProfession
    // must return that entry's id) — every failure traced to this pattern.
    // Applies to any candidate, not just AVAM's French/Italian titles, so
    // filtered generally rather than per-string.
    const hasDeadConnectorWord = (normalizedText) => normalizedText.split(' ').some((w) => w.length === 1);

    // Entries whose bare root alias is genuinely polysemous across
    // unrelated fields (not just a seniority tier of the same field), so
    // row-anchoring pulls in majority-wrong-domain candidates: "consulente"
    // /"Berater"/"conseiller" (any kind of advisor — pulled in tuberculosis
    // advisors, marriage counsellors, agricultural advisors), "docente"'s
    // "maestro"/"Meister" (elementary teacher vs. any trade's master
    // craftsman — pulled in boat-builders, poultry farmers, glaziers),
    // "impiegato"'s "Angestellte" (any employee — pulled in pool/library/
    // funeral-home staff), "autista"'s "Führer"/"conduttore" (driver vs.
    // works supervisor — pulled in construction-site managers, dog
    // trainers), "progettista-elettrico"'s "Handwerk"/craft-design (pulled
    // in generic craft designers and unrelated construction PMs). Curating
    // per-string at this volume (~550 combined) isn't reliable within this
    // PR — tracked as a follow-up requiring either manual curation or a
    // multi-word-only anchor for entries with a generic bare-root alias.
    const EXCLUDE_ENTRIES = new Set([
      'consulente-clientela', 'docente', 'impiegato', 'autista', 'progettista-elettrico',
    ]);

    let redundant = 0;
    let collision = 0;
    let seniorityCompound = 0;
    let excludedString = 0;
    let excludedEntry = 0;
    let deadConnector = 0;
    const proposals = [];
    for (const entry of PROFESSION_TAXONOMY) {
      if (EXCLUDE_ENTRIES.has(entry.id)) {
        excludedEntry += (candidatesById.get(entry.id)?.size) || 0;
        continue;
      }
      const existing = new Set(entry.aliases.map(normalizeText));
      const candidates = candidatesById.get(entry.id);
      if (!candidates) continue;
      const add = [];
      for (const c of [...candidates].sort()) {
        if (existing.has(c)) continue;
        if (EXCLUDE_STRINGS.has(c)) { excludedString++; continue; }
        if (hasDeadConnectorWord(c)) { deadConnector++; continue; }
        const alreadyResolves = strictMatchProfession(c);
        if (alreadyResolves === entry.id) { redundant++; continue; }
        if (alreadyResolves && alreadyResolves !== entry.id) { collision++; continue; }
        if (isSeniorityCompound(c)) { seniorityCompound++; continue; }
        add.push(c);
      }
      if (add.length) proposals.push({ id: entry.id, label: entry.label, add });
    }

    writeFileSync(
      join(process.env.CLAUDE_JOB_DIR || tmpdir(), 'tmp', 'avam-alias-proposals.json'),
      JSON.stringify(proposals, null, 2),
    );
    console.log(`\nDropped ${redundant} redundant, ${collision} colliding, ${seniorityCompound} seniority-compound, ${excludedString} excluded-string, ${deadConnector} dead-connector-word, ${excludedEntry} excluded-entry candidates.`);
    console.log(`${proposals.length} entries have candidate new aliases. Wrote avam-alias-proposals.json.`);
    for (const p of proposals) {
      console.log(`\n${p.id} (${p.label}):`);
      for (const a of p.add) console.log(`  + ${a}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main();
