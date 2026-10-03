import { describe, expect, it, vi } from 'vitest';
import {
  citedPaths,
  classifyCandidateBullets,
  createTwinLookup,
  fetchManifestFiles,
  mirrorRoute,
  renderCandidateBulletsSection,
} from '../scripts/ci/followup-candidate-bullets.mjs';

// Titolo di fallimento: «Triage follow-up: il prompt conia item con token già
// vero o nel repository sbagliato».
//
// Il triage riceveva l'intera sezione `## Non implementato (ancora)` e una
// mappa in prosa dei repository. Qui si fissa ciò che ora gli arriva già
// deciso: quali bullet sono candidati e dove si corregge ogni path citato.

// Forma reale di `scripts/ci/loop-sync-manifest.json` (vive solo nel corpus).
const MANIFEST = [
  { path: 'host/batchWrite.ts', sitePath: 'build-plugins/batchWrite.ts', mode: 'identical' },
  { path: 'scripts/lib/pr-body-sections-check.mjs', mode: 'identical' },
  { path: 'scripts/ci/pr-body-contract.mjs', mode: 'corpus-only' },
  { path: '.github/workflows/post-merge-followup.yml', mode: 'adapted' },
  { path: 'generator/tests/claude-rate-limit.test.mjs', sitePath: 'tests/claude-rate-limit.test.ts', mode: 'adapted' },
  { path: 'scripts/lib/control-char-publish-gate.mjs', mode: 'not-ported' },
];

const never = (label: string) => vi.fn((): boolean => {
  throw new Error(`${label} non doveva essere chiamato`);
});
const only = (...paths: string[]) => vi.fn((p: string) => paths.includes(p));

describe('mirrorRoute — lato sito', () => {
  it('un file `identical` citato col nome del corpus si corregge nel sito, col sitePath', () => {
    // Red-first: il file manca sul sito ed esiste nel corpus, quindi la regola
    // «per esistenza» lo mandava al corpus. `bin/where-to-fix` dice sito.
    const existsHere = only();
    const existsTwin = only('host/batchWrite.ts');
    const route = mirrorRoute({
      path: 'host/batchWrite.ts', side: 'site', manifestFiles: MANIFEST, existsHere, existsTwin,
    });
    expect(route).toEqual({ repo: 'site', targetPath: 'build-plugins/batchWrite.ts', why: 'manifest:identical' });
    // Il nome è quello del gemello: si guarda solo che qui non esista un omonimo.
    expect(existsHere).toHaveBeenCalledWith('host/batchWrite.ts');
    expect(existsTwin).not.toHaveBeenCalled();
  });

  it('un file `identical` citato col nome del sito resta nel sito', () => {
    expect(mirrorRoute({
      path: 'build-plugins/batchWrite.ts', side: 'site', manifestFiles: MANIFEST,
      existsHere: never('existsHere'), existsTwin: never('existsTwin'),
    })).toMatchObject({ repo: 'site', targetPath: 'build-plugins/batchWrite.ts' });
  });

  it('un `corpus-only` va al corpus senza interrogare il gemello', () => {
    const existsTwin = never('existsTwin');
    expect(mirrorRoute({
      path: 'scripts/ci/pr-body-contract.mjs', side: 'site', manifestFiles: MANIFEST,
      existsHere: only(), existsTwin,
    })).toEqual({ repo: 'corpus', targetPath: 'scripts/ci/pr-body-contract.mjs', why: 'manifest:corpus-only' });
    expect(existsTwin).not.toHaveBeenCalled();
  });

  it('un omonimo che esiste qui non eredita la voce del gemello', () => {
    // Caso reale: `scripts/ci/redflag-doc-sections.mjs` esiste sul sito ed è
    // `corpus-only` nel manifest. `bin/where-to-fix` dal sito: nessun vincolo.
    const manifestFiles = [
      ...MANIFEST,
      { path: 'scripts/ci/redflag-doc-sections.mjs', mode: 'corpus-only' },
    ];
    const existsTwin = never('existsTwin');
    expect(mirrorRoute({
      path: 'scripts/ci/redflag-doc-sections.mjs', side: 'site', manifestFiles,
      existsHere: only('scripts/ci/redflag-doc-sections.mjs'), existsTwin,
    })).toEqual({ repo: 'site', targetPath: 'scripts/ci/redflag-doc-sections.mjs', why: 'no-entry:exists-here' });
    // Vale per ogni mode: un file del sito che si chiama come la copia corpus
    // di un `identical` rinominato non va spostato sul sitePath di quella voce.
    expect(mirrorRoute({
      path: 'host/batchWrite.ts', side: 'site', manifestFiles,
      existsHere: only('host/batchWrite.ts'), existsTwin,
    })).toMatchObject({ repo: 'site', targetPath: 'host/batchWrite.ts', why: 'no-entry:exists-here' });
    // Lookup locale fallito: non si sa se l'omonimo esiste, quindi unknown.
    expect(mirrorRoute({
      path: 'scripts/ci/redflag-doc-sections.mjs', side: 'site', manifestFiles,
      existsHere: () => null, existsTwin,
    })).toMatchObject({ repo: 'unknown', why: 'manifest:twin-name:here-lookup-failed' });
    expect(existsTwin).not.toHaveBeenCalled();
  });

  it('un `adapted` che esiste qui resta nel sito e non interroga il gemello', () => {
    const existsTwin = never('existsTwin');
    expect(mirrorRoute({
      path: '.github/workflows/post-merge-followup.yml', side: 'site', manifestFiles: MANIFEST,
      existsHere: only('.github/workflows/post-merge-followup.yml'), existsTwin,
    })).toMatchObject({ repo: 'site', targetPath: '.github/workflows/post-merge-followup.yml' });
    expect(existsTwin).not.toHaveBeenCalled();
  });

  it('un `adapted` citato col nome della copia del corpus va al corpus', () => {
    expect(mirrorRoute({
      path: 'generator/tests/claude-rate-limit.test.mjs', side: 'site', manifestFiles: MANIFEST,
      existsHere: only(), existsTwin: only('generator/tests/claude-rate-limit.test.mjs'),
    })).toMatchObject({ repo: 'corpus', targetPath: 'generator/tests/claude-rate-limit.test.mjs' });
  });

  it('un `not-ported` appartiene al sito', () => {
    expect(mirrorRoute({
      path: 'scripts/lib/control-char-publish-gate.mjs', side: 'site', manifestFiles: MANIFEST,
      existsHere: never('existsHere'), existsTwin: never('existsTwin'),
    })).toMatchObject({ repo: 'site' });
  });

  it('senza voce decide l\'esistenza: qui, poi nel gemello, altrimenti unknown', () => {
    const args = { side: 'site' as const, manifestFiles: MANIFEST };
    expect(mirrorRoute({ ...args, path: 'services/router.ts', existsHere: only('services/router.ts'), existsTwin: never('existsTwin') }))
      .toMatchObject({ repo: 'site', why: 'no-entry:exists-here' });
    expect(mirrorRoute({ ...args, path: 'generator/scripts/x.mjs', existsHere: only(), existsTwin: only('generator/scripts/x.mjs') }))
      .toMatchObject({ repo: 'corpus', targetPath: 'generator/scripts/x.mjs', why: 'no-entry:exists-twin' });
    expect(mirrorRoute({ ...args, path: 'scripts/new-file.mjs', existsHere: only(), existsTwin: only() }))
      .toMatchObject({ repo: 'unknown', why: 'no-entry:not-found' });
  });

  it('un lookup del gemello fallito è unknown, non un verdetto', () => {
    expect(mirrorRoute({
      path: 'generator/scripts/x.mjs', side: 'site', manifestFiles: MANIFEST,
      existsHere: only(), existsTwin: () => null,
    })).toMatchObject({ repo: 'unknown', why: 'no-entry:twin-lookup-failed' });
    expect(mirrorRoute({
      path: 'generator/scripts/x.mjs', side: 'site', manifestFiles: MANIFEST,
      existsHere: only(), existsTwin: () => { throw new Error('rate limit'); },
    })).toMatchObject({ repo: 'unknown' });
  });

  it('manifest illeggibile → unknown, MAI un instradamento per sola esistenza', () => {
    const existsHere = only();
    const existsTwin = only('host/batchWrite.ts');
    for (const manifestFiles of [null, undefined, {}] as never[]) {
      const route = mirrorRoute({ path: 'host/batchWrite.ts', side: 'site', manifestFiles, existsHere, existsTwin });
      expect(route).toEqual({ repo: 'unknown', targetPath: 'host/batchWrite.ts', why: 'manifest-unavailable' });
    }
    expect(existsHere).not.toHaveBeenCalled();
    expect(existsTwin).not.toHaveBeenCalled();
  });

  it('voci in conflitto sullo stesso path → unknown', () => {
    const conflicting = [
      { path: 'scripts/a.mjs', mode: 'identical' },
      { path: 'scripts/a.mjs', mode: 'corpus-only' },
    ];
    expect(mirrorRoute({ path: 'scripts/a.mjs', side: 'corpus', manifestFiles: conflicting }))
      .toMatchObject({ repo: 'unknown', why: 'manifest:conflict' });
  });
});

describe('mirrorRoute — lato corpus', () => {
  it('un file `identical` che esiste nel corpus si corregge nel sito, col sitePath', () => {
    const existsHere = only('host/batchWrite.ts');
    expect(mirrorRoute({
      path: 'host/batchWrite.ts', side: 'corpus', manifestFiles: MANIFEST,
      existsHere, existsTwin: never('existsTwin'),
    })).toEqual({ repo: 'site', targetPath: 'build-plugins/batchWrite.ts', why: 'manifest:identical' });
    expect(existsHere).not.toHaveBeenCalled();
  });

  it('un `adapted` che esiste nel corpus resta nel corpus', () => {
    expect(mirrorRoute({
      path: '.github/workflows/post-merge-followup.yml', side: 'corpus', manifestFiles: MANIFEST,
      existsHere: only('.github/workflows/post-merge-followup.yml'), existsTwin: never('existsTwin'),
    })).toMatchObject({ repo: 'corpus' });
  });
});

describe('citedPaths', () => {
  it('prende i path fra backtick e scarta simboli, glob, comandi e risalite', () => {
    expect(citedPaths(
      'tocca `scripts/ci/foo.mjs:42` e `./build-plugins/bar.ts`, non `fooBar()` né `scripts/update-*.mjs`, '
      + '`git diff origin/main -- a/b.ts`, `../etc/passwd.txt`, `package.json`; di nuovo `scripts/ci/foo.mjs`',
    )).toEqual(['scripts/ci/foo.mjs', 'build-plugins/bar.ts']);
  });
});

describe('classifyCandidateBullets', () => {
  // Righe reali dei due body, verbatim.
  const PR_10258 = [
    '## Implementato',
    '- registro dei canali',
    '',
    '## Non implementato (ancora)',
    '',
    '- `components/preferences/SubscriptionPreferencesController.tsx` — falso positivo, solo lessicalmente simile ma semanticamente diverso: condivide l\'identificatore del promemoria, che lì è l\'interruttore già esistente. **Motivo:** nessuna dichiarazione di canale da aggiungere. **Prossimo passo:** `git diff origin/main -- components/preferences/SubscriptionPreferencesController.tsx` resta vuoto in questa PR.',
    '- `scripts/lib/email-cascade.mjs` — falso positivo, solo lessicalmente simile ma semanticamente diverso: usa lo stesso id `application-intent-reminder` per la sua tabella di sender, già corretta. **Motivo:** l\'id del registro è stato scelto uguale al suo. **Prossimo passo:** `git diff origin/main -- scripts/lib/email-cascade.mjs` resta vuoto in questa PR.',
    '',
    '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
  ].join('\n');
  const PR_10289 = [
    '## Non implementato (ancora)',
    '',
    '- `by construction`: `FU-2026-09-28-012`–`014`, `038` e `039` risultano già coperti dalla configurazione/codice presente su `main` (filtro `skipped`, mutex daily, guard stale e ID finding stabili), quindi non hanno una modifica site-side residua da includere. Motivo: non esiste un diff applicabile senza duplicare una correzione già presente. Prossimo passo: riconfermare con il prossimo run di guardia.',
    '- hooks/useNewsletterAutologinInFlight.ts — falso positivo, not the same bug class: è un hook UI fuori dal grafo Vite della config. Motivo: l\'import alias è risolto dal bundler applicativo. Prossimo passo: nessuno, salvo un finding specifico di build UI.',
    '- scripts/assemble-jobs-dataset.mjs — falso positivo, by construction: `isHttpsJobUrl` è un predicato booleano con guardia di tipo e non emette il valore URL non normalizzato modificato da questa PR. Motivo: usa `URL` solo per validare un booleano. Prossimo passo: nessuno, salvo un nuovo finding sul contratto di validazione.',
  ].join('\n');

  it('le righe reali delle PR 10258 e 10289 non sono candidate e non costano lookup', () => {
    const existsHere = never('existsHere');
    const existsTwin = never('existsTwin');
    for (const body of [PR_10258, PR_10289]) {
      const bullets = classifyCandidateBullets({ pr: { body }, side: 'site', manifestFiles: MANIFEST, existsHere, existsTwin });
      expect(bullets.length).toBeGreaterThan(0);
      expect(bullets.filter((b) => b.candidate)).toEqual([]);
      expect(bullets.every((b) => b.state !== null && b.routes.length === 0)).toBe(true);
    }
    expect(existsHere).not.toHaveBeenCalled();
    expect(existsTwin).not.toHaveBeenCalled();
  });

  it('la riga di attribuzione in coda al body non diventa un bullet', () => {
    const bullets = classifyCandidateBullets({ pr: { body: PR_10258 }, side: 'site', manifestFiles: MANIFEST });
    expect(bullets.some((b) => b.text.includes('Generated with'))).toBe(false);
  });

  it('un bullet `blocked: fonte assente` è candidato, col suo stato e la sua route', () => {
    const body = [
      '## Non implementato (ancora)',
      '- Salari per cantone in `host/batchWrite.ts` — blocked: fonte assente, l\'ufficio statistico non pubblica ancora la serie.',
      '- Estendere il fix ai crawler sibling',
      '- Altro lavoro — in questa PR',
    ].join('\n');
    const existsTwin = never('existsTwin');
    const bullets = classifyCandidateBullets({
      pr: { body }, side: 'site', manifestFiles: MANIFEST, existsHere: only(), existsTwin,
    });
    expect(bullets.map((b) => [b.state, b.candidate])).toEqual([
      ['blocked-technical', true],
      [null, true],
      ['in-this-pr', false],
    ]);
    expect(bullets[0].routes).toEqual([
      { path: 'host/batchWrite.ts', repo: 'site', targetPath: 'build-plugins/batchWrite.ts', why: 'manifest:identical' },
    ]);
    expect(existsTwin).not.toHaveBeenCalled();
  });

  it('le righe di chiusura e «Nessuno» con motivo non diventano candidati', () => {
    // Forme reali: PR 11113 («Nessuno — snapshot automatizzato, senza residui.»)
    // e PR 11195 (`Addresses #7079` in coda alla sezione).
    const body = [
      '## Non implementato (ancora)',
      '',
      '- Nessuno — snapshot automatizzato, senza residui.',
      '',
      'Addresses #7079',
      'Closes #12',
      'Follow-up item: FU-2026-09-28-012',
      '',
      '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
    ].join('\n');
    const bullets = classifyCandidateBullets({ pr: { body }, side: 'site', manifestFiles: MANIFEST });
    expect(bullets).toEqual([{
      text: 'Nessuno — snapshot automatizzato, senza residui.',
      kind: 'empty-declared',
      state: null,
      candidate: false,
      reason: 'empty',
      routes: [],
    }]);
  });

  it('«Nessuno» seguito da testo è un residuo, non una sezione vuota', () => {
    const body = '## Non implementato (ancora)\n- Nessuno dei crawler sibling è stato corretto\n';
    const [bullet] = classifyCandidateBullets({ pr: { body }, side: 'site', manifestFiles: MANIFEST });
    expect(bullet).toMatchObject({ kind: 'bullet', candidate: true, reason: null });
  });

  it('distingue le righe di lista dalla prosa: solo i bullet sono materia di conio', () => {
    const body = [
      '## Non implementato (ancora)',
      '- Estendere il fix ai crawler sibling',
      '  resta da coprire il parser paginato',
      '1. Portare la guardia nel gemello',
      'Nota per il revisore.',
    ].join('\n');
    const bullets = classifyCandidateBullets({ pr: { body }, side: 'site', manifestFiles: MANIFEST });
    expect(bullets.map((b) => b.kind)).toEqual(['bullet', 'prose', 'bullet', 'prose']);
  });

  it('dichiara perché un bullet non è candidato: stato che chiude oppure match lessicale', () => {
    const body = [
      '## Non implementato (ancora)',
      '- Altro lavoro — in questa PR',
      // Residuo misto: l'oracolo lo scarta per «aggiungere un test», ma porta
      // un'edit concreta. Il motivo `hard-exclude` lo lascia al triage.
      '- Correggere il parser in `scripts/x.mjs` e aggiungere un test — blocked: fonte assente',
    ].join('\n');
    const bullets = classifyCandidateBullets({
      pr: { body }, side: 'site', manifestFiles: MANIFEST,
      existsHere: never('existsHere'), existsTwin: never('existsTwin'),
    });
    expect(bullets.map((b) => [b.candidate, b.reason, b.state])).toEqual([
      [false, 'closing-state', 'in-this-pr'],
      [false, 'hard-exclude', 'blocked-technical'],
    ]);
  });

  it('senza manifest i candidati restano candidati e ogni route è unknown', () => {
    const body = '## Non implementato (ancora)\n- Sistemare `host/batchWrite.ts`\n';
    const [bullet] = classifyCandidateBullets({
      pr: { body }, side: 'site', manifestFiles: null, existsHere: only(), existsTwin: only('host/batchWrite.ts'),
    });
    expect(bullet.candidate).toBe(true);
    expect(bullet.routes.map((r) => r.repo)).toEqual(['unknown']);
  });

  it('un body senza sezione non produce bullet', () => {
    expect(classifyCandidateBullets({ pr: { body: '## Implementato\n- x' }, side: 'site', manifestFiles: MANIFEST })).toEqual([]);
    expect(classifyCandidateBullets({ pr: {}, side: 'site', manifestFiles: MANIFEST })).toEqual([]);
  });
});

describe('I/O iniettato', () => {
  it('il lookup del gemello ha cache e tetto; 404 è false, il resto è null', () => {
    const api = vi.fn((args: string[]) => {
      const url = args[args.length - 1];
      if (url.includes('missing')) throw Object.assign(new Error('gh failed'), { stderr: 'gh: Not Found (HTTP 404)' });
      if (url.includes('boom')) throw Object.assign(new Error('gh failed'), { stderr: 'gh: API rate limit exceeded (HTTP 403)' });
      return '';
    });
    const lookup = createTwinLookup({ repo: 'owner/twin', cap: 3, api });
    expect(lookup('a/there.ts')).toBe(true);
    expect(lookup('a/there.ts')).toBe(true);
    expect(lookup('a/missing.ts')).toBe(false);
    expect(lookup('a/boom.ts')).toBeNull();
    const callsAtCap = api.mock.calls.length;
    expect(lookup('a/over-cap.ts')).toBeNull();
    expect(api.mock.calls.length).toBe(callsAtCap);
    expect(api.mock.calls[0][0].at(-1)).toBe('repos/owner/twin/contents/a/there.ts?ref=main');
  });

  it('il manifest letto via API rende `files`, e null su errore o forma inattesa', () => {
    expect(fetchManifestFiles('owner/corpus', () => JSON.stringify({ files: MANIFEST }))).toEqual(MANIFEST);
    expect(fetchManifestFiles('owner/corpus', () => '{"files": "no"}')).toBeNull();
    expect(fetchManifestFiles('owner/corpus', () => { throw new Error('404'); })).toBeNull();
  });

  it('la sezione del bundle nomina le PR, e dichiara il manifest mancante', () => {
    const section = renderCandidateBulletsSection(
      [{ number: 7, bullets: [] }, { number: 8, error: 'pr-body-unavailable' }],
      { manifestOk: false },
    );
    expect(section.startsWith('## Candidate bullets\n')).toBe(true);
    expect(section).toContain('### PR #7');
    expect(section).toContain('"error": "pr-body-unavailable"');
    expect(section).toContain('NON leggibile');
  });
});
