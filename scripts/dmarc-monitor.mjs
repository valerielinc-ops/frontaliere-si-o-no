#!/usr/bin/env node
/**
 * dmarc-monitor.mjs — Autonomous DMARC health watchdog for frontaliereticino.ch.
 *
 * WHY THIS EXISTS
 * ───────────────
 * Cloudflare DMARC Management is enabled on the zone (the `_dmarc` TXT record
 * carries the `…@dmarc-reports.cloudflare.net` aggregate mailbox). Cloudflare
 * ingests and parses the aggregate (RUA) reports every legitimate receiver
 * sends back, but the only way to *read* that parsed data is to sit in front of
 * the dashboard. Nobody does that on a schedule, so a misconfigured sender or a
 * spoofing campaign goes unnoticed — and the domain is stuck at `p=none`
 * (monitor-only, zero protection) forever because no one confirms it is safe to
 * harden.
 *
 * This watchdog closes that loop with ZERO human attention required. It reads
 * the SAME data the dashboard shows, via Cloudflare's GraphQL Analytics dataset
 * `dmarcReportsSourcesAdaptiveGroups` (no extra DNS record, no mailbox, no
 * provider integration — the data is already in Cloudflare). It then opens a
 * GitHub issue ONLY when there is something to act on:
 *
 *   1. FAILING SOURCE (priority:high) — a sending source produced a meaningful
 *      number of messages that FAIL DMARC over the window. Two flavours, both
 *      worth a look before tightening the policy:
 *        • an UNKNOWN org (not in the expected-senders allowlist) → possible
 *          spoofing, or a forgotten service that was never aligned;
 *        • a KNOWN org failing → a real misconfiguration that WOULD bounce/junk
 *          legitimate mail the moment the policy moves past `p=none`.
 *
 *   2. READY TO HARDEN (priority:low) — over the window virtually everything
 *      passes DMARC and no source is failing in volume, so it is safe to move
 *      the policy from `p=none` → `p=quarantine` (and later `p=reject`). This is
 *      the nudge that actually turns monitoring into protection.
 *
 * If neither holds, the run is SILENT (no issue) and exits 0. It is a reporter,
 * never a gate: any internal error is logged and the process still exits 0 so a
 * transient Cloudflare/GraphQL blip never paints a scheduled run red.
 *
 * AUTH
 * ────
 *   Needs CF_API_TOKEN (Zone → Analytics → Read on the zone) — the same token
 *   cf-status-report.mjs uses, already stored in Firebase Remote Config. In CI
 *   run `node scripts/load-rc-env.mjs` first. CF_ZONE_ID is optional (resolved
 *   from CF_ZONE_NAME via the REST API when absent).
 *
 *   Opening issues needs `gh` authenticated (GITHUB_TOKEN in Actions). With
 *   --dry-run the script prints findings and never touches GitHub — use it for
 *   local inspection.
 *
 * USAGE
 * ─────
 *   node scripts/dmarc-monitor.mjs                 # last 7 days, may open issues
 *   node scripts/dmarc-monitor.mjs --days=14       # widen the window
 *   node scripts/dmarc-monitor.mjs --dry-run       # print only, no GitHub writes
 *   node scripts/dmarc-monitor.mjs --json          # machine-readable summary
 *
 * Exit code: always 0 (reporter, not a gate) unless argv is malformed.
 */

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const GRAPHQL_ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql';
const REST_BASE = 'https://api.cloudflare.com/client/v4';
const ZONE_NAME = process.env.CF_ZONE_NAME || 'frontaliereticino.ch';

// ── Tunables (env-overridable so the workflow can tighten without a code edit) ─
// A source must produce at least this many DMARC-failing messages over the
// window to raise an alert. Below it we treat the failures as ordinary
// background noise — mailing-list/forwarder breakage and lone scanners that no
// enforcement policy meaningfully harms.
const FAIL_MIN_VOL = intEnv('DMARC_FAIL_MIN_VOL', 20);
// Readiness needs a real sample so we don't green-light hardening off three
// messages in a quiet week.
const READY_MIN_TOTAL = intEnv('DMARC_READY_MIN_TOTAL', 50);
// Readiness also needs the window-wide failure share at or below this fraction.
const READY_MAX_FAIL_RATE = floatEnv('DMARC_READY_MAX_FAIL_RATE', 0.01);

// Orgs we expect to send as frontaliereticino.ch. Matched case-insensitively as
// substrings of the report's `sourceOrgName`. Used ONLY to annotate findings
// (known-misconfig vs unknown-source) — it never suppresses an alert, so a new
// legit provider that starts failing is still surfaced, just labelled "unknown".
const KNOWN_SENDERS = (process.env.DMARC_KNOWN_SENDERS
  ? process.env.DMARC_KNOWN_SENDERS.split(',')
  : [
      'mailjet',          // transactional + newsletter
      'amazon',           // Resend sends via Amazon SES
      'mailgun',          // transactional / inbound MX
      'maileroo',         // listed in SPF
      'sendersrv',        // listed in SPF
      'constant company', // Vultr — self-hosted sending/relay infra
      'google',           // Gmail forwarders / occasional relays
      'microsoft',        // Outlook/O365 forwarders
      'outlook',
    ]
).map((s) => s.trim().toLowerCase()).filter(Boolean);

const FAIL_ISSUE_TITLE = 'DMARC: sorgente che fallisce (possibile spoofing o mittente da sistemare)';
const READY_ISSUE_TITLE = 'DMARC: pronto per irrigidire la policy (p=none → p=quarantine)';
const WORKFLOW_NAME = 'DMARC Monitor';

function intEnv(name, dflt) {
  const v = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) ? v : dflt;
}
function floatEnv(name, dflt) {
  const v = parseFloat(process.env[name] ?? '');
  return Number.isFinite(v) ? v : dflt;
}

function parseArgs(argv) {
  const opts = { days: 7, dryRun: false, json: false };
  for (const a of argv.slice(2)) {
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--json') opts.json = true;
    else if (a.startsWith('--days=')) {
      const n = parseInt(a.slice('--days='.length), 10);
      if (!Number.isFinite(n) || n < 1 || n > 90) {
        console.error(`Invalid --days (1..90): ${a}`);
        process.exit(2);
      }
      opts.days = n;
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return opts;
}

/** YYYY-MM-DD for `now − days`, in UTC (matches the dataset's `date` dimension). */
function sinceDate(days) {
  const d = new Date(Date.now() - days * 86400_000);
  return d.toISOString().slice(0, 10);
}

async function cfGet(path, token) {
  const res = await fetch(`${REST_BASE}/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.json();
}

async function resolveZoneId(token) {
  if (process.env.CF_ZONE_ID) return process.env.CF_ZONE_ID;
  const j = await cfGet(`zones?name=${encodeURIComponent(ZONE_NAME)}`, token);
  if (!j.success || !j.result?.length) {
    throw new Error(`zone lookup failed for ${ZONE_NAME}: ${JSON.stringify(j.errors)}`);
  }
  return j.result[0].id;
}

async function fetchSources(token, zoneId, since) {
  const query = `query DmarcSources($zone: String!, $since: Date!) {
    viewer {
      zones(filter: { zoneTag: $zone }) {
        dmarcReportsSourcesAdaptiveGroups(
          limit: 200,
          filter: { date_geq: $since },
          orderBy: [sum_totalMatchingMessages_DESC]
        ) {
          dimensions { sourceOrgName headerFrom sourceIP spf dkim disposition }
          sum { totalMatchingMessages dmarc spfPass dkimPass }
        }
      }
    }
  }`;
  const res = await fetch(GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { zone: zoneId, since } }),
  });
  const j = await res.json();
  if (j.errors) throw new Error(`GraphQL error: ${JSON.stringify(j.errors)}`);
  const rows = j.data?.viewer?.zones?.[0]?.dmarcReportsSourcesAdaptiveGroups;
  if (!Array.isArray(rows)) throw new Error('unexpected GraphQL shape (no rows array)');
  return rows;
}

export function isKnown(orgName) {
  const n = (orgName || '').toLowerCase();
  return KNOWN_SENDERS.some((k) => n.includes(k));
}

/**
 * Collapse the per-(org,from,ip,…) rows into per-source-org aggregates and
 * derive the findings. Pure function over the GraphQL rows so it is trivially
 * unit-testable.
 */
export function analyze(rows) {
  const byOrg = new Map();
  let total = 0;
  let totalPass = 0;
  for (const r of rows) {
    const org = r.dimensions?.sourceOrgName || '(unknown org)';
    const msgs = Number(r.sum?.totalMatchingMessages || 0);
    const pass = Number(r.sum?.dmarc || 0);
    total += msgs;
    totalPass += pass;
    let agg = byOrg.get(org);
    if (!agg) {
      agg = { org, known: isKnown(org), total: 0, pass: 0, fail: 0, topFailIP: null, topFailIPCount: 0 };
      byOrg.set(org, agg);
    }
    agg.total += msgs;
    agg.pass += pass;
    const fail = msgs - pass;
    agg.fail += fail;
    if (fail > agg.topFailIPCount) {
      agg.topFailIPCount = fail;
      agg.topFailIP = r.dimensions?.sourceIP || null;
    }
  }
  const totalFail = total - totalPass;
  const failingSources = [...byOrg.values()]
    .filter((s) => s.fail >= FAIL_MIN_VOL)
    .sort((a, b) => b.fail - a.fail);
  const failRate = total > 0 ? totalFail / total : 0;
  const ready =
    failingSources.length === 0 &&
    total >= READY_MIN_TOTAL &&
    failRate <= READY_MAX_FAIL_RATE;
  return {
    total,
    totalPass,
    totalFail,
    failRate,
    sources: [...byOrg.values()].sort((a, b) => b.total - a.total),
    failingSources,
    ready,
  };
}

function pct(n, d) {
  if (!d) return '0%';
  return `${((100 * n) / d).toFixed(1)}%`;
}

function createIssue({ title, description, priority }) {
  // Mirrors the call sites in gh-pat-expiry-monitor.yml. `automation` keeps the
  // deterministic issue-triage classifier from routing this to an auto-fixer
  // (titles outside the crawler/follow-up buckets stay route:none).
  execFileSync(
    'node',
    [
      'scripts/lib/github-issue-creator.mjs',
      '--title', title,
      '--description', description,
      '--priority', String(priority),
      '--label', 'automation',
      '--workflow', WORKFLOW_NAME,
    ],
    { stdio: 'inherit' },
  );
}

function buildFailBody(a, days, since) {
  const lines = [
    '## ⚠️ DMARC: una o più sorgenti falliscono in volume',
    '',
    `Finestra analizzata: **ultimi ${days} giorni** (dal \`${since}\`), dati dal`,
    'DMARC Management di Cloudflare (dataset `dmarcReportsSourcesAdaptiveGroups`).',
    '',
    `Messaggi totali: **${a.total}** · passano DMARC: **${a.totalPass}** (${pct(a.totalPass, a.total)}) ·`,
    `falliscono: **${a.totalFail}** (${pct(a.totalFail, a.total)}).`,
    '',
    '### Sorgenti che falliscono DMARC',
    '',
    '| Sorgente | Tipo | Msg | Falliti | Pass-rate | IP principale dei fail |',
    '|---|---|---:|---:|---:|---|',
  ];
  for (const s of a.failingSources) {
    lines.push(
      `| ${s.org} | ${s.known ? 'noto (mittente atteso)' : '🚩 SCONOSCIUTO'} | ${s.total} | ${s.fail} | ${pct(s.pass, s.total)} | ${s.topFailIP || '—'} |`,
    );
  }
  lines.push(
    '',
    '### Come leggerlo',
    '- **Sorgente SCONOSCIUTA che fallisce** → o qualcuno spoofa il tuo dominio,',
    '  oppure è un servizio legittimo dimenticato e mai allineato (SPF/DKIM). Se è',
    '  tuo, configuralo; se non lo riconosci, è la prova che la protezione va alzata.',
    '- **Sorgente NOTA che fallisce** → un tuo mittente legittimo è mal configurato:',
    '  con `p=quarantine`/`p=reject` quei messaggi finirebbero in spam o bloccati.',
    '  Vai a sistemare SPF/DKIM di quel provider PRIMA di irrigidire la policy.',
    '',
    '### Azione',
    '1. Identifica ogni sorgente in tabella (l\'IP principale aiuta).',
    '2. Mittenti tuoi → allinea SPF (return-path sul dominio) e/o firma DKIM.',
    '3. Sorgenti che non riconosci e non riesci a giustificare → è spoofing:',
    '   procedi verso `p=quarantine` per neutralizzarlo.',
    '',
    '_Aperto automaticamente dal workflow DMARC Monitor. Si auto-aggiorna con un',
    'commento finché la condizione persiste; chiudilo quando hai sistemato._',
  );
  return lines.join('\n');
}

function buildReadyBody(a, days, since) {
  return [
    '## ✅ DMARC: pronto per passare a `p=quarantine`',
    '',
    `Negli **ultimi ${days} giorni** (dal \`${since}\`) il dominio ha avuto`,
    `**${a.total}** messaggi analizzati dal DMARC Management di Cloudflare:`,
    `**${a.totalPass}** passano DMARC (${pct(a.totalPass, a.total)}), solo`,
    `**${a.totalFail}** falliscono (${pct(a.totalFail, a.total)}) e nessuna sorgente`,
    `fallisce in volume (soglia ${FAIL_MIN_VOL}).`,
    '',
    'Tutti i mittenti legittimi sono allineati: alzare la policy non manderà in',
    'spam la posta vera. Oggi sei a `p=none` → **monitori soltanto, non sei protetto**.',
    '',
    '### Azione consigliata',
    '1. Nel record `_dmarc.frontaliereticino.ch` (DNS Cloudflare) cambia `p=none`',
    '   in `p=quarantine`. Opzionale ma prudente: rampa con `pct=25` → `50` → `100`.',
    '2. Lascia girare 1–2 settimane: questo monitor continua a vegliare e ti',
    '   avvisa se qualcosa si rompe.',
    '3. Quando `p=quarantine` è stabile e pulito, passa a `p=reject` (protezione piena).',
    '',
    '_Aperto automaticamente dal workflow DMARC Monitor. Una volta alzata la',
    'policy chiudi pure questa issue._',
  ].join('\n');
}

async function main() {
  const opts = parseArgs(process.argv);
  const token = process.env.CF_API_TOKEN;
  if (!token) {
    console.error('CF_API_TOKEN missing — load it via scripts/load-rc-env.mjs first. Skipping (exit 0).');
    return;
  }

  const since = sinceDate(opts.days);
  let zoneId;
  let rows;
  try {
    zoneId = await resolveZoneId(token);
    rows = await fetchSources(token, zoneId, since);
  } catch (err) {
    // Reporter, not a gate: a Cloudflare/GraphQL hiccup must not fail the run.
    console.error(`DMARC fetch failed (non-fatal): ${err.message}`);
    return;
  }

  const a = analyze(rows);

  if (opts.json) {
    console.log(JSON.stringify({ since, days: opts.days, ...a }, null, 2));
  } else {
    console.log(`DMARC sources since ${since} (${opts.days}d):`);
    console.log(`  total=${a.total} pass=${a.totalPass} (${pct(a.totalPass, a.total)}) fail=${a.totalFail} (${pct(a.totalFail, a.total)})`);
    for (const s of a.sources) {
      console.log(`  • ${s.org} [${s.known ? 'known' : 'UNKNOWN'}] msg=${s.total} fail=${s.fail} pass=${pct(s.pass, s.total)}`);
    }
    console.log(a.failingSources.length ? `  → ${a.failingSources.length} failing source(s)` : '  → no failing sources');
    console.log(a.ready ? '  → READY to harden (p=quarantine)' : '  → not flagged ready');
  }

  if (a.total === 0) {
    console.log('No DMARC data in window — nothing to report.');
    return;
  }

  const actions = [];
  if (a.failingSources.length) actions.push('fail');
  else if (a.ready) actions.push('ready');

  if (opts.dryRun) {
    console.log(`[dry-run] would open issue(s): ${actions.length ? actions.join(', ') : 'none'}`);
    return;
  }

  if (a.failingSources.length) {
    createIssue({
      title: FAIL_ISSUE_TITLE,
      description: buildFailBody(a, opts.days, since),
      priority: 2,
    });
  } else if (a.ready) {
    createIssue({
      title: READY_ISSUE_TITLE,
      description: buildReadyBody(a, opts.days, since),
      priority: 4,
    });
  }
}

// Run only when invoked directly (not when imported by the test suite), so
// importing analyze()/isKnown() never triggers a live Cloudflare call.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    // Last-resort guard: still exit 0 (reporter contract).
    console.error(`DMARC monitor unexpected error (non-fatal): ${err.stack || err.message}`);
  });
}
