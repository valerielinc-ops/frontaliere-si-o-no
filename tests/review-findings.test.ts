import { describe, expect, it } from 'vitest';
import {
  changedLinesFromPatch,
  dedupeFindingsById,
  findingDeclaredClass,
  findingSymbol,
  isMalformedReviewBody,
  isRegressionFinding,
  LEDGER_MAX_ENTRIES,
  renderFindingsLedger,
  reviewBodyDefects,
  stableFindingId,
  unchangedLineImportants,
} from '../scripts/ci/lib/review-findings.mjs';
import {
  classifyReview,
  historicalImportantFindings,
  importantFindings,
  partitionHistoricalImportantFindings,
  reviewBodyWithHistoricalFindings,
  runReviewGate,
} from '../scripts/ci/review-gate.mjs';

const HEAD = 'a'.repeat(40);

function finding(text: string) {
  return importantFindings(`## Findings (Important: 1, Nit: 0)\n\n${text}\n`)[0];
}

describe('identità stabile del finding', () => {
  it('non cambia quando la riga si sposta', () => {
    const a = finding('`scripts/ci/foo.mjs:L12`: 🔴 Important: `parseFoo()` non gestisce il null. Aggiungi la guardia.');
    const b = finding('`scripts/ci/foo.mjs:L87`: 🔴 Important: `parseFoo()` non gestisce il null. Aggiungi la guardia.');
    expect(stableFindingId(a)).toBe(stableFindingId(b));
  });

  it('distingue due rilievi diversi sullo stesso file', () => {
    const a = finding('`scripts/ci/foo.mjs:L12`: 🔴 Important: `parseFoo()` non gestisce il null.');
    const b = finding('`scripts/ci/foo.mjs:L12`: 🔴 Important: `writeBar()` scrive fuori dal tmpdir.');
    expect(stableFindingId(a)).not.toBe(stableFindingId(b));
  });

  it('distingue la stessa prosa su file diversi', () => {
    const a = finding('`scripts/ci/foo.mjs:L12`: 🔴 Important: `parseFoo()` non gestisce il null.');
    const b = finding('`scripts/ci/bar.mjs:L12`: 🔴 Important: `parseFoo()` non gestisce il null.');
    expect(stableFindingId(a)).not.toBe(stableFindingId(b));
  });

  it('cade sulla prosa normalizzata quando non c’è un simbolo', () => {
    expect(findingSymbol('`scripts/ci/foo.mjs:L12`: 🔴 Important: il loop non termina.')).toBe('');
    const a = finding('`scripts/ci/foo.mjs:L12`: 🔴 Important: il loop non termina.');
    const b = finding('`scripts/ci/foo.mjs:L40`: 🔴 Important: il loop non termina.');
    expect(stableFindingId(a)).toBe(stableFindingId(b));
  });

  it('non scambia un path in backtick per un simbolo', () => {
    expect(findingSymbol('🔴 Important: `scripts/ci/foo.mjs` e `NONCODE_RE` divergono.')).toBe('NONCODE_RE');
  });

  it('legge la classe dichiarata e rifiuta quelle inventate', () => {
    expect(findingDeclaredClass('`a.mjs:L1`: 🔴 Important: [regression] rotto.')).toBe('regression');
    expect(findingDeclaredClass('`a.mjs:L1`: 🔴 Important [urgentissimo]: rotto.')).toBe('other');
    expect(findingDeclaredClass('`a.mjs:L1`: 🔴 Important: rotto.')).toBe('other');
    expect(isRegressionFinding(finding('`a.mjs:L1`: 🔴 Important: [regression] rotto.'))).toBe(true);
  });

  it('deduplica per id conservando il primo esemplare', () => {
    const a = finding('`scripts/ci/foo.mjs:L12`: 🔴 Important: `parseFoo()` non gestisce il null.');
    const b = finding('`scripts/ci/foo.mjs:L99`: 🔴 Important: `parseFoo()` non gestisce il null.');
    expect(dedupeFindingsById([a, b])).toHaveLength(1);
    expect(dedupeFindingsById([a, b])[0].lineNumber).toBe(a.lineNumber);
  });
});

describe('igiene del body', () => {
  it('scarta un body con \\n letterali al posto delle righe', () => {
    const body = '## Findings (Important: 1, Nit: 0)\\n\\n`a.mjs:L1`: 🔴 Important: rotto.\\n\\n## LGTM';
    expect(reviewBodyDefects(body)).toContain('literal-newline');
    expect(isMalformedReviewBody(body)).toBe(true);
  });

  it('scarta una conferma senza anchor', () => {
    expect(reviewBodyDefects('## Findings (Important: 0, Nit: 0)\n\nFix di : ok\n\n## LGTM'))
      .toContain('empty-fix-anchor');
    expect(reviewBodyDefects('## Findings\n\n- Fix di ``: ok.\n')).toContain('empty-fix-anchor');
  });

  it('non confonde un \\n citato dentro un blocco di codice con la malformazione', () => {
    const body = ['## Scope', 'La regex separa su `\\n`.', '', '```js', "split('\\n')", "join('\\n')", "trim('\\n')", '```', '', '## Findings (Important: 0, Nit: 0)', '', '## LGTM'].join('\n');
    expect(isMalformedReviewBody(body)).toBe(false);
  });

  it('lascia passare un body normale', () => {
    expect(isMalformedReviewBody('## Findings (Important: 0, Nit: 0)\n\n- Fix di `a.mjs:L3`: ok.\n\n## LGTM')).toBe(false);
  });
});

describe('changedLinesFromPatch', () => {
  it('estrae le righe nuove per path e registra i path senza righe', () => {
    const patch = [
      'diff --git a/scripts/ci/foo.mjs b/scripts/ci/foo.mjs',
      '--- a/scripts/ci/foo.mjs',
      '+++ b/scripts/ci/foo.mjs',
      '@@ -10,0 +11,2 @@',
      '+const added = 1;',
      '+const other = 2;',
    ].join('\n');
    const map = changedLinesFromPatch(patch)!;
    expect([...map.get('scripts/ci/foo.mjs')!]).toEqual([11, 12]);
  });

  it('ritorna null su un input non testuale', () => {
    expect(changedLinesFromPatch(null as unknown as string)).toBeNull();
  });
});

describe('🔴 nuovi su righe non cambiate', () => {
  const stale = finding('`scripts/ci/foo.mjs:L12`: 🔴 Important: `parseFoo()` non gestisce il null.');
  const compared = new Map([['scripts/ci/foo.mjs', new Set([80, 81])]]);

  it('declassa un finding nuovo su una riga che nessuno ha toccato', () => {
    expect(unchangedLineImportants({ findings: [stale], priorFindingIds: new Set(), changedLines: compared }))
      .toHaveLength(1);
  });

  it('non declassa un finding già aperto', () => {
    expect(unchangedLineImportants({
      findings: [stale],
      priorFindingIds: new Set([stableFindingId(stale)]),
      changedLines: compared,
    })).toHaveLength(0);
  });

  it('non declassa una regressione dichiarata', () => {
    const regression = finding('`scripts/ci/foo.mjs:L12`: 🔴 Important: [regression] `parseFoo()` non gestisce il null.');
    expect(unchangedLineImportants({ findings: [regression], priorFindingIds: new Set(), changedLines: compared }))
      .toHaveLength(0);
  });

  it('non declassa quando la riga citata è fra quelle cambiate', () => {
    expect(unchangedLineImportants({
      findings: [stale],
      priorFindingIds: new Set(),
      changedLines: new Map([['scripts/ci/foo.mjs', new Set([12])]]),
    })).toHaveLength(0);
  });

  it('non declassa un finding senza anchor di riga', () => {
    const bare = finding('🔴 Important: `parseFoo()` non gestisce il null in `scripts/ci/foo.mjs`.');
    expect(unchangedLineImportants({ findings: [bare], priorFindingIds: new Set(), changedLines: compared }))
      .toHaveLength(0);
  });

  it('non declassa quando il path citato non è stato confrontato', () => {
    expect(unchangedLineImportants({
      findings: [stale],
      priorFindingIds: new Set(),
      changedLines: new Map([['scripts/ci/altro.mjs', new Set([1])]]),
    })).toHaveLength(0);
  });

  it('non declassa niente quando il delta non è calcolabile', () => {
    expect(unchangedLineImportants({ findings: [stale], priorFindingIds: new Set(), changedLines: null }))
      .toHaveLength(0);
  });
});

describe('classifyReview con la regola sulle righe non cambiate', () => {
  const body = '## Findings (Important: 1, Nit: 0)\n\n`scripts/ci/foo.mjs:L12`: 🔴 Important: `parseFoo()` non gestisce il null.\n\n## LGTM';
  const base = {
    files: ['scripts/ci/foo.mjs'],
    complete: true,
    repositoryPaths: ['scripts/ci/foo.mjs'],
  };

  it('declassa e non blocca quando main ha solo mosso la base', () => {
    const result = classifyReview(body, {
      ...base,
      priorFindingIds: new Set<string>(),
      // merge di main che NON tocca i file della PR: patch vuoto, il seed con
      // l'elenco file è ciò che rende «non cambiata» la riga citata.
      changedLinesSince: new Map(),
    });
    expect(result.staleDeclassified).toHaveLength(1);
    expect(result.blocking).toBe(false);
    expect(result.inScope).toHaveLength(0);
  });

  it('resta bloccante senza il delta', () => {
    const result = classifyReview(body, base);
    expect(result.staleDeclassified ?? []).toHaveLength(0);
    expect(result.blocking).toBe(true);
  });

  it('resta bloccante su una regressione dichiarata', () => {
    const regression = body.replace('🔴 Important:', '🔴 Important: [regression]');
    const result = classifyReview(regression, {
      ...base,
      priorFindingIds: new Set<string>(),
      changedLinesSince: new Map(),
    });
    expect(result.blocking).toBe(true);
  });
});

describe('carry storico senza duplicati', () => {
  it('non ripete un finding già presente con un anchor spostato', () => {
    const current = '## Findings (Important: 1, Nit: 0)\n\n`scripts/ci/foo.mjs:L87`: 🔴 Important: `parseFoo()` non gestisce il null.\n\n## LGTM';
    const historical = importantFindings('`scripts/ci/foo.mjs:L12`: 🔴 Important: `parseFoo()` non gestisce il null.');
    expect(reviewBodyWithHistoricalFindings(current, historical)).toBe(current);
  });
});

describe('runReviewGate scarta un verdetto malformato', () => {
  it('non approva un body con \\n letterali', async () => {
    const reviews = [[{
      id: 1,
      user: { type: 'Bot', login: 'frontaliere-automation[bot]' },
      state: 'COMMENTED',
      commit_id: HEAD,
      submitted_at: '2026-09-19T12:00:00Z',
      // Niente `## Findings`/`## LGTM` reali: `normalizeReviewBody` non
      // riscrive questo body, quindi il gate lo vedrebbe come una riga sola.
      body: 'Scope: la PR va bene.\\nFindings: nessuno.\\nLGTM.\\n',
    }]];
    const result = await runReviewGate({
      repo: 'owner/repo', pr: '1', headSha: HEAD, reviews, mutate: false,
      repositoryPaths: [], changedPathsFn: () => null, changedLinesFn: () => null,
    });
    expect(result.approved).toBe(false);
    expect(result.reason).toMatch(/malformato/u);
    expect(result.bodyDefects).toContain('literal-newline');
  });

  it('approva un body ben formato con lo stesso contenuto', async () => {
    const reviews = [[{
      id: 1,
      user: { type: 'Bot', login: 'frontaliere-automation[bot]' },
      state: 'COMMENTED',
      commit_id: HEAD,
      submitted_at: '2026-09-19T12:00:00Z',
      body: '## Findings (Important: 0, Nit: 0)\n\n## LGTM\n',
    }]];
    const result = await runReviewGate({
      repo: 'owner/repo', pr: '1', headSha: HEAD, reviews, mutate: false,
      repositoryPaths: [], changedPathsFn: () => null, changedLinesFn: () => null,
    });
    expect(result.approved).toBe(true);
  });
});

describe('ledger passato al reviewer', () => {
  it('elenca aperti e chiusi con il loro id, senza ripetere un aperto', () => {
    const open = importantFindings('`scripts/ci/foo.mjs:L12`: 🔴 Important: `parseFoo()` non gestisce il null.');
    const closed = importantFindings('`scripts/ci/bar.mjs:L3`: 🔴 Important: `writeBar()` scrive fuori dal tmpdir.');
    const ledger = renderFindingsLedger({ open, confirmed: [...open, ...closed] });
    expect(ledger).toContain(`\`${stableFindingId(open[0])}\` **open**`);
    expect(ledger).toContain(`\`${stableFindingId(closed[0])}\` **confirmed-fixed**`);
    expect(ledger.match(new RegExp(stableFindingId(open[0]), 'gu')).length).toBe(1);
  });

  it('dichiara la prima review quando non c’è storia', () => {
    expect(renderFindingsLedger({})).toMatch(/prima review/u);
  });

  it('tiene tutti gli open e taglia solo la coda dei confirmed', () => {
    const open = Array.from({ length: 3 }, (_unused, index) =>
      importantFindings(`\`scripts/ci/o${index}.mjs:L1\`: 🔴 Important: \`open${index}()\` rotto.`)[0]);
    const confirmed = Array.from({ length: 50 }, (_unused, index) =>
      importantFindings(`\`scripts/ci/c${index}.mjs:L1\`: 🔴 Important: \`done${index}()\` rotto.`)[0]);
    const ledger = renderFindingsLedger({ open, confirmed });
    expect((ledger.match(/\*\*open\*\*/gu) || []).length).toBe(3);
    expect((ledger.match(/\*\*confirmed-fixed\*\*/gu) || []).length).toBe(LEDGER_MAX_ENTRIES - 3);
    expect(ledger).toMatch(/\(\+13 confirmed-fixed più vecchi/u);
  });
});


describe('collisione dell’id stabile (review #9318, finding 1)', () => {
  // Due rilievi DIVERSI sullo stesso file, stessa classe, che nominano per
  // primo lo stesso simbolo: con `(path, simbolo, classe)` collidevano e
  // `dedupeFindingsById` ne faceva sparire uno dal carry storico.
  const a = finding('`scripts/ci/foo.mjs:L12`: 🔴 Important: `parseFoo()` non gestisce il null e emette structured data invalido.');
  const b = finding('`scripts/ci/foo.mjs:L44`: 🔴 Important: `parseFoo()` scrive il file fuori dal tmpdir.');

  it('non collassa due rilievi diversi che citano lo stesso simbolo', () => {
    expect(stableFindingId(a)).not.toBe(stableFindingId(b));
    expect(dedupeFindingsById([a, b])).toHaveLength(2);
  });

  it('un Important aperto non sparisce dal carry per colpa dell’altro', () => {
    const current = `## Findings (Important: 1, Nit: 0)\n\n${a.text}\n\n## LGTM`;
    expect(reviewBodyWithHistoricalFindings(current, [a, b])).toContain(b.text);
  });

  it('resta invariante allo spostamento della riga', () => {
    const moved = finding('`scripts/ci/foo.mjs:L900`: 🔴 Important: `parseFoo()` non gestisce il null e emette structured data invalido.');
    expect(stableFindingId(moved)).toBe(stableFindingId(a));
  });
});

describe('ledger: confirmed-fixed solo da conferma esplicita (review #9318, finding 2)', () => {
  const HEAD_A = 'a'.repeat(40);
  const HEAD_B = 'b'.repeat(40);
  const bot = (id: number, body: string, commit: string, at: string) => ({
    id, user: { type: 'Bot', login: 'frontaliere-automation[bot]' },
    state: 'COMMENTED', commit_id: commit, body, submitted_at: at,
  });

  it('classifica confermato solo ciò che una review successiva chiude con `Fix di`', () => {
    const reviews = [[
      bot(1, '## Findings (Important: 2, Nit: 0)\n\n`scripts/ci/uno.mjs:L3`: 🔴 Important: `alfa()` rotto.\n\n`scripts/ci/due.mjs:L7`: 🔴 Important: `beta()` rotto.\n', HEAD_B, '2026-09-19T10:00:00Z'),
      bot(2, '## Findings (Important: 1, Nit: 0)\n\n- Fix di `scripts/ci/uno.mjs:L3`: ok.\n\n`scripts/ci/due.mjs:L7`: 🔴 Important: `beta()` rotto.\n', HEAD_A, '2026-09-19T11:00:00Z'),
    ]];
    const { open, confirmed } = partitionHistoricalImportantFindings(reviews, { includeLatest: true });
    expect(confirmed.map((f) => f.text).join('\n')).toContain('alfa()');
    expect(confirmed.map((f) => f.text).join('\n')).not.toContain('beta()');
    expect(open.map((f) => f.text).join('\n')).toContain('beta()');
    // `historicalImportantFindings` resta il contratto precedente.
    expect(historicalImportantFindings(reviews, { includeLatest: true })).toEqual(open);
  });

  it('un finding mai confermato non finisce nel ledger come chiuso', () => {
    const reviews = [[
      bot(1, '## Findings (Important: 1, Nit: 0)\n\n`scripts/ci/uno.mjs:L3`: 🔴 Important: `alfa()` rotto.\n', HEAD_B, '2026-09-19T10:00:00Z'),
      bot(2, '## Findings (Important: 0, Nit: 0)\n\n## LGTM\n', HEAD_A, '2026-09-19T11:00:00Z'),
    ]];
    const { open, confirmed } = partitionHistoricalImportantFindings(reviews, { includeLatest: true });
    expect(confirmed).toHaveLength(0);
    expect(renderFindingsLedger({ open, confirmed })).not.toContain('confirmed-fixed');
    expect(renderFindingsLedger({ open, confirmed })).toContain('**open**');
  });
});

describe('changedLinesFromPatch: dentro un hunk niente è un header (review #9318, finding 3)', () => {
  it('una riga AGGIUNTA che inizia con `++ ` non viene letta come header', () => {
    const patch = [
      'diff --git a/scripts/ci/foo.mjs b/scripts/ci/foo.mjs',
      '--- a/scripts/ci/foo.mjs',
      '+++ b/scripts/ci/foo.mjs',
      '@@ -10,0 +11,3 @@',
      '+++ /dev/null',
      '+const added = 1;',
      '+-- non un header',
    ].join('\n');
    const map = changedLinesFromPatch(patch)!;
    expect([...map.keys()]).toEqual(['scripts/ci/foo.mjs']);
    expect([...map.get('scripts/ci/foo.mjs')!]).toEqual([11, 12, 13]);
  });

  it('un file cancellato non crea una voce di path', () => {
    const patch = [
      'diff --git a/scripts/ci/via.mjs b/scripts/ci/via.mjs',
      '--- a/scripts/ci/via.mjs',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-uno',
      '-due',
    ].join('\n');
    expect([...changedLinesFromPatch(patch)!.keys()]).toEqual([]);
  });

  it('conta il contesto e ignora `\\ No newline at end of file`', () => {
    const patch = [
      '--- a/scripts/ci/foo.mjs',
      '+++ b/scripts/ci/foo.mjs',
      '@@ -1,2 +1,3 @@',
      ' contesto',
      '+aggiunta',
      ' altro contesto',
      '\\ No newline at end of file',
    ].join('\n');
    expect([...changedLinesFromPatch(patch)!.get('scripts/ci/foo.mjs')!]).toEqual([2]);
  });

  it('separa due file nello stesso patch', () => {
    const patch = [
      'diff --git a/uno.mjs b/uno.mjs',
      '--- a/uno.mjs',
      '+++ b/uno.mjs',
      '@@ -1,0 +1,1 @@',
      '+primo',
      'diff --git a/due.mjs b/due.mjs',
      '--- a/due.mjs',
      '+++ b/due.mjs',
      '@@ -5,0 +6,1 @@',
      '+secondo',
    ].join('\n');
    const map = changedLinesFromPatch(patch)!;
    expect([...map.get('uno.mjs')!]).toEqual([1]);
    expect([...map.get('due.mjs')!]).toEqual([6]);
  });
});
