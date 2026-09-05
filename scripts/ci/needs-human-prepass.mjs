#!/usr/bin/env node
/**
 * needs-human-prepass.mjs — la metà deterministica dello sweep `needs-human`.
 *
 * ## Il difetto, misurato
 *
 * `needs-human` era assorbente, e `needs-human-sweep.yml` è stato costruito per
 * drenarlo. Ma il suo drenaggio è UN run Claude alla settimana con un cap di 15
 * azioni, e il 2026-08-24 le issue `needs-human` sul sito erano **59** — quattro
 * settimane di coda nel caso migliore, mentre lo stadio VERDICT-EXIT (#6323) ne
 * aggiunge di nuove a ogni tick del drainer: 15 escalation nei primi 15 minuti
 * dal suo merge. Un'uscita che riceve più di quanto emette non è un'uscita.
 *
 * La cosa che rende il cap sprecato è che la maggior parte di quelle issue **non
 * contiene una decisione**. Sulle 59 misurate, 7 erano decisioni vere (registrate
 * in `VISION.md` § «Decisioni RICHIESTE»); le altre erano guasti aperti da un
 * monitor — `Crawler Failure:`, `CI Failure:`, `Validation Failure (dist)`,
 * `[crawler-health]`, `App Error:`, `PostHog Exception:` — e follow-up tecniche
 * con item deferred. Su nessuna di queste serve il giudizio di un modello per
 * dire «questa non è una domanda per il proprietario»: il titolo lo dice, e il
 * titolo lo scrive un nostro script.
 *
 * Questo pre-pass le rimette in coda a costo zero, e lascia al run Claude
 * esattamente le issue su cui un giudizio serve davvero.
 *
 * ## Perché una ALLOWLIST e non una denylist
 *
 * La direzione dell'errore non è simmetrica. Ri-accodare per sbaglio una
 * decisione del proprietario significa far implementare al fixer una scelta che
 * non gli spetta — espansione di scope, denaro, consenso — ed è esattamente ciò
 * che la lista «Sempre umano» di `VISION.md` esiste per impedire. Lasciare per
 * sbaglio una tecnica al run Claude costa invece un'azione del suo cap.
 *
 * Quindi si riconoscono POSITIVAMENTE le famiglie generate da noi, e tutto il
 * resto resta dov'è. Una famiglia nuova di monitor non viene drenata da questo
 * script finché qualcuno non la aggiunge qui — che è il modo giusto di
 * sbagliare, perché il run Claude la prende comunque.
 *
 * ## Il verdetto batte il riconoscimento di famiglia (fix #5608)
 *
 * Un'issue di famiglia monitor può arrivare in `needs-human` già passata per lo
 * stadio VERDICT-EXIT di `followup-drainer.mjs`, che la escala lì apposta come
 * uscita TERMINALE per un verdetto `NON_RETRYABLE` (es. `no-root-cause`) — con
 * lo sweep settimanale di `needs-human-sweep.yml` come «sola porta di rientro»
 * dichiarata in `verdictExitDecision`. Prima di questa fix, questo pre-pass
 * GIORNALIERO ignorava il verdetto per ogni titolo di famiglia riconosciuto e
 * la re-accodava comunque ad `agent:fix-queued` — riproducendo lo stesso
 * verdetto allo stesso costo prima ancora che lo sweep settimanale la vedesse.
 * Misurato su #5608 (`PostHog Exception:`): no-root-cause confermato tre volte
 * in tre run separate, ognuna preceduta da un re-accodo di questo script nel
 * giorno precedente. Ora un verdetto `NON_RETRYABLE` vince sul riconoscimento
 * di famiglia e la issue resta `keep` per il giudizio dello sweep.
 *
 * Dal 2026-09-04 (escalation #7307) l'insieme che vince è
 * `PREPASS_VERDICT_BEATS_FAMILY`, cioè `NON_RETRYABLE` più `max-turns`. Il
 * criterio non è «il verdetto è definitivo» ma «questo script può cambiare
 * qualcosa prima di rimetterla in coda?»: non sa scrivere una scheda, quindi un
 * ri-accodo sul solo titolo rifà la stessa run allo stesso costo. Lo sweep
 * Claude una scheda la scrive, e resta la porta di rientro.
 *
 * ## `max-turns` non è un `keep`, è uno scorporo (#7280)
 *
 * Quel criterio però risponde no solo per il `requeue`. `max-turns` significa
 * «troppo grande per una run», e per quel verdetto il drainer ha già una strada
 * che NON è il ri-accodo: la DECOMPOSE-ROUTE. Il pre-pass non sa scrivere una
 * scheda, ma sa consegnare la issue allo stadio che la scrive — quindi per una
 * famiglia riconosciuta con `max-turns` ed eleggibile allo scorporo l'azione è
 * `decompose`, non `keep`. Misurato sulle 28 `needs-human` del sito il
 * 2026-09-04: 21 portano `max-turns` e 7 restavano ferme SOLO per questo.
 *
 * Il `keep` resta per le ineleggibili (`from-decompose`, `decomposed:1`): il
 * secondo livello di scorporo è escluso su misura (VISION.md D5), e per loro la
 * porta è lo sweep, che una scheda nuova la scrive davvero.
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { FIX_OUTCOME_RE } from './close-recovered-failure-issues.mjs';
import { PREPASS_VERDICT_BEATS_FAMILY, AGGREGATE_ITEMS_RE, isDecomposeEligible } from './followup-drainer.mjs';

const REPO = process.env.GH_REPO || process.env.GITHUB_REPOSITORY || '';
const DRY = process.argv.includes('--dry-run');
// Cap volutamente BASSO, e tarato sulla portata a valle e non sulla dimensione
// della coda: il sito consegna ~15 PR al giorno (108 `pr-created` in 7 giorni
// misurati il 2026-08-24), quindi immettere 25 issue al giorno riempirebbe la
// coda piu' in fretta di quanto la si svuota — e sopra ~5 PR aperte i merge
// rallentano da soli. A 10/giorno le 59 parcheggiate rientrano in circa una
// settimana senza che nessun altro stadio se ne accorga.
const MAX_PER_RUN = Number(process.env.PREPASS_MAX_PER_RUN || 10);
// Cap SEPARATO, e non un'esenzione dal cap sopra. Sono due risorse diverse: il
// cap di `MAX_PER_RUN` protegge la portata della coda del fixer (~15 PR/giorno,
// sopra ~5 PR aperte i merge rallentano), mentre una nota non instrada niente —
// scrive un commento e lascia la label dov'è. Contarle insieme farebbe morire di
// fame proprio le annotazioni, che sono il grosso del valore nuovo su una coda
// di `keep`. Il conteggio è stampato a parte, e la nota è idempotente (marker
// nei commenti), quindi a regime il volume è zero.
const MAX_NOTES_PER_RUN = Number(process.env.PREPASS_MAX_NOTES_PER_RUN || 10);
// Le letture di stato per i blocchi scaduti, per run e su tutte le issue: una
// issue non può far esplodere il costo del run nominando quaranta PR.
const MAX_REF_LOOKUPS = Number(process.env.PREPASS_MAX_REF_LOOKUPS || 40);
// Di quale repo sono i numeri NUDI che questo pre-pass legge. Sul gemello del
// corpus vale `'corpus'` — vedi `matchRegistry`.
const HOME_SCOPE = 'site';

/**
 * Le famiglie di issue APERTE DA UN MONITOR, riconosciute sul titolo.
 *
 * Ognuna è un titolo che scrive un nostro script, non una persona: il prefisso è
 * parte del contratto di dedup di chi le apre (vedi il vincolo dei 60 caratteri
 * sul titolo canonico), quindi è stabile e non è una euristica sul linguaggio.
 */
export const MONITOR_TITLE_PATTERNS = [
  /^Crawler Failure:/i,
  /^CI Failure:/i,
  /^Workflow Failure:/i,
  /^Validation Failure/i,
  /^\[crawler-health\]/i,
  /^\[data-quality\]/i,
  /^App Error:/i,
  /^PostHog Exception:/i,
  /^CWV (field )?[Rr]egression/i,
  /^follow-up\(#\d+\):/i,
];


/**
 * Verdetti che il 2026-08-24 hanno smesso di essere blocchi di capacità.
 *
 * `blocked-secrets`: il proprietario ha autorizzato in modo permanente l'uso dei
 * secret (registro in `VISION.md`), e `issue-fix.yml` carica Remote Config prima
 * del run. Un verdetto emesso prima di quella data descrive una configurazione
 * che non esiste più, quindi la issue è lavoro normale.
 */
export const STALE_BLOCK_VERDICTS = new Set(['blocked-secrets']);

/**
 * ## Il registro di VISION.md, letto QUI e non solo dal run Claude (#7280)
 *
 * `needs-human-sweep.yml` istruisce il run Claude a «cercare PRIMA una decisione
 * del proprietario già registrata nel registro di VISION.md: se c'è, la issue
 * non è più una domanda — applicala». È corretto, ma quel run è SETTIMANALE, ha
 * cap 15 e costa quota. Questo pre-pass è GIORNALIERO, costa zero e scala — che
 * è testualmente il driver D5 di VISION.md («Allargare il riconoscimento del
 * pre-pass costa zero quota (D4) e scala; un altro run Claude no»).
 *
 * E fino a questa fix il commento che il pre-pass postava affermava «Questa
 * issue non contiene una decisione del proprietario» SENZA averlo verificato:
 * il registro non veniva mai letto da qui.
 *
 * Misurato il 2026-09-05 sul sito: su 42 issue `needs-human`, 11 citano nel
 * corpo un numero su cui il registro ha già deciso — #6404 #6405 #6406 #6407
 * #6408 (→ #6280), #6381 #6382 #6383 (→ #5995), #6357 #6359 (→ #4854), #6761
 * (→ #5705) — ferme da dodici giorni DOPO che la decisione era arrivata.
 *
 * ## La trappola: «cita una riga del registro» NON vuol dire «sbloccala»
 *
 * La riga di #5995 autorizza le leve 1, 3 e 4 e dice a lettere che le leve 2 e
 * 5 «restano BACKLOG, non autorizzate: non aprire lavoro su quelle finché non
 * arriva una decisione dedicata». Una regola ingenua «cita → requeue»
 * riaprirebbe lavoro che il proprietario ha NEGATO: un danno peggiore del non
 * riconoscimento che questa fix ripara. Stessa classe: #5926 è un sì «con
 * vincolo esplicito», #5983 è un NO, #5681 è «NON si fa, per ora».
 *
 * Quindi una riga ha DUE letture, non una:
 *
 *  - **incondizionata** — porta un marcatore affermativo (`SÌ`, `procedi`,
 *    `autorizzat*`) e NESSUN qualificatore fra quelli elencati sotto → il
 *    pre-pass ri-accoda, citando la riga nel commento;
 *  - **condizionata o negativa** — un qualificatore qualsiasi, OPPURE nessun
 *    marcatore affermativo → il pre-pass NON sblocca, ma ALLEGA la riga alla
 *    issue. Il valore resta grande: lo sweep del lunedì non deve più cercarla,
 *    e la issue smette di essere indistinguibile dalle altre 30 del `keep`.
 *
 * L'asimmetria è la stessa dell'allowlist di famiglie qui sopra, e va nella
 * stessa direzione: l'assenza di prova non è prova. Una riga senza marcatore
 * affermativo è «condizionata», mai «incondizionata per default».
 */

/** L'intestazione della sezione-tabella del registro in `VISION.md`. */
export const REGISTRY_HEADING_RE = /^##\s+Decisioni del proprietario gi[àa] prese\b.*$/m;

/**
 * I marcatori che rendono una riga NON applicabile in automatico, con la
 * ragione che finisce nel commento allegato alla issue.
 *
 * Sono FRASI, non la parola «non»: «non solo per questa issue» (riga #5928) è
 * un sì pieno, e un qualificatore su `\bnon\b` lo leggerebbe come condizionato,
 * cioè spegnerebbe il riconoscimento proprio sulle righe più larghe.
 */
export const REGISTRY_QUALIFIERS = [
  [/\bNO\b/, 'decisione negativa'],
  [/\bnon si (fa|fanno|tocca|toccano)\b/i, 'decisione negativa'],
  [/\bnon (si )?stringe(re)?\b/i, 'decisione negativa'],
  [/\bnon autorizzat/i, 'una parte NON è autorizzata'],
  [/\bnon aprire\b/i, 'una parte NON è autorizzata'],
  [/\brestano? BACKLOG\b/i, 'una parte resta a BACKLOG'],
  [/\bsi lasciano stare\b/i, 'famiglia esplicitamente riservata'],
  [/\bdeclinat[oaie]\b/i, 'decisione declinata'],
  [/\bvincol[oi]\b/i, 'autorizzazione con vincolo esplicito'],
  [/\bfinch[éeè]'? non\b/i, 'autorizzazione condizionata nel tempo'],
  [/\bper ora\b/i, 'autorizzazione condizionata nel tempo'],
  [/\bma solo\b/i, 'autorizzazione delimitata'],
  [/\bsoltanto\b/i, 'autorizzazione delimitata'],
  [/\b(delimitat|limitat)[oaie]\b/i, 'autorizzazione delimitata'],
  [/\beccezione\b/i, 'autorizzazione delimitata'],
  [/\bopzione [A-Z]\b/, 'la riga sceglie fra opzioni, non autorizza in blocco'],
  [/\bsalvo\b/i, 'autorizzazione con eccezione'],
  [/\bpurch[éeè]\b/i, 'autorizzazione condizionata'],
  [/\ba condizione\b/i, 'autorizzazione condizionata'],
  [/\bmai\b/i, 'divieto esplicito nella stessa riga'],
];

/**
 * Il «sì» affermativo, in due regex e non in una, perché il flag `i` qui è un
 * difetto e non una comodità: `si` è il pronome impersonale italiano e compare
 * dentro OGNI riga negativa del registro («NON **si** fa», «**si** lasciano
 * stare»). Un `/\bsi\b/i` leggerebbe come affermativa esattamente la riga che
 * nega. Il registro scrive il sì in maiuscolo e accentato: `SÌ`.
 *
 * `\b` non serve e non funzionerebbe: in JS `\w` è ASCII, quindi `Ì` è un
 * non-word char e `/\bSÌ\b/` non aggancia mai la virgola che segue. I lookaround
 * su `\p{L}` fanno il lavoro giusto con il flag `u`.
 */
const REGISTRY_YES_RE = /(?<![\p{L}])(?:SÌ|SI|sì)(?![\p{L}])/u;
const REGISTRY_AUTHORIZED_RE = /\bprocedi\b|\bautorizzat[oaie]\b/i;

/**
 * La lettura di UNA riga del registro. Pura → testabile sui casi reali.
 * @param {string} text testo della riga (cella Decisione + cella Fonte)
 * @returns {{state: 'unconditional'|'conditional', why: string[]}}
 */
export function registryRowState(text = '') {
  const s = String(text || '');
  const why = REGISTRY_QUALIFIERS.filter(([re]) => re.test(s)).map(([, w]) => w);
  if (why.length) return { state: 'conditional', why: [...new Set(why)] };
  if (REGISTRY_YES_RE.test(s) || REGISTRY_AUTHORIZED_RE.test(s)) {
    return { state: 'unconditional', why: [] };
  }
  return { state: 'conditional', why: ['nessun marcatore affermativo: il pre-pass non deduce un sì dal silenzio'] };
}

/**
 * I riferimenti `#N` citati in un testo, filtrati sul repo che li ospita.
 *
 * Il filtro NON è cosmetico. Il registro vive sul sito e i suoi numeri sono
 * numeri del sito; sul gemello del corpus un `#5995` nudo nel corpo di una sua
 * issue significa `nanakokyobashi-rgb/frontaliere-articles#5995`, che non
 * esiste — leggerlo come la riga del registro sarebbe una collisione di
 * numerazione, non un riconoscimento. Da lì `requireRepo`.
 *
 * @param {string} text
 * @param {{repo?: string, requireRepo?: boolean}} opts repo = `owner/name` del sito
 * @returns {Set<number>}
 */
export function citedRefs(text, { repo = '', requireRepo = false } = {}) {
  const [owner, name] = String(repo || '').split('/');
  const out = new Set();
  // Il `(?<!\.md\s{0,3})` non e' un dettaglio: il registro cita le proprie
  // regole come `AGENTS.md #1` e `AGENTS.md #7`, e senza quel lookbehind la
  // riga del 2026-08-20 entra nel registro come una decisione sulla issue #1 —
  // cioe' un numero bassissimo che qualunque corpo puo' nominare per caso.
  for (const m of String(text || '').matchAll(/(?<!\.md\s{0,3})(?:([A-Za-z0-9][\w.-]*)(?:\/([\w.-]+))?)?#(\d+)\b/g)) {
    const o = m[1] || null;
    const n = m[2] || null;
    if (o) {
      if (o !== owner || (n && n !== name)) continue; // riferimento a un terzo repo
    } else if (requireRepo) {
      continue; // numero nudo su un repo diverso da quello del registro
    }
    out.add(Number(m[3]));
  }
  return out;
}

/**
 * Le righe della tabella «Decisioni del proprietario già prese» di `VISION.md`.
 *
 * Parsing a righe e non con un parser Markdown per la stessa ragione per cui
 * `needs-human-prepass-sparse-closure.test.ts` non usa un parser YAML: è
 * l'unico consumatore, gli script del ciclo sono zero-dep, e una dipendenza
 * npm qui morirebbe comunque — il job `prepass` NON esegue `npm ci`.
 *
 * @param {string} md
 * @returns {Array<{date: string, decision: string, source: string, refs: number[],
 *                  state: 'unconditional'|'conditional', why: string[]}>}
 */
export function parseVisionRegistry(md = '') {
  const text = String(md || '');
  const head = REGISTRY_HEADING_RE.exec(text);
  if (!head) return [];
  const rest = text.slice(head.index + head[0].length);
  const end = /\n## /.exec(rest);
  const table = end ? rest.slice(0, end.index) : rest;

  const rows = [];
  for (const raw of table.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('|')) continue;
    const cells = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    if (cells.length < 3) continue;
    const [date, decision, ...restCells] = cells;
    if (/^[-:\s]+$/.test(date) || date === 'Data') continue; // separatore / intestazione
    const source = restCells.join(' | ');
    const body = `${decision} | ${source}`;
    const refs = [...citedRefs(body)];
    if (!refs.length) continue; // una riga che non nomina nessuna issue non è agganciabile
    rows.push({ date, decision, source, refs, scope: registryRowScope(body), ...registryRowState(body) });
  }
  return rows;
}

/** I due repo del ciclo, per disambiguare la numerazione dei riferimenti. */
export const REPO_SLUGS = {
  site: 'valerielinc-ops/frontaliere-si-o-no',
  corpus: 'nanakokyobashi-rgb/frontaliere-articles',
};

/**
 * Di QUALE repo sono i numeri di una riga del registro.
 *
 * `VISION.md` sta sul sito ma è il registro del ciclo INTERO: le righe del
 * 2026-09-05 decidono su #727, #728, #814, #621, #625, #787, #804, #832 — che
 * sono numeri del CORPUS. Senza questo campo una issue del sito che nomina
 * `#814` per tutt'altra ragione aggancerebbe una decisione che non la riguarda:
 * i due repo condividono lo spazio dei numeri bassi e non c'è niente nel numero
 * che dica a quale appartiene.
 *
 * La prova che il registro dà è la parola: chi scrive una riga sul corpus lo
 * dice («…, corpus», «Cinque issue del corpus»). È volutamente grossolano nella
 * direzione sicura — una riga del sito che NOMINA il corpus viene letta come
 * corpus-scoped e quindi non sblocca sul sito: un `keep` in più, mai un
 * `requeue` sbagliato.
 */
export function registryRowScope(text = '') {
  return /\bcorpus\b|\bnanako/i.test(String(text || '')) ? 'corpus' : 'site';
}

/**
 * Le righe del registro che riguardano i riferimenti citati da una issue.
 *
 * `homeScope` dice in quale repo gira il pre-pass: lì un `#N` NUDO è un numero
 * di casa, mentre i numeri dell'altro repo contano solo se il corpo li ha
 * qualificati (`valerielinc-ops/frontaliere-si-o-no#6023`). È la stessa
 * asimmetria che GitHub applica quando risolve il link.
 *
 * @returns {{unconditional: Array<object>, conditional: Array<object>, refs: number[]}}
 */
export function matchRegistry(text, rows = [], { homeScope = 'site' } = {}) {
  const away = homeScope === 'site' ? 'corpus' : 'site';
  const home = citedRefs(text, { repo: REPO_SLUGS[homeScope] });
  const foreign = citedRefs(text, { repo: REPO_SLUGS[away], requireRepo: true });
  const seen = (r) => (r.scope === homeScope ? home : foreign);
  const hits = (rows || []).filter((r) => r.refs.some((n) => seen(r).has(n)));
  return {
    unconditional: hits.filter((r) => r.state === 'unconditional'),
    conditional: hits.filter((r) => r.state === 'conditional'),
    refs: [...new Set(hits.flatMap((r) => r.refs.filter((n) => seen(r).has(n))))].sort((a, b) => a - b),
  };
}

/**
 * ## Secondo meccanismo: i blocchi che scadono in silenzio
 *
 * Trovate il 2026-09-05 due issue del corpus ferme su un blocco che non
 * esisteva più: nanako#471 era `blocked` su `valerielinc-ops#6023`, MERGIATA il
 * 2026-08-18 — diciotto giorni oltre la fine del suo blocco; nanako#714
 * attendeva un probe il cui workflow risponde 404, cioè una prova che nessuno
 * avrebbe più prodotto. Il primo caso è verificabile a costo zero.
 *
 * La granularità è la SEZIONE e non la riga, perché il blocco non è scritto in
 * una grammatica: su nanako#471 la parola sta nel titolo di sezione
 * (`## 1. … — blocked su PR esterna aperta`) e il riferimento tre paragrafi
 * sotto. Una regex sulla riga non lo vedrebbe.
 *
 * Ed è proprio per questa imprecisione che il meccanismo ANNOTA e non sblocca:
 * vedi la nota su `prepassDecision`.
 */
export function blockedRefs(body = '', { homeScope = 'site' } = {}) {
  const text = String(body || '');
  if (!/\bblocked\b/i.test(text)) return [];
  const home = REPO_SLUGS[homeScope];
  const away = REPO_SLUGS[homeScope === 'site' ? 'corpus' : 'site'];
  const out = new Map();
  const collect = (chunk) => {
    for (const m of chunk.matchAll(/(?<!\.md\s{0,3})(?:([A-Za-z0-9][\w.-]*)(?:\/([\w.-]+))?)?#(\d+)\b/g)) {
      const owner = m[1] || null;
      let repo = home;
      if (owner) {
        const slug = [home, away].find((r) => r.split('/')[0] === owner
          && (!m[2] || r.split('/')[1] === m[2]));
        if (!slug) continue; // un terzo repo: non è roba di questo ciclo
        repo = slug;
      }
      const key = `${repo}#${m[3]}`;
      if (!out.has(key)) out.set(key, { repo, number: Number(m[3]), key });
    }
  };
  // Le sezioni sono delimitate dalle intestazioni Markdown, e l'intestazione va
  // guardata anche da sola: su nanako#471 la parola `blocked` sta LÌ
  // (`## 1. … — blocked su PR esterna aperta`) e il riferimento nel corpo sotto.
  const headings = text.match(/^#{1,6} .*$/gm) || [];
  const sections = text.split(/^#{1,6} .*$/m);
  for (let i = 0; i < sections.length; i++) {
    const heading = i > 0 ? headings[i - 1] : '';
    if (/\bblocked\b/i.test(`${heading}\n${sections[i]}`)) collect(`${heading}\n${sections[i]}`);
  }
  return [...out.values()].sort((a, b) => a.key.localeCompare(b.key));
}

const VISION_PATH = new URL('../../VISION.md', import.meta.url);

/**
 * Il registro, dal file di QUESTO repo: `VISION.md` è la sorgente unica e sta
 * qui. Il gemello del corpus non ne ha una copia — deliberato — e la recupera
 * via `gh api …/contents/VISION.md`; là questa funzione è l'unico punto che
 * diverge, il resto del riconoscimento è lo stesso codice.
 *
 * Fail-open, e non per pigrizia: senza registro il pre-pass torna ESATTAMENTE
 * al comportamento precedente, mentre un'eccezione lo farebbe morire prima di
 * `main()`. Peggio del non-riconoscimento c'è solo un pre-pass che smette di
 * girare — già successo, otto giorni, per un file fuori dal checkout sparse
 * (`tests/needs-human-prepass-sparse-closure.test.ts`).
 */
export function readVisionRegistry() {
  try {
    const rows = parseVisionRegistry(fs.readFileSync(VISION_PATH, 'utf8'));
    if (!rows.length) console.log('::warning::needs-human-prepass: registro di VISION.md vuoto o non riconosciuto → riconoscimento disattivato per questo run.');
    return rows;
  } catch (e) {
    console.log(`::warning::needs-human-prepass: VISION.md non leggibile (${String(e).slice(0, 120)}) → riconoscimento del registro disattivato per questo run.`);
    return [];
  }
}


/** Ultimo verdetto da una lista di commenti (forma REST o GraphQL). Pura. */
export function latestVerdict(comments) {
  let latest = null;
  let at = -Infinity;
  for (const c of comments || []) {
    const m = FIX_OUTCOME_RE.exec(String(c?.body || ''));
    if (!m) continue;
    const t = Date.parse(c?.created_at ?? c?.createdAt);
    if (!Number.isNaN(t) && t >= at) { at = t; latest = m[1].toLowerCase(); }
  }
  return latest;
}

/**
 * La decisione, dal solo titolo + labels + ultimo verdetto. Pura → testabile.
 *
 * `keep` è il default e non un ramo di errore: significa «non so dirlo senza
 * giudizio», e il run Claude dello sweep è il posto dove quel giudizio si dà.
 *
 * @param {{title?: string, labels?: string[], verdict?: string|null}} iss
 * @returns {{action: 'requeue'|'decompose'|'keep', reason: string}}
 */
export function prepassDecision({
  title = '', body = '', labels = [], verdict = null,
  registry = [], staleBlocks = [], homeScope = 'site',
} = {}) {
  // Il corpo entra QUI e non nella decisione di famiglia. La distinzione non è
  // formale: `isAggregate`/`AGGREGATE_ITEMS_RE` girano sul TITOLO apposta,
  // perché sul corpo la parola «batch» bastava a mandare allo scorporo tre
  // issue che non dichiaravano nessun conteggio (misurato il 2026-08-25). Qui
  // il corpo non viene interpretato come prosa: se ne estraggono riferimenti
  // `#N` e si incrociano con una TABELLA. È una chiave esterna, non un'euristica
  // sul linguaggio — e infatti il giudizio su cosa quella riga autorizzi lo dà
  // la riga, non il corpo della issue.
  const reg = matchRegistry(`${title}\n${body}`, registry, { homeScope });
  const d = decideAction({ title, labels, verdict, reg });
  // Un tracker permanente non si annota. Il solo che porta `agent:no-age-out` è
  // il digest dello sweep, il cui CORPO viene riscritto ogni lunedì con l'elenco
  // delle domande aperte: i riferimenti citati cambiano ogni settimana, quindi
  // cambierebbe il marker di idempotenza e la nota diventerebbe un commento
  // settimanale sull'unica issue che nessuno vuole più rumorosa.
  const note = labels.includes('agent:no-age-out') ? null : prepassNote(reg, staleBlocks);
  return note ? { ...d, note, marker: noteMarker(reg, staleBlocks) } : d;
}

/** Il ramo che sceglie l'azione. Separato dal wrapper solo per tenerlo puro. */
function decideAction({ title = '', labels = [], verdict = null, reg }) {
  // Un tracker permanente è aperto per scelta: non si accoda e non si scorpora.
  if (labels.includes('agent:no-age-out')) return { action: 'keep', reason: 'tracker permanente' };
  // Sotto lavorazione attiva di una sessione locale (claim mutex, #6427): l'unico
  // caso dove `needs-human` + un'altra label può davvero significare «in volo».
  // `agent:fix`/`agent:fix-queued`/`agent:decompose`/`agent:decompose-queued`
  // NON qualificano: la query a monte (`main()`) filtra già su `needs-human`,
  // quindi ogni issue che arriva qui ce l'ha SEMPRE — e nessuno di quei 4 stadi
  // aggiunge `needs-human` restando `agent:fix*`/`agent:decompose*` mentre è
  // davvero in coda: è lo stato morto lasciato dall'escalation VERDICT-EXIT
  // (prima di questa fix non rimuoveva quelle label), mai un'issue in lavoro.
  for (const l of ['agent:in-progress']) {
    if (labels.includes(l)) return { action: 'keep', reason: `già in lavorazione (${l})` };
  }

  const monitor = MONITOR_TITLE_PATTERNS.find((re) => re.test(title));


  // Lo scorporo viene PRIMA di ogni ramo che ri-accoda, secret inclusi: un
  // container con N item deferred ha più target, e ri-accodarlo intero è «il
  // modo documentato di rifare max-turns». Valeva già contro il `requeue`
  // finale; ora vale anche contro `STALE_BLOCK_VERDICTS`, che stava sopra e
  // rimandava in coda intero un aggregato con verdetto `blocked-secrets`.
  //
  // Ma solo se lo stadio di decomposizione lo accetterebbe davvero. Il predicato
  // è quello del drainer, `isDecomposeEligible`, importato e non riscritto: là
  // esclude `decomposed:1`, `from-decompose`, `agent:decompose*` e
  // `maybe-resolved`, e `issue-decompose.yml` NON ri-controlla l'eleggibilità —
  // va dritto al run Claude. Senza il gate, il pre-pass mandava allo scorporo
  // proprio le issue che il drainer ne aveva appena escluse (❓ review #7318).
  //
  // E l'ineleggibile esce `keep` QUI, esplicito, invece di cadere più giù. Il
  // fallthrough sembrava innocuo perché sotto c'è il ramo del verdetto, ma
  // quel ramo è condizionato a `verdict &&`, e `verdict` è `null` sia quando la
  // issue non porta nessun marker `FIX_OUTCOME` sia quando la lettura dei
  // commenti fallisce (in `main()` il `catch` la azzera, silenzioso). Un
  // container `decomposed:1` senza verdetto arrivava quindi al `requeue` finale,
  // cioè al ri-accodo intero che il commento qui sopra chiama «il modo
  // documentato di rifare max-turns»: il loop non si chiudeva, cambiava porta
  // (🔴 review #7325). Né scorporo né ri-accodo: lo guarda lo sweep.
  const aggregate = monitor && AGGREGATE_ITEMS_RE.test(title);
  if (aggregate) {
    if (isDecomposeEligible({ labels: labels.map((name) => ({ name })) })) {
      return { action: 'decompose', reason: 'container multi-item generato da un monitor' };
    }
    return {
      action: 'keep',
      reason: 'container multi-item che il drainer ha già escluso dallo scorporo: né decompose né requeue intero, decide lo sweep',
    };
  }

  // Il registro di `VISION.md` batte il «famiglia non riconosciuta → keep» qui
  // sotto: una issue che cita una riga INCONDIZIONATA non è più una domanda per
  // il proprietario — è lavoro normale, e la sua porta non deve essere un run
  // Claude settimanale con cap 15 (D5).
  //
  // Serve che TUTTE le righe agganciate siano incondizionate, non che ne esista
  // una. Un corpo che cita sia #6280 (sì pieno) sia #5995 (leve 2 e 5 «non
  // autorizzate: non aprire lavoro su quelle») descrive un lavoro che sta a
  // cavallo dei due, e nel dubbio non si sblocca: `keep` costa un giro di
  // sweep, il ri-accodo sbagliato fa implementare al fixer una scelta che il
  // proprietario ha NEGATO.
  //
  // E NON batte `PREPASS_VERDICT_BEATS_FAMILY`: `max-turns`/`no-root-cause`
  // dicono che l'ultima run è morta per una ragione che il ri-accodo non cambia,
  // e una decisione del proprietario non rende quella run più corta. Le due cose
  // sono ortogonali; ri-accodare qui riaprirebbe il loop che #5608 e nanako#778
  // hanno chiuso, con in più il timbro del registro a farlo sembrare giusto.
  if (reg && reg.unconditional.length && !reg.conditional.length
      && !(verdict && PREPASS_VERDICT_BEATS_FAMILY.has(verdict))) {
    const r = reg.unconditional[0];
    const cited = reg.refs.map((n) => `#${n}`).join(' ');
    return {
      action: 'requeue',
      reason: `il registro di \`VISION.md\` ha già deciso il ${r.date} sui riferimenti citati nel corpo (${cited}), con una riga incondizionata (nessun qualificatore): non è più una domanda per il proprietario`,
    };
  }

  if (verdict && STALE_BLOCK_VERDICTS.has(verdict)) {
    return { action: 'requeue', reason: `verdetto \`${verdict}\` superato dalla decisione del 2026-08-24 sui secret` };
  }

  // Dopo il ramo secret perché quello ri-accoda un titolo QUALSIASI, anche non
  // riconosciuto, ed è una decisione del proprietario che questa funzione non
  // riscrive; prima di tutto il resto perché da qui in giù si decide solo fra
  // `keep` e `requeue`, e per un titolo che nessun nostro monitor ha scritto il
  // giudizio è dello sweep.
  if (!monitor) return { action: 'keep', reason: 'famiglia non riconosciuta: la valuta il run Claude' };
  // `max-turns` su una famiglia riconosciuta: NON un `requeue` (rifarebbe la
  // stessa run allo stesso costo, è il criterio di `PREPASS_VERDICT_BEATS_FAMILY`)
  // ma lo SCORPORO, che è la strada che quel verdetto ha già nel drainer
  // (DECOMPOSE-ROUTE, `outcome === 'max-turns'`): un turn-budget esaurito
  // descrive una issue troppo grande per una run, non un verdetto fermo.
  //
  // Perché non contraddice la costante che sta sopra: il suo criterio non è «il
  // verdetto è definitivo» ma «questo stadio sa cambiare qualcosa prima di
  // rimettere in coda?». Sul `requeue` la risposta resta no — il pre-pass non sa
  // scrivere una scheda. Sul `decompose` la risposta è sì, e non perché la
  // scriva lui: la scrive il run planner, esattamente come la scrive lo sweep.
  // «Non riaprire una porta che non puoi accompagnare» vale per la porta del
  // fixer, non per quella dello scorporo, che è accompagnata per costruzione.
  //
  // Misurato il 2026-09-04 sulle 28 `needs-human` del sito (#7280): 21 su 28
  // portano `max-turns`, e per 7 di esse — `Crawler Failure: Run zurich/volg/
  // lidl/ipersonal/chicco-doro/faulhaber`, `[crawler-health] recruitingapp-2563`
  // — questo era l'UNICO motivo del `keep`. Ci finiscono perché il gemello
  // crawler del drainer (`crawlerFixDecision`) parcheggia `max-turns` senza
  // passare dalla DECOMPOSE-ROUTE che la path queue-managed ha: qui quella
  // asimmetria si chiude a valle, sull'uscita.
  //
  // `isDecomposeEligible` resta il gate, per la stessa ragione del ramo
  // aggregato qui sopra: esclude `from-decompose`/`decomposed:1`, cioè il
  // secondo livello di scorporo che VISION.md D5 esclude su misura (z=0,59 fra
  // il tasso di `max-turns` delle scorporate e quello delle intere). Le
  // ineleggibili restano allo sweep, che per loro è la porta giusta — è lui che
  // ha liberato #7096 #7158 #7203 scrivendo una scheda nuova.
  if (verdict === 'max-turns' && isDecomposeEligible({ labels: labels.map((name) => ({ name })) })) {
    return { action: 'decompose', reason: 'turn-budget esaurito su famiglia riconosciuta: troppo grande per una run, non un verdetto fermo' };
  }
  // Il verdetto vince sul riconoscimento di famiglia, ma SOLO sul `requeue`: è
  // l'unica azione qui che non cambia niente per il fixer, mentre lo scorporo
  // qui sopra cambia l'input come lo cambia la scheda dello sweep. Criterio,
  // derivazione e misure stanno sulla costante in `followup-drainer.mjs`; il
  // difetto che questa posizione ripara è il 🔴 della review su nanako#778.
  if (verdict && PREPASS_VERDICT_BEATS_FAMILY.has(verdict)) {
    return { action: 'keep', reason: `verdetto \`${verdict}\` non ri-accodabile a costo zero: resta per il giudizio dello sweep settimanale` };
  }
  return { action: 'requeue', reason: `famiglia di monitor riconosciuta (${monitor})` };
}

/**
 * Il marker di idempotenza del commento. Il pre-pass è stateless per
 * costruzione (zero-Claude, nessun artifact, solo il `GITHUB_TOKEN` del cron):
 * la sola memoria disponibile è quella che si scrive dove la si rilegge, cioè i
 * commenti della issue — che vengono GIÀ letti per il verdetto, quindi zero
 * chiamate in più. Porta dentro i riferimenti, così una riga di registro NUOVA
 * su una issue già annotata riapre bocca una volta sola.
 */
export function noteMarker(reg, staleBlocks = []) {
  const parts = [];
  if (reg && reg.refs.length) parts.push(`r=${reg.refs.join(',')}`);
  if (staleBlocks.length) parts.push(`b=${staleBlocks.map((s) => s.key).join(',')}`);
  return parts.length ? `<!-- PREPASS_NOTE: ${parts.join(' ')} -->` : null;
}

/**
 * Il commento da allegare alla issue: la riga del registro che la riguarda, e i
 * blocchi che il corpo dichiara ma che sono già finiti.
 *
 * Vale anche — anzi soprattutto — quando l'azione resta `keep`: un'issue con la
 * riga allegata non è più indistinguibile dalle altre trenta del `keep`, e lo
 * sweep del lunedì non paga più il costo di cercarla. Pura → testabile.
 */
export function prepassNote(reg, staleBlocks = []) {
  const rows = [...((reg && reg.unconditional) || []), ...((reg && reg.conditional) || [])];
  if (!rows.length && !staleBlocks.length) return null;
  const out = [];

  if (rows.length) {
    out.push('📓 **Registro di `VISION.md`: la decisione che riguarda questa issue esiste già.**', '');
    out.push(
      'Il pre-pass deterministico (zero-Claude, giornaliero) ha agganciato i riferimenti citati '
      + 'nel corpo alle righe del registro «Decisioni del proprietario già prese». Sono qui, '
      + 'trascritte: non vanno più cercate.',
      '',
    );
    out.push('| Data | Decisione registrata | Lettura del pre-pass |');
    out.push('|---|---|---|');
    for (const r of rows) {
      const cell = r.decision.replace(/\|/g, '\\|');
      const read = r.state === 'unconditional'
        ? '✅ **incondizionata** — nessun qualificatore'
        : `⚠️ **condizionata o negativa** — ${r.why.join('; ')}`;
      out.push(`| ${r.date} | ${cell} | ${read} |`);
    }
    out.push('');
    if (reg.conditional.length) {
      out.push(
        '⚠️ Almeno una riga è condizionata o negativa, quindi il pre-pass **non sblocca**. '
        + 'Una regola «cita una riga registrata → rimetti in coda» riaprirebbe lavoro che il '
        + 'proprietario ha delimitato o negato — il danno peggiore di quello che ripara. '
        + 'Chi lavora questa issue resta dentro i limiti scritti nella riga.',
      );
    }
  }

  if (staleBlocks.length) {
    if (out.length) out.push('');
    out.push('⏱️ **Blocco scaduto.** Il corpo dichiara un blocco e nomina riferimenti che oggi risultano chiusi:', '');
    for (const b of staleBlocks) out.push(`- ${b.link} — **${b.state}** il ${b.at}`);
    out.push(
      '',
      'Il pre-pass **non toglie `needs-human` d\'ufficio** su questo segnale, e la ragione è la '
      + 'grammatica: un blocco non è scritto in una forma contrattuale. Su nanako#471 la parola '
      + '`blocked` sta in un titolo di sezione e il riferimento tre paragrafi sotto, mentre altre '
      + 'sezioni della stessa issue dichiarano blocchi SENZA nominare nulla. Il pre-pass può quindi '
      + 'provare che *un* riferimento citato è chiuso, mai che fosse l\'unica causa — e sbloccare su '
      + 'quella prova parziale sarebbe la versione «blocchi» dello sblocco cieco sul registro. '
      + 'Quello che qui costa zero è la MISURA, ed è quella che manca allo sweep: la classe C del '
      + 'suo prompt («claim scaduta») chiede la misura più economica che decide, e ora ce l\'ha già '
      + 'scritta sotto gli occhi.',
    );
  }
  return out.join('\n');
}

function gh(args, { json = true } = {}) {
  const out = execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return json ? JSON.parse(out) : out;
}

/**
 * Lo stato di un riferimento, con cache e budget. `null` = «non lo so» (aperto,
 * non leggibile, budget esaurito) — mai «non scaduto», che sarebbe la stessa
 * bugia del commento che questa PR toglie.
 */
function makeRefResolver() {
  const cache = new Map();
  return (repo, number) => {
    const key = `${repo}#${number}`;
    if (cache.has(key)) return cache.get(key);
    if (cache.size >= MAX_REF_LOOKUPS) return null;
    let v = null;
    try {
      const o = gh(['api', `repos/${repo}/issues/${number}`]);
      if (o && o.state === 'closed') {
        const merged = o.pull_request && o.pull_request.merged_at;
        v = {
          key,
          link: `${repo}#${number}`,
          state: merged ? 'MERGED' : 'CLOSED',
          at: String(merged || o.closed_at || '').slice(0, 10),
        };
      }
    } catch { v = null; }
    cache.set(key, v);
    return v;
  };
}

function main() {
  if (!REPO) { console.log('needs-human-prepass: nessun repo risolvibile → niente da fare.'); return; }
  const registry = readVisionRegistry();
  let issues = [];
  try {
    // `body` entra qui e non con una chiamata per issue: `gh issue list` lo
    // serve nella stessa risposta, quindi il riconoscimento del registro e
    // quello dei blocchi scaduti costano ZERO chiamate in più sull'elenco.
    issues = gh(['issue', 'list', '--repo', REPO, '--state', 'open', '--label', 'needs-human',
      '--json', 'number,title,body,labels,updatedAt', '--limit', '300']);
  } catch (e) {
    console.log(`::warning::needs-human-prepass: elenco non leggibile (${String(e).slice(0, 100)}) → nessuna azione.`);
    return;
  }
  console.log(`needs-human-prepass — repo ${REPO}, ${issues.length} issue \`needs-human\`, registro VISION.md: ${registry.length} righe${DRY ? ' [DRY-RUN]' : ''}`);

  // Le più stantie prima: sono quelle che aspettano da più tempo, e il cap non
  // deve tagliarle sempre. `gh issue list` ordina dalla più recente.
  const ordered = [...issues].sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));

  const refState = makeRefResolver();
  const counts = { requeue: 0, decompose: 0, keep: 0 };
  let acted = 0;
  let noted = 0;
  let noteCapLogged = false;
  for (const iss of ordered) {
    const labels = (iss.labels || []).map((l) => l.name);
    const body = iss.body || '';
    // Il verdetto si legge sempre (anche per un titolo di famiglia monitor
    // riconosciuto): un verdetto NON_RETRYABLE vince sul riconoscimento di
    // famiglia (vedi `prepassDecision`), quindi non può più essere saltato solo
    // perché il titolo basterebbe a decidere `requeue` da solo.
    let comments = [];
    let verdict = null;
    try {
      const cs = gh(['api', `repos/${REPO}/issues/${iss.number}/comments?per_page=100`, '--paginate']);
      comments = Array.isArray(cs) ? cs : [];
      verdict = latestVerdict(comments);
    } catch { comments = []; verdict = null; }

    // I blocchi scaduti si misurano solo dove il corpo ne dichiara uno: su una
    // issue senza la parola `blocked` questo costa zero chiamate.
    const staleBlocks = [];
    for (const ref of blockedRefs(body, { homeScope: HOME_SCOPE })) {
      const st = refState(ref.repo, ref.number);
      if (st) staleBlocks.push(st);
    }

    const d = prepassDecision({ title: iss.title, body, labels, verdict, registry, staleBlocks, homeScope: HOME_SCOPE });
    counts[d.action]++;

    const already = d.marker && comments.some((c) => String(c?.body || '').includes(d.marker));

    if (d.action === 'keep') {
      // La nota non consuma `MAX_PER_RUN`: non instrada niente, non tocca le
      // label e non mette pressione sulla coda del fixer, che è ciò che quel cap
      // protegge. Ha il suo, dichiarato — vedi `MAX_NOTES_PER_RUN`.
      if (!d.note || already) continue;
      if (noted >= MAX_NOTES_PER_RUN) {
        if (!noteCapLogged) {
          console.log(`needs-human-prepass: cap note ${MAX_NOTES_PER_RUN}/run raggiunto → il resto al prossimo giro (no silent cap).`);
          noteCapLogged = true;
        }
        continue;
      }
      noted++;
      if (DRY) { console.log(`[dry] #${iss.number} ✎ nota ${d.marker} — "${iss.title.slice(0, 60)}"`); continue; }
      try {
        gh(['issue', 'comment', String(iss.number), '--repo', REPO, '--body', `${d.note}\n\n${d.marker}`], { json: false });
        console.log(`PREPASS #${iss.number} ✎ nota allegata ${d.marker}`);
      } catch (e) {
        console.log(`::warning::needs-human-prepass: nota non allegata a #${iss.number} (${String(e).slice(0, 100)}).`);
      }
      continue;
    }

    if (acted >= MAX_PER_RUN) {
      console.log(`needs-human-prepass: cap ${MAX_PER_RUN}/run raggiunto → il resto al prossimo giro (no silent cap).`);
      break;
    }
    acted++;
    const add = d.action === 'requeue' ? 'agent:fix-queued' : 'agent:decompose-queued';
    if (DRY) { console.log(`[dry] #${iss.number} → ${add} (${d.reason}) — "${iss.title.slice(0, 60)}"`); continue; }
    // La riga che questa PR ripara: prima era `Questa issue non contiene una
    // decisione del proprietario`, affermato SENZA aver letto il registro. Ora è
    // un esito verificato in questo run, e la forma dice quale dei tre casi è.
    const registryVerdict = registry.length
      ? (d.note ? '' : 'Nessuna riga del registro «Decisioni del proprietario già prese» di `VISION.md` riguarda i riferimenti citati nel corpo: verificato in questo run, non assunto.')
      : 'Il registro di `VISION.md` non è stato leggibile in questo run, quindi il riconoscimento del registro non si è pronunciato (fail-open).';
    const note = [
      `🔁 **Pre-pass deterministico dello sweep (zero-Claude)**: ${d.reason}. Questa issue torna nel ciclo autonomo invece di occupare un'azione del cap del run Claude settimanale.`,
      registryVerdict,
      already ? '' : d.note,
      already ? '' : d.marker,
    ].filter(Boolean).join('\n\n');
    try {
      gh(['issue', 'comment', String(iss.number), '--repo', REPO, '--body', note], { json: false });
      gh(['issue', 'edit', String(iss.number), '--repo', REPO,
        '--add-label', add, '--remove-label', 'needs-human', '--remove-label', 'fu-parked'], { json: false });
      console.log(`PREPASS #${iss.number} → ${add} (${d.reason})`);
    } catch (e) {
      console.log(`::warning::needs-human-prepass: #${iss.number} non instradata (${String(e).slice(0, 100)}).`);
    }
  }
  console.log(`needs-human-prepass: requeue=${counts.requeue} decompose=${counts.decompose} keep=${counts.keep} note=${noted} (azioni eseguite: ${acted}, cap ${MAX_PER_RUN}; note cap ${MAX_NOTES_PER_RUN}).`);
}

if (process.argv[1] && process.argv[1].endsWith('needs-human-prepass.mjs')) main();
