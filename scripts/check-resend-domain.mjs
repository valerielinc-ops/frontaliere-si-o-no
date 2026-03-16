#!/usr/bin/env node

/**
 * Verifica readiness Resend per la newsletter:
 * - stato dominio su Resend API
 * - presenza record DNS TXT resend-domain-verification
 *
 * Uso:
 *   RESEND_API_KEY=... NEWSLETTER_FROM="Frontaliere Ticino <newsletter@frontaliereticino.ch>" node scripts/check-resend-domain.mjs
 */

import dns from 'node:dns/promises';

const from = process.env.NEWSLETTER_FROM || 'Frontaliere Ticino <newsletter@frontaliereticino.ch>';
const apiKey = process.env.RESEND_API_KEY;
const fromAddress = (from.match(/<([^>]+)>/)?.[1] || from).toLowerCase();
const domain = fromAddress.split('@')[1] || '';

async function getResendDomainStatus() {
  if (!apiKey) return { ok: false, reason: 'RESEND_API_KEY mancante' };
  const res = await fetch('https://api.resend.com/domains', {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    return { ok: false, reason: `Resend API ${res.status}` };
  }
  const payload = await res.json();
  const item = (payload?.data || []).find((d) => String(d.name || '').toLowerCase() === domain);
  if (!item) return { ok: false, reason: `Dominio ${domain} non trovato su Resend` };
  return { ok: item.status === 'verified', status: item.status || 'unknown', region: item.region || null };
}

async function getTxtRecords() {
  try {
    const records = await dns.resolveTxt(domain);
    return records.map((row) => row.join(''));
  } catch {
    return [];
  }
}

async function main() {
  if (!domain) {
    console.error('❌ NEWSLETTER_FROM non contiene un dominio valido.');
    process.exit(1);
  }

  console.log(`📮 Sender: ${fromAddress}`);
  console.log(`🌐 Domain: ${domain}`);

  const [resend, txtRecords] = await Promise.all([getResendDomainStatus(), getTxtRecords()]);
  const hasResendTxt = txtRecords.some((r) => r.includes('resend-domain-verification='));

  console.log('\nResend status:');
  if ('status' in resend) {
    console.log(`- verified: ${resend.ok ? 'yes' : 'no'}`);
    console.log(`- status: ${resend.status}`);
    if (resend.region) console.log(`- region: ${resend.region}`);
  } else {
    console.log(`- error: ${resend.reason}`);
  }

  console.log('\nDNS TXT check:');
  console.log(`- resend-domain-verification present: ${hasResendTxt ? 'yes' : 'no'}`);
  if (!hasResendTxt) {
    console.log('- aggiungi TXT richiesto da Resend nel DNS di frontaliereticino.ch');
  }

  if (!resend.ok || !hasResendTxt) {
    console.log('\n⚠️ Dominio non pronto per invio production.');
    process.exitCode = 1;
  } else {
    console.log('\n✅ Dominio pronto per invio production.');
  }
}

main().catch((err) => {
  console.error('❌', err?.message || err);
  process.exit(1);
});
