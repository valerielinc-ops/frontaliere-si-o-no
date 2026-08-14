/**
 * pr-body-generators-state — il generatore deve conoscere le regole del gate
 * che poi giudica quello che ha scritto.
 *
 * Due difetti dello stesso componente, stessa radice:
 *
 *   1. RESIDUI SENZA STATO. Il gate (`pr-body-sections-check.mjs`, classe
 *      `bullet-without-state`) pretende che ogni bullet di
 *      `## Non implementato (ancora)` dichiari uno stato letterale; i
 *      generatori emettevano bullet nudi. Misurato il 2026-08-14 sulle ultime
 *      100 PR: sito 264 bullet su 554 senza stato (60 PR su 100), corpus 156 su
 *      378 (74 su 100).
 *   2. `Closes` SU UNA FOLLOW-UP AGGREGATA. `pr-body-contract.yml` fallisce la
 *      PR; il generatore lo emetteva incondizionatamente. Due volte in un
 *      giorno: #5848 e #5862.
 *
 * PERCHÉ IL TEST SCOPRE I GENERATORI INVECE DI ELENCARLI. Una lista di path
 * sarebbe un'allowlist: il generatore aggiunto domani non ci sarebbe, il test
 * resterebbe verde, e sarebbe la quindicesima «guardia che esiste e non
 * guarda» di questo workspace. Qui i generatori si trovano scandendo l'albero
 * per chi EMETTE `## Non implementato`, quindi un generatore nuovo entra da
 * solo nella copertura — e se non rispetta il contratto, entra rosso.
 *
 * NOTA SUL CORPO ASINCRONO. I test qui sotto sono `async` e leggono via
 * `fs.promises` di proposito: un corpo SINCRONO abbastanza lungo viene
 * riportato da vitest come «timed out» anche quando passa (su un gate di
 * questo repo, 7 fallimenti su 14 erano test PASSATI). Async, il timer misura
 * quello che deve.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  bulletState,
  sectionBullets,
  stripNonContent,
} from '../scripts/lib/pr-body-sections-check.mjs';
import {
  RESIDUAL_STATE_LITERALS,
  ABOLISHED_DEFERRAL_LITERALS,
  closingRefFor,
} from '../scripts/lib/pr-body-generator-contract.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Dove può vivere un generatore. `data/`, `public/` e `dist/` non contengono
// codice; `.claude/worktrees/**` sono checkout completi del repo e
// moltiplicherebbero ogni hit per il numero di worktree aperti (in locale ~4×,
// in CI zero) — un conteggio che dipende dallo stato del disco non è una
// misura.
const SCAN_ROOTS = ['.github', 'scripts', 'docs', 'build-plugins', '.claude/commands'];
const SCAN_FILES = ['AGENTS.md', 'REVIEW.md', 'FOLLOWUP.md', 'ISSUES.md', 'CLAUDE.md'];
const SCAN_EXT = new Set(['.yml', '.yaml', '.mjs', '.js', '.ts', '.sh', '.md']);
const SKIP_DIR = new Set(['node_modules', 'worktrees', 'dist', 'data', 'public', '.git']);

/**
 * L'header EMESSO, e solo quello. La discriminante fra generatore e validatore
 * è che l'emissione occupa la RIGA INTERA — nuda (`## Non implementato
 * (ancora)`), o dentro la meccanica di trasporto della shell (`'## Non
 * implementato (ancora)' \`). Un validatore lo nomina invece in mezzo a una
 * frase: «`## Non implementato (ancora)` present WITH "(ancora)"», oppure
 * dentro una regex letterale. Senza questo vincolo di fine riga i sei messaggi
 * d'errore di `pr-body-sections-check.mjs` — cioè il GATE — venivano contati
 * come bullet emessi da un generatore.
 */
const NON_IMPL_RE =
  /^[^\S\n]*['"`]?[ \t]*#{2,3}[ \t]+Non[ \t]+implementato(?:[ \t]*\(ancora\))?[ \t]*['"`]?[ \t]*\\?[ \t]*$/gim;

type SourceFile = { rel: string; text: string };

async function walk(dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return; // radice assente in questo checkout → niente da scandire
  }
  await Promise.all(
    entries.map(async (e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIR.has(e.name)) return;
        await walk(full, out);
      } else if (SCAN_EXT.has(path.extname(e.name))) {
        out.push(full);
      }
    }),
  );
}

let sources: SourceFile[] = [];

beforeAll(async () => {
  const files: string[] = [];
  await Promise.all(SCAN_ROOTS.map((r) => walk(path.join(REPO, r), files)));
  for (const f of SCAN_FILES) files.push(path.join(REPO, f));
  const read = await Promise.all(
    files.map(async (f) => {
      try {
        return { rel: path.relative(REPO, f), text: await fs.readFile(f, 'utf-8') };
      } catch {
        return null;
      }
    }),
  );
  sources = read.filter((x): x is SourceFile => x !== null);
});

// ---------------------------------------------------------------------------
// Estrazione: cosa un generatore EMETTE sotto `## Non implementato`
// ---------------------------------------------------------------------------

/**
 * Le righe che seguono l'header, ripulite dalla meccanica della shell/YAML che
 * le trasporta: `printf '%s' \` mette ogni riga fra apici singoli con una
 * continuazione finale, l'heredoc le lascia nude, un prompt YAML le indenta.
 * Si smette al primo heading successivo — la stessa regola del gate, che è
 * anche la trappola nota («un `###` subito sotto l'header svuota la sezione»).
 */
export function emittedResidualLines(text: string, from: number): string[] {
  const rest = text.slice(from);
  const lines: string[] = [];
  for (const raw of rest.split('\n')) {
    const cleaned = raw
      .replace(/\\$/, '')                 // continuazione shell
      .replace(/^\s*'(.*)'\s*$/, '$1')    // 'riga' \
      .replace(/^\s*"(.*)"\s*$/, '$1')    // "riga" \
      .trim();
    // Fine sezione: un heading di QUALUNQUE livello, o la fine del blocco che
    // trasporta il body (fine heredoc / fine array printf).
    if (/^#{1,6}[ \t]/.test(cleaned)) break;
    if (/^(EOF|>>\s*"?\$body|>\s*"?\$body|```)/.test(cleaned)) break;
    lines.push(cleaned);
  }
  return lines;
}

/**
 * Un bullet è un TEMPLATE (istruzione a un agente) quando il segnaposto è il
 * SOGGETTO del bullet, cioè apre il testo: `- <scope NON fatto> — <STATO>`.
 *
 * Il test `<…>` ovunque nel bullet non basta e ha già prodotto un falso
 * positivo qui: `mirror-articles-engine.yml` emette un bullet vero che contiene
 * `TypeError: <member> is not a function`, e veniva scambiato per un template
 * — cioè esentato dal controllo sullo stato. Un falso positivo su un
 * classificatore di ESENZIONE è un buco, non rumore.
 */
function isPlaceholder(bullet: string): boolean {
  const body = bullet.replace(/^[ \t]*[-*+][ \t]*/, '').replace(/^\*\*/, '');
  return /^<[^>\n]{2,}>/.test(body) || /^\$\{?\{?[A-Z_]/.test(body);
}

/**
 * I blocchi `prompt: |` di un workflow, delimitati per indentazione come vuole
 * lo scalare literal di YAML: il blocco finisce alla prima riga non vuota con
 * indentazione minore o uguale a quella della chiave.
 */
function promptBlocks(text: string): string[] {
  const out: string[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)prompt:\s*\|/.exec(lines[i]);
    if (!m) continue;
    const indent = m[1].length;
    const buf: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (l.trim() === '') { buf.push(l); continue; }
      const ind = l.length - l.replace(/^\s*/, '').length;
      if (ind <= indent) break;
      buf.push(l);
    }
    out.push(buf.join('\n'));
  }
  return out;
}

type Emission = { rel: string; bullets: string[]; placeholders: string[]; raw: string };

function emissions(srcs: SourceFile[]): Emission[] {
  const out: Emission[] = [];
  for (const s of srcs) {
    NON_IMPL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = NON_IMPL_RE.exec(s.text)) !== null) {
      const lines = emittedResidualLines(s.text, m.index + m[0].length);
      const raw = lines.join('\n');
      const all = sectionBullets(raw);
      out.push({
        rel: s.rel,
        raw,
        bullets: all.filter((b) => !isPlaceholder(b)),
        placeholders: all.filter(isPlaceholder),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------

describe('generatori del body PR — sezione dei residui', () => {
  it('trova almeno i generatori noti (il discovery non è vacuo)', async () => {
    const found = new Set(emissions(sources).map((e) => e.rel));
    // Se il discovery si rompe, ogni altro test qui sotto diventa verde a vuoto
    // scandendo zero file. Questi quattro esistono e emettono la sezione: se
    // uno sparisce dal set, è il discovery ad essere rotto, non il repo.
    for (const rel of [
      '.github/workflows/issue-fix.yml',
      '.github/workflows/mirror-articles-engine.yml',
      '.github/workflows/refresh-shard-weights.yml',
      '.github/pull_request_template.md',
    ]) {
      expect(found, `discovery vacuo: ${rel} non trovato`).toContain(rel);
    }
    expect(found.size).toBeGreaterThanOrEqual(6);
  });

  it('ogni bullet LETTERALE emesso dichiara uno stato', async () => {
    const offenders: string[] = [];
    for (const e of emissions(sources)) {
      for (const b of e.bullets) {
        if (bulletState(b) === null) {
          offenders.push(`${e.rel}: ${b.slice(0, 110)}`);
        }
      }
    }
    expect(
      offenders,
      'un generatore emette un bullet di residuo senza stato letterale '
        + '(`in questa PR` / `PR concatenata #N` / `per scelta` / `by construction` / `blocked: <causa>`). '
        + 'Senza stato, followup-has-candidates.mjs lo riapre come issue nuova anche se il lavoro è chiuso.',
    ).toEqual([]);
  });

  it('ogni generatore con bullet SEGNAPOSTO nomina tutti gli stati', async () => {
    const offenders: string[] = [];
    for (const e of emissions(sources)) {
      if (e.placeholders.length === 0) continue;
      const src = sources.find((s) => s.rel === e.rel)!.text;
      const missing = RESIDUAL_STATE_LITERALS
        // `PR concatenata #N` / `blocked: <causa>` variano nel segnaposto finale:
        // si cerca la parte fissa, che è ciò che il gate riconosce.
        .map((lit) => lit.replace(/\s*<[^>]*>$/, '').replace(/\s*#N$/, ''))
        .filter((lit) => !src.toLowerCase().includes(lit.toLowerCase()));
      if (missing.length) offenders.push(`${e.rel}: manca ${missing.join(' / ')}`);
    }
    expect(
      offenders,
      'un generatore istruisce un agente a scrivere i residui senza dargli la tassonomia completa degli stati',
    ).toEqual([]);
  });

  it('ogni PROMPT che fa scrivere i residui a un agente nomina tutti gli stati', async () => {
    // Un generatore può non EMETTERE la sezione e comunque produrla: un prompt
    // che dice a un agente «apri la PR con `## Non implementato (ancora)`»
    // nomina l'header in mezzo a una frase, quindi il discovery per riga intera
    // qui sopra non lo vede. `pr-redflag-fixer.yml` e `post-merge-followup.yml`
    // sono esattamente questo, e senza questa guardia un prompt nuovo potrebbe
    // istruire un agente a scrivere residui senza dargli la tassonomia.
    //
    // Solo chi istruisce a SCRIVERE: un prompt di review (`gh pr review`) legge
    // la tassonomia da REVIEW.md e non deve duplicarla qui.
    //
    // I due segnali devono stare NELLO STESSO blocco `prompt: |`, non solo
    // nello stesso file. Con il criterio più lasco `pr-review-loop.yml`
    // risultava un generatore: nomina l'header al rigo 579 (per verificarlo, è
    // un reviewer) e `gh pr create` al rigo 19 — dentro un commento YAML in
    // cima al file, fuori da qualunque prompt. Il blocco è il confine naturale
    // di «una istruzione»; una finestra a distanza fissa sarebbe stata un
    // numero magico da ritarare al primo prompt più lungo.
    const WRITES = /gh\s+pr\s+create|gh\s+pr\s+edit[^\n]*--body|gh\s+issue\s+create/;
    const MENTIONS = /#{2,3}\s+Non\s+implementato/i;
    const offenders: string[] = [];
    const covered: string[] = [];
    for (const s of sources) {
      const blocks = promptBlocks(s.text);
      if (!blocks.some((b) => WRITES.test(b) && MENTIONS.test(b))) continue;
      covered.push(s.rel);
      const missing = RESIDUAL_STATE_LITERALS
        .map((lit) => lit.replace(/\s*<[^>]*>$/, '').replace(/\s*#N$/, ''))
        .filter((lit) => !s.text.toLowerCase().includes(lit.toLowerCase()));
      if (missing.length) offenders.push(`${s.rel}: manca ${missing.join(' / ')}`);
    }
    // Anti-vacuo: se il filtro smette di selezionare qualcosa, l'assenza di
    // offender non significa più niente.
    expect(covered.length, 'nessun prompt-generatore selezionato: il filtro è vacuo').toBeGreaterThanOrEqual(4);
    expect(covered, 'pr-review-loop è un REVIEWER, non un generatore: se entra qui il filtro è troppo largo').not.toContain('.github/workflows/pr-review-loop.yml');
    expect(
      offenders,
      'un prompt istruisce un agente a scrivere i residui senza dargli la tassonomia completa degli stati',
    ).toEqual([]);
  });

  it('nessun bullet emesso usa la tassonomia ABOLITA come stato', async () => {
    const offenders: string[] = [];
    for (const e of emissions(sources)) {
      for (const b of [...e.bullets, ...e.placeholders]) {
        const clean = stripNonContent(b);
        const abolished = ABOLISHED_DEFERRAL_LITERALS.filter((a) =>
          new RegExp(`\\b${a.replace(/ /g, '\\s+')}\\b`, 'i').test(clean),
        );
        // Solo quando l'abolito è LO STATO del bullet, cioè non ce n'è un altro
        // valido: un bullet che dice «by construction: … out of scope …» è prosa
        // corretta, non una scappatoia.
        if (abolished.length && bulletState(b) === null) {
          offenders.push(`${e.rel}: [${abolished.join(',')}] ${b.slice(0, 90)}`);
        }
      }
    }
    expect(
      offenders,
      '`out of scope` / `posposto` sono la tassonomia pre-AGENTS.md #8, ABOLITA: '
        + 'un bullet che si ferma lì viene bocciato dal reviewer e riaperto dal collector',
    ).toEqual([]);
  });
});

describe('generatori del body PR — keyword di chiusura', () => {
  // Una closing keyword GitHub seguita da un riferimento NON letterale: una
  // variabile shell, un'espressione GHA, o il segnaposto `#N`. È il caso in cui
  // il generatore non sa a priori se il bersaglio è un'aggregata.
  const VARIABLE_CLOSE =
    /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b:?\s*#?(?:\$\{?\{?[^\s`'"]*|<[^>\n]+>|N\b)/i;

  it('nessun generatore emette una chiusura su un bersaglio variabile senza passare dal contratto', async () => {
    const offenders: string[] = [];
    for (const e of emissions(sources)) {
      const src = sources.find((s) => s.rel === e.rel)!.text;
      // Solo i file che GENERANO un body (emettono la sezione): un gate o un
      // test che DISCUTE `Closes #N` non è un generatore.
      const hit = src.split('\n').findIndex((l) => VARIABLE_CLOSE.test(stripNonContent(l)));
      if (hit < 0) continue;
      const goesThroughContract =
        src.includes('pr-body-generator-contract') || /\bAddresses\b/.test(src);
      if (!goesThroughContract) {
        offenders.push(`${e.rel}:${hit + 1}: ${src.split('\n')[hit].trim().slice(0, 110)}`);
      }
    }
    expect(
      offenders,
      'un generatore emette `Closes #<variabile>` senza sapere se il bersaglio è una follow-up '
        + 'AGGREGATA multi-item. Su quelle pr-body-contract.yml fallisce la PR (nasce rossa: #5848, #5862) '
        + 'e al merge chiuderebbe un aggregato con item ancora dovuti. '
        + 'Calcola la riga con scripts/lib/pr-body-generator-contract.mjs --closing-ref.',
    ).toEqual([]);
  });

  it('closingRefFor sceglie Addresses su un aggregato e Closes altrove', async () => {
    const followUp = [{ name: 'follow-up' }];
    expect(
      closingRefFor({ number: 5834, title: 'follow-up(#1): 3 items deferred — x', body: '', labels: followUp })!.line,
    ).toBe('Addresses #5834');
    expect(
      closingRefFor({ number: 99, title: 'Sweep: ~30 crawlers', body: '', labels: followUp })!.line,
    ).toBe('Addresses #99');
    // #3378: un conteggio esplicito «1 item deferred» è autoritativo anche se il
    // titolo contiene la parola ordinaria «batch» — non è un aggregato.
    expect(
      closingRefFor({ number: 3378, title: 'follow-up(#1): 1 item deferred — batch backfill', body: '', labels: followUp })!.line,
    ).toBe('Closes #3378');
    // Senza label `follow-up` la regola non si applica: è una issue ordinaria.
    expect(
      closingRefFor({ number: 7, title: '3 items deferred', body: '', labels: [{ name: 'bug' }] })!.line,
    ).toBe('Closes #7');
    expect(closingRefFor({ title: 'senza numero' })).toBeNull();
  });

  it('il contratto e il mirror inline di pr-body-contract.yml danno la stessa risposta', async () => {
    // Il gate porta una COPIA di isAggregate() dentro `actions/github-script`.
    // Due copie divergono al primo ritocco, e divergerebbero in silenzio: qui
    // la copia del workflow viene estratta ed eseguita sugli stessi input.
    const wf = sources.find((s) => s.rel === '.github/workflows/pr-body-contract.yml');
    expect(wf, 'pr-body-contract.yml non trovato — il confronto sarebbe vacuo').toBeTruthy();
    const m = /const isAggregateTitleBody = \(t, b\) => \{([\s\S]*?)\n\s*\};/.exec(wf!.text);
    expect(m, 'blocco isAggregateTitleBody non estratto — il confronto sarebbe vacuo').toBeTruthy();
    // eslint-disable-next-line no-new-func
    const mirrored = new Function('t', 'b', m![1]) as (t: string, b: string) => boolean;

    const cases: Array<[string, string]> = [
      ['follow-up(#1): 3 items deferred — x', ''],
      ['follow-up(#1): 1 item deferred — batch backfill', ''],
      ['Sweep: ~30 crawlers', ''],
      ['fix(seo): un titolo qualunque', 'nessun conteggio'],
      ['follow-up(#1): 2 item deferred — y', ''],
      ['bulk retag', ''],
    ];
    for (const [title, body] of cases) {
      const mine = closingRefFor({ number: 1, title, body, labels: [{ name: 'follow-up' }] })!.aggregate;
      expect(mine, `divergenza gate/generatore su "${title}"`).toBe(Boolean(mirrored(title, body)));
    }
  });
});

describe('vocabolario condiviso generatore ↔ gate', () => {
  it('ogni forma che il generatore EMETTE è riconosciuta dal gate', async () => {
    for (const lit of RESIDUAL_STATE_LITERALS) {
      const bullet = `- qualcosa che resta da fare — ${lit.replace('<causa>', 'la quota del provider è esaurita').replace('#N', '#1234')}`;
      expect(bulletState(bullet), `il gate non riconosce lo stato "${lit}"`).not.toBeNull();
    }
  });

  it('un bullet senza stato resta senza stato (il riconoscitore non è permissivo)', async () => {
    expect(bulletState('- il resto della classe, fuori scope')).toBeNull();
    expect(bulletState('- da fare in un secondo momento')).toBeNull();
  });
});
