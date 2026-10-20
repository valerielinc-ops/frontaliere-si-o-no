/**
 * swiss-pension-sources.mjs — parser puri delle fonti ufficiali per i
 * parametri previdenziali svizzeri (pipeline D11 «pensioni»).
 *
 * PERCHE' QUESTE FONTI E NON ALTRE
 * ────────────────────────────────
 * Le pagine UFAS/BSV su admin.ch che riassumono «le cifre dell'anno» non sono
 * un formato stabile (cambiano struttura a ogni rifacimento) e www.bsv.admin.ch
 * non pubblica i parametri come dati aperti. I promemoria ufficiali AVS/AI
 * (Centro d'informazione AVS/AI, ahv-iv.ch, editi con l'UFAS) invece:
 *   - hanno URL permanenti per numero (`/p/3.01.d` = rendite di vecchiaia,
 *     `/p/2.01.d` = contributi salariali, `/p/2.08.d` = contributi AD);
 *   - riportano in copertina «Stand am 1. Januar <anno>», cioe' DICHIARANO
 *     l'anno per cui valgono, che e' esattamente cio' che serve per non
 *     pubblicare cifre scadute;
 *   - robots.txt di ahv-iv.ch non vieta /p/ (vieta login, sitemap, tabid).
 * Le soglie LPP e i massimali 3a non si leggono da un documento: sono
 * definiti DALLA LEGGE come multipli della rendita AVS massima (art. 2, 7, 8
 * e 46 LPP; art. 5 OPP2; art. 7 OPP3), quindi si derivano dalla rendita
 * massima appena letta. Il massimale 3a derivato si confronta poi con quello
 * scritto da UFAS (www.bsv.admin.ch/it/contributi-al-pilastro-3a): se le due
 * strade non danno lo stesso numero, il dataset si rifiuta.
 *
 * Nessuna funzione qui fa rete: ricevono testo e restituiscono numeri, cosi'
 * sono testabili su estratti veri dei documenti.
 */

export const AHV_IV_LEAFLET_BASE = 'https://www.ahv-iv.ch/p';
export const AHV_IV_LEAFLETS = Object.freeze({
  oldAgePensions: `${AHV_IV_LEAFLET_BASE}/3.01.d`,
  salaryContributions: `${AHV_IV_LEAFLET_BASE}/2.01.d`,
  unemploymentContributions: `${AHV_IV_LEAFLET_BASE}/2.08.d`,
});
export const AHV_IV_CANTONAL_FUNDS_URL = 'https://www.ahv-iv.ch/de/Kontakte/Kantonale-Ausgleichskassen';
export const BSV_PILLAR_3A_URL = 'https://www.bsv.admin.ch/it/contributi-al-pilastro-3a';
export const BSV_OCCUPATIONAL_PENSION_URL = 'https://www.bsv.admin.ch/de/altersvorsorge-beruflichen-vorsorge';
export const FEDLEX_BVG_URL = 'https://www.fedlex.admin.ch/eli/cc/1983/797_797_797/it';

/** Spazi tipografici (sottile, non separabile) e trattini dei PDF → ASCII. */
export function normalizeText(text) {
  return String(text)
    .replace(/[    ]/g, ' ')
    .replace(/[–—]/g, '–')
    .replace(/[ \t]+/g, ' ');
}

/** Numero svizzero «1 260», «148 200», «7'258», «36’288» → 1260 ecc. */
export function parseSwissInteger(raw) {
  const digits = String(raw).replace(/[\s'’.]/g, '');
  return /^\d+$/.test(digits) ? Number(digits) : NaN;
}

/** Percentuale «10,6» / «1.25» → 10.6 / 1.25. */
export function parsePercent(raw) {
  const n = Number(String(raw).replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
}

/** «Stand am 1. Januar 2026» → 2026 (anno per cui il promemoria vale). */
export function parseLeafletStandYear(text) {
  const m = /Stand am 1\. Januar (\d{4})/.exec(normalizeText(text));
  return m ? Number(m[1]) : null;
}

/**
 * Promemoria 3.01 «Altersrenten und Hilflosenentschädigungen der AHV»: riga
 * «Altersrente 1 260.– 2 520.–» della tabella «Rentenansätze» (minima e
 * massima mensile a scala completa).
 */
export function parseOldAgePensionLeaflet(text) {
  const t = normalizeText(text);
  const standYear = parseLeafletStandYear(t);
  const m = /Altersrente\s+(\d{1,2} ?\d{3})\.–\s+(\d{1,2} ?\d{3})\.–/.exec(t);
  if (!m) throw new Error('promemoria 3.01: riga «Altersrente <min>.– <max>.–» non trovata');
  const minMonthly = parseSwissInteger(m[1]);
  const maxMonthly = parseSwissInteger(m[2]);
  if (!(minMonthly > 0) || maxMonthly !== minMonthly * 2) {
    // Art. 34 cpv. 3 LAVS: la massima e' il doppio della minima. Un parse che
    // non lo rispetta ha letto la riga sbagliata.
    throw new Error(`promemoria 3.01: rendite incoerenti min=${minMonthly} max=${maxMonthly}`);
  }
  return { standYear, minMonthly, maxMonthly };
}

/**
 * Promemoria 2.01 «Lohnbeiträge an die AHV, die IV und die EO»: tabella
 * «AHV 8,7 % / IV 1,4 % / EO 0,5 % / Total 10,6 %» e quota «5,3 %» a carico
 * del lavoratore.
 */
export function parseSalaryContributionsLeaflet(text) {
  const t = normalizeText(text);
  const standYear = parseLeafletStandYear(t);
  const pick = (label) => {
    const m = new RegExp(`(?:^|\\n)\\s*${label}\\s+(\\d+,\\d+) ?%`).exec(t);
    return m ? parsePercent(m[1]) : NaN;
  };
  const avs = pick('AHV');
  const ai = pick('IV');
  const apg = pick('EO');
  const total = pick('Total');
  if (![avs, ai, apg, total].every(Number.isFinite)) {
    throw new Error('promemoria 2.01: tabella AHV/IV/EO/Total non trovata');
  }
  if (Math.abs(avs + ai + apg - total) > 1e-9) {
    throw new Error(`promemoria 2.01: AHV ${avs} + IV ${ai} + EO ${apg} != Total ${total}`);
  }
  return { standYear, avsPct: avs, aiPct: ai, apgPct: apg, totalPct: total, employeePct: Math.round((total / 2) * 1000) / 1000 };
}

/**
 * Promemoria 2.08 «Beiträge an die Arbeitslosenversicherung»: «Bis zu einem
 * jährlichen Höchstbetrag von 148 200 Franken beträgt der Beitragssatz an die
 * ALV 2,2 %».
 */
export function parseUnemploymentLeaflet(text) {
  const t = normalizeText(text).replace(/\s*\n\s*/g, ' ').replace(/ -\s/g, '');
  const standYear = parseLeafletStandYear(t);
  const m = /Höchstbetrag von (\d{2,3} \d{3}) Franken beträgt der Beitragssatz an die ALV (\d+,\d+) ?%/.exec(t);
  if (!m) throw new Error('promemoria 2.08: frase sul massimale ALV non trovata');
  const totalPct = parsePercent(m[2]);
  return { standYear, salaryCapCHF: parseSwissInteger(m[1]), totalPct, employeePct: Math.round((totalPct / 2) * 1000) / 1000 };
}

/** Pagina UFAS sul pilastro 3a: «massimo di 7258 franchi … massimo di 36 288 franchi». */
export function parsePillar3aPage(html) {
  const t = normalizeText(stripTags(html));
  const m = /massimo di ([\d '’]+?) franchi all.anno se si è salariati[\s\S]*?massimo di ([\d '’]+?) franchi all.anno/.exec(t);
  if (!m) throw new Error('pagina UFAS 3a: massimali non trovati');
  return { withLpp: parseSwissInteger(m[1]), withoutLpp: parseSwissInteger(m[2]) };
}

/** Pagina UFAS sulla previdenza professionale: «Zinses von mindestens 1,25 % ab 2024». */
export function parseMinimumInterestPage(html) {
  const t = normalizeText(stripTags(html));
  const m = /Zinses von mindestens (\d+,\d+) ?% ab (\d{4})/.exec(t);
  if (!m) throw new Error('pagina UFAS LPP: tasso d\'interesse minimo non trovato');
  return { ratePct: parsePercent(m[1]), since: Number(m[2]) };
}

/**
 * Pagina ahv-iv.ch «Kantonale Ausgleichskassen»: un blocco per cassa con
 * «Nr. <n><br>Kanton: <XX><br><br> <Nome><br>…» e «Webseite: <a href=…>».
 */
export function parseCantonalCompensationFunds(html) {
  const out = {};
  const blocks = String(html).split('class="co-address-content');
  for (const block of blocks.slice(1)) {
    const head = /Nr\.\s*(\d+)<br>\s*Kanton:\s*([A-Z]{2})<br>\s*<br>\s*([^<]+?)\s*<br>/.exec(block);
    if (!head) continue;
    const code = head[2];
    if (out[code]) continue;
    // Di norma la riga «Webseite:»; alcune schede (NE) hanno una tabella
    // impaginata a mano senza quella riga: si ripiega sul link esterno piu'
    // corto del blocco (la home, non la pagina «Kontakt»).
    const web = /Webseite:<\/td>\s*<td[^>]*>\s*<a href="([^"]+)"/.exec(block);
    const external = [...block.matchAll(/<a href="(https?:\/\/[^"]+)"/g)]
      .map((m) => m[1].trim())
      .filter((u) => !/ahv-iv\.ch|cdn-cgi/.test(u))
      .sort((a, b) => a.length - b.length);
    const url = web ? web[1].trim() : external[0] || null;
    out[code] = {
      number: Number(head[1]),
      name: decodeEntities(head[3]).replace(/\s+/g, ' ').trim(),
      url: url ? url.replace(/^http:\/\//, 'https://') : null,
    };
  }
  return out;
}

function stripTags(html) {
  return decodeEntities(
    String(html)
      .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ')
      .replace(/<[^>]+>/g, ' '),
  );
}

function decodeEntities(s) {
  return String(s)
    .replace(/&uuml;/g, 'ü')
    .replace(/&ouml;/g, 'ö')
    .replace(/&auml;/g, 'ä')
    .replace(/&egrave;/g, 'è')
    .replace(/&eacute;/g, 'é')
    .replace(/&rsquo;/g, '’')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

/**
 * Soglie LPP e massimali 3a derivati per legge dalla rendita AVS massima
 * annua (R = 12 × massima mensile):
 *   soglia d'entrata 3/4 R (art. 2 e 7 LPP), deduzione di coordinamento 7/8 R
 *   (art. 8 cpv. 1), salario coordinato minimo 1/8 R (art. 8 cpv. 2),
 *   limite superiore 3 R (art. 8 cpv. 1 e art. 46), 3a con LPP 8% di 3 R,
 *   3a senza LPP 40% di 3 R (art. 7 cpv. 1 OPP3), arrotondati al franco.
 */
export function deriveOccupationalLimits(avsMaxMonthly) {
  const annual = avsMaxMonthly * 12;
  const upper = annual * 3;
  return {
    avsMaxAnnual: annual,
    lppEntryThreshold: Math.round((annual * 3) / 4),
    lppCoordinationDeduction: Math.round((annual * 7) / 8),
    lppMinCoordinatedSalary: Math.round(annual / 8),
    lppMaxInsuredSalary: upper,
    pillar3aMaxWithLpp: Math.round(upper * 0.08),
    pillar3aMaxWithoutLpp: Math.round(upper * 0.4),
  };
}

/**
 * Casse pensioni pubbliche dei cantoni (dipendenti cantonali). Nessuna fonte
 * federale le elenca: lista curata, ogni URL aperto e verificato a mano il
 * 2026-10-05 (titolo della home page = nome della cassa), in parte gia'
 * classificate nelle fonti cantonali P5. `null` dove non e' stata verificata
 * una cassa cantonale autonoma: meglio un vuoto dichiarato che un nome
 * inventato.
 */
export const CANTONAL_PUBLIC_PENSION_FUNDS_VERIFIED_AT = '2026-10-05';
export const CANTONAL_PUBLIC_PENSION_FUNDS = Object.freeze({
  AG: { name: 'Aargauische Pensionskasse (APK)', url: 'https://www.apk.ch/' },
  AI: null,
  AR: { name: 'Pensionskasse Appenzell Ausserrhoden (PKAR)', url: 'https://www.pkar.ch/' },
  BE: { name: 'Bernische Pensionskasse (BPK)', url: 'https://bpk.ch/' },
  BL: { name: 'Basellandschaftliche Pensionskasse (BLPK)', url: 'https://www.blpk.ch/' },
  BS: { name: 'Pensionskasse Basel-Stadt (PKBS)', url: 'https://www.pkbs.ch/de/' },
  FR: { name: "Caisse de prévoyance de l'Etat de Fribourg (CPEF)", url: 'https://www.cpef.ch/' },
  GE: { name: "Caisse de prévoyance de l'Etat de Genève (CPEG)", url: 'https://www.cpeg.ch/' },
  GL: { name: 'Glarner Pensionskasse', url: 'https://glpk.ch/' },
  GR: { name: 'Pensionskasse Graubünden (PKGR)', url: 'https://www.pkgr.ch/' },
  JU: { name: 'Caisse de pensions de la République et Canton du Jura (CPJU)', url: 'https://www.cpju.ch/' },
  LU: { name: 'Luzerner Pensionskasse (LUPK)', url: 'https://www.lupk.ch/' },
  NE: { name: "Caisse de pensions de l'Etat de Neuchâtel (CPCN)", url: 'https://cpcn.ch/' },
  NW: { name: 'Pensionskasse Nidwalden', url: 'https://www.pknw.ch/' },
  OW: null,
  SG: { name: 'St.Galler Pensionskasse (SGPK)', url: 'https://sgpk.ch/' },
  SH: { name: 'Pensionskasse Schaffhausen (PKSH)', url: 'https://www.pksh.ch/' },
  SO: { name: 'Pensionskasse Kanton Solothurn (PKSO)', url: 'https://pkso.ch/' },
  SZ: { name: 'Pensionskasse des Kantons Schwyz (PKSZ)', url: 'https://pksz.ch/' },
  TG: { name: 'Pensionskasse Thurgau (PKTG)', url: 'https://pktg.ch/' },
  TI: { name: 'Istituto di previdenza del Cantone Ticino (IPCT)', url: 'https://www.ipct.ch/' },
  UR: { name: 'Pensionskasse Uri', url: 'https://www.pkuri.ch/' },
  VD: { name: "Caisse de pensions de l'Etat de Vaud (CPEV)", url: 'https://www.cpev.ch/' },
  VS: { name: 'Caisse de prévoyance du Canton du Valais (CPVAL)', url: 'https://cpval.ch/' },
  ZG: { name: 'Zuger Pensionskasse', url: 'https://www.zugerpk.ch/' },
  ZH: { name: 'BVK Personalvorsorge des Kantons Zürich', url: 'https://bvk.ch/de/' },
});
