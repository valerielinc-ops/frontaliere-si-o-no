import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import {
  loadSocialCopyPack,
  normalizeSocialCopyPack,
  releaseSocialCopyAssignment,
  releaseUnpublishedSocialCopyAssignment,
  selectSocialCopy,
  selectSocialCopyForPublish,
  SOCIAL_COPY_INSTAGRAM_OBJECTIVES,
  socialCopyTemplateCount,
  socialCopyLedgerFields,
  socialCopyTrackingContent,
  validatePersistedSocialCopyPack,
} from '../scripts/lib/social-copy-pack.mjs';

const CHANNEL_KINDS: Record<string, string[]> = {
  instagram: ['article', 'job', 'border', 'reel'],
  tiktok: ['article', 'job', 'border', 'video'],
  facebook: ['article', 'job', 'event', 'digest'],
  linkedin: ['article', 'job'],
  telegram: ['job', 'border'],
  reddit: ['article', 'job'],
};

function channels() {
  const ordinal = ['primo', 'secondo', 'terzo', 'quarto', 'quinto', 'sesto', 'settimo', 'ottavo', 'nono', 'decimo', 'undicesimo', 'dodicesimo'];
  return Object.fromEntries(Object.entries(CHANNEL_KINDS).map(([channel, kinds]) => [
    channel,
    Object.fromEntries(kinds.map((kind) => [kind, Array.from({ length: socialCopyTemplateCount(channel, kind) }, (_, index) => {
      const objective = channel === 'instagram' ? SOCIAL_COPY_INSTAGRAM_OBJECTIVES[Math.floor(index / 3)] : null;
      const objectiveLabel = objective === 'share'
        ? 'Condividi lo spunto'
        : objective === 'save'
          ? 'Salva questo contenuto'
          : 'Quale spunto ti interessa ' + ordinal[index] + '? Raccontalo nei commenti';
      return {
        id: channel + '-' + kind + '-' + ordinal[index],
        ...(objective ? { objective } : {}),
        hook: 'Uno spunto ' + ordinal[index] + ' per parlare di ' + kind + ' su ' + channel,
        cta: objective
          ? objective === 'conversation' ? objectiveLabel : objectiveLabel + ' ' + ordinal[index]
          : 'Apri la pagina ' + ordinal[index] + ' per saperne di più',
      };
    })])),
  ]));
}

describe('social copy pack', () => {
  it('validates the complete channel matrix and keeps its identity stable', () => {
    const pack = normalizeSocialCopyPack(
      { channels: channels() },
      { generatedAt: '2026-10-01T00:00:00.000Z' },
    );

    expect(pack.packId).toMatch(/^[a-f0-9]{16}$/);
    expect(pack.schemaVersion).toBe(2);
    expect(validatePersistedSocialCopyPack(pack, { now: '2026-10-20T00:00:00.000Z' })).toEqual(pack);
  });

  it('keeps a valid v1 pack active for existing channels while Reddit waits for a v2 pack', () => {
    const legacyChannels = channels();
    delete legacyChannels.reddit;
    const generatedAt = '2026-10-01T00:00:00.000Z';
    const packId = createHash('sha256')
      .update('frontaliere-social-copy-v1\n' + JSON.stringify(legacyChannels))
      .digest('hex')
      .slice(0, 16);
    const legacyPack = {
      schemaVersion: 1,
      promptVersion: 'frontaliere-social-copy-v1',
      packId,
      generatedAt,
      validUntil: new Date(Date.parse(generatedAt) + 45 * 86400000).toISOString(),
      channels: legacyChannels,
    };

    const validated = validatePersistedSocialCopyPack(legacyPack, { now: '2026-10-20T00:00:00.000Z' });

    expect(selectSocialCopy({
      pack: validated,
      channel: 'instagram',
      kind: 'article',
      expectedObjective: 'save',
      assignmentKey: 'legacy-content',
    })).toMatchObject({ copyMode: 'codex', copyPromptVersion: 'frontaliere-social-copy-v1' });
    expect(selectSocialCopy({
      pack: validated,
      channel: 'reddit',
      kind: 'article',
      assignmentKey: 'legacy-content',
    })).toBeNull();
  });

  it('rejects unverified numeric claims, URLs, and missing variants', () => {
    const numeric = channels();
    numeric.instagram.article[0].hook = 'Scopri una novità nel 2026';
    expect(() => normalizeSocialCopyPack({ channels: numeric })).toThrow(/numeric claims/);

    const linked = channels();
    linked.tiktok.job[1].cta = 'Vai su https://example.test';
    expect(() => normalizeSocialCopyPack({ channels: linked })).toThrow(/URL/);

    const hashtag = channels();
    hashtag.facebook.article[0].hook = 'Un nuovo spunto #frontaliere';
    expect(() => normalizeSocialCopyPack({ channels: hashtag })).toThrow(/hashtags/);

    const incomplete = channels();
    incomplete.facebook.event.pop();
    expect(() => normalizeSocialCopyPack({ channels: incomplete })).toThrow(/exactly 3 templates/);
    const incompleteJobs = channels();
    incompleteJobs.facebook.job.pop();
    expect(() => normalizeSocialCopyPack({ channels: incompleteJobs })).toThrow(/exactly 12 templates/);
  });

  it('rejects Instagram CTAs whose action conflicts with their declared objective', () => {
    const wrongShareAction = channels();
    wrongShareAction.instagram.article[0].cta = 'Gira pagina per leggere questo spunto';
    expect(() => normalizeSocialCopyPack({ channels: wrongShareAction })).toThrow(/Instagram share objective/);

    const negatedShareAction = channels();
    negatedShareAction.instagram.article[0].cta = 'Non condividere questo spunto';
    expect(() => normalizeSocialCopyPack({ channels: negatedShareAction })).toThrow(/Instagram share objective/);

    for (const cta of ['Condividendo questo spunto', 'Condivideremo questo spunto']) {
      const nonImperativeShare = channels();
      nonImperativeShare.instagram.article[0].cta = cta;
      expect(() => normalizeSocialCopyPack({ channels: nonImperativeShare })).toThrow(/Instagram share objective/);
    }

    const mixedActions = channels();
    mixedActions.instagram.article[0].cta = 'Condividi e salva questo spunto';
    expect(() => normalizeSocialCopyPack({ channels: mixedActions })).toThrow(/Instagram share objective/);

    const negatedFollowUpAction = channels();
    negatedFollowUpAction.instagram.article[0].cta = 'Condividi questo spunto e non condividere altro';
    expect(() => normalizeSocialCopyPack({ channels: negatedFollowUpAction })).toThrow(/Instagram share objective/);

    const extraConversationAction = channels();
    extraConversationAction.instagram.article[6].cta = 'Quale valico preferisci? Raccontalo nei commenti e segui la pagina';
    expect(() => normalizeSocialCopyPack({ channels: extraConversationAction })).toThrow(/exactly one explicit action/);

    const prefixedConversationAction = channels();
    prefixedConversationAction.instagram.article[6].cta = 'Segui la pagina. Quale valico preferisci? Raccontalo nei commenti';
    expect(() => normalizeSocialCopyPack({ channels: prefixedConversationAction })).toThrow(/Instagram conversation objective/);

    const wrongSaveAction = channels();
    wrongSaveAction.instagram.article[3].cta = 'Tieni presente questa guida';
    expect(() => normalizeSocialCopyPack({ channels: wrongSaveAction })).toThrow(/Instagram save objective/);

    for (const cta of ['Salvando questa guida', 'Salveremo questa guida']) {
      const nonImperativeSave = channels();
      nonImperativeSave.instagram.article[3].cta = cta;
      expect(() => normalizeSocialCopyPack({ channels: nonImperativeSave })).toThrow(/Instagram save objective/);
    }

    const wrongConversationAction = channels();
    wrongConversationAction.instagram.article[6].cta = 'Quali commenti trovi più utili?';
    expect(() => normalizeSocialCopyPack({ channels: wrongConversationAction })).toThrow(/Instagram conversation objective/);

    const negatedConversationAction = channels();
    negatedConversationAction.instagram.article[6].cta = 'Non vogliamo che tu commenti: quale valico preferisci?';
    expect(() => normalizeSocialCopyPack({ channels: negatedConversationAction })).toThrow(/Instagram conversation objective/);

    const multipleConversationQuestions = channels();
    multipleConversationQuestions.instagram.article[6].cta = 'Quale valico scegli? Dove vai? Raccontacelo nei commenti';
    expect(() => normalizeSocialCopyPack({ channels: multipleConversationQuestions })).toThrow(/Instagram conversation objective/);

    const closedConversationQuestion = channels();
    closedConversationQuestion.instagram.article[6].cta = 'Ti interessa questa guida? Raccontacelo nei commenti';
    expect(() => normalizeSocialCopyPack({ channels: closedConversationQuestion })).toThrow(/Instagram conversation objective/);
  });

  it('rejects multi-action CTAs on non-Instagram channels too', () => {
    for (const cta of [
      'Leggi la guida e condividi il contenuto',
      'Condividi questo post e tagga un amico',
      'Apri la guida e menziona chi ne ha bisogno',
    ]) {
      const mixed = channels();
      mixed.linkedin.article[0].cta = cta;
      expect(() => normalizeSocialCopyPack({ channels: mixed })).toThrow(/exactly one explicit action/);
    }
  });

  it('assigns one stable template and records reportable copy fields', () => {
    const pack = normalizeSocialCopyPack({ channels: channels() });
    const options = {
      pack,
      channel: 'instagram',
      kind: 'article',
      expectedObjective: 'save',
      assignmentKey: 'article:2026-11-02',
    };
    const selected = selectSocialCopy(options);

    expect(selectSocialCopy(options)).toEqual(selected);
    expect(selected).toMatchObject({
      copyMode: 'codex',
      copySlot: 'article',
      copyPromptVersion: 'frontaliere-social-copy-v2',
      copyPackId: pack.packId,
      objective: 'save',
    });
    expect(socialCopyLedgerFields(selected)).toMatchObject({
      copyMode: 'codex',
      copySlot: 'article',
      copyTemplateId: selected?.id,
      copyHook: selected?.hook,
      copyCta: selected?.cta,
      copyObjective: 'save',
    });
    expect(selected?.objective).toBe('save');
    expect(selectSocialCopy({ ...options, expectedObjective: 'share' })?.objective).toBe('share');
  });

  it('uses Firebase-balanced assignment when Remote Config enables the experiment', async () => {
    const pack = normalizeSocialCopyPack({ channels: channels() });
    const assignBalancedImpl = async ({ templateIds }: { templateIds: string[] }) => ({
      templateId: templateIds[1],
      reused: false,
    });
    const selected = await selectSocialCopyForPublish({
      pack,
      channel: 'facebook',
      kind: 'article',
      assignmentKey: 'article:balanced',
      experimentConfig: { schemaVersion: 1, experimentId: 'social-copy-balanced-v1', enabled: true },
      assignBalancedImpl,
    });

    expect(selected).toMatchObject({
      copyMode: 'codex',
      copyAssignmentMode: 'firebase-balanced',
      copyExperimentId: 'social-copy-balanced-v1',
      copyAssignment: {
        experimentId: 'social-copy-balanced-v1',
        channel: 'facebook',
        slot: 'article',
        assignmentKey: 'article:balanced',
      },
      copyPromptVersion: 'frontaliere-social-copy-v2',
    });
    expect(socialCopyLedgerFields(selected)).toMatchObject({
      copyAssignmentMode: 'firebase-balanced',
      copyExperimentId: 'social-copy-balanced-v1',
    });
    const experimentHash = createHash('sha256').update('social-copy-balanced-v1').digest('hex').slice(0, 8);
    expect(socialCopyTrackingContent('article', selected)).toContain('.' + selected?.id + '.b.' + experimentHash);
    expect(socialCopyLedgerFields(selected)).not.toHaveProperty('copyAssignment');

    let releasedAssignment: unknown;
    await expect(releaseSocialCopyAssignment(selected, {
      releaseBalancedImpl: async (assignment: unknown) => {
        releasedAssignment = assignment;
        return true;
      },
    })).resolves.toBe(true);
    expect(releasedAssignment).toMatchObject({
      experimentId: 'social-copy-balanced-v1',
      channel: 'facebook',
      slot: 'article',
      assignmentKey: 'article:balanced',
    });
  });

  it('keeps the stable variant and records degraded assignment when Firebase is unavailable', async () => {
    const pack = normalizeSocialCopyPack({ channels: channels() });
    const selected = await selectSocialCopyForPublish({
      pack,
      channel: 'telegram',
      kind: 'job',
      assignmentKey: 'job:firebase-unavailable',
      experimentConfig: { schemaVersion: 1, experimentId: 'social-copy-balanced-v1', enabled: true },
      assignBalancedImpl: async () => { throw new Error('permission denied'); },
    });

    expect(selected).toMatchObject({
      copyMode: 'codex',
      copyAssignmentMode: 'deterministic-fallback',
      copyExperimentId: 'social-copy-balanced-v1',
    });
    expect(socialCopyLedgerFields(selected)).toMatchObject({
      copyAssignmentMode: 'deterministic-fallback',
      copyExperimentId: 'social-copy-balanced-v1',
    });
    const experimentHash = createHash('sha256').update('social-copy-balanced-v1').digest('hex').slice(0, 8);
    expect(socialCopyTrackingContent('job', selected)).toContain('.' + selected?.id + '.f.' + experimentHash);
  });

  it('releases a balanced reservation only when the caller reports a certain pre-delivery skip', async () => {
    const copy = {
      copyAssignmentMode: 'firebase-balanced',
      copyAssignment: {
        experimentId: 'social-copy-balanced-v1',
        packId: '0123456789abcdef',
        channel: 'instagram',
        slot: 'article',
        objective: 'share',
        assignmentKey: 'article:2026-10-01',
      },
    };
    const releaseBalancedImpl = vi.fn(async () => true);

    await expect(releaseUnpublishedSocialCopyAssignment(copy, {
      releaseBalancedImpl,
      reason: 'carousel assets did not render',
    })).resolves.toBe(true);
    expect(releaseBalancedImpl).toHaveBeenCalledWith(copy.copyAssignment);
    await expect(releaseUnpublishedSocialCopyAssignment({ copyAssignmentMode: 'deterministic-fallback' }, {
      releaseBalancedImpl,
    })).resolves.toBe(false);
  });

  it('does not write Firebase assignments while building a dry-run preview', async () => {
    const pack = normalizeSocialCopyPack({ channels: channels() });
    let assigned = false;
    const selected = await selectSocialCopyForPublish({
      pack,
      channel: 'facebook',
      kind: 'article',
      assignmentKey: 'article:preview',
      dryRun: true,
      experimentConfig: { schemaVersion: 1, experimentId: 'social-copy-balanced-v1', enabled: true },
      assignBalancedImpl: async () => {
        assigned = true;
        return { templateId: 'facebook-article-one' };
      },
    });

    expect(assigned).toBe(false);
    expect(selected?.copyAssignmentMode).toBe('deterministic');
  });

  it('adds a compact variant id to UTM content while preserving legacy attribution', () => {
    const copy = {
      copyMode: 'codex',
      copyPackId: '0123456789abcdef',
      copySlot: 'article',
      id: 'facebook-article-two',
    };
    expect(socialCopyTrackingContent('article-a', copy)).toBe('article-a--cp0123456789abcdef-article.facebook-article-two.d');
    expect(socialCopyTrackingContent('article-a', socialCopyLedgerFields(null))).toBe('article-a');
    expect(socialCopyTrackingContent('', copy)).toBe('');
    expect(socialCopyTrackingContent('article-a', { ...copy, copyPackId: 'bad' })).toBe('article-a');
  });

  it('falls back cleanly when the generated pack is absent or stale', () => {
    expect(loadSocialCopyPack({ filePath: 'missing-social-copy-pack.json' })).toBeNull();
    const stale = normalizeSocialCopyPack(
      { channels: channels() },
      { generatedAt: '2026-01-01T00:00:00.000Z' },
    );
    expect(() => validatePersistedSocialCopyPack(stale, { now: '2026-03-01T00:00:00.000Z' })).toThrow(/stale/);
    expect(socialCopyLedgerFields(null, { fallbackHook: 'Copy esistente' })).toMatchObject({
      copyMode: 'deterministic',
      copyTemplateId: 'baseline',
      copyHook: 'Copy esistente',
    });
  });
});
