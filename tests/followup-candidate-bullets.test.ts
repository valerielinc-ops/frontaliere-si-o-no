import { describe, expect, it, vi } from 'vitest';
import {
  citedPaths,
  classifyCandidateBullets,
  createMergeRunLookup,
  createTwinLookup,
  fetchManifestFiles,
  isOwnVerificationBullet,
  mirrorRoute,
  namedTestFiles,
  parseVitestFileResults,
  renderCandidateBulletsSection,
} from '../scripts/ci/followup-candidate-bullets.mjs';
import { isCandidateItem } from '../scripts/ci/followup-has-candidates.mjs';
import {
  decisionDeferralFindings,
  nonImplementedSection,
  topLevelBullets,
} from '../scripts/lib/pr-body-sections-check.mjs';

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

  // Il reviewer cita i file come `path:L251`: con la sola forma numerica quel
  // path veniva scartato, `routes` restava vuoto e il triage ricadeva sulla
  // mappa in prosa, cioe' poteva coniare il follow-up nel repository sbagliato.
  it.each([
    ['ancora con L', '`scripts/ci/foo.mjs:L12`'],
    ['intervallo con L su entrambi i capi', '`scripts/ci/foo.mjs:L12-L20`'],
    ['intervallo con L solo in testa', '`scripts/ci/foo.mjs:L12-20`'],
    ['riga e colonna', '`scripts/ci/foo.mjs:12:5`'],
    ['intervallo numerico', '`scripts/ci/foo.mjs:12-20`'],
    ['prefisso ./ e ancora con L', '`./scripts/ci/foo.mjs:L7`'],
  ])('toglie l\'ancora di riga dal path citato (%s)', (_label, text) => {
    expect(citedPaths(text)).toEqual(['scripts/ci/foo.mjs']);
  });

  it('non scambia per ancora un nome di file che finisce con L e cifre', () => {
    expect(citedPaths('`scripts/ci/levelL12.mjs` e `docs/NOTE-L3.md`')).toEqual(['scripts/ci/levelL12.mjs', 'docs/NOTE-L3.md']);
  });

  it('instrada un path citato con ancora L come lo stesso path senza ancora', () => {
    const manifestFiles = [{ path: 'scripts/ci/foo.mjs', mode: 'identical' }];
    const plain = mirrorRoute({ path: 'scripts/ci/foo.mjs', side: 'corpus', manifestFiles });
    const anchored = mirrorRoute({ path: 'scripts/ci/foo.mjs:L12', side: 'corpus', manifestFiles });
    expect(anchored).toEqual(plain);
    expect(anchored.targetPath).toBe('scripts/ci/foo.mjs');
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

  it('le righe di chiusura non diventano bullet e «Nessuno» da solo è una sezione vuota', () => {
    // Forma reale: PR 11195 (`Addresses #7079` in coda alla sezione).
    const body = [
      '## Non implementato (ancora)',
      '',
      '- Nessuno.',
      '',
      'Addresses #7079',
      'Closes #12',
      'Follow-up item: FU-2026-09-28-012',
      '',
      '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
    ].join('\n');
    const bullets = classifyCandidateBullets({ pr: { body }, side: 'site', manifestFiles: MANIFEST });
    expect(bullets).toEqual([{
      text: 'Nessuno.',
      kind: 'empty-declared',
      state: null,
      candidate: false,
      reason: 'empty',
      routes: [],
    }]);
  });

  // Review della PR corpus 2080: la regex era ancorata solo all'inizio, quindi
  // «Nessuno» seguito da un segno e poi da un'azione usciva `reason: empty` e il
  // triage lo scartava, mentre l'oracolo condiviso lo dichiara candidato.
  it.each([
    ['Nessuno.'],
    ['**Nessuno**'],
    ['none'],
    ['_Niente._'],
    ['Nothing —'],
  ])('«%s» da solo è una sezione dichiarata vuota', (line) => {
    const body = `## Non implementato (ancora)\n- ${line}\n`;
    const [bullet] = classifyCandidateBullets({ pr: { body }, side: 'site', manifestFiles: MANIFEST });
    expect(bullet).toMatchObject({ kind: 'empty-declared', candidate: false, reason: 'empty' });
  });

  it.each([
    ['Nessuno: aggiornare `scripts/ci/foo.mjs`', ['scripts/ci/foo.mjs']],
    ['Nessuno — aggiungere il guard', []],
    // Forma reale della PR 11113: il motivo è testo, e il testo lo giudica
    // l'oracolo condiviso, non un elenco di frasi «non residue».
    ['Nessuno — snapshot automatizzato, senza residui.', []],
  ])('«%s»: «Nessuno» seguito da un\'azione resta materia dell\'oracolo', (line, paths) => {
    const body = `## Non implementato (ancora)\n- ${line}\n`;
    const [bullet] = classifyCandidateBullets({
      pr: { body }, side: 'site', manifestFiles: MANIFEST, existsHere: only('scripts/ci/foo.mjs'), existsTwin: only(),
    });
    expect(bullet).toMatchObject({ kind: 'bullet', candidate: isCandidateItem(line), reason: null });
    expect(bullet.candidate).toBe(true);
    expect(bullet.routes.map((r) => r.path)).toEqual(paths);
  });

  it('fuori dalla sezione vuota il verdetto è sempre quello di isCandidateItem()', () => {
    // Osservatore di parità: il bundle non deve mai dire `candidate: false` a
    // un item che l'oracolo dichiara candidato, salvo la sola dichiarazione vuota.
    const lines = [
      'Nessuno: aggiornare `scripts/ci/foo.mjs`',
      'Nessuno — aggiungere il guard',
      'Niente; resta da portare il parser nel gemello',
      'none (see `scripts/ci/foo.mjs`)',
      'Nessuno dei crawler sibling è stato corretto',
      'Altro lavoro — in questa PR',
      'Nessuno.',
      '**Nessuno**',
    ];
    const body = `## Non implementato (ancora)\n${lines.map((l) => `- ${l}`).join('\n')}\n`;
    const bullets = classifyCandidateBullets({
      pr: { body }, side: 'site', manifestFiles: MANIFEST, existsHere: only(), existsTwin: only(),
    });
    for (const bullet of bullets) {
      if (bullet.kind === 'empty-declared') continue;
      expect([bullet.text, bullet.candidate]).toEqual([bullet.text, isCandidateItem(bullet.text)]);
    }
    expect(bullets.filter((b) => b.kind === 'empty-declared').map((b) => b.text)).toEqual(['Nessuno.', '**Nessuno**']);
  });

  it('i sub-bullet di una voce si leggono con la voce, non come item separati', () => {
    // Adversarial check della PR corpus 2080: `Motivo`/`Prossimo passo` su righe
    // annidate uscivano come tre `kind: bullet` candidati, e il genitore `per
    // scelta`, letto senza il suo motivo, diventava candidato anche lui.
    const body = [
      '## Non implementato (ancora)',
      '- Portare il guard nel gemello — per scelta',
      '  - **Motivo:** il gemello scende col transport.',
      '  - **Prossimo passo:** rebase della 2080 dopo il merge.',
      '- Sibling da correggere:',
      '  - `scripts/ci/foo.mjs`',
      '    1. `scripts/ci/bar.mjs`',
      '- Estendere il fix ai crawler sibling',
    ].join('\n');
    const bullets = classifyCandidateBullets({
      pr: { body }, side: 'site', manifestFiles: MANIFEST, existsHere: only('scripts/ci/foo.mjs', 'scripts/ci/bar.mjs'), existsTwin: only(),
    });
    expect(bullets.map((b) => [b.kind, b.state, b.candidate, b.reason])).toEqual([
      ['bullet', 'by-choice', false, 'closing-state'],
      ['bullet', null, true, null],
      ['bullet', null, true, null],
    ]);
    // Il testo è quello che giudica il contratto (`topLevelBullets()`): i
    // sub-bullet tengono il proprio marker.
    expect(bullets[0].text).toBe(
      'Portare il guard nel gemello — per scelta - **Motivo:** il gemello scende col transport. - **Prossimo passo:** rebase della 2080 dopo il merge.',
    );
    expect(bullets[1].routes.map((r) => r.path)).toEqual(['scripts/ci/foo.mjs', 'scripts/ci/bar.mjs']);
  });

  it('«Nessuno» seguito da testo è un residuo, non una sezione vuota', () => {
    const body = '## Non implementato (ancora)\n- Nessuno dei crawler sibling è stato corretto\n';
    const [bullet] = classifyCandidateBullets({ pr: { body }, side: 'site', manifestFiles: MANIFEST });
    expect(bullet).toMatchObject({ kind: 'bullet', candidate: true, reason: null });
  });

  it('distingue le righe di lista dalla prosa: solo i bullet sono materia di conio', () => {
    // Prima della review della PR corpus 2080 le tre righe sotto la voce
    // uscivano come item a sé. Il contratto le unisce alla voce, e il bundle
    // con lui: è prosa solo ciò che precede il primo bullet.
    const body = [
      '## Non implementato (ancora)',
      'Nota per il revisore.',
      '1. Portare la guardia nel gemello',
      '- Estendere il fix ai crawler sibling',
      '  resta da coprire il parser paginato',
      '1. Portare la guardia nel gemello',
      'Nota per il revisore.',
    ].join('\n');
    const bullets = classifyCandidateBullets({ pr: { body }, side: 'site', manifestFiles: MANIFEST });
    expect(bullets.map((b) => b.kind)).toEqual(['prose', 'bullet', 'bullet']);
    expect(bullets[2].text).toBe(
      'Estendere il fix ai crawler sibling resta da coprire il parser paginato 1. Portare la guardia nel gemello Nota per il revisore.',
    );
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

// Review della PR corpus 2080 (commit 9e6cced576), due 🔴 sul gemello:
//   1. le continuazioni senza marker restavano item separati, mentre il parser
//      del contratto le unisce alla voce: `- residuo` seguito da `per scelta`
//      su una riga sotto usciva `candidate: true`;
//   2. i path nella root (`FOLLOWUP.md`, `REVIEW.md`) non ricevevano `routes`,
//      e senza route il prompt ricade sulla mappa «tutto il resto → sito».
describe('continuazioni: stessa regola del parser del contratto', () => {
  it('una continuazione semplice con `per scelta` chiude la voce', () => {
    const body = [
      '## Non implementato (ancora)',
      '- Portare il guard nel gemello',
      '  per scelta. Motivo: il gemello scende col transport del manifest. Prossimo passo: rebase della 2080 dopo il merge.',
    ].join('\n');
    const bullets = classifyCandidateBullets({
      pr: { body }, side: 'site', manifestFiles: MANIFEST,
      existsHere: never('existsHere'), existsTwin: never('existsTwin'),
    });
    expect(bullets.map((b) => [b.kind, b.state, b.candidate, b.reason])).toEqual([
      ['bullet', 'by-choice', false, 'closing-state'],
    ]);
    // Il contratto la giudica una deroga completa: nessun finding.
    expect(decisionDeferralFindings(body)).toEqual([]);
  });

  it('`blocked: <causa>` su una riga di continuazione ha il verdetto del contratto', () => {
    const technical = [
      '## Non implementato (ancora)',
      '- Salari per cantone in `host/batchWrite.ts`',
      '  blocked: fonte assente, l\'ufficio statistico non pubblica ancora la serie.',
    ].join('\n');
    const existsTwin = never('existsTwin');
    const [tech, ...restTech] = classifyCandidateBullets({
      pr: { body: technical }, side: 'site', manifestFiles: MANIFEST, existsHere: only(), existsTwin,
    });
    expect(restTech).toEqual([]);
    expect(tech).toMatchObject({ kind: 'bullet', state: 'blocked-technical', candidate: true, reason: null });
    expect(tech.routes.map((r) => [r.path, r.repo])).toEqual([['host/batchWrite.ts', 'site']]);

    const owner = [
      '## Non implementato (ancora)',
      '- Riattivare il canale newsletter settimanale',
      '  blocked: decisione del proprietario — Motivo: il canale resta spento finché non cambia il budget. Prossimo passo: rileggere la decisione alla revisione di novembre.',
    ].join('\n');
    const ownerBullets = classifyCandidateBullets({ pr: { body: owner }, side: 'site', manifestFiles: MANIFEST });
    expect(ownerBullets.map((b) => [b.state, b.candidate, b.reason])).toEqual([['blocked-owner', false, 'closing-state']]);
    expect(decisionDeferralFindings(owner)).toEqual([]);
  });

  it('la prosa prima del primo bullet resta un item a sé, le righe dopo si uniscono alla voce', () => {
    const body = [
      '## Non implementato (ancora)',
      'Nota per il revisore.',
      '- Estendere il fix ai crawler sibling',
      '  resta da coprire il parser paginato',
      '',
      '1. Portare la guardia nel gemello',
    ].join('\n');
    const bullets = classifyCandidateBullets({ pr: { body }, side: 'site', manifestFiles: MANIFEST });
    expect(bullets.map((b) => [b.kind, b.text])).toEqual([
      ['prose', 'Nota per il revisore.'],
      ['bullet', 'Estendere il fix ai crawler sibling resta da coprire il parser paginato 1. Portare la guardia nel gemello'],
    ]);
  });

  it('un heading chiude la sezione, come nel contratto', () => {
    const body = [
      '## Non implementato (ancora)',
      '- Altro lavoro — in questa PR',
      '### Sibling',
      '- `scripts/ci/foo.mjs` — da correggere',
    ].join('\n');
    const bullets = classifyCandidateBullets({ pr: { body }, side: 'site', manifestFiles: MANIFEST });
    expect(bullets.map((b) => b.text)).toEqual(['Altro lavoro — in questa PR']);
  });

  // Osservatore di parità: il raggruppamento del bundle È quello del contratto
  // (`topLevelBullets()`), e su ogni voce che dichiara una decisione il verdetto
  // del bundle coincide con quello di `decisionDeferralFindings()`.
  const PARITY_BODIES: Array<[string, string]> = [
    ['continuazione semplice', [
      '## Non implementato (ancora)',
      '- `scripts/ci/foo.mjs`: allineare il gemello',
      '  per scelta. Motivo: il gemello scende col transport del manifest. Prossimo passo: rebase della 2080 dopo il merge.',
      '- Riallineare `scripts/ci/bar.mjs`',
      '  per scelta, senza motivo scritto.',
      '- Sistemare il parser — in questa PR',
    ].join('\n')],
    ['sub-bullet con i due campi', [
      '## Non implementato (ancora)',
      '',
      '- Portare il guard nel gemello — per scelta',
      '  - **Motivo:** il gemello scende col transport.',
      '  - **Prossimo passo:** rebase della 2080 dopo il merge.',
      '- `scripts/ci/baz.mjs` — falso positivo, solo lessicalmente simile.',
      '  Motivo: condivide il token ma non la classe di bug.',
      '- by construction: il guard copre già il caso.',
      '',
      'Paragrafo di chiusura che il contratto attacca all\'ultima voce. Prossimo passo: nessuna azione richiesta qui.',
    ].join('\n')],
    ['lista indentata e continuazione dopo una riga vuota', [
      '## Non implementato (ancora)',
      '  - Riattivare il canale newsletter',
      '',
      '    blocked: decisione del proprietario — Motivo: budget non approvato.',
      '    Prossimo passo: rileggere la decisione alla revisione di novembre.',
      '  - Salari per cantone — blocked: fonte assente',
    ].join('\n')],
  ];

  it.each(PARITY_BODIES)('parità col parser del contratto: %s', (_label, body) => {
    const contract = topLevelBullets(nonImplementedSection(body));
    const bullets = classifyCandidateBullets({
      pr: { body }, side: 'site', manifestFiles: MANIFEST, existsHere: only(), existsTwin: only(),
    });
    expect(bullets.map((b) => b.text)).toEqual(contract.map((b: { text: string }) => b.text.replace(/^[-*+][ \t]+/, '')));
    expect(bullets.every((b) => b.kind === 'bullet')).toBe(true);
    const flagged = new Set(decisionDeferralFindings(body).map((f: { index: number }) => f.index));
    bullets.forEach((bullet, i) => {
      if (!['by-choice', 'by-construction', 'blocked-owner'].includes(bullet.state as string)) return;
      // Voce di decisione: è candidata esattamente quando il contratto la boccia.
      expect([bullet.text, bullet.candidate]).toEqual([bullet.text, flagged.has(i + 1)]);
    });
  });
});

describe('path nella root', () => {
  const ROOT_MANIFEST = [
    ...MANIFEST,
    { path: 'FOLLOWUP.md', mode: 'adapted' },
    { path: 'REVIEW.md', mode: 'adapted' },
    { path: 'AGENTS.md', mode: 'adapted' },
  ];

  it('`FOLLOWUP.md` citato da una PR del corpus resta nel corpus, mai sulla mappa del sito', () => {
    const body = '## Non implementato (ancora)\n- Allineare la regola di chiusura in `FOLLOWUP.md` e in `REVIEW.md:L12`\n';
    const [bullet] = classifyCandidateBullets({
      pr: { body }, side: 'corpus', manifestFiles: ROOT_MANIFEST,
      existsHere: only('FOLLOWUP.md', 'REVIEW.md'), existsTwin: never('existsTwin'),
    });
    expect(bullet.candidate).toBe(true);
    expect(bullet.routes).toEqual([
      { path: 'FOLLOWUP.md', repo: 'corpus', targetPath: 'FOLLOWUP.md', why: 'manifest:adapted:exists-here' },
      { path: 'REVIEW.md', repo: 'corpus', targetPath: 'REVIEW.md', why: 'manifest:adapted:exists-here' },
    ]);
  });

  it('`AGENTS.md` citato da una PR del sito resta nel sito', () => {
    const body = '## Non implementato (ancora)\n- Documentare il gate in `AGENTS.md`\n';
    const [bullet] = classifyCandidateBullets({
      pr: { body }, side: 'site', manifestFiles: ROOT_MANIFEST,
      existsHere: only('AGENTS.md'), existsTwin: never('existsTwin'),
    });
    expect(bullet.routes.map((r) => [r.path, r.repo])).toEqual([['AGENTS.md', 'site']]);
  });

  it('`package.json` e `res.json` non hanno voce nel manifest: nessuna route', () => {
    const body = '## Non implementato (ancora)\n- Aggiornare `package.json` e il parsing di `res.json` in `scripts/ci/foo.mjs`\n';
    const existsHere = only('scripts/ci/foo.mjs', 'package.json');
    const [bullet] = classifyCandidateBullets({
      pr: { body }, side: 'site', manifestFiles: ROOT_MANIFEST, existsHere, existsTwin: only(),
    });
    expect(bullet.routes.map((r) => r.path)).toEqual(['scripts/ci/foo.mjs']);
    expect(existsHere).not.toHaveBeenCalledWith('package.json');
  });

  it('citedPaths accetta un nome nella root solo se è fra quelli dichiarati', () => {
    const text = '`FOLLOWUP.md`, `package.json`, `README.md` e `scripts/ci/foo.mjs`';
    expect(citedPaths(text)).toEqual(['scripts/ci/foo.mjs']);
    expect(citedPaths(text, { rootFiles: new Set(['FOLLOWUP.md']) })).toEqual(['FOLLOWUP.md', 'scripts/ci/foo.mjs']);
  });

  it('senza manifest un nome nella root non diventa una route', () => {
    const body = '## Non implementato (ancora)\n- Allineare `FOLLOWUP.md`\n';
    const [bullet] = classifyCandidateBullets({ pr: { body }, side: 'corpus', manifestFiles: null });
    expect(bullet.routes).toEqual([]);
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

  // Review frontaliere-articles#2097: l'API risponde 404 anche a un token senza
  // accesso al repository. Un 404 è `false` solo se il ref del gemello si legge.
  it('404 con gemello non leggibile da questo token (404, 403, rete sul ref) → null, mai false', () => {
    for (const probeError of ['gh: Not Found (HTTP 404)', 'gh: Resource not accessible (HTTP 403)', 'dial tcp: i/o timeout']) {
      const api = vi.fn((args: string[]) => {
        const url = args[args.length - 1];
        if (url === 'repos/owner/twin/commits/main') throw Object.assign(new Error('gh failed'), { stderr: probeError });
        throw Object.assign(new Error('gh failed'), { stderr: 'gh: Not Found (HTTP 404)' });
      });
      const lookup = createTwinLookup({ repo: 'owner/twin', cap: 5, api });
      expect(lookup('a/missing.ts')).toBeNull();
      expect(lookup('a/other.ts')).toBeNull();
      expect(api.mock.calls.filter((call) => call[0].at(-1) === 'repos/owner/twin/commits/main')).toHaveLength(1);
    }
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

// Titolo di fallimento: «Triage follow-up: verifica rinviata alla CI coniata
// senza leggere la run del merge».
//
// «Vitest in locale — blocked: il resource guard blocca vitest; la CI di questa
// PR fa da oracolo» è candidato per `bulletState()` e il triage lo coniava
// sempre: 13 item su #10433 e 2 su #10283. Lo stato `blocked:` resta (è la
// forma onesta): decide la run `tests` sull'head della PR, letta davvero.
describe('own-verification: la verifica rinviata alla CI la decide la run del merge', () => {
  // Righe reali, verbatim.
  const PR_10197_BULLET = '- blocked: la suite Vitest locale è stata rifiutata dal resource guard per swap oltre la soglia dell\'85%; la verifica completa è affidata alla CI di questa PR.';
  const PR_10221_BULLETS = [
    '- Esecuzione vitest locale di `git-commit-data-append-only-sets.test.ts` e del nuovo test: blocked: il resource guard blocca vitest con lo swap all\'89-92% (soglia 85%), occupato da altri processi. Motivo: la verifica locale è la riproduzione bash dello stesso scenario, con numeri prima/dopo. Prossimo passo: il check `vitest` di questa PR esegue il nuovo test; la suite locale si rilancia quando lo swap scende.',
    '- Esecuzione in CI del caso originale `canonicalizes expired routes after a successful stash pop`: blocked: il file gira solo in `live-data gates`, la cui ultima run (36418824033) si ferma all\'Assemble per il dato `convit-holding.json` (shrink 98.6%) prima di vitest. Motivo: è un problema di dati, indipendente da questa PR. Prossimo passo: alla prima run di `live-data gates` che supera l\'Assemble, leggere l\'esito del file (atteso 13/13).',
  ];
  const HEAD = '04b69c52c7db85decf4a9b1675b1696fe505362d';
  const body = (...bullets: string[]) => ['## Non implementato (ancora)', '', ...bullets].join('\n');

  // Forma reale di `gh run view --log` (run 36425406490): prefisso
  // `<job>\t<step>\t<timestamp>` e colori in notazione caret, non byte ESC.
  const logLine = (text: string) => `vitest (unit + integration)\tUNKNOWN STEP\t2026-09-28T13:05:32.3030427Z ${text}`;
  const greenLine = (file: string) => logLine(` ^[[32m✓^[[39m ^[[30m^[[43m node ^[[49m^[[39m ${file} ^[[2m(^[[22m^[[2m3 tests^[[22m^[[2m)^[[22m^[[33m 1288^[[2mms^[[22m^[[39m`);
  const failedLine = (file: string) => logLine(` ^[[31m❯^[[39m ^[[30m^[[43m node ^[[49m^[[39m ${file} ^[[2m(^[[22m^[[2m3 tests^[[22m^[[2m | ^[[22m^[[31m1 failed^[[39m^[[2m)^[[22m`);
  // Il body della PR stampato nel log nomina il file: non deve valere come esecuzione.
  const bodyEcho = (file: string) => logLine(`  "body": "- Esecuzione vitest locale di \`${file}\`: blocked: …"`);

  const fakeGh = (runs: object[], logs: Record<string, string>) => vi.fn((args: string[]) => {
    if (args[0] === 'run' && args[1] === 'list') return JSON.stringify(runs);
    if (args[0] === 'run' && args[1] === 'view') {
      const log = logs[args[2]];
      if (log === undefined) throw new Error('log unavailable');
      return log;
    }
    throw new Error(`unexpected gh ${args.join(' ')}`);
  });
  const run = (databaseId: number, conclusion: string, createdAt = '2026-09-28T12:59:10Z') => (
    { databaseId, conclusion, status: 'completed', createdAt }
  );
  const classify = (text: string, mergeRunVerdict?: unknown, existsHere = only()) => classifyCandidateBullets({
    pr: { body: text, headRefOid: HEAD } as { body: string },
    side: 'site', manifestFiles: MANIFEST, existsHere, existsTwin: only(),
    mergeRunVerdict: mergeRunVerdict as never,
  });

  it('le righe reali delle PR 10197 e 10221 sono della classe; `live-data gates` no', () => {
    expect(isOwnVerificationBullet(PR_10197_BULLET)).toBe(true);
    expect(isOwnVerificationBullet(PR_10221_BULLETS[0])).toBe(true);
    // Il secondo bullet della 10221 nomina vitest ma rinvia a un altro workflow.
    expect(isOwnVerificationBullet(PR_10221_BULLETS[1])).toBe(false);
  });

  it('una fonte assente, una misura al deploy o una run naturale restano lavoro sospeso', () => {
    for (const text of [
      '- Salari ticinesi — blocked: fonte ufficiale assente',
      '- Tempo di build — blocked: si misura al primo deploy',
      '- Copertura del crawler — blocked: serve la prossima run naturale del cron',
      '- Test del portale — blocked: il resource guard blocca vitest; la prova vera è la verifica live dopo il deploy',
      '- Nuovo test vitest — per scelta: il resource guard blocca vitest. **Motivo:** x. **Prossimo passo:** y.',
    ]) expect(isOwnVerificationBullet(text)).toBe(false);
  });

  it('un rinvio a una run diversa da quella della PR resta lavoro sospeso, anche con la guardia', () => {
    // Senza file nominati, una run `tests` verde basterebbe ad archiviarli:
    // la prova che chiedono non è quella run.
    for (const text of [
      '- Copertura crawler: blocked: il resource guard blocca vitest con swap al 90%. Prossimo passo: osservare la prossima run schedulata del cron crawler.',
      '- Traduzioni: blocked: il resource guard blocca vitest; serve la run post-merge di translate-pending.',
      '- Dati: blocked: guardia risorse, vitest rifiutato; si verifica dopo il merge con la run nightly.',
      '- Parser: blocked: resource guard su vitest. Prossimo passo: `gh workflow run x.yml` (workflow_dispatch).',
      // Anche quando nomina la CI della PR, il rinvio a un cron resta fuori.
      '- Crawler: blocked: il resource guard blocca vitest; la CI di questa PR esegue la suite, poi va osservata la run del cron crawler.',
    ]) expect(isOwnVerificationBullet(text)).toBe(false);
  });

  it('la guardia vale solo con il rinvio alla CI della PR; «dopo il merge» da solo non esclude', () => {
    // Bucket 10283, verbatim: il «dopo il merge» è un rebase, non una prova.
    expect(isOwnVerificationBullet('- Verifica locale con vitest: blocked: la resource-guard locale blocca i comandi pesanti con lo swap sopra l\'85%. Motivo: la macchina è satura. Prossimo passo: la run `tests` di questa PR è l\'oracolo; la PR #10096 viene ribasata su questa dopo il merge.')).toBe(true);
    expect(isOwnVerificationBullet('- Suite locale: blocked: il resource guard blocca vitest; si rilancia quando la macchina si libera.')).toBe(false);
  });

  it('`swap` è la guardia solo con una soglia, e `test` non vale dentro `testo`', () => {
    expect(isOwnVerificationBullet('- Portale: blocked: lo swap del dominio richiede il testo legale del fornitore; ne parla la CI della PR.')).toBe(false);
    expect(isOwnVerificationBullet('- Suite locale: blocked: swap oltre la soglia dell\'85%, vitest rifiutato; la verifica è della CI della PR.')).toBe(true);
  });

  it('riconosce il rinvio esplicito alla CI come oracolo, e la guardia solo se dopo `blocked:`', () => {
    expect(isOwnVerificationBullet('- Verifica locale con vitest: blocked: macchina satura. Prossimo passo: la CI di questa PR fa da oracolo.')).toBe(true);
    expect(isOwnVerificationBullet('- Vitest bloccato dal resource guard (swap 92%): blocked: attendo la decisione sul crawler.')).toBe(false);
  });

  it('i file di test nominati: path, nomi nudi e comandi; il resto no', () => {
    expect(namedTestFiles(PR_10221_BULLETS[0])).toEqual(['git-commit-data-append-only-sets.test.ts']);
    expect(namedTestFiles('`npx vitest run tests/a.test.ts tests/b.test.tsx` e `scripts/x.mjs`, `tests/fixtures/x.json`'))
      .toEqual(['tests/a.test.ts', 'tests/b.test.tsx']);
    expect(namedTestFiles(PR_10197_BULLET)).toEqual([]);
  });

  it('il reporter vitest nel log: righe verdi e rosse, mai il body della PR ristampato', () => {
    const results = parseVitestFileResults([
      greenLine('tests/a.test.ts'),
      failedLine('tests/b.test.ts'),
      bodyEcho('tests/c.test.ts'),
      logLine(' ^[[33m↓^[[39m tests/d.test.ts ^[[2m(3 tests | 3 skipped)^[[22m'),
    ].join('\n'));
    expect(Object.fromEntries(results)).toEqual({ 'tests/a.test.ts': 'green', 'tests/b.test.ts': 'failed' });
  });

  it('il reporter senza colori (`|node|`) vale come quello colorato', () => {
    const results = parseVitestFileResults([
      logLine(' ✓ |node| tests/a.test.ts (3 tests) 12ms'),
      logLine(' ❯ |node| tests/b.test.ts (3 tests | 1 failed) 9ms'),
    ].join('\n'));
    expect(Object.fromEntries(results)).toEqual({ 'tests/a.test.ts': 'green', 'tests/b.test.ts': 'failed' });
  });

  it('lato corpus il comando della scheda usa `node --test` e `generator/tests/`', () => {
    const [bullet] = classifyCandidateBullets({
      pr: { body: body('- Test del parser `x.test.mjs`: blocked: il resource guard blocca i test (swap 91%); li esegue la CI della PR.'), headRefOid: HEAD } as { body: string },
      side: 'corpus', manifestFiles: MANIFEST, existsHere: only('generator/tests/x.test.mjs'), existsTwin: only(),
    });
    expect(bullet).toMatchObject({
      candidate: true,
      ownVerification: { verdict: 'unknown', command: 'node --test generator/tests/x.test.mjs' },
    });
  });

  it('file nominato verde nel log della run → non candidato, `verified-by-merge-run` con l\'id della run', () => {
    const gh = fakeGh([run(36425406490, 'success')], {
      36425406490: [greenLine('tests/git-commit-data-append-only-sets.test.ts'), bodyEcho('x')].join('\n'),
    });
    const [bullet] = classify(body(PR_10221_BULLETS[0]), createMergeRunLookup({ repo: 'o/site', gh }));
    expect(bullet).toMatchObject({
      candidate: false,
      reason: 'verified-by-merge-run',
      routes: [],
      ownVerification: { verdict: 'executed-green', runId: 36425406490 },
    });
    expect(gh.mock.calls[0][0]).toEqual(expect.arrayContaining(['--workflow', 'tests.yml', '--commit', HEAD]));
  });

  it('file nominato ASSENTE dal log di una run `success` → resta candidato, con il comando', () => {
    // Red-first: è il caso reale della PR 10221 (run 36425406490 verde, ma il
    // file è live-data e il gate PR non lo esegue). Fidarsi del solo verde lo
    // avrebbe archiviato.
    const gh = fakeGh([run(36425406490, 'success')], {
      36425406490: [greenLine('tests/git-commit-data-legacy-staging.test.ts'), bodyEcho('git-commit-data-append-only-sets.test.ts')].join('\n'),
    });
    const [bullet] = classify(
      body(PR_10221_BULLETS[0]),
      createMergeRunLookup({ repo: 'o/site', gh }),
      only('tests/git-commit-data-append-only-sets.test.ts'),
    );
    expect(bullet.candidate).toBe(true);
    expect(bullet.reason).toBeNull();
    expect(bullet.ownVerification).toMatchObject({
      verdict: 'not-executed',
      runId: 36425406490,
      files: [{ file: 'git-commit-data-append-only-sets.test.ts', status: 'absent' }],
      command: 'npx vitest run tests/git-commit-data-append-only-sets.test.ts',
    });
  });

  it('run `failure`, lookup in errore, tetto raggiunto o lookup assente → resta candidato', () => {
    const failing = createMergeRunLookup({ repo: 'o/site', gh: fakeGh([run(1, 'failure')], {}) });
    const throwing = () => { throw new Error('boom'); };
    const listFails = createMergeRunLookup({ repo: 'o/site', gh: vi.fn(() => { throw new Error('HTTP 502'); }) });
    const capped = createMergeRunLookup({
      repo: 'o/site', logCap: 0, gh: fakeGh([run(1, 'success')], { 1: greenLine('tests/git-commit-data-append-only-sets.test.ts') }),
    });
    const logFails = createMergeRunLookup({ repo: 'o/site', gh: fakeGh([run(1, 'success')], {}) });
    const verdicts = [failing, throwing, listFails, capped, logFails, undefined].map((lookup) => {
      const [bullet] = classify(body(PR_10221_BULLETS[0]), lookup);
      expect(bullet.candidate).toBe(true);
      return [bullet.ownVerification?.verdict, bullet.ownVerification?.why?.split(':')[0]];
    });
    expect(verdicts).toEqual([
      ['not-executed', 'run-failure'],
      ['unknown', 'lookup-error'],
      ['unknown', 'run-list-failed'],
      ['unknown', 'log-cap-reached'],
      ['unknown', 'log-read-failed'],
      ['unknown', 'lookup-unavailable'],
    ]);
    // Anche senza file nominati una run rossa non chiude niente.
    const [plain] = classify(body(PR_10197_BULLET), createMergeRunLookup({ repo: 'o/site', gh: fakeGh([run(2, 'failure')], {}) }));
    expect(plain).toMatchObject({ candidate: true, ownVerification: { verdict: 'not-executed' } });
  });

  it('nessun file nominato e run `success` → non candidato, senza leggere il log', () => {
    const gh = fakeGh([run(36394507210, 'success')], {});
    const [bullet] = classify(body(PR_10197_BULLET), createMergeRunLookup({ repo: 'o/site', gh }));
    expect(bullet).toMatchObject({
      candidate: false, reason: 'verified-by-merge-run', ownVerification: { verdict: 'executed-green', runId: 36394507210 },
    });
    expect(gh.mock.calls.some((call) => call[0][1] === 'view')).toBe(false);
  });

  it('un bullet non della classe non interroga la run', () => {
    const lookup = vi.fn();
    const bullets = classify(body(PR_10221_BULLETS[1], '- Salari — blocked: fonte ufficiale assente'), lookup);
    expect(bullets.every((b) => b.candidate && b.ownVerification === undefined)).toBe(true);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('una head SHA mancante è `unknown`; log e liste in cache, una lettura per run', () => {
    const gh = fakeGh([run(1, 'success')], { 1: greenLine('tests/a.test.ts') });
    const lookup = createMergeRunLookup({ repo: 'o/site', gh });
    expect(lookup({ pr: {}, testFiles: [] })).toMatchObject({ verdict: 'unknown', why: 'head-sha-unavailable' });
    expect(lookup({ pr: { headRefOid: HEAD }, testFiles: ['tests/a.test.ts'] }).verdict).toBe('executed-green');
    expect(lookup({ pr: { headRefOid: HEAD }, testFiles: ['a.test.ts'] }).verdict).toBe('executed-green');
    expect(gh.mock.calls.map((call) => call[0][1])).toEqual(['list', 'view']);
  });

  it('la sezione del bundle dice al triage di non coniare `verified-by-merge-run` e di citare la run', () => {
    const section = renderCandidateBulletsSection([], { manifestOk: true });
    expect(section).toMatch(/`reason: verified-by-merge-run`[^\n]*NON creare issue[^\n]*`ownVerification\.runId`/);
    expect(section).toMatch(/`ownVerification\.verdict: not-executed\|unknown`[^\n]*`COMANDO: <ownVerification\.command>`/);
  });
});
