import { describe, it, expect, afterEach } from 'vitest';
import {
  bucketState,
  canonicalDailyBuckets,
  dailyBucketSourcePrNumbers,
  dailyBucketIdentity,
  dailyBucketInfo,
  dailyBucketTitle,
  dailyKeyFromBucketBody,
  dailyKeyZurich,
  dailyItemFingerprint,
  dedupeDailyItems,
  followupFingerprint,
  followupItemId,
  hasDailyBucketRepositoryConsistency,
  hasStableItemIds,
  hasStableItemIdsForDailyKey,
  hasUnterminatedMarkdownFence,
  parseFollowupItems,
  selectFirstOpenItem,
  updateFollowupItemState,
} from '../scripts/ci/followup-resolution-match.mjs';
import {
  dailyBucketRecoveryDecision,
  decideDailyMintGate,
  decideMintGate,
  mergeDailyBucketBodies,
  parseOpenFollowupPages,
  retitleDailyBucket,
} from '../scripts/ci/gate-minted-followups.mjs';
import { dailyBucketCloseGate, reconcileDailyItems } from '../scripts/ci/reconcile-followups.mjs';
import { dailyBucketQueueDecision, dailyMutexDecision, flattenPaginatedOpenPrs, openPrForDailyItem } from '../scripts/ci/followup-drainer.mjs';
import { triageDailyKey } from '../scripts/ci/collect-followup-batch.mjs';

const DAY = '2026-09-09';

function item(id: string, state = 'open', title = 'Proteggi il comportamento') {
  return [
    `### ${id} — ${title}`,
    `- State: ${state}`,
    '- Sources: PR #8101; reviewer 🟡',
    '- Stato dichiarato nella PR: nessuno',
    '- Target file: `scripts/example.mjs`',
    '- Original text:',
    '  > il controllo non è sempre applicato',
    '- Suggested action: aggiungi `firstGuard()` e `secondGuard()` in `scripts/example.mjs`',
    '- Acceptance token: `firstGuard()`',
  ].join('\n');
}

function distinctItem(id: string, state = 'open') {
  return item(id, state)
    .replaceAll('firstGuard()', 'thirdGuard()')
    .replaceAll('secondGuard()', 'fourthGuard()');
}

function body(...items: string[]) {
  return [
    '## Batch',
    `- Daily key: ${DAY} (Europe/Zurich)`,
    '- State: collecting',
    '- Target repository: owner/repo',
    '',
    '## Item',
    ...items.flatMap((entry) => ['', entry]),
    '',
  ].join('\n');
}

const resolvedIo = {
  fileExists: (path: string) => path === 'scripts/example.mjs',
  readFile: () => 'firstGuard(); secondGuard(); thirdGuard(); fourthGuard();',
};

afterEach(() => {
  delete process.env.TRIAGE_DAILY_KEY;
});

describe('daily follow-up identity and dedup', () => {
  it('uses the Zurich calendar day, including the UTC boundary', () => {
    expect(dailyKeyZurich(Date.parse('2026-09-08T22:30:00.000Z'))).toBe(DAY);
    expect(dailyKeyZurich(Date.parse('2026-09-09T00:30:00.000Z'))).toBe(DAY);
  });

  it('round-trips the canonical bucket title and stable IDs', () => {
    const title = dailyBucketTitle(DAY, 'owner/repo', 2);
    expect(title).toBe(`follow-up(daily:${DAY}): 2 items — owner/repo`);
    expect(dailyBucketInfo(title)).toEqual({ dailyKey: DAY, itemCount: 2, targetRepository: 'owner/repo' });
    expect(followupItemId(DAY, 1)).toBe(`FU-${DAY}-001`);
    expect(followupItemId(DAY, 2.9)).toBe(`FU-${DAY}-002`);
    expect(retitleDailyBucket(title, 1)).toBe(`follow-up(daily:${DAY}): 1 item — owner/repo`);
  });

  it('keeps site and corpus fingerprints separate and normalizes equivalent input', () => {
    const base = {
      targetFile: 'scripts/example.mjs',
      acceptanceToken: 'firstGuard()',
    };
    expect(followupFingerprint({ ...base, targetRepository: 'OWNER/REPO' }))
      .toBe(followupFingerprint({ ...base, targetRepository: ' owner/repo ' }));
    expect(followupFingerprint({ ...base, targetRepository: 'owner/repo' }))
      .not.toBe(followupFingerprint({ ...base, targetRepository: 'other/repo' }));
    expect(followupFingerprint({ ...base, targetRepository: 'owner/repo', targetFile: 'scripts/other.mjs' }))
      .not.toBe(followupFingerprint({ ...base, targetRepository: 'owner/repo' }));
    expect(followupFingerprint({ targetRepository: 'owner/repo', targetFile: base.targetFile, acceptanceToken: '   ', suggestedAction: 'add `firstGuard()`' }))
      .toBe(followupFingerprint({ targetRepository: 'owner/repo', targetFile: base.targetFile, acceptanceToken: '', suggestedAction: 'add `firstGuard()`' }));
  });

  it('deduplicates equal fingerprints and merges all source PRs into the kept item', () => {
    const source = body(
      item(`FU-${DAY}-001`),
      item(`FU-${DAY}-002`).replace('PR #8101', 'PR #8102'),
    );
    const [first, second] = parseFollowupItems(source);
    const result = dedupeDailyItems([first, second], 'owner/repo');
    expect(result.items).toHaveLength(1);
    expect(result.duplicates).toHaveLength(1);
    expect(result.items[0].id).toBe(`FU-${DAY}-001`);
    expect(result.items[0].text).toContain('PR #8101');
    expect(result.items[0].text).toContain('PR #8102');
    expect(result.duplicates[0].fingerprint).toBe(dailyItemFingerprint(result.items[0], 'owner/repo'));
  });

  it('canonicalizza un solo owner per chiave giornaliera e repository', () => {
    const issues = [
      { number: 12, title: dailyBucketTitle(DAY, 'owner/repo', 1) },
      { number: 9, title: dailyBucketTitle(DAY, 'owner/repo', 2) },
      { number: 3, title: dailyBucketTitle(DAY, 'other/repo', 1) },
    ];
    expect(dailyBucketIdentity(issues[0].title)).toBe(`${DAY}|owner/repo`);
    expect(canonicalDailyBuckets(issues).get(`${DAY}|owner/repo`)?.number).toBe(9);
    expect(canonicalDailyBuckets(issues).get(`${DAY}|other/repo`)?.number).toBe(3);
  });

  it('richiede una lista follow-up REST completa e distingue PR da issue', () => {
    const parsed = parseOpenFollowupPages(JSON.stringify([
      [{ number: 10, title: dailyBucketTitle(DAY, 'owner/repo', 1), state: 'open' }],
      [{ number: 11, title: 'pull request label', pull_request: { url: 'https://example.test/pr/11' } }],
    ]));
    expect(parsed?.map((entry) => entry.number)).toEqual([10]);
    expect(parseOpenFollowupPages(JSON.stringify([
      [{ number: 10, title: 'x' }],
      [{ number: 10, title: 'duplicate' }],
    ]))).toBeNull();
    expect(parseOpenFollowupPages('not-json')).toBeNull();
  });

  it('recupera un collecting storico solo con Sources e marker per ogni PR', () => {
    expect(dailyBucketRecoveryDecision({
      state: 'collecting',
      sourcePrs: [8101, 8102],
      triagedPrs: [8101, 8102],
    })).toMatchObject({ eligible: true, reason: 'historical-triage-markers' });
    expect(dailyBucketRecoveryDecision({
      state: 'collecting',
      sourcePrs: [8101, 8102],
      triagedPrs: [8101],
    })).toMatchObject({
      eligible: false,
      reason: 'historical-triage-incomplete',
      missingPrs: [8102],
    });
    expect(dailyBucketRecoveryDecision({
      state: 'collecting',
      sourcePrs: [],
      triagedPrs: [],
    })).toMatchObject({ eligible: false, reason: 'no-source-pr-markers' });
    expect(dailyBucketRecoveryDecision({
      state: 'collecting',
      sourcePrs: [8101],
      triagedPrs: [8101],
      scanOk: false,
    })).toMatchObject({ eligible: false, reason: 'historical-triage-scan-unavailable' });
    expect(dailyBucketRecoveryDecision({
      state: 'sealed',
      sourcePrs: [8101],
      triagedPrs: [8101],
    })).toMatchObject({ eligible: false, reason: 'bucket-not-collecting' });
  });

  it('legge Sources e Daily key solo fuori da fence/quote', () => {
    const source = body(item(`FU-${DAY}-001`))
      .replace('- Sources: PR #8101; reviewer 🟡', '- Sources: PR #8101; reviewer 🟡\n```md\n- Sources: PR #9999\n```\n> - Sources: PR #8888');
    expect(dailyKeyFromBucketBody(source)).toBe(DAY);
    expect(dailyBucketSourcePrNumbers(source)).toEqual([8101]);
  });

  it('consolida i bucket duplicati, rimappa ID collidenti e deduplica le Sources', () => {
    const title = dailyBucketTitle(DAY, 'owner/repo', 1);
    const merged = mergeDailyBucketBodies(
      { title, body: body(item(`FU-${DAY}-001`)) },
      { title, body: body(item(`FU-${DAY}-001`).replace('PR #8101', 'PR #8102')) },
    );
    expect(merged?.body).toContain('- State: collecting');
    expect(parseFollowupItems(merged?.body || '')).toHaveLength(1);
    expect(merged?.body).toContain('PR #8101');
    expect(merged?.body).toContain('PR #8102');

    const distinct = mergeDailyBucketBodies(
      { title, body: body(item(`FU-${DAY}-001`)) },
      { title, body: body(distinctItem(`FU-${DAY}-001`)) },
    );
    expect(parseFollowupItems(distinct?.body || '').map((entry) => entry.id)).toEqual([
      `FU-${DAY}-001`,
      `FU-${DAY}-002`,
    ]);

    const mismatchedPrimaryBody = body(item(`FU-${DAY}-001`)).replace(
      `- Daily key: ${DAY}`,
      '- Daily key: 2026-09-08',
    );
    expect(mergeDailyBucketBodies(
      { title, body: mismatchedPrimaryBody },
      { title, body: body(item(`FU-${DAY}-001`).replace('PR #8101', 'PR #8102')) },
    )).toBeNull();
    expect(mergeDailyBucketBodies(
      { title, body: body(item(`FU-${DAY}-001`)) },
      {
        title: dailyBucketTitle('2026-09-08', 'owner/repo', 1),
        body: body(item('FU-2026-09-08-001')).replace(`- Daily key: ${DAY}`, '- Daily key: 2026-09-08'),
      },
    )).toBeNull();
  });
});

describe('daily item parsing and lifecycle', () => {
  it('segnala una fence Markdown non terminata e blocca sealing, queue, reconcile e close', () => {
    const unterminated = body(item(`FU-${DAY}-001`)).replace(
      '- Acceptance token: `firstGuard()`',
      '- Acceptance token: `firstGuard()`\n```md\n### FU-2020-01-01-999 — item finto\n- State: done',
    );
    const parsed = parseFollowupItems(unterminated);
    expect(parsed).toHaveLength(1);
    expect(parsed.unterminatedFence).toBe(true);
    expect(hasUnterminatedMarkdownFence(unterminated)).toBe(true);
    expect(decideDailyMintGate({
      title: dailyBucketTitle(DAY, 'owner/repo', 1),
      body: unterminated,
    })).toMatchObject({ action: 'skip', reason: 'unterminated-markdown-fence' });
    expect(dailyBucketQueueDecision({
      title: dailyBucketTitle(DAY, 'owner/repo', 1),
      body: unterminated.replace('- State: collecting', '- State: sealed'),
    })).toMatchObject({ eligible: false, reason: 'unterminated-markdown-fence' });
    expect(reconcileDailyItems(unterminated, resolvedIo, DAY)).toMatchObject({
      changed: false,
      reason: 'unterminated-markdown-fence',
    });
    expect(dailyBucketCloseGate(unterminated, resolvedIo, DAY)).toMatchObject({
      blocks: true,
      reason: 'unterminated-markdown-fence',
    });
  });

  it('selects and updates only the first open item without renumbering IDs', () => {
    const sealed = body(item(`FU-${DAY}-001`, 'done'), distinctItem(`FU-${DAY}-002`));
    const first = selectFirstOpenItem(sealed);
    expect(first?.id).toBe(`FU-${DAY}-002`);
    expect(parseFollowupItems(sealed)).toHaveLength(2);
    expect(hasStableItemIds(sealed)).toBe(true);
    expect(bucketState(sealed)).toBe('collecting');
    const updated = updateFollowupItemState(sealed, `FU-${DAY}-002`, 'in-progress');
    expect(updated).toContain(`### FU-${DAY}-002 — Proteggi il comportamento\n- State: in-progress`);
    expect(updated).toContain(`### FU-${DAY}-001 — Proteggi il comportamento\n- State: done`);
  });

  it('rifiuta State duplicati/conflicting live ma ignora esempi in fence e quote', () => {
    const valid = body(item(`FU-${DAY}-001`)).replace(
      '- Suggested action: aggiungi `firstGuard()` e `secondGuard()` in `scripts/example.mjs`',
      '- Suggested action: aggiungi `firstGuard()` e `secondGuard()` in `scripts/example.mjs`\n```md\n- State: done\n```\n> - State: blocked',
    );
    expect(parseFollowupItems(valid)).toHaveLength(1);
    const conflicting = body(item(`FU-${DAY}-001`).replace('- State: open', '- State: open\n- State: done'));
    expect(parseFollowupItems(conflicting)).toEqual([]);
    expect(bucketState(conflicting)).toBeNull();
    const duplicateBucketState = body(item(`FU-${DAY}-001`)).replace(
      '- State: collecting',
      '- State: collecting\n- State: sealed',
    );
    expect(bucketState(duplicateBucketState)).toBeNull();
  });

  it('close e reconcile ignorano headings/campi annidati in fence e quote', () => {
    const nested = body(item(`FU-${DAY}-001`)).replace(
      '- Original text:\n  > il controllo non è sempre applicato',
      '- Original text:\n```md\n### FU-2020-01-01-999 — item finto\n- State: done\n- Suggested action: aggiungi `ghost()` in `scripts/example.mjs`\n```\n> ### FU-2020-01-01-998 — item citato\n> - State: done\n  > il controllo non è sempre applicato',
    ).replace('- State: collecting', '- State: sealed');
    expect(parseFollowupItems(nested).map((entry) => entry.id)).toEqual([`FU-${DAY}-001`]);
    const reconciled = reconcileDailyItems(nested, resolvedIo, DAY);
    expect(reconciled.changes.map((change) => change.id)).toEqual([`FU-${DAY}-001`]);
    expect(dailyBucketCloseGate(reconciled.body, resolvedIo, DAY).blocks).toBe(false);
  });

  it('rifiuta gli ID FU con data diversa dalla chiave del bucket in close/reconcile/drainer', () => {
    const wrong = body(item('FU-2026-09-08-001')).replace('- State: collecting', '- State: sealed');
    expect(dailyKeyFromBucketBody(wrong)).toBe(DAY);
    expect(hasStableItemIdsForDailyKey(wrong, DAY)).toBe(false);
    expect(dailyBucketCloseGate(wrong, resolvedIo, DAY)).toMatchObject({
      blocks: true,
      reason: 'mismatched-stable-item-id',
    });
    expect(reconcileDailyItems(wrong, resolvedIo, DAY)).toMatchObject({
      changed: false,
      reason: 'mismatched-stable-item-id',
    });
    expect(dailyBucketQueueDecision({
      title: dailyBucketTitle(DAY, 'owner/repo', 1),
      body: wrong,
    })).toMatchObject({ eligible: false, reason: 'mismatched-stable-item-id' });

    const mismatchedBodyKey = body(item(`FU-${DAY}-001`))
      .replace(`- Daily key: ${DAY}`, '- Daily key: 2026-09-08')
      .replace('- State: collecting', '- State: sealed');
    expect(decideDailyMintGate({
      title: dailyBucketTitle(DAY, 'owner/repo', 1),
      body: mismatchedBodyKey,
    })).toMatchObject({ action: 'skip', reason: 'mismatched-daily-key' });
    expect(dailyBucketQueueDecision({
      title: dailyBucketTitle(DAY, 'owner/repo', 1),
      body: mismatchedBodyKey,
    })).toMatchObject({ eligible: false, reason: 'mismatched-daily-key' });
  });

  it('rifiuta repository incoerenti fra titolo, header, item e fingerprint', () => {
    const itemWithWrongRepository = item(`FU-${DAY}-001`)
      .replace('- Target file:', '- Target repository: other/repo\n- Target file:');
    const wrongItem = body(itemWithWrongRepository);
    expect(hasDailyBucketRepositoryConsistency(wrongItem, 'owner/repo')).toBe(false);
    expect(dailyItemFingerprint(parseFollowupItems(wrongItem)[0], 'owner/repo')).toBeNull();
    expect(decideDailyMintGate({
      title: dailyBucketTitle(DAY, 'owner/repo', 1),
      body: wrongItem,
    })).toMatchObject({ action: 'skip', reason: 'mismatched-target-repository' });
    const sealedWrongItem = wrongItem.replace('- State: collecting', '- State: sealed');
    expect(dailyBucketQueueDecision({
      title: dailyBucketTitle(DAY, 'owner/repo', 1),
      body: sealedWrongItem,
    })).toMatchObject({ eligible: false, reason: 'mismatched-target-repository' });
    expect(reconcileDailyItems(sealedWrongItem, resolvedIo, DAY, 'owner/repo')).toMatchObject({
      changed: false,
      reason: 'mismatched-target-repository',
    });
    expect(dailyBucketCloseGate(sealedWrongItem, resolvedIo, DAY, 'owner/repo')).toMatchObject({
      blocks: true,
      reason: 'mismatched-target-repository',
    });

    const wrongHeader = body(item(`FU-${DAY}-001`)).replace(
      '- Target repository: owner/repo',
      '- Target repository: other/repo',
    );
    expect(decideDailyMintGate({
      title: dailyBucketTitle(DAY, 'owner/repo', 1),
      body: wrongHeader,
    })).toMatchObject({ action: 'skip', reason: 'mismatched-target-repository' });
    expect(mergeDailyBucketBodies(
      { title: dailyBucketTitle(DAY, 'owner/repo', 1), body: body(item(`FU-${DAY}-001`)) },
      { title: dailyBucketTitle(DAY, 'owner/repo', 1), body: wrongHeader },
    )).toBeNull();
    expect(mergeDailyBucketBodies(
      { title: dailyBucketTitle(DAY, 'owner/repo', 1), body: body(item(`FU-${DAY}-001`)) },
      {
        title: dailyBucketTitle(DAY, 'other/repo', 1),
        body: wrongHeader,
      },
    )).toBeNull();
  });
});

describe('daily mint gate and reconciliation', () => {
  it('seals a complete collecting bucket and never queues it before sealing', () => {
    const source = body(item(`FU-${DAY}-001`), distinctItem(`FU-${DAY}-002`));
    const queueBefore = dailyBucketQueueDecision({
      title: dailyBucketTitle(DAY, 'owner/repo', 2),
      body: source,
    });
    expect(queueBefore).toEqual({ eligible: false, reason: 'bucket-collecting', item: null });

    const decision = decideDailyMintGate({
      title: dailyBucketTitle(DAY, 'owner/repo', 2),
      body: source,
    });
    expect(decision.action).toBe('seal');
    expect(decision.body).toContain('- State: sealed');
    expect(decision.body).toContain(`FU-${DAY}-001`);
    expect(decision.body).toContain(`FU-${DAY}-002`);

    const queueAfter = dailyBucketQueueDecision({
      title: dailyBucketTitle(DAY, 'owner/repo', 2),
      body: decision.body || '',
    });
    expect(queueAfter.eligible).toBe(true);
    expect(queueAfter.item?.id).toBe(`FU-${DAY}-001`);
  });

  it('blocca queue e close quando il conteggio nel titolo non coincide col body', () => {
    const source = body(item(`FU-${DAY}-001`)).replace('- State: collecting', '- State: sealed');
    const issue = { title: dailyBucketTitle(DAY, 'owner/repo', 2), body: source };
    expect(dailyBucketQueueDecision(issue)).toMatchObject({
      eligible: false,
      reason: 'mismatched-item-count',
    });
    expect(dailyBucketCloseGate(
      source,
      resolvedIo,
      DAY,
      'owner/repo',
      2,
    )).toMatchObject({ blocks: true, reason: 'mismatched-item-count' });
    expect(reconcileDailyItems(source, resolvedIo, DAY, 'owner/repo', 2)).toMatchObject({
      changed: false,
      reason: 'mismatched-item-count',
    });
  });

  it('permits a late retry to seal a daily bucket after the legacy freshness window', () => {
    const decision = decideMintGate({
      title: dailyBucketTitle(DAY, 'owner/repo', 1),
      body: body(item(`FU-${DAY}-001`)),
      createdAt: '2026-09-08T00:00:00.000Z',
    }, {
      now: Date.parse('2026-09-09T12:00:00.000Z'),
      maxAgeMin: 1,
    });
    expect(decision.action).toBe('seal');
    expect(decision.reason).toBe('daily-bucket-sealed');
  });

  it('leaves collecting when the triage session did not complete all chunks', () => {
    const decision = decideDailyMintGate({
      title: dailyBucketTitle(DAY, 'owner/repo', 1),
      body: body(item(`FU-${DAY}-001`)),
    }, { triageComplete: false });
    expect(decision).toMatchObject({ action: 'skip', reason: 'triage-incomplete', body: null });
  });

  it('ripara un bucket sealed senza ereditare il segnale globale di triage', () => {
    const decision = decideDailyMintGate({
      title: dailyBucketTitle(DAY, 'owner/repo', 1),
      body: body(item(`FU-${DAY}-001`)).replace('- State: collecting', '- State: sealed'),
    }, { triageComplete: false });
    expect(decision).toMatchObject({ action: 'keep', reason: 'already-sealed', body: null });
  });

  it('demotes an item without acceptance and seals only the valid survivors', () => {
    const invalid = item(`FU-${DAY}-002`).replace(
      '- Suggested action: aggiungi `firstGuard()` e `secondGuard()` in `scripts/example.mjs`',
      '- Suggested action: valuta il rischio in futuro',
    );
    const decision = decideDailyMintGate({
      title: dailyBucketTitle(DAY, 'owner/repo', 2),
      body: body(item(`FU-${DAY}-001`), invalid),
    });
    expect(decision.action).toBe('demote');
    expect(decision.valid).toHaveLength(1);
    expect(decision.demoted).toHaveLength(1);
    expect(decision.body).toContain('- State: sealed');
    expect(decision.body).toContain(`FU-${DAY}-001`);
    expect(decision.body).not.toContain(`FU-${DAY}-002`);
  });

  it('applica il fingerprint nel gate di produzione, non solo come helper', () => {
    const duplicateBody = body(
      item(`FU-${DAY}-001`),
      item(`FU-${DAY}-002`).replace('PR #8101', 'PR #8102'),
    );
    const decision = decideDailyMintGate({
      title: dailyBucketTitle(DAY, 'owner/repo', 2),
      body: duplicateBody,
    });
    expect(decision.action).toBe('dedupe');
    expect(decision.reason).toBe('duplicate-fingerprint');
    expect(decision.duplicates).toHaveLength(1);
    expect(decision.body).toContain('PR #8101');
    expect(decision.body).toContain('PR #8102');
    expect(parseFollowupItems(decision.body || '')).toHaveLength(1);
  });

  it('marks resolved open items done but blocks closure until every item is done', () => {
    const source = body(item(`FU-${DAY}-001`), distinctItem(`FU-${DAY}-002`, 'open'))
      .replace('- State: collecting', '- State: sealed');
    const reconciled = reconcileDailyItems(source, resolvedIo);
    expect(reconciled.changed).toBe(true);
    expect(reconciled.changes.map((change) => change.id)).toEqual([
      `FU-${DAY}-001`,
      `FU-${DAY}-002`,
    ]);
    const closed = dailyBucketCloseGate(reconciled.body, resolvedIo);
    // Strong evidence is intentionally required for the auto-close path; each item
    // has two prescribed tokens, so all valid items can close after the grace tier.
    expect(closed.blocks).toBe(false);
  });

  it('also finalizes a resolved item left in progress by a fixer run', () => {
    const source = body(item(`FU-${DAY}-001`, 'in-progress'))
      .replace('- State: collecting', '- State: sealed');
    const reconciled = reconcileDailyItems(source, resolvedIo);
    expect(reconciled.changes.map((change) => change.id)).toEqual([`FU-${DAY}-001`]);
    expect(reconciled.body).toContain(`### FU-${DAY}-001 — Proteggi il comportamento\n- State: done`);
  });

  it('keeps a malformed or collecting bucket open', () => {
    const collecting = dailyBucketCloseGate(body(item(`FU-${DAY}-001`)), resolvedIo);
    expect(collecting).toMatchObject({ blocks: true, reason: 'bucket-collecting' });
    const missingId = dailyBucketCloseGate(
      body(item(`FU-${DAY}-001`).replace(`### FU-${DAY}-001 — Proteggi il comportamento`, '### 1. legacy'))
        .replace('- State: collecting', '- State: sealed'),
      resolvedIo,
    );
    expect(missingId).toMatchObject({ blocks: true, reason: 'missing-stable-item-id' });
  });
});

describe('daily drainer item mutex', () => {
  it('does not block an item claimed by a different item marker', () => {
    const id = `FU-${DAY}-001`;
    const pr = { number: 42, title: 'fix another item', body: `Addresses #9\nFollow-up item: FU-${DAY}-002` };
    expect(openPrForDailyItem(id, [pr])).toBeNull();
    expect(openPrForDailyItem(id, [{ ...pr, body: `Addresses #9\nFollow-up item: ${id}` }])).toEqual({
      ...pr,
      body: `Addresses #9\nFollow-up item: ${id}`,
    });
  });

  it('distingue una scansione open-PR fallita da una lista vuota e pagina tutte le risposte', () => {
    const id = `FU-${DAY}-001`;
    expect(dailyMutexDecision(id, { ok: false, prs: [] })).toMatchObject({
      eligible: false,
      reason: 'open-pr-scan-unavailable',
    });
    expect(dailyMutexDecision(id, { ok: true, prs: [] })).toMatchObject({ eligible: true, reason: null });
    expect(dailyMutexDecision(id, {
      ok: true,
      prs: [{ number: 77, body: `Follow-up item: ${id}` }],
    })).toMatchObject({ eligible: false, reason: 'item-pr-open' });
    expect(flattenPaginatedOpenPrs([[{ number: 1 }], [{ number: 2 }]])).toEqual([{ number: 1 }, { number: 2 }]);
    expect(flattenPaginatedOpenPrs('not-json' as unknown as unknown[])).toBeNull();
  });
});

describe('collect batch daily key', () => {
  it('allows the workflow retry to keep an explicit successful-run key', () => {
    process.env.TRIAGE_DAILY_KEY = '2026-09-08';
    expect(triageDailyKey(Date.parse('2026-09-09T12:00:00Z'))).toBe('2026-09-08');
  });
});
