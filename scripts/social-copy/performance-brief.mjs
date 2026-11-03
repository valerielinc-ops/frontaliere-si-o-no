#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';
import { buildCreativeReport, DEFAULT_MINIMUM_OBSERVATIONS } from '../lib/instagram-insights-report.mjs';

export function buildSocialCopyPerformanceBrief(insights, ledger, {
  minimumObservations = DEFAULT_MINIMUM_OBSERVATIONS,
  windowHours = 72,
} = {}) {
  const report = buildCreativeReport(insights, { ledger, minimumObservations, windowHours });
  const groups = new Map();
  for (const treatment of report.treatments) {
    for (const copy of treatment.copyVariants || []) {
      const angleId = String(copy.copyAngleId || '').trim();
      const pillarId = String(copy.copyPillarId || '').trim();
      if (
        copy.copyMode !== 'codex'
        || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(String(copy.copyTemplateId || ''))
        || !/^[a-f0-9]{16}$/.test(String(copy.copyPackId || ''))
        || (angleId && !/^[a-z0-9][a-z0-9-]{0,31}$/.test(angleId))
        || (pillarId && !/^[a-z0-9][a-z0-9-]{0,31}$/.test(pillarId))
        || Boolean(angleId) !== Boolean(pillarId)
        || (copy.copyAngleIntent && !['searchable', 'shareable', 'both'].includes(copy.copyAngleIntent))
        || !['article', 'job', 'border', 'reel'].includes(treatment.kind)
        || !['share', 'save', 'conversation'].includes(treatment.objective)
      ) continue;
      const assignmentMode = copy.copyAssignmentMode || 'unknown';
      const experimentId = copy.copyExperimentId || 'unknown';
      const key = [treatment.kind, treatment.objective, copy.copyPackId, copy.copyTemplateId, angleId || 'unknown-angle', pillarId || 'unknown-pillar', assignmentMode, experimentId].join('|');
      const group = groups.get(key) || {
        kind: treatment.kind,
        objective: treatment.objective,
        packId: copy.copyPackId,
        templateId: copy.copyTemplateId,
        ...(angleId ? { angleId, pillarId, angleIntent: copy.copyAngleIntent || null } : {}),
        assignmentMode,
        experimentId,
        observations: 0,
        audience: 0,
        primaryTotal: 0,
        interactions: 0,
        interactionsComplete: true,
      };
      group.observations += copy.observations;
      group.audience += Number(copy.audienceBase ?? copy.reach) || 0;
      group.primaryTotal += copy.primaryTotal;
      if (copy.interactions === null || copy.interactions === undefined) {
        group.interactionsComplete = false;
      } else if (group.interactionsComplete) {
        group.interactions += copy.interactions;
      }
      groups.set(key, group);
    }
  }

  const variants = [...groups.values()]
    .sort((a, b) => a.kind.localeCompare(b.kind)
      || a.objective.localeCompare(b.objective)
      || String(a.templateId).localeCompare(String(b.templateId))
      || Number(!a.angleId) - Number(!b.angleId)
      || String(a.angleId || '').localeCompare(String(b.angleId || ''))
      || a.assignmentMode.localeCompare(b.assignmentMode)
      || a.experimentId.localeCompare(b.experimentId))
    .map((group) => {
      const enoughData = group.observations >= minimumObservations && group.audience > 0;
      return {
        kind: group.kind,
        objective: group.objective,
        packId: group.packId,
        templateId: group.templateId,
        ...(group.angleId ? { angleId: group.angleId, pillarId: group.pillarId, angleIntent: group.angleIntent } : {}),
        assignmentMode: group.assignmentMode,
        experimentId: group.experimentId,
        observations: group.observations,
        eligibleForDescription: enoughData,
        primaryRate: enoughData ? group.primaryTotal / group.audience : null,
        interactionRate: enoughData && group.interactionsComplete ? group.interactions / group.audience : null,
      };
    });

  return {
    schemaVersion: 1,
    source: 'instagram-insights',
    windowHours,
    minimumObservations,
    acceptedRows: report.acceptedRows,
    variants,
    interpretation: 'Descriptive only; no winner, eligibility, or publishing decision is inferred.',
  };
}

function readJson(file, label) {
  if (!file || !existsSync(file)) throw new Error(label + ' is missing');
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function run(argv = process.argv.slice(2)) {
  const input = argv.find((arg) => arg.startsWith('--input='))?.slice('--input='.length);
  const ledgerPath = argv.find((arg) => arg.startsWith('--ledger='))?.slice('--ledger='.length);
  if (!input || !ledgerPath) throw new Error('usage: node scripts/social-copy/performance-brief.mjs --input=<insights.json> --ledger=<ledger.json>');
  const brief = buildSocialCopyPerformanceBrief(readJson(input, 'Insights'), readJson(ledgerPath, 'ledger'));
  process.stdout.write(JSON.stringify(brief));
  return 0;
}

if (isInvokedDirectly(import.meta.url)) {
  try {
    process.exitCode = run();
  } catch (error) {
    process.stderr.write('Social copy performance brief unavailable: ' + error.message + '\n');
    process.exitCode = 2;
  }
}
