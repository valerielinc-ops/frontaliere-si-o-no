import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import {
  buildSocialCopyBlockContext,
  assertSocialCopyTreatmentContinuity,
  loadSocialCopyPack,
  normalizeSocialCopyPack,
  releaseSocialCopyAssignment,
  releaseUnpublishedSocialCopyAssignment,
  releaseUnpublishedSocialCopyAssignmentBestEffort,
  selectSocialCopy,
  selectSocialCopyForPublish,
  SOCIAL_COPY_INSTAGRAM_OBJECTIVES,
  socialCopyExperimentRegistrationId,
  socialCopyExperimentTreatmentFingerprint,
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

function channels({ includeEditorialAngles = true, schemaVersion = 4 } = {}) {
  const ordinal = ['primo', 'secondo', 'terzo', 'quarto', 'quinto', 'sesto', 'settimo', 'ottavo', 'nono', 'decimo', 'undicesimo', 'dodicesimo'];
  return Object.fromEntries(Object.entries(CHANNEL_KINDS).map(([channel, kinds]) => [
    channel,
    Object.fromEntries(kinds.map((kind) => [kind, Array.from({ length: socialCopyTemplateCount(channel, kind, schemaVersion) }, (_, index) => {
      const objectives = kind === 'reel' && schemaVersion >= 4
        ? ['follow']
        : SOCIAL_COPY_INSTAGRAM_OBJECTIVES.filter((objective) => objective !== 'follow');
      const objective = channel === 'instagram' ? objectives[Math.floor(index / 3)] : null;
      const objectiveLabel = objective === 'share'
        ? 'Condividi lo spunto'
        : objective === 'save'
          ? 'Salva questo contenuto'
          : objective === 'follow'
            ? 'Segui il profilo per aggiornamenti verificati sul Ticino'
            : 'Quale spunto ti interessa ' + ordinal[index] + '? Raccontalo nei commenti';
      return {
        id: channel + '-' + kind + '-' + ordinal[index],
        ...(includeEditorialAngles ? { angleId: `${channel}-${kind}-angle-${(index % 3) + 1}` } : {}),
        ...(objective ? { objective } : {}),
        hook: 'Uno spunto ' + ordinal[index] + ' per parlare di ' + kind + ' su ' + channel,
        cta: objective
          ? objective === 'conversation' ? objectiveLabel : objectiveLabel + ' ' + ordinal[index]
          : 'Apri la pagina ' + ordinal[index] + ' per saperne di più',
      };
    })])),
  ]));
}

function editorialPlan(rawChannels = channels()) {
  const pillars = [
    { id: 'opportunita', name: 'Opportunità concrete', audienceNeed: 'Valutare opportunità e passi pratici con informazioni chiare' },
    { id: 'vita-oltreconfine', name: 'Vita oltreconfine', audienceNeed: 'Orientarsi tra lavoro e vita tra Italia e Svizzera' },
    { id: 'strumenti-utili', name: 'Strumenti utili', audienceNeed: 'Trovare risposte verificabili a domande ricorrenti' },
  ];
  const angleLabels = ['domanda pratica', 'contesto utile', 'prossimo passo'];
  const angles = Object.fromEntries(Object.entries(rawChannels).map(([channel, kinds]) => [
    channel,
    Object.fromEntries(Object.keys(kinds).map((kind) => [kind, angleLabels.map((label, index) => ({
      id: `${channel}-${kind}-angle-${index + 1}`,
      pillarId: pillars[index].id,
      audienceNeed: `Capire meglio ${kind} partendo da una ${label} concreta`,
      angle: `Parti da una ${label} legata a ${kind}`,
      intent: ['searchable', 'shareable', 'both'][index],
      evidenceBasis: 'editorial-hypothesis',
    }))])),
  ]));
  return { pillars, angles };
}

function packInput(rawChannels = channels()) {
  return { channels: rawChannels, editorialPlan: editorialPlan(rawChannels) };
}

function registeredExperiment(pack: { packId: string }, channel: string, slot: string, objective = '') {
  const experimentId = 'social-copy-angle-matched-v3';
  const selectedObjective = channel === 'linkedin' ? 'overall' : objective;
  const treatmentFingerprint = socialCopyExperimentTreatmentFingerprint(pack, {
    channel, slot, objective: selectedObjective,
  });
  const registrationId = socialCopyExperimentRegistrationId({
    experimentId,
    packId: pack.packId,
    treatmentFingerprint,
    channel,
    slot,
    objective: selectedObjective,
  });
  return {
    schemaVersion: 4,
    experimentId,
    enabled: true,
    protocolVersion: 'social-copy-angle-matched-block-v3',
    registrations: { [registrationId]: 'a'.repeat(64) },
    registrationDeadlines: { [registrationId]: '2099-01-01T00:00:00.000Z' },
    winners: {},
  };
}

function withoutEditorialAngles(rawChannels) {
  for (const kinds of Object.values(rawChannels)) {
    for (const templates of Object.values(kinds)) {
      for (const template of templates) delete template.angleId;
    }
  }
  return rawChannels;
}

describe('social copy pack', () => {
  it('validates the complete channel matrix and keeps its identity stable', () => {
    const pack = normalizeSocialCopyPack(
      packInput(),
      { generatedAt: '2026-10-01T00:00:00.000Z' },
    );

    expect(pack.packId).toMatch(/^[a-f0-9]{16}$/);
    expect(pack.schemaVersion).toBe(4);
    expect(pack.editorialPlan.angles.instagram.article).toHaveLength(3);
    expect(validatePersistedSocialCopyPack(pack, { now: '2026-10-20T00:00:00.000Z' })).toEqual(pack);
  });

  it('keeps angle-level experiment identity stable across weekly hook refreshes', () => {
    const first = normalizeSocialCopyPack(packInput(), { generatedAt: '2026-10-01T00:00:00.000Z' });
    const refreshedInput = packInput();
    refreshedInput.channels.instagram.article[0].hook = 'Un esempio utile per orientarti nel lavoro oltreconfine';
    const refreshed = normalizeSocialCopyPack(refreshedInput, { generatedAt: '2026-11-01T00:00:00.000Z' });
    const treatmentFingerprint = socialCopyExperimentTreatmentFingerprint(first, {
      channel: 'instagram', slot: 'article', objective: 'share',
    });
    const refreshedFingerprint = socialCopyExperimentTreatmentFingerprint(refreshed, {
      channel: 'instagram', slot: 'article', objective: 'share',
    });
    expect(first.packId).not.toBe(refreshed.packId);
    expect(refreshedFingerprint).toBe(treatmentFingerprint);
    expect(socialCopyExperimentRegistrationId({
      experimentId: 'social-copy-angle-matched-v3', packId: first.packId,
      treatmentFingerprint, channel: 'instagram', slot: 'article', objective: 'share',
    })).toBe(socialCopyExperimentRegistrationId({
      experimentId: 'social-copy-angle-matched-v3', packId: refreshed.packId,
      treatmentFingerprint: refreshedFingerprint, channel: 'instagram', slot: 'article', objective: 'share',
    }));
    expect(assertSocialCopyTreatmentContinuity(first, refreshed)).toBe(true);
  });

  it('maps a frozen angle arm onto the refreshed pack template', async () => {
    const first = normalizeSocialCopyPack(packInput(), { generatedAt: '2026-10-01T00:00:00.000Z' });
    const refreshedInput = packInput();
    refreshedInput.channels.instagram.article[0].hook = 'Un esempio utile per orientarti nel lavoro oltreconfine';
    const refreshed = normalizeSocialCopyPack(refreshedInput, { generatedAt: '2026-11-01T00:00:00.000Z' });
    const armId = first.editorialPlan.angles.instagram.article[0].id;
    const freshTemplate = refreshed.channels.instagram.article.find((template) => template.angleId === armId);
    let allocatedArms: string[] = [];
    const selected = await selectSocialCopyForPublish({
      pack: refreshed,
      channel: 'instagram',
      kind: 'article',
      expectedObjective: 'share',
      assignmentKey: 'article:stable-angle',
      blockContext: buildSocialCopyBlockContext({ sourceClass: 'article', scheduledDate: '2026-11-03' }),
      experimentConfig: registeredExperiment(first, 'instagram', 'article', 'share'),
      assignBalancedImpl: async ({ armIds }: { armIds: string[] }) => {
        allocatedArms = armIds;
        return { armId, blockId: 'd'.repeat(64), blockCycle: 4 };
      },
    });

    expect(allocatedArms).toContain(armId);
    expect(selected).toMatchObject({
      id: freshTemplate?.id,
      hook: freshTemplate?.hook,
      copyPackId: refreshed.packId,
      copyAngleId: armId,
      copyRegistrationHash: 'a'.repeat(64),
    });
  });

  it('rejects redefining a treatment while reusing its angle ID', () => {
    const first = normalizeSocialCopyPack(packInput());
    const changedInput = packInput();
    changedInput.editorialPlan.angles.instagram.article[0].angle = 'Una definizione diversa con lo stesso identificatore';
    const changed = normalizeSocialCopyPack(changedInput);
    expect(() => assertSocialCopyTreatmentContinuity(first, changed)).toThrow(/without new angle IDs/);
  });

  it('requires three referenced, evenly assigned editorial angles per channel format', () => {
    expect(() => normalizeSocialCopyPack({ channels: channels() })).toThrow(/editorialPlan/);

    const unknownAngle = packInput();
    unknownAngle.channels.instagram.article[0].angleId = 'unregistered-angle';
    expect(() => normalizeSocialCopyPack(unknownAngle)).toThrow(/reference an editorial angle/);

    const unevenAngles = packInput();
    unevenAngles.channels.facebook.job[0].angleId = 'facebook-job-angle-2';
    expect(() => normalizeSocialCopyPack(unevenAngles)).toThrow(/evenly distributed/);

    const inventedEvidence = packInput();
    inventedEvidence.editorialPlan.angles.instagram.article[0].evidenceBasis = 'high-performing';
    expect(() => normalizeSocialCopyPack(inventedEvidence)).toThrow(/evidenceBasis is unsupported/);

    const duplicateAngles = packInput();
    duplicateAngles.editorialPlan.angles.instagram.article[1].angle = duplicateAngles.editorialPlan.angles.instagram.article[0].angle;
    expect(() => normalizeSocialCopyPack(duplicateAngles)).toThrow(/angles and audience needs must be distinct/);
  });

  it('carries exact editorial angle and pillar IDs into publishing metadata and UTM content', () => {
    const pack = normalizeSocialCopyPack(packInput());
    const selected = selectSocialCopy({
      pack,
      channel: 'facebook',
      kind: 'article',
      assignmentKey: 'article:angle-attribution',
    });

    expect(selected).toMatchObject({
      copyAngleId: expect.stringMatching(/^facebook-article-angle-[123]$/),
      copyPillarId: expect.stringMatching(/^(opportunita|vita-oltreconfine|strumenti-utili)$/),
      copyAngleIntent: expect.stringMatching(/^(searchable|shareable|both)$/),
    });
    expect(socialCopyLedgerFields(selected)).toMatchObject({
      copyAngleId: selected?.copyAngleId,
      copyPillarId: selected?.copyPillarId,
      copyAngleIntent: selected?.copyAngleIntent,
    });
    expect(socialCopyTrackingContent('article-a', selected)).toContain(`.a${selected?.copyAngleId}.d`);
  });

  it('keeps a valid v1 pack active for existing channels while Reddit waits for a v2 pack', () => {
    const legacyChannels = withoutEditorialAngles(channels({ schemaVersion: 1 }));
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

  it('keeps a valid v2 pack active while the new editorial plan is generated', () => {
    const previousChannels = withoutEditorialAngles(channels({ schemaVersion: 2 }));
    const generatedAt = '2026-10-01T00:00:00.000Z';
    const packId = createHash('sha256')
      .update('frontaliere-social-copy-v2\n' + JSON.stringify(previousChannels))
      .digest('hex')
      .slice(0, 16);
    const previousPack = {
      schemaVersion: 2,
      promptVersion: 'frontaliere-social-copy-v2',
      packId,
      generatedAt,
      validUntil: new Date(Date.parse(generatedAt) + 45 * 86400000).toISOString(),
      channels: previousChannels,
    };

    expect(validatePersistedSocialCopyPack(previousPack, { now: '2026-10-20T00:00:00.000Z' })).toMatchObject({
      schemaVersion: 2,
      promptVersion: 'frontaliere-social-copy-v2',
    });
  });

  it('keeps a valid v3 pack active until the Reel follow pack is regenerated', () => {
    const rawPreviousChannels = channels({ schemaVersion: 3 });
    const previousChannels = Object.fromEntries(Object.entries(rawPreviousChannels).map(([channel, kinds]) => [
      channel,
      Object.fromEntries(Object.entries(kinds).map(([kind, templates]) => [
        kind,
        templates.map((template) => ({
          id: template.id,
          ...(template.objective ? { objective: template.objective } : {}),
          ...(template.angleId ? { angleId: template.angleId } : {}),
          hook: template.hook,
          cta: template.cta,
        })),
      ])),
    ]));
    const previousEditorialPlan = editorialPlan(previousChannels);
    const generatedAt = '2026-10-01T00:00:00.000Z';
    const packId = createHash('sha256')
      .update('frontaliere-social-copy-v3\n' + JSON.stringify({ editorialPlan: previousEditorialPlan, channels: previousChannels }))
      .digest('hex')
      .slice(0, 16);
    const previousPack = {
      schemaVersion: 3,
      promptVersion: 'frontaliere-social-copy-v3',
      packId,
      generatedAt,
      validUntil: new Date(Date.parse(generatedAt) + 45 * 86400000).toISOString(),
      editorialPlan: previousEditorialPlan,
      channels: previousChannels,
    };

    const validated = validatePersistedSocialCopyPack(previousPack, { now: '2026-10-20T00:00:00.000Z' });
    expect(validated.schemaVersion).toBe(3);
    expect(selectSocialCopy({
      pack: validated,
      channel: 'instagram',
      kind: 'reel',
      expectedObjective: 'share',
      assignmentKey: 'legacy-reel-share',
    })).toMatchObject({ copyMode: 'codex', objective: 'share' });
    expect(selectSocialCopy({
      pack: validated,
      channel: 'instagram',
      kind: 'reel',
      expectedObjective: 'follow',
      assignmentKey: 'legacy-reel-follow',
    })).toBeNull();
  });

  it('selects the v4 Reel follow arm as the growth objective', () => {
    const pack = normalizeSocialCopyPack(packInput());
    const selected = selectSocialCopy({
      pack,
      channel: 'instagram',
      kind: 'reel',
      expectedObjective: 'follow',
      assignmentKey: 'reel-follow-growth',
    });

    expect(selected).toMatchObject({ copyMode: 'codex', objective: 'follow' });
    expect(selected?.cta).toMatch(/^Segui\b/u);
    expect(selectSocialCopy({
      pack,
      channel: 'instagram',
      kind: 'reel',
      expectedObjective: 'share',
      assignmentKey: 'reel-legacy-share',
    })).toBeNull();
  });

  it('rejects unverified numeric claims, URLs, and missing variants', () => {
    const numeric = channels();
    numeric.instagram.article[0].hook = 'Scopri una novità nel 2026';
    expect(() => normalizeSocialCopyPack(packInput(numeric))).toThrow(/numeric claims/);

    const linked = channels();
    linked.tiktok.job[1].cta = 'Vai su https://example.test';
    expect(() => normalizeSocialCopyPack(packInput(linked))).toThrow(/URL/);

    const hashtag = channels();
    hashtag.facebook.article[0].hook = 'Un nuovo spunto #frontaliere';
    expect(() => normalizeSocialCopyPack(packInput(hashtag))).toThrow(/hashtags/);

    const incomplete = channels();
    incomplete.facebook.event.pop();
    expect(() => normalizeSocialCopyPack(packInput(incomplete))).toThrow(/exactly 3 templates/);
    const incompleteJobs = channels();
    incompleteJobs.facebook.job.pop();
    expect(() => normalizeSocialCopyPack(packInput(incompleteJobs))).toThrow(/exactly 12 templates/);
  });

  it('rejects Instagram CTAs whose action conflicts with their declared objective', () => {
    const wrongShareAction = channels();
    wrongShareAction.instagram.article[0].cta = 'Gira pagina per leggere questo spunto';
    expect(() => normalizeSocialCopyPack(packInput(wrongShareAction))).toThrow(/Instagram share objective/);

    const negatedShareAction = channels();
    negatedShareAction.instagram.article[0].cta = 'Non condividere questo spunto';
    expect(() => normalizeSocialCopyPack(packInput(negatedShareAction))).toThrow(/Instagram share objective/);

    for (const cta of ['Condividendo questo spunto', 'Condivideremo questo spunto']) {
      const nonImperativeShare = channels();
      nonImperativeShare.instagram.article[0].cta = cta;
      expect(() => normalizeSocialCopyPack(packInput(nonImperativeShare))).toThrow(/Instagram share objective/);
    }

    const mixedActions = channels();
    mixedActions.instagram.article[0].cta = 'Condividi e salva questo spunto';
    expect(() => normalizeSocialCopyPack(packInput(mixedActions))).toThrow(/Instagram share objective/);

    const negatedFollowUpAction = channels();
    negatedFollowUpAction.instagram.article[0].cta = 'Condividi questo spunto e non condividere altro';
    expect(() => normalizeSocialCopyPack(packInput(negatedFollowUpAction))).toThrow(/Instagram share objective/);

    const extraConversationAction = channels();
    extraConversationAction.instagram.article[6].cta = 'Quale valico preferisci? Raccontalo nei commenti e segui la pagina';
    expect(() => normalizeSocialCopyPack(packInput(extraConversationAction))).toThrow(/Instagram conversation objective/);

    const prefixedConversationAction = channels();
    prefixedConversationAction.instagram.article[6].cta = 'Segui la pagina. Quale valico preferisci? Raccontalo nei commenti';
    expect(() => normalizeSocialCopyPack(packInput(prefixedConversationAction))).toThrow(/Instagram conversation objective/);

    const wrongSaveAction = channels();
    wrongSaveAction.instagram.article[3].cta = 'Tieni presente questa guida';
    expect(() => normalizeSocialCopyPack(packInput(wrongSaveAction))).toThrow(/Instagram save objective/);

    for (const cta of ['Salvando questa guida', 'Salveremo questa guida']) {
      const nonImperativeSave = channels();
      nonImperativeSave.instagram.article[3].cta = cta;
      expect(() => normalizeSocialCopyPack(packInput(nonImperativeSave))).toThrow(/Instagram save objective/);
    }

    const wrongConversationAction = channels();
    wrongConversationAction.instagram.article[6].cta = 'Quali commenti trovi più utili?';
    expect(() => normalizeSocialCopyPack(packInput(wrongConversationAction))).toThrow(/Instagram conversation objective/);

    const negatedConversationAction = channels();
    negatedConversationAction.instagram.article[6].cta = 'Non vogliamo che tu commenti: quale valico preferisci?';
    expect(() => normalizeSocialCopyPack(packInput(negatedConversationAction))).toThrow(/Instagram conversation objective/);

    const multipleConversationQuestions = channels();
    multipleConversationQuestions.instagram.article[6].cta = 'Quale valico scegli? Dove vai? Raccontacelo nei commenti';
    expect(() => normalizeSocialCopyPack(packInput(multipleConversationQuestions))).toThrow(/Instagram conversation objective/);

    const closedConversationQuestion = channels();
    closedConversationQuestion.instagram.article[6].cta = 'Ti interessa questa guida? Raccontacelo nei commenti';
    expect(() => normalizeSocialCopyPack(packInput(closedConversationQuestion))).toThrow(/Instagram conversation objective/);

    const wrongFollowAction = channels();
    wrongFollowAction.instagram.reel[0].cta = 'Apri il profilo per gli aggiornamenti';
    expect(() => normalizeSocialCopyPack(packInput(wrongFollowAction))).toThrow(/Instagram follow objective/);

    const mixedFollowActions = channels();
    mixedFollowActions.instagram.reel[0].cta = 'Segui il profilo e condividi questo Reel';
    expect(() => normalizeSocialCopyPack(packInput(mixedFollowActions))).toThrow(/Instagram follow objective/);
  });

  it('rejects multi-action CTAs on non-Instagram channels too', () => {
    for (const cta of [
      'Leggi la guida e condividi il contenuto',
      'Condividi questo post e tagga un amico',
      'Apri la guida e menziona chi ne ha bisogno',
    ]) {
      const mixed = channels();
      mixed.linkedin.article[0].cta = cta;
      expect(() => normalizeSocialCopyPack(packInput(mixed))).toThrow(/exactly one explicit action/);
    }
  });

  it('assigns one stable template and records reportable copy fields', () => {
    const pack = normalizeSocialCopyPack(packInput());
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
      copyPromptVersion: 'frontaliere-social-copy-v4',
      copyAngleId: selected?.copyAngleId,
      copyPillarId: selected?.copyPillarId,
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
    const pack = normalizeSocialCopyPack(packInput());
    const assignBalancedImpl = async ({ armIds, blockContext }: { armIds: string[]; blockContext?: unknown }) => ({
      armId: armIds[1],
      reused: false,
      blockId: 'a'.repeat(64),
      blockCycle: 2,
      blockContext,
    });
    const blockContext = buildSocialCopyBlockContext({ sourceClass: 'article', scheduledDate: '2026-11-03' });
    const selected = await selectSocialCopyForPublish({
      pack,
      channel: 'facebook',
      kind: 'article',
      assignmentKey: 'article:balanced',
      blockContext,
      experimentConfig: registeredExperiment(pack, 'facebook', 'article'),
      assignBalancedImpl,
    });

    expect(selected).toMatchObject({
      copyMode: 'codex',
      copyAssignmentMode: 'firebase-balanced',
      copyExperimentId: 'social-copy-angle-matched-v3',
      copyRegistrationHash: 'a'.repeat(64),
      copyBlockId: 'a'.repeat(64),
      copyBlockCycle: 2,
      id: pack.channels.facebook.article[1].id,
      copyAngleId: pack.channels.facebook.article[1].angleId,
      copyAssignment: {
        experimentId: 'social-copy-angle-matched-v3',
        channel: 'facebook',
        slot: 'article',
        assignmentKey: 'article:balanced',
        blockContext,
        blockId: 'a'.repeat(64),
        blockCycle: 2,
        registrationHash: 'a'.repeat(64),
      },
      copyPromptVersion: 'frontaliere-social-copy-v4',
    });
    expect(socialCopyLedgerFields(selected)).toMatchObject({
      copyAssignmentMode: 'firebase-balanced',
      copyExperimentId: 'social-copy-angle-matched-v3',
      copyRegistrationHash: 'a'.repeat(64),
      copyBlockId: 'a'.repeat(64),
      copyBlockCycle: 2,
    });
    const experimentHash = createHash('sha256').update('social-copy-angle-matched-v3').digest('hex').slice(0, 8);
    expect(socialCopyTrackingContent('article', selected)).toContain('.' + selected?.id + '.a' + selected?.copyAngleId + '.b.' + experimentHash);
    expect(socialCopyLedgerFields(selected)).not.toHaveProperty('copyAssignment');

    let releasedAssignment: unknown;
    await expect(releaseSocialCopyAssignment(selected, {
      releaseBalancedImpl: async (assignment: unknown) => {
        releasedAssignment = assignment;
        return true;
      },
    })).resolves.toBe(true);
    expect(releasedAssignment).toMatchObject({
      experimentId: 'social-copy-angle-matched-v3',
      channel: 'facebook',
      slot: 'article',
      assignmentKey: 'article:balanced',
    });
  });

  it('uses only the matching registered Remote Config winner and creates no new assignment', async () => {
    const pack = normalizeSocialCopyPack(packInput());
    const registrationId = socialCopyExperimentRegistrationId({
      experimentId: 'social-copy-angle-matched-v3',
      packId: pack.packId,
      treatmentFingerprint: socialCopyExperimentTreatmentFingerprint(pack, {
        channel: 'instagram', slot: 'article', objective: 'share',
      }),
      channel: 'instagram',
      slot: 'article',
      objective: 'share',
    });
    const registrationHash = 'b'.repeat(64);
    const template = pack.channels.instagram.article.find((row) => row.objective === 'share');
    let assigned = false;
    const selected = await selectSocialCopyForPublish({
      pack,
      channel: 'instagram',
      kind: 'article',
      expectedObjective: 'share',
      assignmentKey: 'article:winner',
      blockContext: buildSocialCopyBlockContext({ sourceClass: 'article', scheduledDate: '2026-11-03' }),
      asOf: new Date('2026-11-03T12:00:00.000Z'),
      experimentConfig: {
        schemaVersion: 4,
        experimentId: 'social-copy-angle-matched-v3',
        enabled: true,
        protocolVersion: 'social-copy-angle-matched-block-v3',
        registrations: { [registrationId]: registrationHash },
        registrationDeadlines: { [registrationId]: '2026-11-02T00:00:00.000Z' },
        winners: { [registrationId]: { registrationHash, angleId: template?.angleId } },
      },
      assignBalancedImpl: async () => {
        assigned = true;
        return { armId: 'unexpected' };
      },
    });

    expect(assigned).toBe(false);
    expect(selected).toMatchObject({ copyAssignmentMode: 'firebase-winner', id: template?.id });
    expect(selected).not.toHaveProperty('copyRegistrationHash');
    expect(socialCopyLedgerFields(selected)).not.toHaveProperty('copyRegistrationHash');
  });

  it('stops opening new experiment assignments after the frozen deadline', async () => {
    const pack = normalizeSocialCopyPack(packInput());
    const experimentConfig = registeredExperiment(pack, 'instagram', 'article', 'share');
    const registrationId = Object.keys(experimentConfig.registrations)[0];
    experimentConfig.registrationDeadlines[registrationId] = '2026-11-02T00:00:00.000Z';
    let assigned = false;
    const selected = await selectSocialCopyForPublish({
      pack,
      channel: 'instagram',
      kind: 'article',
      expectedObjective: 'share',
      assignmentKey: 'article:expired-registration',
      blockContext: buildSocialCopyBlockContext({ sourceClass: 'article', scheduledDate: '2026-11-03' }),
      asOf: new Date('2026-11-03T12:00:00.000Z'),
      experimentConfig,
      assignBalancedImpl: async () => {
        assigned = true;
        return { armId: 'unexpected' };
      },
    });

    expect(assigned).toBe(false);
    expect(selected).not.toHaveProperty('copyRegistrationHash');
    expect(selected).not.toHaveProperty('copyBlockId');
  });

  it('fails closed on legacy experiment configs without protocol deadlines', async () => {
    const pack = normalizeSocialCopyPack(packInput());
    const experimentConfig = registeredExperiment(pack, 'instagram', 'article', 'share');
    experimentConfig.schemaVersion = 3;
    delete (experimentConfig as any).registrationDeadlines;
    let assigned = false;
    const selected = await selectSocialCopyForPublish({
      pack,
      channel: 'instagram',
      kind: 'article',
      expectedObjective: 'share',
      assignmentKey: 'article:legacy-config',
      blockContext: buildSocialCopyBlockContext({ sourceClass: 'article', scheduledDate: '2026-11-03' }),
      asOf: new Date('2026-11-03T12:00:00.000Z'),
      experimentConfig,
      assignBalancedImpl: async () => {
        assigned = true;
        return { armId: 'unexpected' };
      },
    });

    expect(assigned).toBe(false);
    expect(selected).not.toHaveProperty('copyRegistrationHash');
    expect(selected).not.toHaveProperty('copyBlockId');
  });

  it('does not assign an experiment arm when the publisher cannot confirm an exact post id', async () => {
    const pack = normalizeSocialCopyPack(packInput());
    let assigned = false;
    const selected = await selectSocialCopyForPublish({
      pack,
      channel: 'instagram',
      kind: 'article',
      expectedObjective: 'share',
      assignmentKey: 'article:robot-queue',
      blockContext: buildSocialCopyBlockContext({ sourceClass: 'article', scheduledDate: '2026-11-03' }),
      allowExperimentExposure: false,
      experimentConfig: registeredExperiment(pack, 'instagram', 'article', 'share'),
      assignBalancedImpl: async () => {
        assigned = true;
        return { armId: 'unexpected' };
      },
    });

    expect(assigned).toBe(false);
    expect(selected?.copyAssignmentMode).toBe('deterministic');
  });

  it('derives a stable block context only from a supported source class and valid scheduled date', () => {
    expect(buildSocialCopyBlockContext({ sourceClass: 'job', scheduledDate: '2026-11-03' }))
      .toEqual({ contentClass: 'job', weekday: 2 });
    expect(buildSocialCopyBlockContext({ sourceClass: 'unknown-title-category', scheduledDate: '2026-11-03' })).toBeNull();
    expect(buildSocialCopyBlockContext({ sourceClass: 'job', scheduledDate: '2026-02-30' })).toBeNull();
  });

  it('keeps the stable variant and records degraded assignment when Firebase is unavailable', async () => {
    const pack = normalizeSocialCopyPack(packInput());
    const selected = await selectSocialCopyForPublish({
      pack,
      channel: 'telegram',
      kind: 'job',
      assignmentKey: 'job:firebase-unavailable',
      blockContext: buildSocialCopyBlockContext({ sourceClass: 'job', scheduledDate: '2026-11-03' }),
      experimentConfig: registeredExperiment(pack, 'telegram', 'job'),
      assignBalancedImpl: async () => { throw new Error('permission denied'); },
    });

    expect(selected).toMatchObject({
      copyMode: 'codex',
      copyAssignmentMode: 'deterministic-fallback',
      copyExperimentId: 'social-copy-angle-matched-v3',
    });
    expect(socialCopyLedgerFields(selected)).toMatchObject({
      copyAssignmentMode: 'deterministic-fallback',
      copyExperimentId: 'social-copy-angle-matched-v3',
    });
    const experimentHash = createHash('sha256').update('social-copy-angle-matched-v3').digest('hex').slice(0, 8);
    expect(socialCopyTrackingContent('job', selected)).toContain('.' + selected?.id + '.a' + selected?.copyAngleId + '.f.' + experimentHash);
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

  it('reports best-effort release failures without throwing past a batch publisher', async () => {
    const copy = {
      copyAssignmentMode: 'firebase-balanced',
      copyAssignment: {
        experimentId: 'social-copy-balanced-v1',
        packId: '0123456789abcdef',
        channel: 'facebook',
        slot: 'event',
        assignmentKey: 'event:1',
      },
    };
    const failure = new Error('temporary Firestore error');
    const onFailure = vi.fn();
    const releaseBalancedImpl = vi.fn(async () => { throw failure; });

    await expect(releaseUnpublishedSocialCopyAssignmentBestEffort(copy, {
      releaseBalancedImpl,
      onFailure,
      reason: 'batch item was rejected',
    })).resolves.toBe(false);
    expect(releaseBalancedImpl).toHaveBeenCalledWith(copy.copyAssignment);
    expect(onFailure).toHaveBeenCalledWith(failure);
    await expect(releaseUnpublishedSocialCopyAssignmentBestEffort(
      { copyAssignmentMode: 'deterministic-fallback' },
    )).resolves.toBe(true);
  });

  it('does not write Firebase assignments while building a dry-run preview', async () => {
    const pack = normalizeSocialCopyPack(packInput());
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
    expect(socialCopyTrackingContent('article-a', { ...copy, copyAngleId: 'article-practical' }))
      .toBe('article-a--cp0123456789abcdef-article.facebook-article-two.aarticle-practical.d');
    expect(socialCopyTrackingContent('article-a', socialCopyLedgerFields(null))).toBe('article-a');
    expect(socialCopyTrackingContent('', copy)).toBe('');
    expect(socialCopyTrackingContent('article-a', { ...copy, copyPackId: 'bad' })).toBe('article-a');
  });

  it('falls back cleanly when the generated pack is absent or stale', () => {
    expect(loadSocialCopyPack({ filePath: 'missing-social-copy-pack.json' })).toBeNull();
    const stale = normalizeSocialCopyPack(
      packInput(),
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
