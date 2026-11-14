/**
 * Pure contract of the IT section-group publication plan: the group ids, the
 * shape check of a plan, and the per-group content digest a durable receipt
 * carries. Deliberately free of file reads and of the plan builder, so that
 * the small workflows that only need to SPEAK about groups (the receipt
 * resolver, the deploy-request coordinator) check out this file and nothing
 * that opens `scripts/lib/section-shard-slugs.json`.
 * `it-shard-group-plan.mjs` re-exports everything here for its existing users.
 */
import { createHash } from 'node:crypto';

export const IT_SHARD_GROUP_IDS = Object.freeze([
  'zurigo',
  'svizzera',
  'small-1',
  'small-2',
  'small-3',
  'small-4',
]);

export const LARGE_SECTIONS = Object.freeze(['zurigo', 'svizzera']);
const SHA_RE = /^[0-9a-f]{40}$/iu;
const RUN_ID_RE = /^\d+$/u;

function text(value) {
  return value == null ? '' : String(value).trim();
}

export function validateItShardGroupPlan(plan, { sourceRunId, sourceSha, buildId } = {}) {
  const errors = [];
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return { valid: false, errors: ['plan is not an object'] };
  if (plan.schemaVersion !== 1) errors.push('schemaVersion is unsupported');
  if (plan.kind !== 'it-shard-push-group-plan') errors.push('kind is invalid');
  if (sourceRunId != null && text(plan.sourceRunId) !== text(sourceRunId)) errors.push('sourceRunId does not match');
  if (sourceSha != null && text(plan.sourceSha).toLowerCase() !== text(sourceSha).toLowerCase()) errors.push('sourceSha does not match');
  if (buildId != null && text(plan.buildId) !== text(buildId)) errors.push('buildId does not match');
  if (!RUN_ID_RE.test(text(plan.sourceRunId))) errors.push('sourceRunId is missing or malformed');
  if (!SHA_RE.test(text(plan.sourceSha))) errors.push('sourceSha is missing or malformed');
  if (!RUN_ID_RE.test(text(plan.buildId))) errors.push('buildId is missing or malformed');
  const required = Array.isArray(plan.requiredSections) ? plan.requiredSections : [];
  if (required.length === 0) errors.push('requiredSections is empty or missing');
  if (required.some((section) => typeof section !== 'string' || !text(section))) {
    errors.push('requiredSections contains an invalid section key');
  }
  if (new Set(required).size !== required.length) errors.push('requiredSections contains duplicate sections');
  if (!Array.isArray(plan.groups)) errors.push('groups is not an array');
  else {
    const ids = plan.groups.map((group) => text(group?.id));
    if (ids.length !== IT_SHARD_GROUP_IDS.length || IT_SHARD_GROUP_IDS.some((id) => !ids.includes(id))) {
      errors.push('groups do not match the required group ids');
    }
    const sections = plan.groups.flatMap((group) => Array.isArray(group?.sections) ? group.sections : []);
    if ([...sections].sort().join('\n') !== [...required].sort().join('\n')) {
      errors.push('group sections do not partition requiredSections');
    }
    for (const section of LARGE_SECTIONS) {
      const group = plan.groups.find((candidate) => candidate?.id === section);
      if (required.includes(section) && (group?.sections?.length !== 1 || group.sections[0] !== section)) {
        errors.push(`${section} must stay alone in its group`);
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Content digest of one IT section group as declared by the source publication
 * plan. It is the value a durable group receipt carries (publish-receipts.mjs):
 * a retry of the same source run may skip a group only when the receipt it finds
 * was written for exactly this population, so a re-run attempt that rebuilt the
 * section tree with different content never adopts the earlier publication.
 */
export function itShardGroupPlanDigest(plan, groupId) {
  const group = (Array.isArray(plan?.groups) ? plan.groups : []).find((candidate) => candidate?.id === groupId);
  if (!group) throw new Error(`IT shard group ${JSON.stringify(groupId)} is not part of the publication plan`);
  const sections = [...(Array.isArray(group.sections) ? group.sections : [])].map(String).sort();
  const payload = {
    v: 1,
    sourceRunId: text(plan.sourceRunId),
    sourceSha: text(plan.sourceSha).toLowerCase(),
    buildId: text(plan.buildId),
    group: groupId,
    sections,
    fileCounts: Object.fromEntries(sections.map((section) => [section, plan.fileCounts?.[section] ?? null])),
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/** `{ group: digest }` for every group of a plan, in canonical group order. */
export function expectedItGroupDigests(plan) {
  return Object.fromEntries(IT_SHARD_GROUP_IDS
    .filter((id) => (Array.isArray(plan?.groups) ? plan.groups : []).some((group) => group?.id === id))
    .map((id) => [id, itShardGroupPlanDigest(plan, id)]));
}
