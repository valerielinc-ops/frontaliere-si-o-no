import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildJobAlertFunnel,
  formatJobAlertBatchLine,
  formatJobAlertCount,
  formatJobAlertFunnelLines,
  formatJobAlertFunnelMarkdown,
  formatJobAlertProviderLine,
  writeJobAlertStepSummary,
} from '../scripts/lib/job-alert-funnel.mjs';
import { read } from './helpers/senders';

// Contatori del run 41012935263 (30/10/2026, LIVE). Il log stampa quasi tutti i
// passaggi; la divisione tra «già inviati» e «link morti» non compare, ma il loro
// totale sì (2.643 − 1.033 − 1.380 = 230), ed è l'unico vincolo che il funnel
// richiede. Il numero di destinatari unici non è nel log: è un valore d'esempio.
const RUN_2026_10_30 = {
  archive: 14625,
  paused: 39,
  companyImmediate: 281,
  allowlist: 0,
  base: 14305,
  suppressionDeferred: 0,
  suppressed: 1392,
  backfill: 215,
  cooldown: 55,
  decayed: 1760,
  notDue: 8240,
  eligible: 2643,
  noCandidate: 4,
  emptyProfile: 540,
  zeroMatch: 489,
  alreadySent: 200,
  deadLinks: 30,
  quotaDeferred: 0,
  planned: 1380,
  failed: 0,
  sent: 1380,
  ambiguous: 0,
  retrySent: 0,
  uniqueRecipients: 1211,
};

const PROVIDERS = [
  { id: 'maileroo', configured: true, sent: 1380, benched: 0, remaining: 4347, dailyLimit: 8064 },
  { id: 'resend', configured: true, sent: 0, benched: 0, remaining: 100, dailyLimit: Number.POSITIVE_INFINITY },
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe('formatJobAlertCount', () => {
  it('separates thousands with a dot and keeps small numbers plain', () => {
    expect(formatJobAlertCount(14625)).toBe('14.625');
    expect(formatJobAlertCount(1380)).toBe('1.380');
    expect(formatJobAlertCount(39)).toBe('39');
    expect(formatJobAlertCount(0)).toBe('0');
  });

  it('marks negatives with a minus sign and an infinite limit with ∞', () => {
    expect(formatJobAlertCount(-1392)).toBe('−1.392');
    expect(formatJobAlertCount(Number.POSITIVE_INFINITY)).toBe('∞');
    expect(formatJobAlertCount(Number.NaN)).toBe('—');
  });
});

describe('buildJobAlertFunnel', () => {
  it('reproduces the 2026-10-30 run with every step balanced', () => {
    const funnel = buildJobAlertFunnel(RUN_2026_10_30);

    expect(funnel.balanced).toBe(true);
    expect(funnel.imbalance).toEqual([0, 0, 0, 0]);
    expect(funnel.values.totalSent).toBe(1380);
  });

  it('hides the incident-only steps when they are zero, and shows them with their count when they happen', () => {
    const normal = buildJobAlertFunnel(RUN_2026_10_30).rows.map((row) => row.label);
    expect(normal).not.toContain('lettura soppressioni fallita');
    expect(normal).not.toContain('rinviati per quota giornaliera');

    const incident = buildJobAlertFunnel({ ...RUN_2026_10_30, quotaDeferred: 300 });
    const quota = incident.rows.find((row) => row.label === 'rinviati per quota giornaliera');
    expect(quota?.count).toBe(300);
  });

  it('hides the test-list step on normal runs and shows it when TARGET_EMAIL excluded alerts', () => {
    const normal = buildJobAlertFunnel(RUN_2026_10_30).rows.map((row) => row.label);
    expect(normal).not.toContain('fuori dalla lista di test');

    const targeted = buildJobAlertFunnel({ ...RUN_2026_10_30, archive: 14630, allowlist: 5 });
    expect(targeted.rows.map((row) => row.label)).toContain('fuori dalla lista di test');
    expect(targeted.balanced).toBe(true);
  });

  it('flags a count that does not add up instead of presenting it as final', () => {
    // 80 email «inviate» in più di quelle pianificate meno le fallite: un bug di
    // contabilità, non un numero da leggere.
    const funnel = buildJobAlertFunnel({ ...RUN_2026_10_30, sent: 1460 });

    expect(funnel.balanced).toBe(false);
    expect(funnel.imbalance[3]).toBe(-80);
    const lines = formatJobAlertFunnelLines(funnel, { date: '2026-10-30', mode: 'LIVE' });
    expect(lines.join('\n')).toContain('Conteggio non quadrato');
  });

  it('a day with no active alerts and no retries still balances and reports zero', () => {
    const empty = buildJobAlertFunnel({});

    expect(empty.balanced).toBe(true);
    expect(empty.values.totalSent).toBe(0);
    const lines = formatJobAlertFunnelLines(empty, { date: '2026-10-30', mode: 'LIVE' });
    expect(lines[0]).toContain('EMAIL INVIATE OGGI: 0');
  });

  it('a day with no new alerts but a retry shows the retry in the headline', () => {
    const retryOnly = buildJobAlertFunnel({ retrySent: 3, uniqueRecipients: 2 });

    expect(retryOnly.balanced).toBe(true);
    const lines = formatJobAlertFunnelLines(retryOnly, { date: '2026-10-30', mode: 'LIVE' });
    expect(lines[0]).toBe('📬 EMAIL INVIATE OGGI: 3 — nuove 0 · retry 3 · destinatari unici 2');
  });

  it('a dry run does not flag the send check: nothing is sent, so planned is what would have gone out', () => {
    // Il dry-run di produzione del 30/10 (09:27 UTC) segnalava Δ 2 su questo passaggio.
    const counts = { archive: 2, base: 2, eligible: 2, planned: 2, sent: 0, failed: 0 };

    const dry = buildJobAlertFunnel(counts, { dryRun: true });
    expect(dry.balanced).toBe(true);
    expect(dry.imbalance[3]).toBe(0);

    const live = buildJobAlertFunnel(counts);
    expect(live.balanced).toBe(false);
    expect(live.imbalance[3]).toBe(2);
  });

  it('counts retries as sent today but keeps the new-send figure separate', () => {
    const funnel = buildJobAlertFunnel({ ...RUN_2026_10_30, retrySent: 12 });

    expect(funnel.values.sent).toBe(1380);
    expect(funnel.values.totalSent).toBe(1392);
    expect(funnel.balanced).toBe(true);
  });
});

describe('formatJobAlertFunnelLines', () => {
  const funnel = buildJobAlertFunnel(RUN_2026_10_30);
  const lines = formatJobAlertFunnelLines(funnel, { date: '2026-10-30', mode: 'LIVE', linkAudit: { batches: 42, defects: 0 } });

  it('opens with the number of emails sent, before the detail', () => {
    expect(lines[0]).toContain('EMAIL INVIATE OGGI: 1.380');
    expect(lines[0]).toContain('nuove 1.380');
    expect(lines[0]).toContain('retry 0');
    expect(lines[0]).toContain('destinatari unici 1.211');
  });

  it('shows each step with its count, in the order the sender decides them', () => {
    const text = lines.join('\n');
    expect(text).toMatch(/Alert attivi in archivio\s+14\.625/);
    expect(text).toMatch(/Base attiva\s+14\.305/);
    expect(text).toMatch(/soppressi .*\s+1\.392/);
    expect(text).toMatch(/decaduti per cadenza\s+1\.760/);
    expect(text).toMatch(/Eleggibili oggi\s+2\.643/);
    expect(text).toMatch(/Email pianificate\s+1\.380/);
    expect(text.indexOf('Base attiva')).toBeLessThan(text.indexOf('Eleggibili oggi'));
    expect(text.indexOf('Eleggibili oggi')).toBeLessThan(text.indexOf('Email pianificate'));
  });

  it('stays short: one block, no provider table, no per-alert noise', () => {
    expect(lines.length).toBeLessThan(40);
    expect(lines.join('\n')).not.toContain('Email Provider Summary');
  });

  it('reports the link audit as a single line for the whole run', () => {
    expect(lines.join('\n')).toContain('🔗 Link audit: 42 batch auditati · 0 con difetti');
  });

  it('says plainly that nothing was sent on a dry run', () => {
    const dry = formatJobAlertFunnelLines(funnel, { date: '2026-10-30', mode: 'DRY RUN' });
    expect(dry[0]).toContain('DRY RUN — nessun invio: 1.380 email sarebbero partite');
  });
});

describe('formatJobAlertFunnelMarkdown', () => {
  const funnel = buildJobAlertFunnel(RUN_2026_10_30);
  const markdown = formatJobAlertFunnelMarkdown(funnel, {
    date: '2026-10-30',
    mode: 'LIVE',
    providers: PROVIDERS,
    linkAudit: { batches: 42, defects: 0 },
  });

  it('renders the funnel as a table with the reason for each excluded group', () => {
    expect(markdown).toContain('## 📬 Funnel job alert · 2026-10-30 · LIVE');
    expect(markdown).toContain('| − in pausa | −39 |');
    expect(markdown).toContain('| = **Base attiva** | **14.305** |');
    expect(markdown).toContain('| − soppressi (stop globale, bounce, reclamo, lista provider) | −1.392 | nessun invio finché il consenso non torna |');
    expect(markdown).toContain('| = **Eleggibili oggi** | **2.643** |');
  });

  it('puts the emails sent in the headline', () => {
    expect(markdown).toContain('**EMAIL INVIATE OGGI: 1.380 — nuove 1.380 · retry 0 · destinatari unici 1.211**');
  });

  it('adds one provider table, with an infinite limit shown as ∞', () => {
    expect(markdown).toContain('### Provider email');
    expect(markdown).toContain('| maileroo | ✅ | 1.380 | 0 | 4.347 | 8.064 |');
    expect(markdown).toContain('| resend | ✅ | 0 | 0 | 100 | ∞ |');
  });
});

describe('formatJobAlertProviderLine', () => {
  it('prints one line with each configured provider, its sends and the quota left today', () => {
    expect(formatJobAlertProviderLine(PROVIDERS)).toBe(
      '   📮 Provider: maileroo 1.380 inviate (residuo 4.347 di 8.064) · resend 0 inviate (residuo 100)',
    );
  });

  it('prints nothing when no provider is configured', () => {
    expect(formatJobAlertProviderLine([])).toBe('');
  });
});

describe('formatJobAlertBatchLine', () => {
  it('prints one line per batch with the provider split', () => {
    expect(formatJobAlertBatchLine(3, {
      sent: 41,
      failed: 0,
      ambiguous: 0,
      providerBreakdown: { maileroo: { identified: 41, ambiguous: 0, persistFailed: 0 } },
    })).toBe('   📦 Batch 3 · inviate 41 (ambigue 0) · fallite 0 · maileroo 41');
  });

  it('counts ambiguous acceptances under their provider', () => {
    expect(formatJobAlertBatchLine(1, {
      sent: 5,
      failed: 2,
      ambiguous: 1,
      providerBreakdown: { maileroo: { identified: 4, ambiguous: 1, persistFailed: 0 } },
    })).toBe('   📦 Batch 1 · inviate 5 (ambigue 1) · fallite 2 · maileroo 5');
  });
});

describe('writeJobAlertStepSummary', () => {
  it('appends the markdown to the GitHub step summary file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'job-alert-funnel-'));
    try {
      const target = path.join(dir, 'summary.md');
      expect(writeJobAlertStepSummary('## first', { target })).toBe(true);
      expect(writeJobAlertStepSummary('## second', { target })).toBe(true);
      expect(readFileSync(target, 'utf8')).toBe('## first\n## second\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does nothing outside GitHub Actions', () => {
    expect(writeJobAlertStepSummary('## local', { target: '' })).toBe(false);
  });

  it('warns and carries on when the summary file cannot be written', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dir = mkdtempSync(path.join(tmpdir(), 'job-alert-funnel-'));
    try {
      expect(writeJobAlertStepSummary('## x', { target: path.join(dir, 'missing', 'summary.md') })).toBe(false);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Job Summary non scritto'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('send-job-alerts.mjs log contract', () => {
  const source = read('scripts/send-job-alerts.mjs');

  it('keeps one line per alert in the log, switchable with JOB_ALERT_LOG_DETAIL=0', () => {
    expect(source).toMatch(/const JOB_ALERT_LOG_DETAIL = process\.env\.JOB_ALERT_LOG_DETAIL !== '0'/);
    expect(source).not.toMatch(/console\.log\(`\s+📬 Alert/);
    expect(source).not.toMatch(/console\.log\(`\s+⏭️/);
    expect(source).not.toMatch(/console\.log\(`\s+🔗 Live-link check/);
  });

  it('never prints a subscriber address in a log line: the Actions log of this repo is public', () => {
    // Un indirizzo stampato in un log di Actions è un indirizzo pubblicato.
    const logLines = source.split('\n').filter((line) => /console\.(log|warn|error)\(|logDetail\(/.test(line));
    const leaking = logLines.filter((line) => /\$\{[^}]*(\bemail\b|chunk\[0\])/i.test(line));
    expect(leaking).toEqual([]);
  });

  it('keeps the provider table out of the log: it lives in the Job Summary', () => {
    expect(source).not.toMatch(/logProviderSummary\(\);/);
    expect(source).toMatch(/formatJobAlertProviderLine\(providers\)/);
  });

  it('asks the cascade for quiet batches in both the first send and the retry', () => {
    expect(source.match(/quiet: true,/g)).toHaveLength(2);
  });

  it('logs the reason for each filtered alert, one line each, through logDetail', () => {
    expect(source).toMatch(/logDetail\(`\s+🚫 soppresso/);
    expect(source).toMatch(/logDetail\(`\s+🚫 senza base di iscrizione/);
    expect(source).toMatch(/logDetail\(`\s+📬 rinviato/);
    expect(source).toMatch(/logDetail\(`\s+🪦 decaduto per cadenza/);
  });

  it('prints the cadence ceiling only when it is switched on (it was printing «nulld»)', () => {
    expect(source).toMatch(/if \(JOB_ALERT_CADENCE_CEILING_DAYS != null\) console\.log/);
  });

  it('prints the funnel before any early return, so a zero-send day still writes the Job Summary', () => {
    // Il 🔴 del revisore: il ritorno «nessun alert attivo» usciva prima del funnel.
    expect(source).toMatch(/await printJobAlertFunnel\(\{ retryOutcome \}\);\s*console\.log\('   No live inventory jobs/);
    expect(source).toMatch(/await printJobAlertFunnel\(\{ funnelIn, retryOutcome \}\);\s*console\.log\('   No active alerts/);
    const funnelAt = source.indexOf('await printJobAlertFunnel({');
    const noMatchAt = source.indexOf("'   No matches — no emails to send.'");
    expect(funnelAt).toBeGreaterThan(0);
    expect(noMatchAt).toBeGreaterThan(funnelAt);
  });
});

describe('shared cascade quiet mode', () => {
  it('keeps the per-call summary lines behind the quiet flag in functions/src/emailCascade.js', () => {
    const cascade = read('functions/src/emailCascade.js');
    expect(cascade).toMatch(/quiet = false\b/);
    expect(cascade).toMatch(/if \(!quiet\) \{\n\s+console\.log\(`📧 Email cascade/);
    expect(cascade).toMatch(/if \(!quiet\) \{\n\s+console\.log\(`✅ Sent: /);
  });
});
