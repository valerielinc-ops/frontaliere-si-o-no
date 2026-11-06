#!/usr/bin/env node

/**
 * Report the four-arm daily job-alert subject experiment.
 *
 * Usage:
 *   node scripts/report-job-alert-subject-ab.mjs
 *   node scripts/report-job-alert-subject-ab.mjs --period week_2026-10-19
 *   node scripts/report-job-alert-subject-ab.mjs --json
 *
 * `trackedOpenRate` and `trackedClickRate` are the primary KPIs. Cloudflare
 * sends remain visible in the all-send fields, but are excluded from the
 * primary denominator because that provider currently emits no open/click
 * webhook for this channel. Mailtrap is excluded as a sandbox.
 */
import {
  hasEnoughPowerForTest,
  pickWinner,
  MIN_COMPARISON_SENDS,
  MIN_EXPECTED_PER_CELL,
} from '../services/newsletter-ab-stats.mjs';
import {
  JOB_ALERT_SUBJECT_EXPERIMENT_ID,
  JOB_ALERT_SUBJECT_VARIANTS,
  jobAlertSubjectPeriodId,
} from './lib/job-alert-subject-experiment.mjs';
import { loadJobAlertSubjectExperimentReport } from './lib/job-alert-subject-ab-data.mjs';
import { getFirestoreDb } from './lib/firestore-admin.mjs';

const args = process.argv.slice(2);
const JSON_OUT = args.includes('--json');

function argValue(flag) {
  const index = args.indexOf(flag);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : null;
}

function primaryCell(cell = {}) {
  return {
    sends: cell.trackedSends || 0,
    opens: cell.trackedOpens || 0,
  };
}

function withWinnerDecision(variants) {
  const completeVariants = Object.fromEntries(
    JOB_ALERT_SUBJECT_VARIANTS.map(({ id }) => [id, variants[id] || {
      sends: 0,
      opens: 0,
      clicks: 0,
      trackedSends: 0,
      trackedOpens: 0,
      trackedClicks: 0,
      openRate: 0,
      clickRate: 0,
      ctor: 0,
      trackedOpenRate: 0,
      trackedClickRate: 0,
      trackedCtor: 0,
      trackingAvailable: false,
    }]),
  );
  const decision = pickWinner(Object.fromEntries(
    Object.entries(completeVariants).map(([variant, cell]) => [variant, primaryCell(cell)]),
  ));
  return { variants: completeVariants, winnerDecision: decision };
}

function formatCell(cell) {
  return `sends=${String(cell.sends).padStart(5)}`
    + ` tracked=${String(cell.trackedSends).padStart(5)}`
    + ` opens=${String(cell.opens).padStart(5)}`
    + ` open-rate=${cell.trackedOpenRate.toFixed(1).padStart(5)}%`
    + ` ctr=${cell.trackedClickRate.toFixed(2).padStart(5)}%`
    + ` ctor=${cell.trackedCtor.toFixed(1).padStart(5)}%`;
}

async function main() {
  const periodId = argValue('--period') || jobAlertSubjectPeriodId();
  const db = await getFirestoreDb();
  const report = await loadJobAlertSubjectExperimentReport(db, {
    periodId,
    experimentId: JOB_ALERT_SUBJECT_EXPERIMENT_ID,
  });

  const variantIds = JOB_ALERT_SUBJECT_VARIANTS.map(({ id }) => id);
  const providers = Object.keys(report.cells).sort();
  const output = {
    ...report,
    periodId,
    variants: variantIds,
    providers: Object.fromEntries(providers.map((provider) => [
      provider,
      withWinnerDecision(report.cells[provider]),
    ])),
    pooled: withWinnerDecision(report.byVariant),
  };

  if (JSON_OUT) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  if (report.totalSends === 0) {
    console.log(`⚠️  No job-alert subject-test sends found for ${periodId}.`);
    return;
  }

  console.log(`\n📊 Job-alert subject A/B report — ${periodId}`);
  console.log(`   Experiment: ${JOB_ALERT_SUBJECT_EXPERIMENT_ID}`);
  console.log(`   Primary KPI excludes Cloudflare tracking-blind sends; Mailtrap is excluded.`);
  console.log(`   Event documents matched by message id: ${report.matchedEvents}`);

  for (const provider of providers) {
    console.log(`▸ ${provider}`);
    for (const variant of variantIds) {
      const cell = report.cells[provider][variant] || {
        sends: 0,
        trackedSends: 0,
        opens: 0,
        trackedOpenRate: 0,
        trackedClickRate: 0,
        trackedCtor: 0,
      };
      console.log(`    ${variant.padEnd(10)} ${formatCell(cell)}`);
    }
    const decision = output.providers[provider].winnerDecision;
    if (decision.reason === 'insufficient sample') {
      console.log(`    → campione insufficiente: almeno ${MIN_COMPARISON_SENDS} invii e ${MIN_EXPECTED_PER_CELL} eventi attesi per braccio`);
    } else if (decision.winner) {
      console.log(`    → vincitore promuovibile: ${decision.winner} (p_adj=${decision.adjustedPValue.toFixed(4)})`);
    } else {
      console.log(`    → nessun vincitore statisticamente significativo (${decision.reason})`);
    }
  }

  console.log('\nΣ per variante — primary tracked KPI:');
  for (const variant of variantIds) {
    const cell = report.byVariant[variant];
    console.log(`    ${variant.padEnd(10)} ${formatCell(cell)}`);
  }
  const pooledDecision = output.pooled.winnerDecision;
  const pooledBest = pooledDecision.best;
  if (pooledBest && hasEnoughPowerForTest(
    primaryCell(report.byVariant[pooledBest]),
    primaryCell(report.byVariant[pooledDecision.runnerUp]),
  )) {
    console.log(`    → confronto globale: ${pooledDecision.winner || 'non significativo'} (p_adj=${pooledDecision.adjustedPValue?.toFixed(4) ?? 'n/a'})`);
  } else {
    console.log('    → confronto globale: campione insufficiente per una decisione');
  }
}

main().catch((error) => {
  console.error('❌ Job-alert subject report failed:', error?.message || error);
  process.exit(1);
});
