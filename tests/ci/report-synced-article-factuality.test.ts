import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Guardie per il reporter di factuality sugli articoli appena sincronizzati
 * (issue #5595).
 *
 * Il difetto riparato NON era il gate — `scripts/lib/article-factuality-gates.mjs`
 * è deterministico e segnala correttamente l'articolo citato nell'issue. Era
 * che il gate non era collegato al percorso che pubblica davvero: dal cutover
 * 2026-08-02 (#4974) i body arrivano da nanakokyobashi-rgb/frontaliere-articles
 * attraverso `.github/workflows/sync-articles-sitemaps.yml`, che committa
 * `packages/articles/content` DIRETTAMENTE su `main` senza PR. Su quel percorso
 * ogni hook basato su un diff committato è morto:
 *
 *   - `pull_request` non esiste;
 *   - la run `push: branches: [main]` di tests.yml non parte nemmeno — il sync
 *     pusha col GITHUB_TOKEN del workflow e GitHub non innesca workflow su quei
 *     push (misurato 2026-08-11: il commit di sync 7f1a3b4f ha 4 check-run,
 *     tutte `schedule`/`workflow_run`, zero `push`);
 *   - e se partisse, su un push `github.base_ref` è vuoto, quindi
 *     `--changed origin/${{ github.base_ref || 'main' }}` diffa `origin/main`
 *     con se stesso → scope vuoto → verde senza aver verificato niente.
 *
 * Questi test coprono le due metà che restano: che `--changed-worktree` esista
 * e dichiari il proprio scope in modo distinguibile da un no-op, e che il
 * reporter non possa perdere il proprio messaggio (corpo issue oltre il limite
 * GitHub, o script nominato dal workflow e non presente).
 */

const ROOT = path.resolve(__dirname, '..', '..');

const {
  ISSUE_TITLE,
  isEscalatable,
  issueScope,
  buildReportIssue,
  buildStepSummary,
} = await import('../../scripts/ci/report-synced-article-factuality.mjs');

/** Finding sintetico nella forma emessa da audit-article-factuality.mjs --json. */
function finding(
  over: Partial<{ id: string; locale: string; criticalCount: number; issueCount: number; issues: unknown[] }> = {},
) {
  return {
    id: 'articolo-di-prova',
    locale: 'it',
    criticalCount: 0,
    issueCount: 1,
    worst: 2,
    issues: [
      {
        code: 'unknown-institution',
        severity: 'major',
        message: 'Ente non in allowlist: "Autorità di controllo del turismo svizzero (ACTS)"',
        evidence: 'Autorità di controllo del turismo svizzero (ACTS)',
      },
    ],
    ...over,
  };
}

describe('regola di escalation', () => {
  /**
   * La regola è su SEVERITÀ + LOCALE, non su un elenco di codici: un codice
   * aggiunto in futuro escala per default invece di restare fuori scope in
   * silenzio. È la stessa forma di difetto — una lista che invecchia e
   * restringe la copertura senza dirlo — che questo lavoro sta rimuovendo.
   */
  it('escala un finding italiano anche solo `major`', () => {
    // Il caso REALE dell'issue #5595: l'ente inventato nel body italiano è
    // `major`, non `critical`. Una regola "solo critical" lo perderebbe.
    expect(isEscalatable(finding({ locale: 'it' }), 'it-or-critical')).toBe(true);
  });

  it('non escala un `major` di traduzione', () => {
    // 3.359 occorrenze di translation-number-dropped su 3.535 finding totali
    // (misura 2026-08-11): escalarle significherebbe ~13 commenti al giorno.
    for (const locale of ['en', 'de', 'fr']) {
      expect(isEscalatable(finding({ locale }), 'it-or-critical')).toBe(false);
    }
  });

  it('escala un `critical` in qualunque locale', () => {
    expect(isEscalatable(finding({ locale: 'de', criticalCount: 2 }), 'it-or-critical')).toBe(true);
    expect(isEscalatable(finding({ locale: 'de', criticalCount: 2 }), 'critical')).toBe(true);
  });

  it('gli scope espliciti sostituiscono la regola di default', () => {
    expect(isEscalatable(finding({ locale: 'fr' }), 'all')).toBe(true);
    expect(isEscalatable(finding({ locale: 'it' }), 'critical')).toBe(false);
  });

  it('uno scope sconosciuto ricade sul default invece di disattivare tutto', () => {
    expect(issueScope({ FACTUALITY_ISSUE_SCOPE: 'boh' })).toBe('it-or-critical');
    expect(issueScope({})).toBe('it-or-critical');
    expect(issueScope({ FACTUALITY_ISSUE_SCOPE: 'all' })).toBe('all');
  });

  /**
   * ── Flusso, non stock (#5661, riapertura del 2026-09-05) ──────────────────
   *
   * #5661 e' stata chiusa alle 21:31:13Z e riaperta alle 22:05:00Z: 34 minuti.
   * L'unico articolo segnalato in quel sync,
   * `vivere-tovo-di-sant-agata-e-lavorare-in-grigioni-da-frontaliere`, era
   * stato GENERATO il 2026-08-11T08:43:30Z — 25 giorni prima della guardia di
   * ammissione (corpus #951, 2026-09-05T21:29:43Z) — ed era entrato nel diff
   * del sync solo perche' la PR corpus #915 gli aveva corretto un errore
   * geografico alle 17:41Z. Il suo `translation-false-friend` non e'
   * «ricomparso»: non se n'e' mai andato, e nessuna guardia di ammissione puo'
   * riguardare un testo scritto prima che esistesse.
   *
   * Senza questo filtro la issue e' immortale per costruzione: basta toccare
   * uno qualunque dei ~2.400 articoli con rilievi preesistenti per riaprirla,
   * e ogni riapertura consuma un tentativo del ciclo. Uno stock storico non e'
   * una ricorrenza, e' un residuo noto e dichiarato.
   */
  it('non escala un articolo gia\' pubblicato che il sync ha solo modificato', () => {
    const vecchio = finding({ locale: 'de', criticalCount: 2, id: 'articolo-di-agosto' });
    const nuoviDiQuestoSync = new Set(['articolo-appena-ammesso']);
    // `critical` in de: senza il filtro flusso/stock questo escalerebbe.
    expect(isEscalatable(vecchio, 'it-or-critical')).toBe(true);
    expect(isEscalatable(vecchio, 'it-or-critical', nuoviDiQuestoSync)).toBe(false);
    // Nemmeno `all` deve poter riscalare lo stock: lo scope allarga le
    // severita', non riapre il corpus gia' pubblicato.
    expect(isEscalatable(vecchio, 'all', nuoviDiQuestoSync)).toBe(false);
  });

  it('escala un articolo ammesso in questo sync', () => {
    const nuovo = finding({ locale: 'de', criticalCount: 2, id: 'articolo-appena-ammesso' });
    const nuoviDiQuestoSync = new Set(['articolo-appena-ammesso']);
    expect(isEscalatable(nuovo, 'it-or-critical', nuoviDiQuestoSync)).toBe(true);
  });

  it('se flusso e stock non sono distinguibili NON smette di segnalare', () => {
    // Fail-open deliberato: git muto non deve trasformare il reporter in un
    // no-op silenzioso — la forma di difetto che questi script esistono per
    // evitare. Meglio una issue di troppo che una condizione vera persa.
    const f = finding({ locale: 'de', criticalCount: 2, id: 'articolo-di-agosto' });
    expect(isEscalatable(f, 'it-or-critical', 'unavailable')).toBe(true);
    expect(isEscalatable(f, 'it-or-critical', null)).toBe(true);
  });
});

describe('corpo della issue', () => {
  it('resta sotto il limite GitHub anche con un sync anomalo', () => {
    // Un refresh dell'intero corpus (o una riscrittura a monte) può cambiare
    // migliaia di body in un colpo solo. GitHub rifiuta un body oltre 65.536
    // caratteri, e `gh issue create` che fallisce verrebbe inghiottito dal
    // catch di main(): la issue non verrebbe aperta e il run resterebbe verde.
    // Troncare degrada; fallire sparisce.
    const many = Array.from({ length: 4000 }, (_, n) =>
      finding({ id: `articolo-${n}`, issueCount: 40, issues: Array.from({ length: 40 }, () => finding().issues[0]) }),
    );
    const { description } = buildReportIssue({ scanned: 16000, flagged: many.length, findings: many }, many, undefined);
    expect(description.length).toBeLessThan(65536);
  });

  it('tronca esplicitamente invece di emettere un corpo che GitHub rifiuta', () => {
    // I cap per numero (25 articoli × 8 problemi) da soli non bastano: un
    // singolo messaggio molto lungo li supera. Il tetto sui caratteri è la
    // rete finale, e deve DIRE di aver troncato.
    const long = {
      code: 'unknown-institution',
      severity: 'major',
      message: 'x'.repeat(5000),
      evidence: 'y'.repeat(400),
    };
    const heavy = Array.from({ length: 25 }, (_, n) =>
      finding({ id: `articolo-${n}`, issueCount: 8, issues: Array.from({ length: 8 }, () => long) }),
    );
    const { description } = buildReportIssue({ scanned: 100, flagged: 25, findings: heavy }, heavy, undefined);
    expect(description.length).toBeLessThan(65536);
    expect(description).toContain('troncato');
  });

  it('dice quanti finding non ha elencato', () => {
    const many = Array.from({ length: 90 }, (_, n) => finding({ id: `articolo-${n}` }));
    const { description } = buildReportIssue({ scanned: 400, flagged: 90, findings: many }, many, undefined);
    expect(description).toMatch(/altri \d+ body-locale segnalati/);
  });

  it('è azionabile: dice dove si corregge il testo e dove la allowlist', () => {
    // Una issue "parlante" per il fixer autonomo: il testo si corregge NEL
    // CORPUS (qui verrebbe sovrascritto dal sync successivo), la allowlist
    // invece sta sul sito e scende al mirror.
    const one = [finding()];
    const { description } = buildReportIssue({ scanned: 4, flagged: 1, findings: one }, one, undefined);
    expect(description).toContain('## Suggested action');
    expect(description).toContain('nanakokyobashi-rgb/frontaliere-articles');
    expect(description).toContain('scripts/lib/article-factuality-gates.mjs');
    expect(description).toContain('Nessuna pubblicazione è stata bloccata');
  });

  it('ha un titolo stabile: i sync successivi deduplicano invece di aprire N issue', () => {
    // github-issue-creator.mjs deduplica sul prefisso del titolo; un titolo che
    // contenesse il run id aprirebbe una issue per sync.
    expect(ISSUE_TITLE).not.toMatch(/\d{4}-\d{2}-\d{2}|run|\d{6,}/i);
    const a = buildReportIssue({ scanned: 4, flagged: 1, findings: [finding()] }, [finding()], 'https://x/1');
    const b = buildReportIssue({ scanned: 8, flagged: 2, findings: [finding()] }, [finding()], 'https://x/2');
    expect(a.title).toBe(b.title);
  });
});

describe('step summary', () => {
  it('uno scope non calcolabile NON si legge come "tutto a posto"', () => {
    // È il cuore del difetto riparato: un gate che smette di verificare deve
    // dirlo, non restituire lo stesso report vuoto di un sync pulito.
    const summary = buildStepSummary({ scanned: 0, flagged: 0, diffUnavailable: true, findings: [] }, []);
    expect(summary).toContain('scope non calcolabile');
    expect(summary).toContain('nessun articolo è stato verificato');
  });

  it('distingue "niente da verificare" da "verificato e pulito"', () => {
    const nothing = buildStepSummary({ scanned: 0, flagged: 0, diffUnavailable: false, findings: [] }, []);
    expect(nothing).toContain('nessun body articolo modificato');
    expect(nothing).not.toContain('scope non calcolabile');
  });

  it('elenca i finding non escalati, che altrimenti non lascerebbero traccia', () => {
    const findings = [finding({ locale: 'en' }), finding({ locale: 'it' })];
    const summary = buildStepSummary({ scanned: 4, flagged: 2, diffUnavailable: false, findings }, [findings[1]]);
    expect(summary).toContain('unknown-institution');
    expect(summary).toContain('2 segnalati, 1 escalati');
  });
});

describe('audit-article-factuality.mjs --changed-worktree', () => {
  /**
   * Si invoca lo script vero, non una copia della sua logica: il difetto da
   * prevenire è proprio che la modalità esista sulla carta e non calcoli
   * niente. Non si asserisce su `scanned`, che dipende da cosa il branch tocca;
   * si asserisce che lo scope sia DICHIARATO e computabile.
   */
  it('dichiara il proprio scope e non è mai bloccante', () => {
    const out = execFileSync(
      process.execPath,
      [path.join(ROOT, 'scripts', 'audit-article-factuality.mjs'), '--json', '--changed-worktree'],
      { cwd: ROOT, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 },
    );
    const report = JSON.parse(out);
    expect(report.mode).toBe('changed-worktree');
    expect(report.diffUnavailable).toBe(false);
    expect(typeof report.scanned).toBe('number');
  });

  it('rifiuta di combinarsi con --changed invece di sceglierne uno in silenzio', () => {
    // Le due modalità rispondono a domande diverse e solo `--changed` imposta
    // un exit code: lasciarne vincere una produrrebbe un verdetto che non
    // corrisponde allo scope stampato.
    let status = 0;
    try {
      execFileSync(
        process.execPath,
        [path.join(ROOT, 'scripts', 'audit-article-factuality.mjs'), '--changed', 'origin/main', '--changed-worktree'],
        { cwd: ROOT, encoding: 'utf-8', stdio: 'pipe' },
      );
    } catch (err) {
      status = (err as { status?: number }).status ?? 0;
    }
    expect(status).toBe(2);
  });
});

describe('script nominati da sync-articles-sitemaps.yml', () => {
  /**
   * Un workflow nomina i suoi script per PATH, non per import: nessuna delle
   * guardie che seguono il grafo degli import li copre, e un path sbagliato o
   * un file mai atterrato passa con la CI verde e si vede solo come uno step
   * rosso in produzione — o, peggio, come uno step `continue-on-error` che
   * fallisce in silenzio ogni volta. Stessa forma di `SiteShellContract` e di
   * `alert-pat-down.mjs` (CLAUDE.md): un contratto senza forma di import.
   */
  it('esistono tutti sul disco', () => {
    const wf = readFileSync(path.join(ROOT, '.github', 'workflows', 'sync-articles-sitemaps.yml'), 'utf-8');
    const named = [...wf.matchAll(/\b(?:node|bash)\s+(scripts\/[\w./-]+\.(?:mjs|sh))/g)].map((m) => m[1]);
    expect(named.length).toBeGreaterThan(0);
    const missing = [...new Set(named)].filter((p) => !existsSync(path.join(ROOT, p)));
    expect(missing).toEqual([]);
  });
});
