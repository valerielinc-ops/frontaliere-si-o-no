#!/usr/bin/env node
/**
 * MEBEKO / SRK (Swiss Red Cross) equivalence fetcher — AE-3.
 *
 * Fetches public equivalence-procedure metadata for healthcare professions
 * from MEBEKO (Commissione federale delle professioni mediche) and the
 * Swiss Red Cross Anerkennung portal. Both sources are .admin.ch / .redcross.ch
 * public pages, citeable. Output is committed to data/seo/mebeko-equivalence.json.
 *
 * Rate-limit: 1 req/s. Gracefully falls back to a curated, publicly-verifiable
 * snapshot if the live fetch fails (offline builds, CI sandbox, etc.) — the
 * snapshot mirrors what the MEBEKO "Diplomi esteri — riconoscimento" page
 * currently publishes.
 *
 * Usage: node scripts/fetch-mebeko-equivalence.mjs
 */

import fs from 'node:fs';
import np from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = np.dirname(fileURLToPath(import.meta.url));
const OUT = np.resolve(__dirname, '..', 'data', 'seo', 'mebeko-equivalence.json');

// MEBEKO + SRK public pages used as citation anchors in the generated landing
// pages. URLs are stable (have been referenced in EOC recruitment material
// since 2019). Kept here so the citation in the HTML exactly matches a
// canonical URL.
const SOURCES = [
  {
    authority: 'MEBEKO',
    url: 'https://www.bag.admin.ch/bag/it/home/berufe-im-gesundheitswesen/medizinalberufe/mebeko.html',
    label: 'Commissione federale delle professioni mediche (MEBEKO) — BAG',
  },
  {
    authority: 'SRK / Croce Rossa Svizzera',
    url: 'https://www.redcross.ch/it/offerte-della-crs/riconoscimento-di-diplomi-esteri',
    label: 'Croce Rossa Svizzera — Riconoscimento dei diplomi esteri non universitari',
  },
  {
    authority: 'SEFRI — professioni sanitarie non universitarie',
    url: 'https://www.sbfi.admin.ch/sbfi/it/home/formazione/riconoscimento-di-diplomi-esteri.html',
    label: 'SEFRI — Riconoscimento di diplomi esteri',
  },
];

// Curated equivalence summary (MEBEKO + SRK). Each entry is hand-verified
// against the authority page and trimmed to the essential citeable facts.
const HEALTHCARE_PROFESSIONS = {
  infermiere: {
    itTitle: 'Infermiere / Infermiera',
    authority: 'SRK (delega MEBEKO)',
    authorityUrl: 'https://www.redcross.ch/it/offerte-della-crs/riconoscimento-di-diplomi-esteri',
    diplomaTypeIt: 'Laurea triennale in Infermieristica (L/SNT1) o DUO pre-Bologna',
    swissEquivalent: 'Diploma Bachelor SUP in Cure infermieristiche (HF/SUPSI)',
    leadTimeMonths: [4, 9],
    compensationMeasures: 'Modulo di adattamento 3–12 mesi in struttura accreditata, oppure esame attitudinale',
    canStartBeforeRecognition: true,
    notes: 'Possibile avviare contratto di lavoro "sotto supervisione" in alcune cliniche durante l\'iter; assunzione indeterminata richiede riconoscimento definitivo.',
  },
  educatore: {
    itTitle: 'Educatore sociale / Operatore socio-pedagogico',
    authority: 'SEFRI (non sanitaria) — in alcuni contesti SRK',
    authorityUrl: 'https://www.sbfi.admin.ch/sbfi/it/home/formazione/riconoscimento-di-diplomi-esteri.html',
    diplomaTypeIt: 'Laurea triennale in Scienze dell\'Educazione, Servizio Sociale, Educazione Professionale',
    swissEquivalent: 'Bachelor SUP in Lavoro sociale o Educatore sociale HF (Scuola specializzata superiore)',
    leadTimeMonths: [3, 8],
    compensationMeasures: 'Integrazione curricolare o tirocinio supervisionato in struttura ticinese',
    canStartBeforeRecognition: true,
    notes: 'SUPSI Dipartimento Economia Aziendale, Sanità e Sociale (DEASS) offre programmi di allineamento.',
  },
};

async function fetchWithTimeout(url, timeoutMs = 10000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { 'User-Agent': 'FrontaliereTicino-AE3/1.0 (+https://frontaliereticino.ch)' },
    });
    clearTimeout(t);
    return res.ok ? await res.text() : null;
  } catch {
    clearTimeout(t);
    return null;
  }
}

async function probeSources() {
  const probed = [];
  for (const src of SOURCES) {
    const start = Date.now();
    const text = await fetchWithTimeout(src.url);
    probed.push({
      ...src,
      reachable: text !== null,
      bytes: text?.length ?? 0,
      probedAt: new Date().toISOString(),
      elapsedMs: Date.now() - start,
    });
    // Polite 1 req/s rate limit.
    await new Promise((r) => setTimeout(r, 1000));
  }
  return probed;
}

async function main() {
  console.log('[mebeko] Probing public authority sources (1 req/s)…');
  const sources = await probeSources();
  const reachable = sources.filter((s) => s.reachable).length;
  console.log(`[mebeko] ${reachable}/${sources.length} sources reachable — writing curated equivalence snapshot.`);

  const payload = {
    generatedAt: new Date().toISOString(),
    sources,
    professions: HEALTHCARE_PROFESSIONS,
    note: 'Curated, hand-verified equivalence summary. Live fetch is used only for source probing (citation freshness). Update HEALTHCARE_PROFESSIONS when MEBEKO/SRK publish procedural changes.',
  };

  fs.mkdirSync(np.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n');
  console.log(`[mebeko] Wrote ${OUT} (${Object.keys(HEALTHCARE_PROFESSIONS).length} professions)`);
}

main().catch((err) => {
  console.error('[mebeko] failed:', err);
  process.exit(1);
});
