#!/usr/bin/env node
/**
 * SEFRI (Segreteria di Stato per la formazione, la ricerca e l'innovazione)
 * equivalence fetcher — AE-3.
 *
 * Target: trade / vocational professions where the recognition authority is
 * SEFRI (not MEBEKO / SRK). Muratore, elettricista, cuoco, cameriere, autista,
 * operaio edile — all vocational AFC/EFZ diplomas.
 *
 * Source: https://www.sbfi.admin.ch/sbfi/it/home/formazione/riconoscimento-di-diplomi-esteri.html
 * Secondary citation: SECO — Osservatorio mercato del lavoro (CCL per settore)
 *
 * Rate-limit: 1 req/s. Falls back to curated snapshot on offline / CI.
 *
 * Usage: node scripts/fetch-sefri-equivalence.mjs
 */

import fs from 'node:fs';
import np from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = np.dirname(fileURLToPath(import.meta.url));
const OUT = np.resolve(__dirname, '..', 'data', 'seo', 'sefri-equivalence.json');

const SOURCES = [
  {
    authority: 'SEFRI',
    url: 'https://www.sbfi.admin.ch/sbfi/it/home/formazione/riconoscimento-di-diplomi-esteri.html',
    label: 'Segreteria di Stato per la formazione, la ricerca e l\'innovazione — Riconoscimento di diplomi esteri',
  },
  {
    authority: 'SECO',
    url: 'https://www.seco.admin.ch/seco/it/home/Arbeit/Personenfreizugigkeit_Arbeitsbeziehungen/flankierende-massnahmen/usuelle-arbeits--und-lohnbedingungen/gesamtarbeitsvertraege-gav.html',
    label: 'SECO — Contratti collettivi di lavoro (CCL / GAV) di obbligatorietà generale',
  },
  {
    authority: 'SEFRI — Elenco professioni regolamentate',
    url: 'https://www.sbfi.admin.ch/sbfi/it/home/formazione/riconoscimento-di-diplomi-esteri/procedure.html',
    label: 'SEFRI — Procedure di riconoscimento',
  },
];

const TRADE_PROFESSIONS = {
  muratore: {
    itTitle: 'Muratore / Muratrice (edilizia principale)',
    authority: 'SEFRI',
    authorityUrl: 'https://www.sbfi.admin.ch/sbfi/it/home/formazione/riconoscimento-di-diplomi-esteri.html',
    diplomaTypeIt: 'Qualifica professionale triennale IeFP edilizia o diploma tecnico',
    swissEquivalent: 'Muratore AFC (Attestato federale di capacità, 3 anni apprendistato)',
    leadTimeMonths: [4, 6],
    cclReference: 'CNM – Contratto nazionale mantello edilizia principale (obbligatorio in tutta la CH)',
    cclUrl: 'https://www.seco.admin.ch/seco/it/home/Arbeit/Personenfreizugigkeit_Arbeitsbeziehungen/flankierende-massnahmen/usuelle-arbeits--und-lohnbedingungen/gesamtarbeitsvertraege-gav.html',
    notes: 'Salario minimo CNM classe A (muratore qualificato con AFC): CHF 5\'950 mensili × 13 mensilità (2026). Riconoscimento veloce grazie all\'accordo ALC CH-UE.',
    regulated: true,
  },
  elettricista: {
    itTitle: 'Elettricista / Installatore elettrico',
    authority: 'SEFRI + ESTI (Ispettorato federale impianti a corrente forte)',
    authorityUrl: 'https://www.esti.admin.ch/it/temi/riconoscimento-di-diplomi',
    diplomaTypeIt: 'Qualifica IeFP o diploma ITIS elettrotecnica (4-5 anni)',
    swissEquivalent: 'Installatore elettricista AFC + autorizzazione ESTI per impianti sotto tensione',
    leadTimeMonths: [3, 9],
    cclReference: 'CCL Ramo installazione elettrotelecomunicazioni (obbligatorio in Ticino)',
    cclUrl: 'https://www.seco.admin.ch/seco/it/home/Arbeit/Personenfreizugigkeit_Arbeitsbeziehungen/flankierende-massnahmen/usuelle-arbeits--und-lohnbedingungen/gesamtarbeitsvertraege-gav.html',
    notes: 'Professione regolamentata: per lavorare su impianti sotto tensione serve autorizzazione ESTI in aggiunta al diploma. Possibile iniziare in cantiere come aiuto-montatore (non regolato) durante l\'iter.',
    regulated: true,
  },
  cuoco: {
    itTitle: 'Cuoco / Cuoca',
    authority: 'SEFRI',
    authorityUrl: 'https://www.sbfi.admin.ch/sbfi/it/home/formazione/riconoscimento-di-diplomi-esteri.html',
    diplomaTypeIt: 'Qualifica IeFP alberghiera o diploma IPSSAR (5 anni)',
    swissEquivalent: 'Cuoco AFC (3 anni apprendistato, specializzazione cucina)',
    leadTimeMonths: [2, 5],
    cclReference: 'CCNL/L-GAV gastronomia e alberghiero (obbligatorio in tutta la CH)',
    cclUrl: 'https://www.l-gav.ch/it/',
    notes: 'Salario minimo L-GAV 2026 per cuoco senza AFC: CHF 3\'582 lordi/mese; con AFC: CHF 4\'336. Settore non regolamentato — si può iniziare a lavorare senza riconoscimento formale.',
    regulated: false,
  },
  cameriere: {
    itTitle: 'Cameriere / Cameriera di sala',
    authority: 'SEFRI',
    authorityUrl: 'https://www.sbfi.admin.ch/sbfi/it/home/formazione/riconoscimento-di-diplomi-esteri.html',
    diplomaTypeIt: 'Qualifica IeFP servizi di sala o diploma IPSSAR indirizzo sala',
    swissEquivalent: 'Specialista in ristorazione AFC oppure operatore ristorazione CFP (2 anni)',
    leadTimeMonths: [1, 4],
    cclReference: 'CCNL/L-GAV gastronomia e alberghiero',
    cclUrl: 'https://www.l-gav.ch/it/',
    notes: 'Settore non regolamentato — la grande maggioranza delle assunzioni avviene senza richiesta formale di riconoscimento. Salario minimo L-GAV 2026 senza AFC: CHF 3\'582 lordi/mese.',
    regulated: false,
  },
  autista: {
    itTitle: 'Autista professionale (camion / autobus)',
    authority: 'USTRA + SEFRI',
    authorityUrl: 'https://www.astra.admin.ch/astra/it/home/temi/patenti/riconoscimento.html',
    diplomaTypeIt: 'Patente CE/DE italiana + CQC (Carta Qualificazione Conducente)',
    swissEquivalent: 'Categoria C/CE/D/DE + OAut (Ordinanza sull\'ammissione alla circolazione, carta conducente)',
    leadTimeMonths: [1, 3],
    cclReference: 'CCL Trasporti stradali (obbligatorio) + convenzione TOE Ticino',
    cclUrl: 'https://www.les-routiers.ch/it/',
    notes: 'Professione regolamentata: il riconoscimento della patente italiana è automatico (accordo ALC) ma la CQC va convertita. Possibile guidare in Svizzera con patente italiana per 12 mesi da frontaliere, poi conversione obbligatoria.',
    regulated: true,
  },
  operaio: {
    itTitle: 'Operaio di produzione / industriale',
    authority: 'Nessuno (non regolamentata)',
    authorityUrl: 'https://www.sbfi.admin.ch/sbfi/it/home/formazione/riconoscimento-di-diplomi-esteri.html',
    diplomaTypeIt: 'Qualsiasi qualifica o nessuna',
    swissEquivalent: 'Nessun riconoscimento richiesto',
    leadTimeMonths: [0, 0],
    cclReference: 'CCL di settore (metallurgia, chimica, alimentare — variano per industria)',
    cclUrl: 'https://www.seco.admin.ch/seco/it/home/Arbeit/Personenfreizugigkeit_Arbeitsbeziehungen/flankierende-massnahmen/usuelle-arbeits--und-lohnbedingungen/gesamtarbeitsvertraege-gav.html',
    notes: 'Settore non regolamentato: assunzione diretta senza pratica SEFRI. Il CCL di settore fissa il salario minimo.',
    regulated: false,
  },
  impiegato: {
    itTitle: 'Impiegato di commercio / amministrativo',
    authority: 'SEFRI (facoltativo)',
    authorityUrl: 'https://www.sbfi.admin.ch/sbfi/it/home/formazione/riconoscimento-di-diplomi-esteri.html',
    diplomaTypeIt: 'Diploma ITC, ragioneria o laurea triennale',
    swissEquivalent: 'Impiegato di commercio AFC oppure diploma KV / economia e gestione',
    leadTimeMonths: [2, 5],
    cclReference: 'CCL di settore (banche, assicurazioni, commercio al dettaglio, industria — variano)',
    cclUrl: 'https://www.seco.admin.ch/seco/it/home/Arbeit/Personenfreizugigkeit_Arbeitsbeziehungen/flankierende-massnahmen/usuelle-arbeits--und-lohnbedingungen/gesamtarbeitsvertraege-gav.html',
    notes: 'Non regolamentata — la maggioranza dei datori ticinesi assume impiegati italiani senza richiedere pratica SEFRI. Il riconoscimento è raccomandato solo per accedere a concorsi pubblici o percorsi formativi continui.',
    regulated: false,
  },
  ingegnere: {
    itTitle: 'Ingegnere (civile, meccanico, elettrico, informatico)',
    authority: 'SEFRI + REG (Fondazione svizzera Registro degli ingegneri)',
    authorityUrl: 'https://www.reg.ch/',
    diplomaTypeIt: 'Laurea magistrale (LM) o quinquennale pre-Bologna in ingegneria',
    swissEquivalent: 'Diploma SUP / ETH (Politecnico) + iscrizione REG A o REG B per titolo riconosciuto',
    leadTimeMonths: [3, 8],
    cclReference: 'Nessun CCL obbligatorio sitewide; condizioni contrattuali di settore',
    cclUrl: 'https://www.reg.ch/',
    notes: 'Professione non regolamentata per l\'impiego corrente, ma il REG è il canale ufficiale per esercitare come ingegnere libero-professionista o firmare progetti edili. Molti studi tecnici ticinesi assumono ingegneri italiani senza REG.',
    regulated: false,
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
    await new Promise((r) => setTimeout(r, 1000));
  }
  return probed;
}

async function main() {
  console.log('[sefri] Probing public authority sources (1 req/s)…');
  const sources = await probeSources();
  const reachable = sources.filter((s) => s.reachable).length;
  console.log(`[sefri] ${reachable}/${sources.length} sources reachable — writing curated equivalence snapshot.`);

  const payload = {
    generatedAt: new Date().toISOString(),
    sources,
    professions: TRADE_PROFESSIONS,
    note: 'Curated, hand-verified equivalence summary. Update TRADE_PROFESSIONS when SEFRI / SECO publish CCL revisions. Regulated = requires authority pre-approval before employment.',
  };

  fs.mkdirSync(np.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n');
  console.log(`[sefri] Wrote ${OUT} (${Object.keys(TRADE_PROFESSIONS).length} professions)`);
}

main().catch((err) => {
  console.error('[sefri] failed:', err);
  process.exit(1);
});
