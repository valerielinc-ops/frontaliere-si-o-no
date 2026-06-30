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
 * spoofing campaign goes unnoticed — and the domain never advances along the
 * enforcement ladder (`p=none` → `p=quarantine` → `p=reject`) because no one
 * confirms it is safe to take the next step.
 *
 * This watchdog closes that loop with ZERO human attention required. It reads
 * the SAME data the dashboard shows, via Cloudflare's GraphQL Analytics dataset
 * `dmarcReportsSourcesAdaptiveGroups` (no extra DNS record, no mailbox, no
 * provider integration — the data is already in Cloudflare), reads the CURRENT
 * policy straight from the `_dmarc` record, and opens a GitHub issue ONLY when
 * there is something to act on:
 *
 *   1. FAILING SOURCE (priority:high) — a sending source produced a meaningful
 *      number of messages that FAIL DMARC over the window. Two flavours, both
 *      worth a look before tightening the policy:
 *        • an UNKNOWN org (not in the expected-senders allowlist) → possible
 *          spoofing, or a forgotten service that was never aligned;
 *        • a KNOWN org failing → a real misconfiguration that WOULD bounce/junk
 *          legitimate mail the moment the policy moves past `p=none`.
 *
 *   2. READY FOR THE NEXT STEP (priority:low) — over the window virtually
 *      everything passes DMARC and no source is failing in volume, so it is safe
 *      to advance the policy ONE rung. The nudge is policy-aware:
 *        • at `p=none`       → suggest `p=quarantine`;
 *        • at `p=quarantine` → suggest `p=reject` (full protection);
 *        • at `p=reject`     → SILENT (already fully protected, nothing to do).
 *      Reading the live policy is what stops the monitor from forever nagging
 *      "move to quarantine" after you already have.
 *
 * If neither holds, the run is SILENT (no issue) and exits 0. It is a reporter,
 * never a gate: any internal error is logged and the process still exits 0 so a
 * transient Cloudflare/GraphQL blip never paints a scheduled run red.
 *
 * AUTH
 * ────
 *   Needs CF_API_TOKEN (Zone → Analytics → Read, plus DNS → Read to see the
 *   current policy) — the same token cf-status-report.mjs uses, already stored
 *   in Firebase Remote Config. In CI run `node scripts/load-rc-env.mjs` first.
 *   CF_ZONE_ID is optional (resolved from CF_ZONE_NAME via the REST API).
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
import {
  cfGraphQL,
  resolveZoneId,
  REST_BASE,
  DEFAULT_ZONE_NAME,
} from './lib/cf-analytics.mjs';

const ZONE_NAME = process.env.CF_ZONE_NAME || DEFAULT_ZONE_NAME;

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
// A KNOWN sender almost always carries a small tail of DMARC-failing messages
// that is NOT a misconfiguration: forwarded copies (auto-forwards, mailing
// lists) legitimately break SPF/DKIM alignment and SHOULD fail — that is exactly
// what enforcement is for. So for a known sender we only alert on a SYSTEMATIC
// failure (its pass-rate is low → its own direct sends are failing), not on the
// forwarding tail of an otherwise-healthy one. UNKNOWN sources bypass this floor
// entirely (always surfaced — could be spoofing). 0.90 keeps a real degradation
// visible while silencing the perpetual forwarding noise of a bulk ESP (e.g.
// Mailjet ~96% pass) that would otherwise re-open this issue every single week.
const KNOWN_SENDER_MIN_PASS_RATE = floatEnv('DMARC_KNOWN_MIN_PASS_RATE', 0.9);

// Orgs we expect to send as frontaliereticino.ch. Matched case-insensitively as
// substrings of the report's `sourceOrgName`. Drives two things: it annotates a
// finding (known-misconfig vs unknown-source), and it lets a healthy known
// sender's forwarding tail be treated as background noise (see
// KNOWN_SENDER_MIN_PASS_RATE) — an UNKNOWN source failing in volume is ALWAYS
// surfaced regardless, so a brand-new provider that starts failing still shows
// up (just labelled "unknown"/possible-spoofing).
const KNOWN_SENDERS = (process.env.DMARC_KNOWN_SENDERS
  ? process.env.DMARC_KNOWN_SENDERS.split(',')
  : [
      'mailjet',          // transactional + newsletter
      'amazon',           // Resend sends via Amazon SES
      'mailgun',          // transactional / inbound MX
      'maileroo',         // listed in SPF (_spf.maileroo.com)
      'sendersrv',        // listed in SPF
      'constant company', // Maileroo's shared MTAs (rDNS mta*.maileroo.com, IPs in _spf.maileroo.com); Constant Company/Vultr is the hosting AS
      'google',           // Gmail forwarders / occasional relays
      'microsoft',        // Outlook/O365 forwarders
      'outlook',
    ]
).map((s) => s.trim().toLowerCase()).filter(Boolean);

// Distinct stable titles → independent dedup per enforcement rung. The
// github-issue-creator dedups on the first 60 chars, so the two readiness
// titles must diverge within that prefix (they do: "(p=none →" vs "(p=quar…").
const FAIL_ISSUE_TITLE = 'DMARC: sorgente che fallisce (possibile spoofing o mittente da sistemare)';
const READY_QUARANTINE_TITLE = 'DMARC: pronto per irrigidire la policy (p=none → p=quarantine)';
const READY_REJECT_TITLE = 'DMARC: pronto per protezione piena (p=quarantine → p=reject)';
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
  const data = await cfGraphQL(token, query, { zone: zoneId, since });
  const rows = data?.viewer?.zones?.[0]?.dmarcReportsSourcesAdaptiveGroups;
  if (!Array.isArray(rows)) throw new Error('unexpected GraphQL shape (no rows array)');
  return rows;
}

/**
 * Read the live enforcement policy straight from the `_dmarc` TXT record so the
 * readiness nudge targets the correct NEXT rung. Returns 'none' | 'quarantine'
 * | 'reject', or null if the record can't be read/parsed (→ no readiness nudge,
 * the conservative choice: never suggest a step we can't anchor to reality).
 */
async function fetchCurrentPolicy(token, zoneId) {
  try {
    const url = `${REST_BASE}/zones/${zoneId}/dns_records?type=TXT&name=${encodeURIComponent(`_dmarc.${ZONE_NAME}`)}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const j = await res.json();
    if (!j.success || !Array.isArray(j.result)) return null;
    const rec = j.result.find((r) => /v=DMARC1/i.test(r.content || ''));
    if (!rec) return null;
    const val = rec.content.replace(/^"|"$/g, '').replace(/"\s+"/g, '');
    const m = val.match(/\bp=(none|quarantine|reject)\b/i);
    return m ? m[1].toLowerCase() : null;
  } catch {
    return null;
  }
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
    .filter((s) => {
      if (s.fail < FAIL_MIN_VOL) return false;
      // Unknown source failing in volume → always surface (possible spoofing, or
      // a forgotten service that was never aligned).
      if (!s.known) return true;
      // Known sender → only a SYSTEMATIC failure (low pass-rate) is a real
      // misconfig worth acting on; a small failing tail riding on a healthy
      // pass-rate is ordinary forwarding/mailing-list breakage, which
      // enforcement is supposed to drop and which no DNS fix removes.
      const passRate = s.total > 0 ? s.pass / s.total : 0;
      return passRate < KNOWN_SENDER_MIN_PASS_RATE;
    })
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

/**
 * Given the live policy and the window analysis, return the NEXT enforcement
 * rung to suggest — or null when there is nothing to nudge. Pure + tested.
 *   not-ready            → null (a failing-source alert fires instead)
 *   ready & p=none       → 'quarantine'
 *   ready & p=quarantine → 'reject'
 *   ready & p=reject     → null (fully protected)
 *   policy unknown       → null (don't anchor a suggestion to a guess)
 */
export function nextEnforcementStep(currentPolicy, analysis) {
  if (!analysis.ready) return null;
  if (currentPolicy === 'none') return 'quarantine';
  if (currentPolicy === 'quarantine') return 'reject';
  return null;
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

function buildFailBody(a, days, since, policy) {
  // The right reading of a failing source depends on the live enforcement rung:
  // at p=reject a KNOWN sender failing means legit mail is ALREADY being bounced
  // (urgent), while an UNKNOWN one is spoofing that is ALREADY neutralised. At
  // p=none/quarantine the failures are a warning to fix BEFORE tightening.
  const atReject = policy === 'reject';
  const lines = [
    '## ⚠️ DMARC: una o più sorgenti falliscono in volume',
    '',
    `Finestra analizzata: **ultimi ${days} giorni** (dal \`${since}\`), dati dal`,
    'DMARC Management di Cloudflare (dataset `dmarcReportsSourcesAdaptiveGroups`).',
    '',
    `Policy DMARC attuale: **p=${policy ?? 'sconosciuta'}**.`,
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
    '_Sono in tabella solo le sorgenti con un fallimento sistematico: la piccola coda',
    'di fail di un mittente noto sano (inoltri/mailing-list) è rumore di fondo, ignorata._',
    '',
    '### Come leggerlo',
    '- **Sorgente SCONOSCIUTA che fallisce** → o qualcuno spoofa il tuo dominio,',
    '  oppure è un servizio legittimo dimenticato e mai allineato (SPF/DKIM). Se è',
    '  tuo, configuralo; se non lo riconosci, è la prova che la protezione va alzata.',
    '- **Sorgente NOTA che fallisce in modo sistematico** → un tuo mittente',
    '  legittimo è mal configurato (SPF non allineato e/o DKIM non firmato).',
    atReject
      ? '  Con la policy **già a `p=reject`** quella posta viene **rifiutata ADESSO**: è'
      : '  Con `p=quarantine`/`p=reject` quei messaggi finirebbero in spam o bloccati:',
    atReject
      ? '  consegna legittima persa finché non sistemi SPF/DKIM di quel provider (o lo spegni).'
      : '  sistema SPF/DKIM di quel provider PRIMA di irrigidire la policy.',
    '',
    '### Azione',
    '1. Identifica ogni sorgente in tabella (l\'IP principale + il suo rDNS aiutano).',
    '2. Mittenti tuoi → allinea SPF (return-path sul dominio) e/o firma DKIM, oppure',
    '   smetti di inviare da quel provider finché non è autenticato.',
    atReject
      ? '3. Sorgenti SCONOSCIUTE → `p=reject` le sta già rifiutando: nessun setup da fare, è spoofing neutralizzato.'
      : '3. Sorgenti che non riconosci e non riesci a giustificare → è spoofing: procedi verso un enforcement più alto per neutralizzarlo.',
    '',
    '_Aperto automaticamente dal workflow DMARC Monitor. Si auto-aggiorna con un',
    'commento finché la condizione persiste; chiudilo quando hai sistemato._',
  );
  return lines.join('\n');
}

function buildReadyBody(a, days, since, step) {
  const cfg =
    step === 'reject'
      ? {
          heading: '✅ DMARC: pronto per `p=reject` (protezione piena)',
          from: 'p=quarantine',
          to: 'p=reject',
          nowState: 'sei a `p=quarantine` → la posta falsificata finisce in spam, ma non è bloccata',
          effect: '`p=reject` la fa **rifiutare in consegna**: protezione completa contro lo spoofing del tuo dominio.',
        }
      : {
          heading: '✅ DMARC: pronto per passare a `p=quarantine`',
          from: 'p=none',
          to: 'p=quarantine',
          nowState: 'sei a `p=none` → **monitori soltanto, non sei protetto**',
          effect: '`p=quarantine` manda la posta falsificata **in spam** (recuperabile), senza toccare quella legittima.',
        };
  return [
    `## ${cfg.heading}`,
    '',
    `Negli **ultimi ${days} giorni** (dal \`${since}\`) il dominio ha avuto`,
    `**${a.total}** messaggi analizzati dal DMARC Management di Cloudflare:`,
    `**${a.totalPass}** passano DMARC (${pct(a.totalPass, a.total)}), solo`,
    `**${a.totalFail}** falliscono (${pct(a.totalFail, a.total)}) e nessuna sorgente`,
    `fallisce in volume (soglia ${FAIL_MIN_VOL}).`,
    '',
    `Tutti i mittenti legittimi sono allineati: oggi ${cfg.nowState}.`,
    `Salire da \`${cfg.from}\` a \`${cfg.to}\` è sicuro: ${cfg.effect}`,
    '',
    '### Azione consigliata',
    `1. Nel record \`_dmarc.frontaliereticino.ch\` (DNS Cloudflare) cambia \`${cfg.from}\` in \`${cfg.to}\`.`,
    '2. Lascia girare 1–2 settimane: questo monitor continua a vegliare e ti',
    '   avvisa se qualcosa si rompe.',
    step === 'reject'
      ? '3. A `p=reject` stabile hai la protezione massima: non resta nessuno step.'
      : '3. Quando `p=quarantine` è stabile e pulito, il monitor ti dirà quando passare a `p=reject`.',
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
  let policy;
  try {
    zoneId = await resolveZoneId(token, ZONE_NAME, process.env.CF_ZONE_ID);
    rows = await fetchSources(token, zoneId, since);
    policy = await fetchCurrentPolicy(token, zoneId);
  } catch (err) {
    // Reporter, not a gate: a Cloudflare/GraphQL hiccup must not fail the run.
    console.error(`DMARC fetch failed (non-fatal): ${err.message}`);
    return;
  }

  const a = analyze(rows);
  const step = nextEnforcementStep(policy, a);

  if (opts.json) {
    console.log(JSON.stringify({ since, days: opts.days, policy, step, ...a }, null, 2));
  } else {
    console.log(`DMARC sources since ${since} (${opts.days}d) — current policy: p=${policy ?? 'unknown'}:`);
    console.log(`  total=${a.total} pass=${a.totalPass} (${pct(a.totalPass, a.total)}) fail=${a.totalFail} (${pct(a.totalFail, a.total)})`);
    for (const s of a.sources) {
      console.log(`  • ${s.org} [${s.known ? 'known' : 'UNKNOWN'}] msg=${s.total} fail=${s.fail} pass=${pct(s.pass, s.total)}`);
    }
    console.log(a.failingSources.length ? `  → ${a.failingSources.length} failing source(s)` : '  → no failing sources');
    console.log(step ? `  → READY to advance: p=${policy} → p=${step}` : (a.ready ? '  → ready, but no further step (fully protected / policy unknown)' : '  → not flagged ready'));
  }

  if (a.total === 0) {
    console.log('No DMARC data in window — nothing to report.');
    return;
  }

  const action = a.failingSources.length ? 'fail' : (step ? `ready:${step}` : null);

  if (opts.dryRun) {
    console.log(`[dry-run] would open issue: ${action ?? 'none'}`);
    return;
  }

  if (a.failingSources.length) {
    createIssue({
      title: FAIL_ISSUE_TITLE,
      description: buildFailBody(a, opts.days, since, policy),
      priority: 2,
    });
  } else if (step) {
    createIssue({
      title: step === 'reject' ? READY_REJECT_TITLE : READY_QUARANTINE_TITLE,
      description: buildReadyBody(a, opts.days, since, step),
      priority: 4,
    });
  }
}

// Run only when invoked directly (not when imported by the test suite), so
// importing analyze()/isKnown()/nextEnforcementStep() never triggers a live
// Cloudflare call.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    // Last-resort guard: still exit 0 (reporter contract).
    console.error(`DMARC monitor unexpected error (non-fatal): ${err.stack || err.message}`);
  });
}
