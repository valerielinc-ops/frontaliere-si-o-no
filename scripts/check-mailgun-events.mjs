#!/usr/bin/env node
/**
 * check-mailgun-events.mjs — Poll Mailgun Events API for delivery tracking.
 *
 * Usage:
 *   node scripts/check-mailgun-events.mjs                  # last 50 events
 *   node scripts/check-mailgun-events.mjs --hours 24       # last 24 hours
 *   node scripts/check-mailgun-events.mjs --event delivered # filter by event type
 *   node scripts/check-mailgun-events.mjs --summary        # summary stats only
 *
 * Events tracked: accepted, delivered, failed, opened, clicked, unsubscribed, complained
 *
 * Environment:
 *   MAILGUN_API_KEY  — Mailgun API key (from RC or env)
 *   MAILGUN_DOMAIN   — Sending domain (default: frontaliereticino.ch)
 */

const DOMAIN = process.env.MAILGUN_DOMAIN || 'frontaliereticino.ch';
const API_KEY = process.env.MAILGUN_API_KEY;
const BASE_URL = `https://api.eu.mailgun.net/v3/${DOMAIN}/events`;

if (!API_KEY) {
  console.error('❌ MAILGUN_API_KEY not set. Run: source <(node scripts/load-rc-env.mjs)');
  process.exit(1);
}

const auth = Buffer.from(`api:${API_KEY}`).toString('base64');

// ── Parse CLI args ───────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(flag, defaultVal) {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : defaultVal;
}
const hours = parseInt(getArg('--hours', '48'), 10);
const eventFilter = getArg('--event', '');
const summaryOnly = args.includes('--summary');
const limit = parseInt(getArg('--limit', '100'), 10);

// ── Fetch events ─────────────────────────────────────────────

async function fetchEvents() {
  const since = new Date(Date.now() - hours * 3600 * 1000).toUTCString();
  const params = new URLSearchParams({ limit: String(limit), begin: since, ascending: 'no' });
  if (eventFilter) params.set('event', eventFilter);

  const res = await fetch(`${BASE_URL}?${params}`, {
    headers: { Authorization: `Basic ${auth}` },
  });

  if (!res.ok) {
    console.error(`❌ Mailgun API ${res.status}: ${await res.text()}`);
    process.exit(1);
  }

  return res.json();
}

// ── Format output ────────────────────────────────────────────

const EVENT_ICONS = {
  accepted: '📨',
  delivered: '✅',
  failed: '❌',
  opened: '👁️',
  clicked: '🔗',
  unsubscribed: '🚫',
  complained: '⚠️',
  stored: '📦',
  rejected: '🛑',
};

function formatEvent(evt) {
  const time = new Date(evt.timestamp * 1000).toISOString().replace('T', ' ').slice(0, 19);
  const icon = EVENT_ICONS[evt.event] || '•';
  const recipient = evt.recipient || '';
  const subject = evt.message?.headers?.subject?.slice(0, 60) || '';
  const severity = evt.severity ? ` [${evt.severity}]` : '';
  const reason = evt['delivery-status']?.description?.slice(0, 80) || '';
  return `${time}  ${icon} ${evt.event.padEnd(12)}  ${recipient.padEnd(30)}  ${subject}${severity}${reason ? '\n' + ' '.repeat(22) + '↳ ' + reason : ''}`;
}

function printSummary(events) {
  const counts = {};
  const recipients = new Set();
  for (const evt of events) {
    counts[evt.event] = (counts[evt.event] || 0) + 1;
    if (evt.recipient) recipients.add(evt.recipient);
  }

  console.log(`\n📊 Mailgun Events Summary (last ${hours}h)`);
  console.log('─'.repeat(50));
  for (const [event, count] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    const icon = EVENT_ICONS[event] || '•';
    console.log(`  ${icon} ${event.padEnd(15)} ${count}`);
  }
  console.log('─'.repeat(50));
  console.log(`  Total events:     ${events.length}`);
  console.log(`  Unique recipients: ${recipients.size}`);

  // Delivery rate
  const delivered = counts.delivered || 0;
  const accepted = counts.accepted || 0;
  const failed = counts.failed || 0;
  if (accepted > 0) {
    const rate = ((delivered / accepted) * 100).toFixed(1);
    console.log(`  Delivery rate:    ${rate}% (${delivered}/${accepted})`);
  }
  if (failed > 0) {
    console.log(`  ⚠️  Failed:        ${failed} emails`);
  }
  const opened = counts.opened || 0;
  if (delivered > 0 && opened > 0) {
    console.log(`  Open rate:        ${((opened / delivered) * 100).toFixed(1)}%`);
  }
  console.log('');
}

// ── Main ─────────────────────────────────────────────────────

const data = await fetchEvents();
const events = data.items || [];

if (events.length === 0) {
  console.log(`📭 No events in the last ${hours} hours.`);
  process.exit(0);
}

if (summaryOnly) {
  printSummary(events);
} else {
  console.log(`\n📬 Mailgun Events (last ${hours}h, ${events.length} events)\n`);
  for (const evt of events) {
    console.log(formatEvent(evt));
  }
  printSummary(events);
}
