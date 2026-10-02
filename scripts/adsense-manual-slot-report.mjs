#!/usr/bin/env node
/** Read-only report. Load credentials with the workspace bin/rc-env.sh.
 * node scripts/adsense-manual-slot-report.mjs --start YYYY-MM-DD --end YYYY-MM-DD --json
 * Default: settled seven-day window; no tracked file is written. */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAdSenseToken, last7Days } from './revenue-monitor.mjs';
import { fetchManualSlotReport, renderManualSlotReport } from './lib/adsense-manual-slot-report.mjs';
import { AD_CLIENT } from '../services/adsenseSlots.ts';

export async function runManualSlotReport(args = process.argv.slice(2)) {
  const value = (name) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  const window = last7Days();
  const token = await getAdSenseToken();
  if (!token) throw new Error('AdSense credentials unavailable');
  const account = `accounts/${AD_CLIENT.replace(/^ca-/, '')}`;
  const response = await fetch(`https://adsense.googleapis.com/v2/${account}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`AdSense account HTTP ${response.status}`);
  const metadata = await response.json();
  return fetchManualSlotReport({ token, account, start: value('--start') || window.start, end: value('--end') || window.end, accountTimeZone: metadata.timeZone?.id || null });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runManualSlotReport().then((report) => console.log(process.argv.includes('--json') ? JSON.stringify(report, null, 2) : renderManualSlotReport(report))).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
