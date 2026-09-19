import { describe, expect, it } from 'vitest';
import {
  changedLinesFromPatch,
  dedupeFindingsById,
  findingDeclaredClass,
  findingSymbol,
  isMalformedReviewBody,
  isRegressionFinding,
  renderFindingsLedger,
  reviewBodyDefects,
  stableFindingId,
  unchangedLineImportants,
} from '../scripts/ci/lib/review-findings.mjs';
import {
  classifyReview,
  importantFindings,
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
});
