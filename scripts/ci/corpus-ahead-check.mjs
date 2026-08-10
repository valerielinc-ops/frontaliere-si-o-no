#!/usr/bin/env node
/**
 * corpus-ahead-check.mjs — il RICEVITORE che mancava al lato sito.
 *
 * ## Il difetto, in una riga
 *
 * Il corpus sa gia' quando il suo generatore e' andato avanti rispetto al
 * nostro, ma lo dice **solo a se stesso**, in un repo i cui agenti non possono
 * aprire una PR qui.
 *
 * ## Perche' non e' teorico
 *
 * `nanakokyobashi-rgb/frontaliere-articles` esegue
 * `scripts/ci/loop-drift-check.mjs` ogni giorno alle 07:31 UTC. Quel checker fa
 * un confronto a tre vie (sito oggi, corpus oggi, baseline dell'ultimo
 * allineamento) su ~217 file dichiarati in `scripts/ci/loop-sync-manifest.json`,
 * 99 dei quali sotto `generator/`. Classifica benissimo, e fra le sue classi
 * c'e' `corpus-ahead`: «modificato qui, fermo sul sito».
 *
 * `corpus-ahead` e', per definizione, **lavoro che si fa QUI**. Il corpus lo
 * scrive in una issue aperta SUL CORPUS, ultima nell'ordine di urgenza, con la
 * dicitura «candidato a risalire al sito». Nessun workflow di questo repo legge
 * quella issue, e il fixer autonomo del corpus non ha modo di aprire una PR
 * qui. Il verdetto giusto viene prodotto nel repo sbagliato per agire.
 *
 * Il costo e' misurato, due volte:
 *
 *  - **#81 → #82 sul corpus.** Il cap sulla meta description viene spostato qui
 *    (#5360, 2026-08-08). La fix non scende mai — nessun mirror copre
 *    `generator/`. Il 2026-08-09 il generatore ripresenta il difetto identico,
 *    265 caratteri contro il tetto di 170 di `tests/seo-description-length.test.ts`,
 *    e il job `tests` diventa rosso su OGNI branch di questo repo.
 *  - **2026-08-09, la direzione opposta.** Il corpus mergia #120 (gate
 *    «argomento gia' coperto»), #121 (un segnaposto del prompt non puo' piu'
 *    diventare uno slug) e #122 (microcopy su titolo ed excerpt), tutte dentro
 *    `generator/`. Nessuna risale. Alla data in cui questo file e' stato
 *    scritto, sei gemelli sotto `generator/scripts/` erano `corpus-ahead` e
 *    questo repo non aveva un solo segnale che lo dicesse.
 *
 * ## Perche' NON un mirror
 *
 * La tentazione ovvia e' allargare `mirror-articles-engine.yml` da `engine/` a
 * `generator/`. Sarebbe attivamente distruttivo, per due ragioni indipendenti:
 *
 *  1. **La direzione e' sbagliata.** Un mirror spinge sito → corpus. Le guardie
 *     di #120/#121/#122 stanno SUL CORPUS: mirrorare `generator/` da qui
 *     sovrascriverebbe il generatore che pubblica gli articoli con la nostra
 *     copia piu' vecchia, cioe' cancellerebbe esattamente le guardie che
 *     vogliamo ricevere.
 *  2. **La semantica di copia e' distruttiva.** Sia il mirror dell'engine
 *     (`rm -rf engine && cp -R`) sia `transport-generator-to-nanako.yml`
 *     (`rm -rf generator`, poi ricostruisce dal manifest) ricostruiscono la
 *     cartella da zero. Applicato a `generator/`, questo cancella i file che
 *     esistono SOLO di la': il manifest del corpus ne dichiara 21 come
 *     `corpus-only`, fra cui `generator/scripts/lib/topic-coverage-guard.mjs`
 *     — che e' la guardia di #120. Lo dice gia' in prosa l'intestazione di
 *     `apply-generator-rewire-to-nanako.yml`: «anything that exists ONLY on the
 *     nanako side is destroyed by the next transport».
 *
 * `engine/` e' copiabile perche' `tests/packages-articles-confinement.test.ts`
 * dimostra via AST che non importa nulla fuori da se'. Per `generator/` non
 * esiste una prova simile — anzi, importa `../build-plugins/`, `../data/` e
 * `../services/`, ed e' servito un intero workflow di REWIRE per farlo partire
 * di la'.
 *
 * ## Cosa fa questo script
 *
 * Legge il manifest **del corpus** (non una copia locale: una seconda copia
 * divergerebbe dalla prima, ed e' la classe di difetto che stiamo chiudendo) e
 * rifa' lo stesso confronto a tre vie dal lato di qua. Poi riporta **solo la
 * meta' su cui questo repo puo' agire**:
 *
 *   `corpus-ahead`  il corpus si e' mosso, noi no  → da valutare e portare qui
 *   `both-moved`    mossi entrambi                 → riconciliazione manuale
 *
 * `site-ahead`, `removed-on-site`, `undeclared-drift` e `corpus-only` sono la
 * meta' del corpus e vengono deliberatamente ignorati: il corpus li riporta
 * gia' nella propria issue, e ripeterli qui sdoppierebbe il segnale senza
 * aggiungere una decisione che spetti a noi.
 *
 * Non copia, non mergia, non apre PR. Emette un report e, con `--issue`, apre
 * (o commenta) UNA issue deduplicata su questo repo.
 *
 * ## Il punto cieco, dichiarato
 *
 * Questo controllo e' guidato dal manifest e confronta **file per file**. Eredita
 * quindi, senza attenuarlo, il punto cieco documentato in CLAUDE.md: non vede un
 * gemello che nel manifest non c'e', non vede l'assenza di un test da un lato, e
 * non vede i file che un file allineato *nomina* senza importarli. Un file
 * `corpus-only` che il sito dovrebbe avere resta invisibile da qui — e' la
 * lacuna che il corpus segue nella propria issue #125. Vede la divergenza dei
 * gemelli dichiarati, e nient'altro.
 *
 * Uso:
 *   node scripts/ci/corpus-ahead-check.mjs            # report leggibile, exit 0
 *   node scripts/ci/corpus-ahead-check.mjs --json     # report JSON su stdout
 *   node scripts/ci/corpus-ahead-check.mjs --strict   # exit 1 se c'e' da decidere
 *   node scripts/ci/corpus-ahead-check.mjs --issue    # apre/commenta la issue
 *
 * Env:
 *   CORPUS_REPO  default `nanakokyobashi-rgb/frontaliere-articles`
 *   CORPUS_REF   default `main`
 *   GH_TOKEN     opzionale; il repo del corpus e' pubblico e raw basta.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const CORPUS_REPO = process.env.CORPUS_REPO || 'nanakokyobashi-rgb/frontaliere-articles';
export const CORPUS_REF = process.env.CORPUS_REF || 'main';

/** Il manifest vive sul corpus. Qui non ne teniamo copia, di proposito. */
export const MANIFEST_PATH_IN_CORPUS = 'scripts/ci/loop-sync-manifest.json';

/**
 * Le uniche classi su cui questo repo puo' agire. Tenerlo come costante
 * esportata, e non come letterale sparso nel codice, e' cio' che permette al
 * test di affermare che `site-ahead` non finisce mai nel report di qua.
 */
export const SITE_ACTIONABLE_STATES = ['corpus-ahead', 'both-moved'];

/** Stesso digest del checker del corpus: sha256 del contenuto, primi 16 hex. */
export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);

export const rawUrl = (repo, ref, rel) => `https://raw.githubusercontent.com/${repo}/${ref}/${rel}`;

/** Taglia una `reason` lunga senza spezzarla a meta' parola. */
function clip(text, max) {
  if (!text) return '';
  const s = String(text).replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s.,;:]+$/, '')}…`;
}

/**
 * Classifica UN gemello con lo stesso confronto a tre vie del corpus.
 *
 * Deliberatamente puro (nessuna I/O): e' la meta' che il test esercita senza
 * rete. `now` = {site, corpus} hash di oggi, `base` = {site, corpus} baseline.
 */
export function classify(entry, now, base) {
  const mode = entry.mode;

  // Dichiarato assente di qua: e' una scelta registrata sul corpus, non drift.
  if (mode === 'corpus-only') {
    return { state: 'corpus-only', actionable: false, headline: 'dichiarato solo sul corpus' };
  }

  // Il gemello non esiste (piu') qui. Se ne occupa il corpus, che lo classifica
  // `removed-on-site`: da questa parte non c'e' un file su cui agire.
  if (now.site === null) {
    return { state: 'absent-here', actionable: false, headline: 'nessun gemello in questo repo' };
  }

  // Una baseline mai registrata rende il confronto a tre vie indecidibile: due
  // hash diversi non dicono CHI si e' mosso. Non e' azionabile di qua — la
  // baseline si registra sul corpus con `loop-drift-check.mjs --init`.
  if (!base || base.site == null || base.corpus == null) {
    return { state: 'no-baseline', actionable: false, headline: 'baseline non registrata sul corpus' };
  }

  const siteMoved = now.site !== base.site;
  const corpusMoved = now.corpus !== base.corpus;

  if (!siteMoved && !corpusMoved) {
    return { state: 'stable', actionable: false, headline: 'allineato' };
  }

  if (siteMoved && !corpusMoved) {
    // La meta' del corpus: il lavoro e' portare la NOSTRA modifica di la'.
    return { state: 'site-ahead', actionable: false, headline: 'il sito e\' avanti — se ne occupa il corpus' };
  }

  if (!siteMoved && corpusMoved) {
    return {
      state: 'corpus-ahead',
      actionable: true,
      headline: 'il corpus si e\' mosso, qui no',
      detail:
        mode === 'adapted'
          ? `Il gemello e' ADATTATO di la' (${clip(entry.reason, 200) || 'ragione non dichiarata'}). Non e' copiabile: la modifica va letta e riapplicata sopra la nostra versione.`
          : 'Il file e\' dichiarato identico ai due lati: la modifica del corpus e\' copiabile qui cosi\' com\'e\'.',
    };
  }

  return {
    state: 'both-moved',
    actionable: true,
    headline: 'modificato su entrambi i lati',
    detail:
      'Due modifiche indipendenti dalla baseline. Puo\' anche voler dire che la modifica del corpus e\' GIA\' stata portata qui e che la baseline non e\' stata riallineata: si chiude quando il corpus rigira `scripts/ci/loop-drift-check.mjs --init`.',
  };
}

/**
 * Contenuto del gemello di questa parte, o null se il repo davvero non ce l'ha.
 *
 * Il fallback su `git show` non e' una cintura di sicurezza teorica: questo repo
 * si lavora in worktree SPARSE (CLAUDE.md — un checkout pieno costa 3,9 GB fra
 * `public/` 1,8 GB e `data/` 1,7 GB), e il manifest del corpus dichiara due
 * gemelli proprio sotto `data/`: `data/authors.ts` e `data/canton-url-slugs.json`.
 * In un worktree sparse quei due file sono TRACCIATI ma non materializzati: un
 * `existsSync` da solo li leggerebbe come «assenti», cioe' come «nessun gemello
 * qui», e il confronto sparirebbe in silenzio. E' lo stesso falso negativo che
 * CLAUDE.md segnala come «l'errore diagnostico piu' facile da fare qui».
 *
 * Leggendo l'oggetto git il controllo resta corretto sotto QUALUNQUE
 * configurazione sparse, invece di dipendere dal fatto che il workflow abbia
 * indovinato l'elenco dei prefissi da srotolare.
 */
function siteContent(rel) {
  const p = path.join(ROOT, rel);
  if (fs.existsSync(p)) return fs.readFileSync(p);
  try {
    return execFileSync('git', ['show', `HEAD:${rel}`], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null; // non in HEAD: il gemello davvero non esiste di qua.
  }
}

/** Hash del gemello locale, o null se il repo non ce l'ha. */
export function localHash(rel) {
  const buf = siteContent(rel);
  return buf === null ? null : sha256(buf);
}

async function fetchRaw(repo, ref, rel) {
  const headers = { 'User-Agent': 'corpus-ahead-check' };
  if (process.env.GH_TOKEN) headers.Authorization = `Bearer ${process.env.GH_TOKEN}`;
  const res = await fetch(rawUrl(repo, ref, rel), { headers });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${rel} → HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Piccolo pool: ~217 fetch in sequenza sono inutilmente lente, e in parallelo
 *  pieno prendono un rate-limit. Otto alla volta e' il compromesso. */
async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const idx = i++;
        if (idx >= items.length) return;
        out[idx] = await fn(items[idx], idx);
      }
    }),
  );
  return out;
}

export function renderIssueBody(manifest, results, actionable) {
  const section = (state, title) => {
    const rows = actionable.filter((r) => r.state === state);
    if (!rows.length) return '';
    return [
      `### ${title}`,
      '',
      ...rows.map((r) => `- \`${r.path}\` → \`${r.sitePath}\` — ${r.headline}\n  ${r.detail || ''}`),
      '',
    ].join('\n');
  };

  return [
    `Confronto con \`${CORPUS_REPO}@${CORPUS_REF}\`, baseline dell'ultimo allineamento registrata la': **${manifest.alignedAt || '(mai)'}**.`,
    '',
    `${results.length} gemelli dichiarati nel manifest del corpus, **${actionable.length}** richiedono una decisione **qui**.`,
    '',
    section('corpus-ahead', '⬆️ Il corpus e\' andato avanti — da valutare e portare qui'),
    section('both-moved', '🔴 Modificato su entrambi i lati'),
    '---',
    '',
    'Il corpus produce questo stesso verdetto ogni giorno, ma lo scrive in una issue **sul corpus**, dove nessun agente puo\' aprire una PR su questo repo. Questa issue e\' il ricevitore che mancava.',
    '',
    '`corpus-ahead` non e\' un errore ed **e\' una decisione per file**: una modifica puo\' essere un adattamento locale al corpus (allora la baseline va riallineata la\', con `scripts/ci/loop-drift-check.mjs --init`) oppure un miglioramento che serve anche al generatore che gira qui — `publish-journalist-articles.yml` esegue `scripts/publish-journalist-article.mjs`, che importa da `scripts/create-article.mjs`, ogni 15 minuti.',
    '',
    'Punto cieco noto: il confronto e\' guidato dal manifest, **file per file**. Un gemello non dichiarato la\', un test presente da un solo lato, o un file soltanto *nominato* da un file allineato non sono visibili da qui.',
    '',
    '_Aperta da `scripts/ci/corpus-ahead-check.mjs`._',
  ]
    .filter(Boolean)
    .join('\n');
}

async function main() {
  const ARGS = new Set(process.argv.slice(2));
  const AS_JSON = ARGS.has('--json');
  const STRICT = ARGS.has('--strict');
  const AS_ISSUE = ARGS.has('--issue');

  const manifestBuf = await fetchRaw(CORPUS_REPO, CORPUS_REF, MANIFEST_PATH_IN_CORPUS);
  if (!manifestBuf) {
    throw new Error(`manifest non trovato: ${CORPUS_REPO}@${CORPUS_REF}/${MANIFEST_PATH_IN_CORPUS}`);
  }
  const manifest = JSON.parse(manifestBuf.toString('utf8'));
  if (!Array.isArray(manifest.files)) throw new Error('manifest senza array `files`');

  const results = await mapPool(manifest.files, 8, async (entry) => {
    const sitePath = entry.sitePath || entry.path;
    const base = entry.baseline || null;

    // I `corpus-only` non hanno gemello per dichiarazione: niente fetch.
    if (entry.mode === 'corpus-only') {
      return { path: entry.path, sitePath, mode: entry.mode, ...classify(entry, { site: null, corpus: null }, base) };
    }

    let now;
    try {
      const buf = await fetchRaw(CORPUS_REPO, CORPUS_REF, entry.path);
      now = { site: localHash(sitePath), corpus: buf === null ? null : sha256(buf) };
    } catch (e) {
      // Una fetch fallita non deve rendere inutile tutto il report.
      return {
        path: entry.path,
        sitePath,
        mode: entry.mode,
        state: 'check-failed',
        actionable: false,
        headline: `verifica fallita: ${String(e.message).slice(0, 80)}`,
      };
    }

    return { path: entry.path, sitePath, mode: entry.mode, ...classify(entry, now, base) };
  });

  const actionable = results.filter((r) => r.actionable);

  if (AS_JSON) {
    console.log(JSON.stringify({ corpusRepo: CORPUS_REPO, corpusRef: CORPUS_REF, alignedAt: manifest.alignedAt || null, results, actionable: actionable.length }, null, 2));
  } else {
    const byState = results.reduce((acc, r) => ((acc[r.state] = (acc[r.state] || 0) + 1), acc), {});
    console.log(`Gemelli del generatore — divergenza vs ${CORPUS_REPO}@${CORPUS_REF}`);
    console.log(`Baseline registrata sul corpus: ${manifest.alignedAt || '(mai)'}\n`);
    console.log(`${results.length} file sorvegliati — ${Object.entries(byState).map(([k, v]) => `${k}:${v}`).join('  ')}\n`);
    if (!actionable.length) {
      console.log('Niente da decidere qui: il corpus non si e\' mosso su nessun gemello dichiarato.');
    } else {
      for (const r of actionable) {
        console.log(`  [${r.state}] ${r.path} → ${r.sitePath}`);
        console.log(`      ${r.headline}`);
        if (r.detail) console.log(`      → ${r.detail}`);
        console.log('');
      }
    }
  }

  if (AS_ISSUE && actionable.length) {
    // Import differito: il modulo tocca l'ambiente GitHub all'import, e i test
    // di questo file devono poter caricare il classificatore senza di esso.
    const { createGithubIssue } = await import('../lib/github-issue-creator.mjs');
    await createGithubIssue({
      // Titolo STABILE: il creator deduplica sul prefisso, quindi le passate
      // successive commentano la stessa issue invece di aprirne una al giorno.
      title: 'Il generatore del corpus e\' andato avanti: gemelli da valutare qui',
      description: renderIssueBody(manifest, results, actionable),
      priority: 3,
      labels: ['Bug'],
      workflow: 'corpus-ahead-check',
    });
  }

  return STRICT && actionable.length ? 1 : 0;
}

// `import.meta.main` non esiste su Node 20; il confronto sul path e' la forma
// che questo repo usa altrove per "eseguito, non importato".
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      // PROCEED-SAFE, come il gemello sul corpus: un checker rotto non deve
      // rompere la CI di nessuno. Senza --strict, un errore resta un log.
      console.error(`corpus-ahead-check fallito: ${e && e.stack ? e.stack : e}`);
      process.exit(process.argv.includes('--strict') ? 1 : 0);
    },
  );
}
