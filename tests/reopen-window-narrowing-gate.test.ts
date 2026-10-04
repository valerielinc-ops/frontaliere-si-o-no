import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { intFromEnv } from '../scripts/lib/int-from-env.mjs';

// Il creator e' sostituito da una spia: qui interessa COSA gli arriva, non che
// apra qualcosa. `execFileSync` e' neutralizzato perche' il reporter interroga
// la jobs API per l'estratto dello step fallito.
const { createGithubIssueSpy, resolveGithubIssueSpy } = vi.hoisted(() => ({
  createGithubIssueSpy: vi.fn(async () => ({ number: 1, title: 't', url: 'u' })),
  resolveGithubIssueSpy: vi.fn(async () => null),
}));
vi.mock('../scripts/lib/github-issue-creator.mjs', () => ({
  createGithubIssue: createGithubIssueSpy,
  resolveGithubIssue: resolveGithubIssueSpy,
  commentOnGithubIssue: vi.fn(async () => null),
}));
vi.mock('node:child_process', async (orig) => {
  const actual = await orig<typeof import('node:child_process')>();
  return { ...actual, default: actual, execFileSync: vi.fn(() => '') };
});

/**
 * Nessuno restringe in silenzio la finestra di riapertura.
 *
 * ## Il difetto che questo gate sorveglia
 *
 * #5850 ha reso la riapertura della gemella chiusa il comportamento NORMALE di
 * `scripts/lib/github-issue-creator.mjs`: chi non nomina `reopenWithinHours`
 * eredita `DEFAULT_REOPEN_WITHIN_HOURS` (720h). Restava però un modo di
 * spegnerla senza dirlo — un DEFAULT OMBRA un piano sopra il creator:
 *
 *  - `.github/actions/report-failure/action.yml` aveva `reopen-within-hours`
 *    con `default: '6'`, e i 7 workflow che adottano quella action non
 *    chiedevano 6h: le ricevevano;
 *  - `scripts/ci/report-workflow-failure.mjs` faceva
 *    `intFromEnv('REOPEN_WITHIN_HOURS', 6) || 6`, quindi anche con
 *    l'input vuoto il 6 tornava dentro.
 *
 * Il default di #5850 era corretto e non arrivava a quei chiamanti. È la stessa
 * forma del difetto originale: la protezione esiste, il ramo che la applica non
 * viene mai raggiunto.
 *
 * ## La misura che ha motivato il gate (2026-08-14)
 *
 *  - 22 issue con titolo IDENTICO `CI Failure (build): Deploy to GitHub Pages`
 *    (#1290 … #5864): una coniatura per ogni ricaduta oltre le 6h dal verde che
 *    aveva chiuso la precedente, su una issue che #5121 dichiara canonica;
 *  - #5868/#5869/#5872 (guard di ordinamento CDN, de/en/fr) coniate alle
 *    12:32-12:45Z mentre le gemelle #5773/#5772/#5771 erano chiuse COMPLETED da
 *    27,7h — fuori dalla finestra di 6h;
 *  - il contrasto che chiude la diagnosi: #5864, chiusa 12:32:46Z e RIAPERTA
 *    13:35:37Z, cioè 1,05h dopo, dentro i 6h. Il ramo di riapertura funziona:
 *    era la finestra a essere più corta della cadenza del guasto.
 *
 * ## Cosa pretende, e perché in questa forma
 *
 * Restringere resta legittimo — un validatore post-deploy collassa un flap
 * rosso→verde→rosso dentro UN ciclo (#928/#931/#937/#941) e le sue 6h sono
 * giuste. Quello che non è legittimo è restringere per eredità. Quindi ogni
 * finestra più stretta del default deve stare in `NARROWING_ALLOWLIST` con un
 * motivo scritto, e ogni voce dell'allowlist deve corrispondere a un call site
 * vivo (una voce orfana è un motivo che non descrive più niente).
 *
 * ## Come si mantiene onesto questo gate
 *
 * Il modo in cui un gate come questo muore è lo scanner, non l'asserzione: se
 * la regex smette di trovare i call site, l'insieme delle violazioni è vuoto e
 * il test passa VERDE su un repo interamente rotto. Per questo
 * `lo scanner trova davvero i call site` è un test a sé, con un pavimento sul
 * numero di invocazioni e sul numero di finestre esplicite estratte.
 */

const ROOT = join(__dirname, '..');
const CREATOR = 'scripts/lib/github-issue-creator.mjs';

/** Il default vero, letto dal sorgente: se sparisce o cambia forma, ROSSO. */
function readDefaultWindowHours(): number {
  const src = readFileSync(join(ROOT, CREATOR), 'utf8');
  const m = src.match(/const DEFAULT_REOPEN_WITHIN_HOURS\s*=\s*([^;]+);/);
  if (!m) throw new Error(`DEFAULT_REOPEN_WITHIN_HOURS non trovato in ${CREATOR}`);
  const expr = m[1].trim();
  if (!/^[\d\s*+]+$/.test(expr)) throw new Error(`espressione non aritmetica: ${expr}`);
  // eslint-disable-next-line no-new-func
  const value = Number(new Function(`return (${expr});`)());
  if (!Number.isFinite(value) || value <= 0) throw new Error(`default non plausibile: ${expr}`);
  return value;
}

const DEFAULT_WINDOW_H = readDefaultWindowHours();

/**
 * Finestre più strette del default, ammesse UNA PER UNA con il motivo.
 *
 * Chiave: `<path> :: <ancora> :: <espressione>`, mai il numero di riga.
 *  - `<ancora>` identifica il call site: `title:<titolo>` per un'invocazione
 *    CLI del creator o per l'input `with:` della composite action (il titolo è
 *    l'identità della issue che il call site conia), `fn:<funzione>` per una
 *    proprietà JS (la funzione che la contiene), `step:<nome>` se manca il
 *    titolo;
 *  - `<espressione>` è il testo normalizzato del costrutto che restringe
 *    (`--reopen-within-hours 6`, `reopen-within-hours: 6`,
 *    `reopenWithinHours: 6`, `--no-reopen`).
 *
 * Perché non la riga: con `<path>:<riga>:<ore>` ogni modifica SOPRA una voce
 * rompeva il gate due volte per la stessa riga di codice («restringimento non
 * dichiarato a :930:6» + «voce orfana :922:6», PR 11300, run 37168090373) senza
 * che il restringimento fosse cambiato. Con l'ancora, spostare il costrutto è
 * neutro; cambiarne il valore, il titolo o la funzione produce una chiave
 * nuova, e il restringimento va dichiarato di nuovo.
 *
 * Aggiungerne una senza motivo è il punto: si scrive il motivo o si toglie la
 * finestra.
 */
const NARROWING_ALLOWLIST: Record<string, string> = {
  '.github/workflows/post-deploy-validate-dist.yml :: title:Validation Failure (dist): post-deploy :: --reopen-within-hours 6':
    'validatore post-deploy: il fallback verificato passa --reopen-within-hours 6 e --build-sha "${INPUT_DEPLOY_REF}"; collassa il flap rosso→verde→rosso dentro UN ciclo di deploy (#928/#931/#937/#941) e ha il guard anti-latenza #5539.',
  '.github/workflows/post-deploy-validate-live.yml :: title:Validation Failure (live): post-deploy :: reopen-within-hours: 6':
    'codice verificato in post-deploy-validate-live.yml: lo step Report failure to GitHub Issues passa esplicitamente 6h; report-failure/action.yml ha default vuoto e il resolve gemello usa lo stesso titolo, quindi la finestra è intenzionale e limitata al ciclo corrente.',
  '.github/workflows/deploy-publish.yml :: title:CI Failure (deploy): ${{ github.workflow }} :: reopen-within-hours: 6':
    'codice verificato in deploy-publish.yml: lo step Report failure to GitHub Issues (deploy) passa esplicitamente reopen-within-hours: 6; report-failure/action.yml ha default vuoto e il resolve gemello chiude lo stesso titolo, quindi la finestra è intenzionale e limitata al ciclo corrente.',
  '.github/workflows/lighthouse-ci.yml :: title:Lighthouse regression on production (${{ matrix.form_factor }}) :: --reopen-within-hours 6':
    'gira per PR: due run della stessa PR sono lo stesso incidente, due PR diverse no.',
  '.github/workflows/cwv-field-criterion.yml :: title:CWV field criterion unreadable (#5001 gate blind) :: --reopen-within-hours 24':
    'cadenza giornaliera del criterio di campo: la finestra segue il cron.',
  '.github/workflows/cwv-field-criterion.yml :: title:CWV field regression on a tracked page (#5001 watchlist) :: --reopen-within-hours 168':
    'la seconda soglia dello stesso workflow lavora su finestra settimanale: 168h = il suo periodo.',
  '.github/workflows/cf-otto-route-monitor.yml :: title:OTTO/SearchAtlas Cloudflare routes re-appeared on production :: --reopen-within-hours 24':
    'monitor giornaliero delle route: finestra allineata al cron.',
  '.github/workflows/job-description-locale-audit.yml :: title:Job description locale quality: daily snapshot :: --reopen-within-hours 72':
    'audit ogni 3 giorni: 72h = il suo periodo.',
  '.github/workflows/job-title-locale-audit.yml :: title:Job title locale quality: weekly snapshot :: --reopen-within-hours 336':
    'audit quindicinale: 336h = il suo periodo.',
  'scripts/ci/report-validate-dist-failure.mjs :: fn:reportDist :: reopenWithinHours: 6':
    'ramo `reportDist` (post-deploy, con buildSha): è il caso benedetto dei 6h. Il ramo `reportBuild` dello stesso file NON nomina più la finestra ed eredita il default.',
  'scripts/ci/review-gate.mjs :: fn:mintFollowup :: reopenWithinHours: 0':
    'follow-up di scope già drenata: una issue completata non deve riaprirsi e reinserire finding già risolti nel ciclo successivo.',
};

/**
 * `line` serve solo a dire DOVE guardare in un messaggio d'errore: la chiave
 * della allowlist è `anchor` + `raw`, che non dipendono dalla posizione.
 */
type Site = { file: string; line: number; hours: number | null; raw: string; anchor: string | null };

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === '.git') continue;
      walk(p, out);
    } else if (/\.(ya?ml|mjs|js|cjs)$/.test(name)) out.push(p);
  }
  return out;
}

const FILES = [...walk(join(ROOT, '.github')), ...walk(join(ROOT, 'scripts'))];

/**
 * Un'invocazione CLI si estende finché la riga finisce con `\` OPPURE finché
 * siamo dentro una stringa `"…"` non chiusa: `--description "…"` multilinea è
 * la forma normale in questo repo, e una continuazione a soli backslash la
 * troncherebbe PRIMA dei flag — che è esattamente come si perde una finestra.
 */
function cliBlockAt(lines: string[], i: number): string {
  let block = '';
  let inStr = false;
  for (let j = i; j < lines.length && j - i < 300; j++) {
    block += (j > i ? '\n' : '') + lines[j];
    for (const ch of lines[j]) if (ch === '"') inStr = !inStr;
    if (!inStr && !/\\\s*$/.test(lines[j])) break;
  }
  return block;
}

/**
 * Legge la proprietà JS anche quando il formatter la divide su più righe.
 * Un valore non valutabile resta una finestra non classificabile (`null`): non
 * deve sparire dallo scan, né diventare un restringimento inventato.
 */
function jsWindowAt(lines: string[], i: number): { hours: number | null; raw: string } | null {
  let block = '';
  for (let j = i; j < lines.length && j - i < 50; j++) {
    block += (j > i ? '\n' : '') + lines[j];
    // Il valore finisce alla prima `,`, `}` o fine riga, senza commenti in coda:
    // altrimenti `{ reopenWithinHours: 6 }` darebbe `6 }`, `numOrNull` → null,
    // e il restringimento sparirebbe dal gate in silenzio.
    const match = block.match(/\breopenWithinHours\s*:\s*([^,}\n]+)/);
    if (match) {
      const value = match[1].replace(/\/\*.*?\*\/|\/\/.*$/g, '').trim();
      return { hours: numOrNull(value), raw: normalizeExpr(`reopenWithinHours: ${value}`) };
    }
    if (j > i && /^\s*[}\]]/.test(lines[j])) break;
  }
  return null;
}

/**
 * Scansiona sorgenti già letti. `scan()` la usa sul repo; i test dell'ancora la
 * usano su una copia modificata di un file vero, così la prova passa per lo
 * stesso scanner che giudica il repo e non per una sua imitazione.
 */
function scanSources(sources: Array<{ file: string; src: string }>): { creates: Site[]; windows: Site[] } {
  const creates: Site[] = [];
  const windows: Site[] = [];
  for (const { file, src } of sources) {
    if (!src.includes('github-issue-creator') && !src.includes('createGithubIssue')
      && !src.includes('reopen-within-hours')) continue;
    const lines = src.split('\n');

    for (let i = 0; i < lines.length; i++) {
      // (a) invocazioni CLI del creator, escluse quelle di sola chiusura
      if (/(?:node|tsx)\s+\S*github-issue-creator\.mjs/.test(lines[i])) {
        const block = cliBlockAt(lines, i);
        if (/--resolve\b/.test(block)) continue;
        const anchor = cliTitleAnchor(block) ?? stepNameAnchor(lines, i);
        creates.push({ file, line: i + 1, hours: null, raw: lines[i].trim(), anchor });
        const m = block.match(/--reopen-within-hours\s+"?([^\s"\\]+)"?/);
        if (m) windows.push({ file, line: i + 1, hours: numOrNull(m[1]), raw: normalizeExpr(m[0]), anchor });
        else if (/--no-reopen\b/.test(block)) windows.push({ file, line: i + 1, hours: 0, raw: '--no-reopen', anchor });
        continue;
      }
      // Le righe di COMMENTO non sono call site. Senza questo salto il gate
      // legge le note che spiegano la fix (`… non nomina più
      // `reopenWithinHours: 6``) come se fossero codice, e si accusa da solo —
      // trovato eseguendolo, non ragionandoci.
      if (/^\s*(#|\/\/|\*|\/\*)/.test(lines[i])) continue;
      // (b) opzione passata come proprietà dai chiamanti JS
      if (/\breopenWithinHours\s*:/.test(lines[i])) {
        const js = jsWindowAt(lines, i);
        const fn = enclosingFunctionName(lines, i);
        if (js) windows.push({
          file,
          line: i + 1,
          hours: js.hours,
          raw: js.raw,
          anchor: fn ? `fn:${fn}` : null,
        });
      }
      // (c) input della composite action, e chi lo passa da un workflow
      const yml = lines[i].match(/^\s*reopen-within-hours:\s*'?([^'\s#]+)'?/);
      if (yml) windows.push({
        file,
        line: i + 1,
        hours: numOrNull(yml[1]),
        raw: normalizeExpr(`reopen-within-hours: ${yml[1]}`),
        anchor: yamlSiblingTitleAnchor(lines, i) ?? stepNameAnchor(lines, i),
      });
    }
  }
  return { creates, windows };
}

function scan(): { creates: Site[]; windows: Site[] } {
  return scanSources(FILES.map((abs) => ({ file: relative(ROOT, abs), src: readFileSync(abs, 'utf8') })));
}

/** Il testo del costrutto senza virgolette né spaziature: `"6"` e `6` sono lo stesso. */
function normalizeExpr(raw: string): string {
  return raw.replace(/['"]/g, '').replace(/\s+/g, ' ').trim();
}

function unquote(raw: string): string {
  const t = raw.trim();
  const q = t.match(/^(['"])(.*)\1$/s);
  return q ? q[2] : t;
}

/** `--title "…"` del blocco CLI: è l'identità della issue che il call site conia. */
function cliTitleAnchor(block: string): string | null {
  const m = block.match(/--title\s+(?:"([^"]*)"|'([^']*)'|(\S+))/);
  const title = m ? (m[1] ?? m[2] ?? m[3]) : null;
  return title ? `title:${title.trim()}` : null;
}

/**
 * `title:` fratello di `reopen-within-hours:` nello stesso blocco `with:` della
 * composite action: stessa indentazione, cercato sopra e sotto finché il blocco
 * non si chiude (riga meno indentata).
 */
function yamlSiblingTitleAnchor(lines: string[], i: number): string | null {
  const indent = (l: string) => l.match(/^\s*/)![0].length;
  const own = indent(lines[i]);
  for (const step of [-1, 1]) {
    for (let j = i + step; j >= 0 && j < lines.length; j += step) {
      if (lines[j].trim() === '' || /^\s*#/.test(lines[j])) continue;
      if (indent(lines[j]) < own) break;
      if (indent(lines[j]) !== own) continue;
      const m = lines[j].match(/^\s*title:\s*(.+?)\s*$/);
      if (m) return `title:${unquote(m[1])}`;
    }
  }
  return null;
}

/** Ripiego quando manca il titolo: il nome dello step che contiene la riga. */
function stepNameAnchor(lines: string[], i: number): string | null {
  for (let j = i; j >= 0; j--) {
    const m = lines[j].match(/^\s*-\s+name:\s*(.+?)\s*$/);
    if (m) return `step:${unquote(m[1])}`;
  }
  return null;
}

function numOrNull(raw: string): number | null {
  const t = raw.trim().replace(/^['"]|['"]$/g, '');
  const n = Number(t);
  return t !== '' && Number.isFinite(n) ? n : null;
}

// Una proprietà JS si ancora alla funzione che la contiene: il nome resta
// stabile quando inserimenti sopra il call site spostano le righe del file.
function enclosingFunctionName(lines: string[], i: number): string | null {
  for (let j = i; j >= 0; j--) {
    const match = lines[j].match(/^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/);
    if (match) return match[1];
  }
  return null;
}

/**
 * Chiave stabile: file, ancora del call site, testo del costrutto. Nessun numero
 * di riga. Un'ancora mancante resta `?`: due call site senza ancora nello stesso
 * file con lo stesso costrutto collidono, e `un anchor stabile non accorpa due
 * call site distinti` lo fa ROSSO invece di fonderli in silenzio.
 */
function siteKey(site: Site): string {
  return `${site.file} :: ${site.anchor ?? '?'} :: ${site.raw}`;
}

function isNarrowing(w: Site): boolean {
  return w.hours !== null && w.hours < DEFAULT_WINDOW_H;
}

/**
 * Confronta i restringimenti trovati con la allowlist. Con `files` limita il
 * confronto (anche delle voci orfane) a quei file: serve ai test che rianalizzano
 * un solo file modificato.
 */
function auditAllowlist(found: Site[], files?: Set<string>): { undeclared: string[]; orphans: string[] } {
  const narrowings = found.filter(isNarrowing);
  const live = new Set(narrowings.map(siteKey));
  const inScope = (key: string) => !files || files.has(key.split(' :: ')[0]);
  return {
    undeclared: narrowings
      .filter((w) => !(siteKey(w) in NARROWING_ALLOWLIST))
      .map((w) => `${siteKey(w)} (a ${w.file}:${w.line})`),
    orphans: Object.keys(NARROWING_ALLOWLIST).filter((k) => inScope(k) && !live.has(k)),
  };
}

const { creates, windows } = scan();

describe('lo scanner trova davvero i call site (anti-gate-vacuo)', () => {
  it('il default del creator si legge dal sorgente ed è quello atteso', () => {
    expect(DEFAULT_WINDOW_H).toBe(720);
  });

  it('trova le invocazioni di creazione, non zero', () => {
    // Pavimento largo: i soli crawler-group-*.yml ne portano ~600. Serve a far
    // ROSSO uno scanner rotto, non a fotografare il conteggio esatto.
    expect(creates.length).toBeGreaterThan(500);
  });

  it('estrae davvero delle finestre esplicite', () => {
    expect(windows.length).toBeGreaterThanOrEqual(8);
  });

  it('legge una finestra che sta DOPO una --description multilinea', () => {
    // Il caso che una continuazione a soli backslash perderebbe: la finestra di
    // post-deploy-validate-dist.yml è separata dal `node …` da ~90 righe di
    // description fra virgolette.
    const deep = windows.filter((w) => w.file.endsWith('post-deploy-validate-dist.yml'));
    expect(deep.length).toBeGreaterThanOrEqual(1);
    expect(deep[0].hours).toBe(6);
  });

  it('legge una proprietà JS spezzata su più righe', () => {
    const parsed = jsWindowAt([
      'const options = {',
      '  reopenWithinHours:',
      '    6,',
      '};',
    ], 1);
    expect(parsed?.hours).toBe(6);
  });

  it('legge una proprietà JS inline o commentata senza inghiottire `}` o il commento', () => {
    const inline = jsWindowAt(['createGithubIssue({ title, reopenWithinHours: 6 });'], 0);
    expect(inline).toEqual({ hours: 6, raw: 'reopenWithinHours: 6' });
    const commented = jsWindowAt(['  reopenWithinHours: 6 // ciclo corrente', '};'], 0);
    expect(commented).toEqual({ hours: 6, raw: 'reopenWithinHours: 6' });
  });
});

describe('nessun DEFAULT OMBRA sopra il creator', () => {
  it('report-failure/action.yml non impone una finestra a chi non la chiede', () => {
    const src = readFileSync(join(ROOT, '.github/actions/report-failure/action.yml'), 'utf8');
    const block = src.split(/^\s{2}reopen-within-hours:/m)[1] ?? '';
    const def = block.match(/^\s{4}default:\s*(.*)$/m)?.[1]?.trim() ?? '';
    expect(def.replace(/['"]/g, '')).toBe('');
  });

  it('report-workflow-failure.mjs non rimette un numero al posto dell input vuoto', () => {
    const src = readFileSync(join(ROOT, 'scripts/ci/report-workflow-failure.mjs'), 'utf8');
    const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    // Nessun letterale numerico agganciato a REOPEN_WITHIN_HOURS: né `|| '6'`,
    // né `?? 6`, né `) || 6`. Il coercing a stringa vuota (`|| ''`) resta
    // lecito — è l'assenza dell'input, non una finestra.
    const line = code.split('\n').find((l) => l.includes('REOPEN_WITHIN_HOURS')) ?? '';
    expect(line, 'REOPEN_WITHIN_HOURS non letto').not.toBe('');
    expect(line).not.toMatch(/(\|\||\?\?)\s*['"]?[1-9]/);
    // L'assegnazione deve poter valere `null` (= eredita il default) e non può
    // contenere un numero di ore cablato.
    const assigned = code.match(/const reopenWithinHours\s*=\s*(.+)/)?.[1] ?? '';
    expect(assigned).toMatch(/null/);
    expect(assigned).not.toMatch(/\b[1-9]\d*\b/);
  });
});

/**
 * La meta' COMPORTAMENTALE: le due asserzioni statiche qui sopra leggono il
 * sorgente, e un sorgente si puo' riscrivere in una forma che le soddisfa senza
 * cambiare cio' che arriva al creator. Questo blocco chiama davvero
 * `reportMode` e guarda l'argomento.
 */
describe('report-workflow-failure passa al creator cio che l input dice', () => {
  const ENV = ['REOPEN_WITHIN_HOURS', 'FAILURE_TITLE', 'CLOSED_BY', 'GH_REPO',
    'RUN_ID', 'JOB_KEY', 'WORKFLOW_NAME', 'ISSUE_PRIORITY', 'ISSUE_LABELS'];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
    process.env.FAILURE_TITLE = 'Workflow Failure: Gate di prova';
    process.env.CLOSED_BY = 'close-recovered-failure-issues';
    process.env.WORKFLOW_NAME = 'Gate di prova';
    createGithubIssueSpy.mockClear();
  });
  afterEach(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  });

  it('input VUOTO → nessuna finestra al creator (eredita il default)', async () => {
    const { reportMode } = await import('../scripts/ci/report-workflow-failure.mjs');
    await reportMode({ dryRun: false });
    expect(createGithubIssueSpy).toHaveBeenCalledTimes(1);
    expect(createGithubIssueSpy.mock.calls[0][0].reopenWithinHours).toBeNull();
  });

  it('input `0` → opt-out esplicito, e NON collassa a `null`', async () => {
    process.env.REOPEN_WITHIN_HOURS = '0';
    const { reportMode } = await import('../scripts/ci/report-workflow-failure.mjs');
    await reportMode({ dryRun: false });
    expect(createGithubIssueSpy.mock.calls[0][0].reopenWithinHours).toBe(0);
  });

  it('input numerico → restringe, come chiesto', async () => {
    process.env.REOPEN_WITHIN_HOURS = '6';
    const { reportMode } = await import('../scripts/ci/report-workflow-failure.mjs');
    await reportMode({ dryRun: false });
    expect(createGithubIssueSpy.mock.calls[0][0].reopenWithinHours).toBe(6);
  });
});

describe('ogni restringimento della finestra è dichiarato e motivato', () => {
  const narrowings = windows.filter(isNarrowing);

  it('nessuna finestra più stretta del default fuori dall allowlist', () => {
    expect(auditAllowlist(windows).undeclared).toEqual([]);
  });

  it('ogni restringimento ha un ancora: titolo, funzione o step', () => {
    expect(narrowings.filter((w) => !w.anchor).map((w) => `${w.file}:${w.line}`)).toEqual([]);
  });

  it('nessuna voce dell allowlist è indicizzata per numero di riga', () => {
    // La forma `<path>:<riga>:<ore>` è quella che andava rossa a ogni modifica
    // sopra la voce: non deve rientrare per copia da una voce vecchia.
    const lineKeyed = Object.keys(NARROWING_ALLOWLIST).filter((k) => /:\d+:\d+$/.test(k) || !k.includes(' :: '));
    expect(lineKeyed).toEqual([]);
  });

  it('ogni voce dell allowlist porta un motivo, non un segnaposto', () => {
    for (const [key, why] of Object.entries(NARROWING_ALLOWLIST)) {
      expect(why.length, `motivo troppo corto per ${key}`).toBeGreaterThan(40);
      expect(why, `motivo non sostanzioso per ${key}`).not.toMatch(/^(fuori scope|TODO|n\/?a)\b/i);
    }
  });

  it('nessuna voce orfana: l allowlist descrive call site vivi', () => {
    expect(auditAllowlist(windows).orphans).toEqual([]);
  });

  it('un anchor stabile non accorpa due call site distinti', () => {
    const keys = narrowings.map(siteKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('i due reporter riparati NON nominano più una finestra', () => {
    // deploy.yml: i due step surface↔resolve della coppia #2569/#2658.
    const deployWindows = windows.filter((w) => w.file === '.github/workflows/deploy.yml');
    expect(deployWindows.map((w) => `${w.line}:${w.hours}`)).toEqual([]);
    // report-validate-dist-failure.mjs: resta SOLO il ramo post-deploy.
    const vd = windows.filter((w) => w.file === 'scripts/ci/report-validate-dist-failure.mjs');
    expect(vd.length).toBe(1);
    expect(vd[0].hours).toBe(6);
  });
});

/**
 * La misura della scheda NX-RW-1, come test: il gate segue il COSTRUTTO.
 *
 * Il difetto (PR 11300, run 37168090373): il commit 924d1a0737 ha aggiunto 8
 * righe sopra `reopenWithinHours: 6` in `report-validate-dist-failure.mjs`, e
 * con la chiave `<path>:<riga>:<ore>` il gate ha segnalato insieme «non
 * dichiarato :930:6» e «orfana :922:6» per la stessa riga di codice.
 *
 * Ogni caso prende un file VERO, lo modifica in memoria e lo ripassa per lo
 * stesso `scanSources` che giudica il repo. Un caso per forma di call site:
 * proprietà JS, invocazione CLI del creator, input `with:` della composite.
 */
describe('la allowlist si ancora al costrutto, non alla riga', () => {
  const CASES = [
    { kind: 'proprietà JS', file: 'scripts/ci/report-validate-dist-failure.mjs' },
    { kind: 'invocazione CLI', file: '.github/workflows/cwv-field-criterion.yml' },
    { kind: 'input della composite action', file: '.github/workflows/deploy-publish.yml' },
  ];

  /** Il primo restringimento dichiarato del file, e la riga che porta il valore. */
  function declaredSite(file: string): { site: Site; lines: string[]; valueLine: number } {
    const site = windows.find((w) => w.file === file && isNarrowing(w));
    if (!site) throw new Error(`nessun restringimento in ${file}: il caso non proverebbe niente`);
    expect(siteKey(site) in NARROWING_ALLOWLIST, `${siteKey(site)} non è dichiarato`).toBe(true);
    const lines = readFileSync(join(ROOT, file), 'utf8').split('\n');
    // Per un'invocazione CLI `site.line` è la riga `node …`: il valore sta più
    // sotto, dentro lo stesso blocco.
    let valueLine = site.line - 1;
    while (valueLine < lines.length && !/reopen-within-hours|reopenWithinHours/.test(lines[valueLine])) valueLine++;
    if (valueLine >= lines.length) throw new Error(`valore della finestra non trovato in ${file}`);
    return { site, lines, valueLine };
  }

  for (const { kind, file } of CASES) {
    it(`${kind}: dieci righe vuote sopra il restringimento lasciano il gate verde`, () => {
      const { site, lines } = declaredSite(file);
      const shifted = [...lines.slice(0, site.line - 1), ...Array(10).fill(''), ...lines.slice(site.line - 1)];
      const rescanned = scanSources([{ file, src: shifted.join('\n') }]).windows;
      const moved = rescanned.find((w) => siteKey(w) === siteKey(site));
      expect(moved?.line, 'lo scanner deve ritrovare il costrutto più in basso').toBe(site.line + 10);
      expect(auditAllowlist(rescanned, new Set([file]))).toEqual({ undeclared: [], orphans: [] });
    });

    it(`${kind}: cambiare l espressione del restringimento rende il gate rosso`, () => {
      const { site, lines, valueLine } = declaredSite(file);
      const changed = [...lines];
      const widened = String(site.hours! + 1);
      changed[valueLine] = changed[valueLine].replace(new RegExp(`\\b${site.hours}\\b`), widened);
      expect(changed[valueLine], 'la mutazione deve toccare il valore').not.toBe(lines[valueLine]);
      const rescanned = scanSources([{ file, src: changed.join('\n') }]).windows;
      const audit = auditAllowlist(rescanned, new Set([file]));
      expect(audit.undeclared.some((u) => u.includes(`${widened}`) && u.startsWith(`${file} :: ${site.anchor}`))).toBe(true);
      expect(audit.orphans).toContain(siteKey(site));
    });
  }
});

