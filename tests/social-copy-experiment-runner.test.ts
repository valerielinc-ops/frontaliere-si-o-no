import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  listSocialCopyExperimentCohorts,
  SOCIAL_COPY_EXPERIMENT_PROTOCOL_VERSION,
  runSocialCopyExperimentProtocol,
  socialCopyExperimentPostIdHash,
  summarizeSocialAudienceSafety,
  socialExperimentPlatformPolicyClear,
} from '../scripts/lib/social-copy-experiment-runner.mjs';
import { SOCIAL_EXPERIMENT_PROTOCOL_VERSION } from '../scripts/lib/social-experiment-protocol.mjs';
import {
  socialCopyExperimentRegistrationId,
  socialCopyExperimentTreatmentFingerprint,
} from '../scripts/lib/social-copy-pack.mjs';

function memoryFirestore() {
  const documents = new Map<string, Record<string, any>>();
  const ref = (collection: string, id: string) => ({
    path: `${collection}/${id}`,
    get: async () => {
      const value = documents.get(`${collection}/${id}`);
      return { exists: value !== undefined, data: () => value ? structuredClone(value) : undefined };
    },
    set: async (value: Record<string, any>, options?: { merge?: boolean }) => {
      const key = `${collection}/${id}`;
      documents.set(key, options?.merge ? { ...(documents.get(key) || {}), ...structuredClone(value) } : structuredClone(value));
    },
  });
  const db = {
    collection(name: string) {
      return {
        doc: (id: string) => ref(name, id),
        where(field: string, operator: string, value: unknown) {
          if (operator !== '==') throw new Error('unsupported query');
          return {
            get: async () => ({
              docs: [...documents.entries()]
                .filter(([key, data]) => key.startsWith(`${name}/`) && data[field] === value)
                .map(([key, data]) => ({ id: key.slice(name.length + 1), data: () => structuredClone(data) })),
            }),
          };
        },
      };
    },
    async runTransaction(callback: (transaction: any) => Promise<unknown>) {
      return callback({
        get: async (reference: { path: string }) => {
          const value = documents.get(reference.path);
          return { exists: value !== undefined, data: () => value ? structuredClone(value) : undefined };
        },
        set: (reference: { path: string }, value: Record<string, any>, options?: { merge?: boolean }) => {
          const prior = options?.merge ? documents.get(reference.path) || {} : {};
          documents.set(reference.path, { ...prior, ...structuredClone(value) });
        },
      });
    },
  };
  return { db, documents };
}

function fixture() {
  const pillars = [
    { id: 'useful-steps', name: 'Passi utili', audienceNeed: 'Capire quale passo concreto valutare' },
    { id: 'work-life', name: 'Lavoro e vita', audienceNeed: 'Orientarsi tra lavoro e vita oltre confine' },
    { id: 'clear-tools', name: 'Strumenti chiari', audienceNeed: 'Trovare risposte verificabili alle domande' },
  ];
  const anglesFor = (slot: string) => pillars.map((pillar, index) => ({
    id: `${slot}-angle-${index + 1}`,
    pillarId: pillar.id,
    audienceNeed: `${pillar.audienceNeed} per ${slot}`,
    angle: `Spiega ${slot} da ${pillar.name.toLowerCase()}`,
    intent: ['searchable', 'shareable', 'both'][index],
    evidenceBasis: 'editorial-hypothesis',
  }));
  const pack = {
    packId: '0123456789abcdef',
    editorialPlan: {
      pillars,
      angles: {
        instagram: {
          article: anglesFor('article'),
          reel: anglesFor('reel'),
          border: anglesFor('border'),
        },
      },
    },
    channels: {
      instagram: {
        article: [
          { id: 'ig-one', angleId: 'article-angle-1', objective: 'share' },
          { id: 'ig-two', angleId: 'article-angle-2', objective: 'share' },
          { id: 'ig-three', angleId: 'article-angle-3', objective: 'share' },
        ],
        reel: [
          { id: 'reel-one', angleId: 'reel-angle-1', objective: 'follow' },
          { id: 'reel-two', angleId: 'reel-angle-2', objective: 'follow' },
          { id: 'reel-three', angleId: 'reel-angle-3', objective: 'follow' },
        ],
        border: [{ id: 'border-one', angleId: 'border-angle-1', objective: 'share' }],
      },
    },
  };
  const asOf = new Date('2026-11-03T12:00:00.000Z');
  const baseline = Array.from({ length: 30 }, (_, index) => {
    const published = new Date(asOf.getTime() - (32 - index) * 86400000);
    const numerator = index % 2 === 0 ? 9 : 13;
    return {
      channel: 'instagram',
      postId: `baseline-${index}`,
      publishedAt: published.toISOString(),
      snapshotAt: new Date(published.getTime() + 72 * 3600000).toISOString(),
      snapshotAgeHours: 72,
      windowHours: 72,
      metrics: { shares: numerator, reach: 100 },
      availableMetrics: ['shares', 'reach'],
      copyAttributionStatus: 'exact',
      copyMode: 'codex',
      copySlot: 'article',
      copyPackId: 'aaaaaaaaaaaaaaaa',
      copyTemplateId: 'baseline-copy',
      copyObjective: 'share',
    };
  });
  const reelBaseline = Array.from({ length: 30 }, (_, index) => {
    const published = new Date(asOf.getTime() - (32 - index) * 86400000);
    const numerator = index % 2 === 0 ? 3 : 5;
    return {
      channel: 'instagram',
      postId: `reel-baseline-${index}`,
      publishedAt: published.toISOString(),
      snapshotAt: new Date(published.getTime() + 72 * 3600000).toISOString(),
      snapshotAgeHours: 72,
      windowHours: 72,
      metrics: { follows: numerator, reach: 100 },
      availableMetrics: ['follows', 'reach'],
      copyAttributionStatus: 'exact',
      copyMode: 'codex',
      copySlot: 'reel',
      copyPackId: 'aaaaaaaaaaaaaaaa',
      copyTemplateId: 'baseline-reel-copy',
      copyObjective: 'follow',
    };
  });
  const insights = {
    schemaVersion: 1,
    sources: {
      instagram: {
        status: 'available',
        latestSnapshotAt: '2026-11-03T10:00:00.000Z',
      },
      instagramPostInsights: {
        status: 'available',
        latestSnapshotAt: '2026-11-03T10:00:00.000Z',
      },
    },
    posts: [...baseline, ...reelBaseline],
  };
  return { pack, asOf, insights };
}

function experimentRows(registration: any, asOf: Date, { winner = true } = {}) {
  const assignments: Record<string, any>[] = [];
  const observations: Record<string, any>[] = [];
  const start = Date.parse(registration.startsAt);
  for (let block = 0; block < registration.plannedBlocks; block += 1) {
    const blockId = createHash('sha256').update(`matched-block-${block}`).digest('hex');
    const publishedAt = new Date(start + block * 86400000).toISOString();
    for (const [armIndex, angleId] of registration.arms.entries()) {
      const postId = `post-${block}-${angleId}`;
      const packId = (block + armIndex) % 2 === 0 ? registration.packId : 'fedcba9876543210';
      const snapshotOffsetHours = registration.metric.windowHours || registration.metric.windowDays * 24;
      assignments.push({
        experimentId: registration.experimentId,
        packId,
        channel: registration.channel,
        slot: registration.slot,
        objective: registration.objective,
        armId: angleId,
        blockId,
        blockCycle: block,
        registrationHash: registration.registrationHash,
        status: 'published',
        postIdHash: socialCopyExperimentPostIdHash(registration.channel, postId),
        publishedAt,
      });
      const numeratorName = registration.metric.numerator;
      observations.push({
        channel: registration.measurementChannel,
        postId,
        publishedAt,
        snapshotAt: new Date(Date.parse(publishedAt) + snapshotOffsetHours * 3600000).toISOString(),
        ...(registration.metric.windowHours
          ? { snapshotAgeHours: registration.metric.windowHours, windowHours: registration.metric.windowHours }
          : { windowDays: registration.metric.windowDays, measurementWindow: registration.metric.measurementWindow }),
        metrics: {
          [numeratorName]: winner && angleId === registration.arms[0] ? 25 : 10,
          [registration.metric.denominator]: 100,
        },
        availableMetrics: [numeratorName, registration.metric.denominator],
        copyAttributionStatus: 'exact',
        copyMode: 'codex',
        copyAssignmentMode: 'firebase-balanced',
        copyExperimentId: registration.experimentId,
        copyRegistrationHash: registration.registrationHash,
        copyPackId: packId,
        copySlot: registration.slot,
        copyObjective: registration.objective,
        copyTemplateId: `fresh-template-${angleId}`,
        copyAngleId: angleId,
        copyBlockId: blockId,
        copyBlockCycle: block,
      });
    }
  }
  return { assignments, observations };
}

describe('social-copy experiment runner', () => {
  it('requires positive 30-day account growth and distinguishes flat and declining signals', () => {
    const asOf = new Date('2026-12-15T12:00:00.000Z');
    const snapshots = Array.from({ length: 30 }, (_, index) => ({
      channel: 'instagram',
      metric: 'followers',
      value: 1000 - index,
      snapshotAt: new Date(asOf.getTime() - (29 - index) * 24 * 60 * 60 * 1000).toISOString(),
      status: 'available',
    }));

    expect(summarizeSocialAudienceSafety(snapshots, 'instagram', asOf)).toMatchObject({
      status: 'declining',
      metric: 'followers',
      observations: 30,
      netChange: -29,
    });
    expect(summarizeSocialAudienceSafety(snapshots.slice(5), 'instagram', asOf)).toMatchObject({
      status: 'unqualified',
      netChange: null,
    });
    const flatSnapshots = snapshots.map((row) => ({ ...row, value: 1000 }));
    expect(summarizeSocialAudienceSafety(flatSnapshots, 'instagram', asOf)).toMatchObject({
      status: 'flat',
      netChange: 0,
    });
  });

  it('uses LinkedIn member audience snapshots when evaluating a LinkedIn winner', async () => {
    const { db, documents } = memoryFirestore();
    const { pack, asOf, insights } = fixture();
    const linkedInPack = structuredClone(pack);
    linkedInPack.editorialPlan.angles = {
      linkedin: { article: structuredClone(pack.editorialPlan.angles.instagram.article) },
    };
    linkedInPack.channels = {
      linkedin: {
        article: pack.channels.instagram.article.map((template: any) => ({
          ...template,
          id: `linkedin-${template.id}`,
        })),
      },
    };
    const linkedInBaseline = Array.from({ length: 30 }, (_, index) => {
      const publishedAt = new Date(asOf.getTime() - (36 - index) * 86400000);
      const numerator = index % 2 === 0 ? 10 : 20;
      return {
        channel: 'linkedin-member',
        postId: `linkedin-baseline-${index}`,
        publishedAt: publishedAt.toISOString(),
        snapshotAt: new Date(publishedAt.getTime() + 7 * 86400000).toISOString(),
        windowDays: 7,
        measurementWindow: 'first-seven-utc-calendar-days',
        metrics: { follower_gained_from_content: numerator, impression: 100 },
        availableMetrics: ['follower_gained_from_content', 'impression'],
        copyAttributionStatus: 'exact',
        copyMode: 'codex',
        copySlot: 'article',
        copyPackId: 'aaaaaaaaaaaaaaaa',
        copyTemplateId: 'linkedin-baseline-copy',
        copyObjective: 'overall',
      };
    });
    const linkedinSource = {
      status: 'available',
      lastSuccessAt: asOf.toISOString(),
      postAnalyticsStorageApproved: true,
    };
    const initialInsights = {
      ...insights,
      sources: { linkedinMember: linkedinSource },
      posts: linkedInBaseline,
      audienceSnapshots: Array.from({ length: 30 }, (_, index) => ({
        channel: 'linkedin-member',
        metric: 'followers',
        value: 1000 + index,
        snapshotAt: new Date(asOf.getTime() - (29 - index) * 86400000).toISOString(),
        status: 'available',
      })),
    };

    const initial = await runSocialCopyExperimentProtocol({
      db,
      pack: linkedInPack,
      insights: initialInsights,
      asOf,
      linkedinPostAnalyticsStorageApproved: true,
      setRemoteConfig: async () => ({ ok: true, changed: true }),
    });
    const registration = [...documents.values()].find((value) => value.channel === 'linkedin');
    expect(registration?.measurementChannel).toBe('linkedin-member');
    expect(initial.config.registrations).toHaveProperty(registration?.registrationId);

    const runAt = new Date(Date.parse(registration.startsAt) + (registration.plannedBlocks + 8) * 86400000);
    const { assignments, observations } = experimentRows(registration, runAt);
    assignments.forEach((assignment, index) => {
      documents.set(`social_copy_assignment_records/linkedin-${index}`, assignment);
    });
    const promoted = await runSocialCopyExperimentProtocol({
      db,
      pack: linkedInPack,
      insights: {
        ...initialInsights,
        sources: {
          linkedinMember: { ...linkedinSource, lastSuccessAt: runAt.toISOString() },
        },
        posts: [...linkedInBaseline, ...observations],
        audienceSnapshots: Array.from({ length: 30 }, (_, index) => ({
          channel: 'linkedin-member',
          metric: 'followers',
          value: 1000 + index,
          snapshotAt: new Date(runAt.getTime() - (29 - index) * 86400000).toISOString(),
          status: 'available',
        })),
      },
      asOf: runAt,
      linkedinPostAnalyticsStorageApproved: true,
      setRemoteConfig: async () => ({ ok: true, changed: true }),
    });

    expect(promoted.evaluations[0]).toMatchObject({
      status: 'winner',
      schemaVersion: 2,
      decisionMetricClass: 'post-attributed-follower-growth',
      audienceSafety: { status: 'growing', observations: 30 },
    });
    expect(promoted.config.winners).toHaveProperty(registration.registrationId);

    const flatFollowerSnapshots = Array.from({ length: 30 }, (_, index) => ({
      channel: 'linkedin-member',
      metric: 'followers',
      value: 1000,
      snapshotAt: new Date(runAt.getTime() - (29 - index) * 86400000).toISOString(),
      status: 'available',
    }));
    const exactFollowerGrowthWinner = await runSocialCopyExperimentProtocol({
      db,
      pack: linkedInPack,
      insights: {
        ...initialInsights,
        sources: {
          linkedinMember: { ...linkedinSource, lastSuccessAt: runAt.toISOString() },
        },
        posts: [...linkedInBaseline, ...observations],
        audienceSnapshots: flatFollowerSnapshots,
      },
      asOf: runAt,
      linkedinPostAnalyticsStorageApproved: true,
      setRemoteConfig: async () => ({ ok: true, changed: true }),
    });
    expect(exactFollowerGrowthWinner.evaluations[0]).toMatchObject({
      status: 'winner',
      decisionMetricClass: 'post-attributed-follower-growth',
      audienceSafety: { status: 'flat', netChange: 0 },
    });
    expect(exactFollowerGrowthWinner.config.winners).toHaveProperty(registration.registrationId);
  });

  it('limits experiments to exact-ID supported publisher formats', () => {
    const { pack } = fixture();
    const cohorts = listSocialCopyExperimentCohorts(pack);
    expect(cohorts.map(({ channel, slot, objective }) => [channel, slot, objective])).toEqual([
      ['instagram', 'article', 'share'],
      ['instagram', 'reel', 'follow'],
    ]);
    expect(cohorts.find(({ slot }) => slot === 'reel')?.metric).toEqual({
      numerator: 'follows', denominator: 'reach', windowHours: 72,
    });
  });

  it('requires the private Graph Insights source to be fresh before a Reel experiment can run', () => {
    const registration = { measurementChannel: 'instagram', slot: 'reel' };
    const asOf = new Date('2026-11-03T12:00:00.000Z');
    expect(socialExperimentPlatformPolicyClear(registration, {
      sources: { instagram: { status: 'available', latestSnapshotAt: asOf.toISOString() } },
    }, asOf)).toBe(false);
    expect(socialExperimentPlatformPolicyClear(registration, {
      sources: {
        instagram: { status: 'available', latestSnapshotAt: asOf.toISOString() },
        instagramPostInsights: { status: 'available', latestSnapshotAt: asOf.toISOString() },
      },
    }, asOf)).toBe(true);
  });

  it('keeps LinkedIn post experiments closed unless retention approval is explicit and current', () => {
    const registration = { measurementChannel: 'linkedin-member', slot: 'article' };
    const asOf = new Date('2026-11-03T12:00:00.000Z');
    const insights = {
      sources: {
        linkedinMember: {
          status: 'available',
          lastSuccessAt: asOf.toISOString(),
          postAnalyticsStorageApproved: true,
        },
      },
    };

    expect(socialExperimentPlatformPolicyClear(registration, insights, asOf)).toBe(false);
    expect(socialExperimentPlatformPolicyClear(registration, insights, asOf, {
      linkedinPostAnalyticsStorageApproved: true,
    })).toBe(true);
    expect(socialExperimentPlatformPolicyClear(registration, {
      ...insights,
      sources: { linkedinMember: { ...insights.sources.linkedinMember, postAnalyticsStorageApproved: false } },
    }, asOf, { linkedinPostAnalyticsStorageApproved: true })).toBe(false);
  });

  it('qualifies carousel metric baselines across the rotating engagement objectives', async () => {
    const { db, documents } = memoryFirestore();
    const { pack, asOf, insights } = fixture();
    const articleRows = insights.posts.filter((row: any) => row.copySlot === 'article');
    const objectives = ['share', 'save', 'conversation'];
    articleRows.forEach((row: any, index: number) => {
      row.copyObjective = objectives[index % objectives.length];
      row.metrics = {
        shares: index % 2 === 0 ? 9 : 13,
        saves: index % 3 === 0 ? 5 : 8,
        comments: index % 4 === 0 ? 2 : 4,
        reach: 100,
      };
      row.availableMetrics = ['shares', 'saves', 'comments', 'reach'];
    });
    const configs: any[] = [];

    const result = await runSocialCopyExperimentProtocol({
      db,
      pack,
      insights,
      asOf,
      setRemoteConfig: async (config: any) => { configs.push(config); return { ok: true, changed: true }; },
    });
    const registration = [...documents.values()].find((value) => value.slot === 'article');

    expect(registration).toMatchObject({
      objective: 'share',
      baselinePopulationScope: 'same-slot-metric-across-objectives',
      baseline: { observations: 30 },
    });
    expect(result.config.enabled).toBe(true);
    expect(result.config.registrationDeadlines).toHaveProperty(registration?.registrationId);
  });

  it('closes assignment exposure after the preregistered fixed sample has no winner', async () => {
    const { db, documents } = memoryFirestore();
    const { pack, asOf, insights } = fixture();
    const initial = await runSocialCopyExperimentProtocol({
      db,
      pack,
      insights,
      asOf,
      setRemoteConfig: async () => ({ ok: true, changed: true }),
    });
    const registrationId = socialCopyExperimentRegistrationId({
      experimentId: 'social-copy-angle-matched-v3',
      treatmentFingerprint: socialCopyExperimentTreatmentFingerprint(pack, {
        channel: 'instagram', slot: 'article', objective: 'share',
      }),
      channel: 'instagram',
      slot: 'article',
      objective: 'share',
    });
    const registration = documents.get(`social_copy_experiment_registrations/${registrationId}`);
    const runAt = new Date(Date.parse(registration.startsAt) + (registration.plannedBlocks + 4) * 86400000);
    const { assignments, observations } = experimentRows(registration, runAt, { winner: false });
    assignments.forEach((assignment, index) => {
      documents.set(`social_copy_assignment_records/${index}`, assignment);
    });
    const completed = await runSocialCopyExperimentProtocol({
      db,
      pack,
      insights: {
        ...insights,
        sources: {
          instagram: { status: 'available', latestSnapshotAt: new Date(runAt.getTime() - 3600000).toISOString() },
          instagramPostInsights: { status: 'available', latestSnapshotAt: new Date(runAt.getTime() - 3600000).toISOString() },
        },
        posts: [...insights.posts, ...observations],
      },
      asOf: runAt,
      setRemoteConfig: async () => ({ ok: true, changed: true }),
    });

    expect(initial.config.registrations[registrationId]).toBe(registration.registrationHash);
    expect(completed.evaluations.find((row: any) => row.registrationId === registrationId)?.status).toBe('hold');
    expect(completed.config.registrations).not.toHaveProperty(registrationId);
    expect(completed.config.winners).not.toHaveProperty(registrationId);
  });

  it('freezes an eligible registration, promotes from the fixed exact sample, and rolls back on policy loss', async () => {
    const { db, documents } = memoryFirestore();
    const { pack, asOf, insights } = fixture();
    const configs: any[] = [];
    const first = await runSocialCopyExperimentProtocol({
      db,
      pack,
      insights,
      asOf,
      setRemoteConfig: async (config: any) => { configs.push(config); return { ok: true, changed: true }; },
    });
    const registrationId = socialCopyExperimentRegistrationId({
      experimentId: 'social-copy-angle-matched-v3',
      treatmentFingerprint: socialCopyExperimentTreatmentFingerprint(pack, {
        channel: 'instagram', slot: 'article', objective: 'share',
      }),
      channel: 'instagram',
      slot: 'article',
      objective: 'share',
    });
    const registration = documents.get(`social_copy_experiment_registrations/${registrationId}`);

    expect(first.status).toBe('reconciled');
    expect(first.calibration.status).toBe('passed');
    expect(first.config.protocolVersion).toBe(SOCIAL_COPY_EXPERIMENT_PROTOCOL_VERSION);
    expect(first.config.registrations[registrationId]).toBe(registration?.registrationHash);
    expect(first.config.registrationDeadlines[registrationId]).toBe('2027-11-03T12:00:00.000Z');
    expect(registration).toMatchObject({
      protocolVersion: SOCIAL_EXPERIMENT_PROTOCOL_VERSION,
      baselinePopulationScope: 'same-slot-metric-across-objectives',
      parentFamilySize: 2,
      baseline: { observations: 30 },
    });
    const reelRegistration = [...documents.entries()]
      .find(([key, value]) => key.startsWith('social_copy_experiment_registrations/') && value.slot === 'reel')?.[1];
    expect(reelRegistration).toMatchObject({
      objective: 'follow',
      metric: { numerator: 'follows', denominator: 'reach', windowHours: 72 },
      baseline: { observations: 30 },
    });

    const runAt = new Date('2026-12-15T12:00:00.000Z');
    const refreshedPack = structuredClone(pack);
    refreshedPack.packId = 'fedcba9876543210';
    refreshedPack.channels.instagram.article.forEach((template: any) => { template.id = `fresh-${template.id}`; });
    const { assignments, observations } = experimentRows(registration, runAt);
    assignments[0].status = 'active';
    delete assignments[0].postIdHash;
    assignments.forEach((assignment, index) => {
      documents.set(`social_copy_assignment_records/${index}`, assignment);
    });
    const measured = {
      ...insights,
      sources: { instagram: { status: 'available', latestSnapshotAt: '2026-12-15T10:00:00.000Z' } },
      posts: [...insights.posts, ...observations],
      audienceSnapshots: Array.from({ length: 30 }, (_, index) => ({
        channel: 'instagram',
        metric: 'followers',
        value: 1000 + index,
        snapshotAt: new Date(runAt.getTime() - (29 - index) * 24 * 60 * 60 * 1000).toISOString(),
        status: 'available',
      })),
    };
    const promoted = await runSocialCopyExperimentProtocol({
      db,
      pack: refreshedPack,
      insights: measured,
      asOf: runAt,
      setRemoteConfig: async (config: any) => { configs.push(config); return { ok: true, changed: true }; },
    });
    expect(promoted.evaluations[0]).toMatchObject({ status: 'winner', winnerAngleId: registration.arms[0], metricCoverage: 1 });
    expect(promoted.config.winners[registrationId]).toMatchObject({
      registrationHash: registration?.registrationHash,
      angleId: registration.arms[0],
    });
    expect(promoted.config.packId).toBe(refreshedPack.packId);
    expect(registration?.packId).toBe(pack.packId);
    expect(documents.get('social_copy_assignment_records/0')).toMatchObject({
      status: 'published',
      reconciledFromExactNativePost: true,
    });

    const decliningAudienceSnapshots = Array.from({ length: 30 }, (_, index) => ({
      channel: 'instagram',
      metric: 'followers',
      value: 1000 - index,
      snapshotAt: new Date(runAt.getTime() - (29 - index) * 24 * 60 * 60 * 1000).toISOString(),
      status: 'available',
    }));
    const heldPromotion = await runSocialCopyExperimentProtocol({
      db,
      pack: refreshedPack,
      insights: { ...measured, audienceSnapshots: decliningAudienceSnapshots },
      asOf: runAt,
      setRemoteConfig: async (config: any) => { configs.push(config); return { ok: true, changed: true }; },
    });
    expect(heldPromotion.evaluations[0]).toMatchObject({
      status: 'hold',
      audienceSafety: { status: 'declining', netChange: -29 },
      reason: expect.stringContaining('engagement winner held'),
    });
    expect(heldPromotion.config.winners).not.toHaveProperty(registrationId);

    const flatAudienceSnapshots = Array.from({ length: 30 }, (_, index) => ({
      channel: 'instagram',
      metric: 'followers',
      value: 1000,
      snapshotAt: new Date(runAt.getTime() - (29 - index) * 24 * 60 * 60 * 1000).toISOString(),
      status: 'available',
    }));
    const flatPromotion = await runSocialCopyExperimentProtocol({
      db,
      pack: refreshedPack,
      insights: { ...measured, audienceSnapshots: flatAudienceSnapshots },
      asOf: runAt,
      setRemoteConfig: async (config: any) => { configs.push(config); return { ok: true, changed: true }; },
    });
    expect(flatPromotion.evaluations[0]).toMatchObject({
      status: 'hold',
      decisionMetricClass: 'engagement',
      audienceSafety: { status: 'flat', netChange: 0 },
      reason: expect.stringContaining('audience was flat'),
    });
    expect(flatPromotion.config.winners).not.toHaveProperty(registrationId);

    const unknownAudiencePromotion = await runSocialCopyExperimentProtocol({
      db,
      pack: refreshedPack,
      insights: { ...measured, audienceSnapshots: [] },
      asOf: runAt,
      setRemoteConfig: async (config: any) => { configs.push(config); return { ok: true, changed: true }; },
    });
    expect(unknownAudiencePromotion.evaluations[0]).toMatchObject({
      status: 'hold',
      audienceSafety: { status: 'unqualified' },
      reason: expect.stringContaining('audience safety is unqualified'),
    });
    expect(unknownAudiencePromotion.config.winners).not.toHaveProperty(registrationId);

    const rolledBack = await runSocialCopyExperimentProtocol({
      db,
      pack: refreshedPack,
      insights: {
        ...measured,
        sources: { instagram: { status: 'permission-unavailable', latestSnapshotAt: '2026-12-15T10:00:00.000Z' } },
      },
      asOf: runAt,
      setRemoteConfig: async (config: any) => { configs.push(config); return { ok: true, changed: true }; },
    });
    expect(rolledBack.config.enabled).toBe(false);
    expect(rolledBack.config.winners).toEqual({});
    expect(rolledBack.evaluations[0].status).toBe('hold');
    expect(configs).toHaveLength(6);
  });
});
