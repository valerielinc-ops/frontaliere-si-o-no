#!/usr/bin/env node
/**
 * cf-status-report.mjs — Cloudflare edge status-code report by page.
 *
 * Answers "which pages went 3xx / 4xx / 5xx" by querying the Cloudflare
 * GraphQL Analytics API (dataset `httpRequestsAdaptiveGroups`) for the
 * frontaliereticino.ch zone. Free-plan friendly: no Logpush, no paid
 * features — just the always-on adaptive analytics every zone has.
 *
 * Two queries per run:
 *   1. SUMMARY — group by edgeResponseStatus only → exact count per status
 *      code (path dimension would cap rows and truncate totals).
 *   2. DETAIL  — top-N (status, host, path) rows for every non-2xx status,
 *      so you see the actual offending URLs.
 *
 * Covers the WHOLE zone, not just the locale Worker: the IT bulk passes
 * through Cloudflare untouched (no Worker), so only zone-level adaptive
 * analytics sees its status codes. The /en /de /fr shard pages handled by
 * `frontaliere-locale-router` show up here too (look for 5xx = Worker
 * upstream timeouts to the origin-{loc} GitHub Pages shards).
 *
 * ─── Auth ────────────────────────────────────────────────────────────────
 *   Needs CF_API_TOKEN (scope: Zone → Analytics → Read on the zone).
 *   Already stored in Firebase Remote Config, so locally:
 *
 *     eval "$(GOOGLE_APPLICATION_CREDENTIALS=mcp-gsc-main/service_account_credentials.json \
 *       node scripts/load-rc-env.mjs)" && node scripts/cf-status-report.mjs
 *
 *   In CI: run `node scripts/load-rc-env.mjs` first (populates $GITHUB_ENV).
 *   CF_ZONE_ID is optional — resolved from the zone name via the REST API
 *   when absent.
 *
 * ─── Free-plan limits (baked in) ───────────────────────────────────────────
 *   • httpRequestsAdaptiveGroups accepts a time range of AT MOST 1 day per
 *     query → --hours is clamped to <24h with a small safety margin.
 *   • Retention on the free plan is short (~3 days). Older windows return
 *     empty; the script warns rather than failing silently.
 *
 * ─── Usage ─────────────────────────────────────────────────────────────────
 *   node scripts/cf-status-report.mjs                 # last 24h, all non-2xx
 *   node scripts/cf-status-report.mjs --hours=6       # last 6h
 *   node scripts/cf-status-report.mjs --min-status=400 # 4xx+5xx only (skip 3xx)
 *   node scripts/cf-status-report.mjs --class=5        # only 5xx
 *   node scripts/cf-status-report.mjs --host=frontaliereticino.ch
 *   node scripts/cf-status-report.mjs --limit=50       # rows per detail query
 *   node scripts/cf-status-report.mjs --json           # machine-readable
 *
 * Exit codes: 0 = ran OK (even if errors found — it's a report, not a gate);
 *             1 = bad config / API error.
 */

const GRAPHQL_ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql';
const REST_BASE = 'https://api.cloudflare.com/client/v4';
const ZONE_NAME = process.env.CF_ZONE_NAME || 'frontaliereticino.ch';
// Free plan hard-caps the adaptive-groups window at 1 day. Stay safely under
// it (clock skew once tripped "1d96ms > 1d") and leave headroom.
const MAX_HOURS = 23.9;

function parseArgs(argv) {
  const opts = {
    // Default just under the free-plan 1-day cap so the common no-arg run
    // doesn't emit the "clamped" note every time.
    hours: 23,
    minStatus: 300,
    statusClass: null, // 3 | 4 | 5
    host: null,
    limit: 30,
    json: false,
  };
  for (const arg of argv) {
    const m = arg.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    const [, key, val] = m;
    switch (key) {
      case 'hours': opts.hours = Number(val); break;
      case 'min-status': opts.minStatus = Number(val); break;
      case 'class': opts.statusClass = Number(val); break;
      case 'host': opts.host = val; break;
      case 'limit': opts.limit = Number(val); break;
      case 'json': opts.json = true; break;
      case 'help':
        console.log('See header comment for usage.');
        process.exit(0);
        break;
      default: break;
    }
  }
  return opts;
}

function bail(msg) {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

async function cfGraphQL(token, query, variables) {
  const res = await fetch(GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json().catch(() => null);
  if (!json) bail(`GraphQL returned non-JSON (HTTP ${res.status}).`);
  if (json.errors && json.errors.length) {
    bail(`GraphQL error: ${json.errors.map((e) => e.message).join('; ')}`);
  }
  return json.data;
}

async function resolveZoneId(token) {
  if (process.env.CF_ZONE_ID) return process.env.CF_ZONE_ID;
  const res = await fetch(
    `${REST_BASE}/zones?name=${encodeURIComponent(ZONE_NAME)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const json = await res.json().catch(() => null);
  if (!json || !json.success || !json.result?.length) {
    bail(`Could not resolve zone id for ${ZONE_NAME} (check token scope).`);
  }
  return json.result[0].id;
}

// Build the edgeResponseStatus filter from --min-status / --class.
function statusFilter(opts) {
  if (opts.statusClass) {
    const lo = opts.statusClass * 100;
    return { edgeResponseStatus_geq: lo, edgeResponseStatus_lt: lo + 100 };
  }
  return { edgeResponseStatus_geq: opts.minStatus };
}

const SUMMARY_QUERY = `
query($zone:String!,$since:Time!,$until:Time!,$filter:ZoneHttpRequestsAdaptiveGroupsFilter_InputObject){
  viewer{ zones(filter:{zoneTag:$zone}){
    httpRequestsAdaptiveGroups(limit:100,filter:$filter,orderBy:[count_DESC]){
      count dimensions{ edgeResponseStatus }
    }
  }}
}`;

const DETAIL_QUERY = `
query($zone:String!,$since:Time!,$until:Time!,$limit:Int!,$filter:ZoneHttpRequestsAdaptiveGroupsFilter_InputObject){
  viewer{ zones(filter:{zoneTag:$zone}){
    httpRequestsAdaptiveGroups(limit:$limit,filter:$filter,orderBy:[count_DESC]){
      count dimensions{ edgeResponseStatus clientRequestHTTPHost clientRequestPath }
    }
  }}
}`;

function classOf(status) {
  if (status >= 500) return '5xx';
  if (status >= 400) return '4xx';
  if (status >= 300) return '3xx';
  return '2xx';
}

const ICON = { '3xx': '↪', '4xx': '⚠', '5xx': '🔥', '2xx': '·' };

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const token = process.env.CF_API_TOKEN;
  if (!token) {
    bail(
      'CF_API_TOKEN not set. Run:\n' +
        '  eval "$(GOOGLE_APPLICATION_CREDENTIALS=mcp-gsc-main/service_account_credentials.json node scripts/load-rc-env.mjs)"\n' +
        'then re-run this script.',
    );
  }

  if (!Number.isFinite(opts.hours) || opts.hours <= 0) opts.hours = 24;
  let clampedNote = '';
  if (opts.hours > MAX_HOURS) {
    clampedNote = ` (clamped from ${opts.hours}h — free plan max 1 day/query)`;
    opts.hours = MAX_HOURS;
  }

  const until = new Date();
  const since = new Date(until.getTime() - opts.hours * 3600 * 1000);
  const sinceISO = since.toISOString();
  const untilISO = until.toISOString();

  const zoneId = await resolveZoneId(token);

  const baseFilter = {
    datetime_geq: sinceISO,
    datetime_leq: untilISO,
    ...statusFilter(opts),
  };
  if (opts.host) baseFilter.clientRequestHTTPHost = opts.host;

  const vars = { zone: zoneId, since: sinceISO, until: untilISO, filter: baseFilter };

  const [summaryData, detailData] = await Promise.all([
    cfGraphQL(token, SUMMARY_QUERY, vars),
    cfGraphQL(token, DETAIL_QUERY, { ...vars, limit: opts.limit }),
  ]);

  const summaryRows = summaryData.viewer.zones[0]?.httpRequestsAdaptiveGroups || [];
  const detailRows = detailData.viewer.zones[0]?.httpRequestsAdaptiveGroups || [];

  // Aggregate summary by status code and by class.
  const byStatus = new Map();
  const byClass = { '3xx': 0, '4xx': 0, '5xx': 0 };
  for (const r of summaryRows) {
    const s = r.dimensions.edgeResponseStatus;
    byStatus.set(s, (byStatus.get(s) || 0) + r.count);
    byClass[classOf(s)] = (byClass[classOf(s)] || 0) + r.count;
  }

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          zone: ZONE_NAME,
          window: { since: sinceISO, until: untilISO, hours: opts.hours },
          summaryByStatus: Object.fromEntries(byStatus),
          summaryByClass: byClass,
          detail: detailRows.map((r) => ({
            status: r.dimensions.edgeResponseStatus,
            url: r.dimensions.clientRequestHTTPHost + r.dimensions.clientRequestPath,
            count: r.count,
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  // ─── Human report ────────────────────────────────────────────────────────
  console.log(`\nCloudflare status report — ${ZONE_NAME}`);
  console.log(
    `Window: ${sinceISO} → ${untilISO} (${opts.hours}h)${clampedNote}`,
  );
  if (opts.host) console.log(`Host filter: ${opts.host}`);
  console.log(
    `Filter: ${opts.statusClass ? `${opts.statusClass}xx only` : `status >= ${opts.minStatus}`}`,
  );

  const total = byClass['3xx'] + byClass['4xx'] + byClass['5xx'];
  if (total === 0) {
    console.log(
      '\nNo matching requests in window. ' +
        'On the free plan adaptive analytics retains only ~3 days — older windows return empty.',
    );
    return;
  }

  console.log('\n── Summary by class ──');
  for (const cls of ['3xx', '4xx', '5xx']) {
    if (byClass[cls]) console.log(`  ${ICON[cls]} ${cls}  ${String(byClass[cls]).padStart(8)}`);
  }

  console.log('\n── By status code ──');
  [...byStatus.entries()]
    .sort((a, b) => b[1] - a[1])
    .forEach(([status, count]) =>
      console.log(`  ${ICON[classOf(status)]} ${status}  ${String(count).padStart(8)}`),
    );

  console.log(`\n── Top ${opts.limit} offending URLs ──`);
  console.log('  STATUS    COUNT  URL');
  for (const r of detailRows) {
    const s = r.dimensions.edgeResponseStatus;
    const url = r.dimensions.clientRequestHTTPHost + r.dimensions.clientRequestPath;
    console.log(
      `  ${ICON[classOf(s)]} ${String(s).padEnd(5)} ${String(r.count).padStart(7)}  ${url}`,
    );
  }
  console.log('');
}

main().catch((err) => bail(err?.message || String(err)));
