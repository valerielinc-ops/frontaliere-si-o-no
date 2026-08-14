import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

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
 *    `Number(process.env.REOPEN_WITHIN_HOURS || '6') || 6`, quindi anche con
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
 * Chiave: `<path>:<ore>`. Aggiungerne una senza motivo è il punto: si scrive
 * il motivo o si toglie la finestra.
 */
const NARROWING_ALLOWLIST: Record<string, string> = {
  '.github/workflows/post-deploy-validate-dist.yml:6':
    'validatore post-deploy: collassa il flap rosso→verde→rosso dentro UN ciclo di deploy (#928/#931/#937/#941). Passa anche --build-sha, quindi ha il guard anti-latenza #5539.',
  '.github/workflows/post-deploy-validate-live.yml:6':
    'stessa famiglia post-deploy del precedente: la ricaduta che conta è quella dentro il ciclo, non quella a giorni.',
  '.github/workflows/deploy-publish.yml:6':
    'riporta l esito della pubblicazione dello stesso deploy: oltre il ciclo corrente la condizione non è più la stessa.',
  '.github/workflows/lighthouse-ci.yml:6':
    'gira per PR: due run della stessa PR sono lo stesso incidente, due PR diverse no.',
  '.github/workflows/cwv-field-criterion.yml:24':
    'cadenza giornaliera del criterio di campo: la finestra segue il cron.',
  '.github/workflows/cwv-field-criterion.yml:168':
    'la seconda soglia dello stesso workflow lavora su finestra settimanale: 168h = il suo periodo.',
  '.github/workflows/cf-otto-route-monitor.yml:24':
    'monitor giornaliero delle route: finestra allineata al cron.',
  '.github/workflows/job-description-locale-audit.yml:72':
    'audit ogni 3 giorni: 72h = il suo periodo.',
  '.github/workflows/job-title-locale-audit.yml:336':
    'audit quindicinale: 336h = il suo periodo.',
  'scripts/ci/report-validate-dist-failure.mjs:6':
    'ramo `reportValidateDist` (post-deploy, con buildSha): è il caso benedetto dei 6h. Il ramo `reportBuild` dello stesso file NON nomina più la finestra ed eredita il default.',
};

type Site = { file: string; line: number; hours: number | null; raw: string };

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

function scan(): { creates: Site[]; windows: Site[] } {
  const creates: Site[] = [];
  const windows: Site[] = [];
  for (const abs of FILES) {
    const file = relative(ROOT, abs);
    const src = readFileSync(abs, 'utf8');
    if (!src.includes('github-issue-creator') && !src.includes('createGithubIssue')
      && !src.includes('reopen-within-hours')) continue;
    const lines = src.split('\n');

    for (let i = 0; i < lines.length; i++) {
      // (a) invocazioni CLI del creator, escluse quelle di sola chiusura
      if (/(?:node|tsx)\s+\S*github-issue-creator\.mjs/.test(lines[i])) {
        const block = cliBlockAt(lines, i);
        if (/--resolve\b/.test(block)) continue;
        creates.push({ file, line: i + 1, hours: null, raw: lines[i].trim() });
        const m = block.match(/--reopen-within-hours\s+"?([^\s"\\]+)"?/);
        if (m) windows.push({ file, line: i + 1, hours: numOrNull(m[1]), raw: m[0] });
        else if (/--no-reopen\b/.test(block)) windows.push({ file, line: i + 1, hours: 0, raw: '--no-reopen' });
        continue;
      }
      // Le righe di COMMENTO non sono call site. Senza questo salto il gate
      // legge le note che spiegano la fix (`… non nomina più
      // `reopenWithinHours: 6``) come se fossero codice, e si accusa da solo —
      // trovato eseguendolo, non ragionandoci.
      if (/^\s*(#|\/\/|\*|\/\*)/.test(lines[i])) continue;
      // (b) opzione passata come proprietà dai chiamanti JS
      const js = lines[i].match(/\breopenWithinHours\s*:\s*([^,\n]+)/);
      if (js) windows.push({ file, line: i + 1, hours: numOrNull(js[1]), raw: lines[i].trim() });
      // (c) input della composite action, e chi lo passa da un workflow
      const yml = lines[i].match(/^\s*reopen-within-hours:\s*'?([^'\s#]+)'?/);
      if (yml) windows.push({ file, line: i + 1, hours: numOrNull(yml[1]), raw: lines[i].trim() });
    }
  }
  return { creates, windows };
}

function numOrNull(raw: string): number | null {
  const t = raw.trim().replace(/^['"]|['"]$/g, '');
  const n = Number(t);
  return t !== '' && Number.isFinite(n) ? n : null;
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
  const narrowings = windows.filter((w) => w.hours !== null && w.hours < DEFAULT_WINDOW_H);

  it('nessuna finestra più stretta del default fuori dall allowlist', () => {
    const undeclared = narrowings
      .map((w) => ({ key: `${w.file}:${w.hours}`, at: `${w.file}:${w.line}` }))
      .filter((w) => !(w.key in NARROWING_ALLOWLIST));
    expect(undeclared).toEqual([]);
  });

  it('ogni voce dell allowlist porta un motivo, non un segnaposto', () => {
    for (const [key, why] of Object.entries(NARROWING_ALLOWLIST)) {
      expect(why.length, `motivo troppo corto per ${key}`).toBeGreaterThan(40);
      expect(why, `motivo non sostanzioso per ${key}`).not.toMatch(/^(fuori scope|TODO|n\/?a)\b/i);
    }
  });

  it('nessuna voce orfana: l allowlist descrive call site vivi', () => {
    const live = new Set(narrowings.map((w) => `${w.file}:${w.hours}`));
    const orphans = Object.keys(NARROWING_ALLOWLIST).filter((k) => !live.has(k));
    expect(orphans).toEqual([]);
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
