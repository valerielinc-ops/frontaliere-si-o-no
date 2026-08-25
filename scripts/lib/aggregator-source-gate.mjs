#!/usr/bin/env node
/**
 * Aggregator-source gate — the check behind
 * `tests/aggregator-sourced-crawler-gate.test.ts`.
 *
 * A dedicated crawler that sources its data (and therefore the `url`/
 * `applyUrl` it publishes) from a shared client backed by a known job-board
 * aggregator (see `known-aggregator-domains.mjs`) is not automatically
 * wrong — an employer may genuinely have chosen that aggregator as its own
 * outsourced application channel — but it must never be silent. Left
 * unchecked, this is exactly how a dedicated crawler ends up sending our
 * traffic to a competing job board instead of the employer directly, while
 * every existing quality gate (parser health, structured-data validation,
 * job-content plausibility) stays green, because the DATA is genuine — only
 * the DESTINATION is wrong.
 *
 * This scans every `*-job-parser.mjs` for such an import and requires one of
 * three explicit, evidence-bearing tags in the file:
 *
 *   @outsourced-ats-confirmed: <evidence>
 *     Checked against the employer's own site: no independent direct
 *     listing exists, or the employer explicitly delegates to this board.
 *   @outsourced-ats-needs-migration: <evidence>
 *     Checked against the employer's own site: a direct or better-outsourced
 *     source DOES exist. Open debt — the crawler should move off the
 *     aggregator.
 *   @outsourced-ats-needs-verification: <reason>
 *     Not yet checked (e.g. the employer's site blocks automated fetches).
 *
 * All three satisfy the gate — the point is disclosure, not instant
 * perfection — but the latter two are open debt, meant to be grepped by a
 * follow-up audit/issue rather than left to rot as an undocumented
 * shortcut. An unmarked import is the one state the gate refuses.
 */
import fs from 'node:fs';
import path from 'node:path';
import { AGGREGATOR_BACKED_SHARED_CLIENTS } from './known-aggregator-domains.mjs';

const IMPORT_RX = /from\s+['"]\.\/([^'"]+\.mjs)['"]/g;
const TAG_RX = /@outsourced-ats-(confirmed|needs-migration|needs-verification)\s*:\s*(\S.*)$/m;

/**
 * Aggregator-backed shared clients this source file imports (relative
 * imports only — these are same-directory sibling modules, never a package).
 *
 * @param {string} source
 * @returns {string[]} basenames, e.g. ['jobs-ch-search-common.mjs']
 */
export function aggregatorClientsImportedBy(source = '') {
  const hits = new Set();
  let m;
  IMPORT_RX.lastIndex = 0;
  while ((m = IMPORT_RX.exec(source))) {
    if (AGGREGATOR_BACKED_SHARED_CLIENTS.has(m[1])) hits.add(m[1]);
  }
  return [...hits];
}

/**
 * @param {string} source
 * @returns {{ tag: 'confirmed'|'needs-migration'|'needs-verification', evidence: string } | null}
 */
export function outsourcedAtsTag(source = '') {
  const m = TAG_RX.exec(source);
  return m ? { tag: m[1], evidence: m[2].trim() } : null;
}

/**
 * @param {string} dir directory to scan, e.g. `scripts/lib`
 * @returns {{ file: string, clients: string[], tag: ReturnType<typeof outsourcedAtsTag> }[]}
 */
export function scanJobParsers(dir) {
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!/-job-parser\.mjs$/.test(f)) continue;
    const source = fs.readFileSync(path.join(dir, f), 'utf8');
    const clients = aggregatorClientsImportedBy(source);
    if (!clients.length) continue;
    out.push({ file: f, clients, tag: outsourcedAtsTag(source) });
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}
