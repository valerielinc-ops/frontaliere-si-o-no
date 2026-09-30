#!/usr/bin/env node
/**
 * Readiness probe → one issue per blocked source whose evidence changed.
 *
 * A probe that writes only to the step summary is not an alarm: nobody opens
 * Actions for it, so a GE list published mid-October would sit unused until
 * someone re-checked by hand (that is how #10220 stayed a manual container).
 * This reads the JSON of `discover-sources.mjs` and, for each `readyKeys`
 * entry, opens or updates an issue through github-issue-creator: stable title
 * with the plate code first (the first 60 chars are the dedup key), body in
 * the backlog's four-field format, so the issue enters the normal fix queue.
 *
 *   node scripts/plate-auctions/alert-ready-sources.mjs --from readiness.json [--run-url URL]
 */
import { readFileSync } from 'node:fs';
import { createGithubIssue } from '../lib/github-issue-creator.mjs';

const PROBE_COMMAND = 'node scripts/plate-auctions/discover-sources.mjs --blocked-only --ge-sitemap';

export function readinessAlertTitle(entry) {
  return `${String(entry.plateCode || entry.key).toUpperCase()} plate-auction source is ready — review its activation`;
}

function plan(entry) {
  const key = entry.key;
  const geList = entry.geList || {};
  if (key === 'ge' && entry.recommendation === 'ready-for-connector-check') {
    const fromSitemap = (geList.unknownListDocuments || []).length > 0
      ? ` Se la lista arriva solo dalla sitemap (${geList.unknownListDocuments.join(', ')}), aggiungerne l'URL a \`GE_PLATE_AUCTION_SOURCE.listDocumentUrls\` in \`functions/src/plateAuctionsCore.js\`.`
      : '';
    return {
      causa: `Il connector GE legge dalla lista OCV ufficiale ${geList.connectorRows} targhe per la sessione ${geList.sessionStartsAt || '?'} → ${geList.sessionEndsAt || '?'} (PDF ${geList.listPdfUrl || '?'}). Ipotesi da confermare col COMANDO: la lista è nuova e la sessione non è chiusa.`,
      fix: `Portare \`ge\` a \`status: active\` in \`data/plate-auction-sources-registry.json\` per la durata della sessione, eseguire \`node scripts/plate-auctions/ingest.mjs\` e \`node scripts/plate-auctions/check-health.mjs\`, e riportarla a \`blocked\` dopo ${geList.sessionEndsAt || 'la fine della sessione'}.${fromSitemap} Ricardo resta solo un link.`,
      metrica: `prima=0 righe GE nello snapshot atteso=${geList.connectorRows}`,
    };
  }
  if (key === 'ge' && geList.sitemapError && !geList.connectorError) {
    return {
      causa: `La scansione della sitemap di ge.ch è fallita o incompleta (${geList.sitemapError}), quindi una lista OCV pubblicata con uno slug nuovo non si può escludere; il connector non trova righe aperte fra le liste note. Ipotesi: guasto transitorio di ge.ch, oppure la sitemap ha cambiato forma.`,
      fix: 'Rieseguire il COMANDO: se la sitemap torna leggibile e GE resta `blocked-until-official-list`, chiudere la issue; se cambia forma o supera il tetto di pagine, aggiornare `discoverGeSitemapListDocuments` in `scripts/plate-auctions/discover-sources.mjs` con un test sul nuovo formato.',
      metrica: 'prima=sitemap non letta atteso=sitemap letta per intero',
    };
  }
  if (key === 'ge') {
    return {
      causa: `La pagina d'asta o la sitemap di ge.ch puntano a una lista che il connector non riesce a leggere (${geList.connectorError || 'nessuna riga'}${(geList.unknownListDocuments || []).length ? `; documenti nuovi: ${geList.unknownListDocuments.join(', ')}` : ''}). Ipotesi: layout del PDF o della pagina documento cambiato.`,
      fix: 'Aggiornare il parser GE in `functions/src/plateAuctionsCore.js` con una fixture dal nuovo PDF (solo fatti: numeri e date), senza attivare la fonte finché il connector non produce righe.',
      metrica: 'prima=errore del connector atteso=righe lette per la sessione annunciata',
    };
  }
  if (key === 'zg') {
    return {
      causa: 'La pagina ufficiale di Zugo non dice più che le aste sono sospese («bis auf Weiteres keine Auktionen», Kantonsrat 24.11.2022) e usa lessico d\'asta. Ipotesi da confermare sulla pagina: le aste sono riprese.',
      fix: 'Leggere la pagina ufficiale e cercare una lista o un catalogo ufficiale; aggiornare la voce `zg` del registry solo con evidenza ufficiale, senza fonti private.',
      metrica: 'prima=no-public-auction atteso=fonte ufficiale documentata',
    };
  }
  if (key === 'ju' || key === 'ne') {
    const links = (entry.dataLinks || []).map((link) => `${link.url} («${link.text}»)`).join('; ');
    return {
      causa: `La pagina ufficiale ${key === 'ju' ? 'dell\'OVJ' : 'del SCAN'} linka un possibile file dati o feed: ${links}. Ipotesi: è un elenco ufficiale di targhe consultabile senza captcha.`,
      fix: `Verificare il documento: se è l'elenco ufficiale, scrivere il connector e attivare \`${key}\` solo dopo i test; se non lo è, aggiungerne \`host/path\` a \`REVIEWED_NON_FEED_LINKS.${key}\` in \`scripts/plate-auctions/discover-sources.mjs\`. Ricardo e i guichet con captcha restano esclusi.`,
      metrica: 'prima=official-feed-request-needed atteso=connector attivo oppure link revisionato',
    };
  }
  return {
    causa: 'La pagina ufficiale della fonte bloccata usa ora lessico d\'asta o d\'offerta. Ipotesi: il cantone pubblica un catalogo.',
    fix: 'Verificare la pagina ufficiale; il registry resta invariato senza un catalogo ufficiale leggibile.',
    metrica: 'prima=candidate-office-page-only atteso=decisione documentata',
  };
}

export function formatReadinessAlert(entry, { runUrl } = {}) {
  const { causa, fix, metrica } = plan(entry);
  const evidence = {
    key: entry.key,
    discoveryUrl: entry.discoveryUrl,
    httpStatus: entry.httpStatus,
    recommendation: entry.recommendation,
    ...(entry.geList ? { geList: entry.geList } : {}),
    ...(entry.dataLinks?.length ? { dataLinks: entry.dataLinks } : {}),
  };
  const description = [
    '## Scheda',
    `- CAUSA: ${causa}`,
    `- FIX: ${fix} | REPO: sito | MODE: non-nel-manifest`,
    `- METRICA: ${metrica} | COMANDO: \`${PROBE_COMMAND} | jq '.results[] | select(.key == "${entry.key}")'\``,
    '- OSSERVATORE: `node scripts/plate-auctions/check-health.mjs` e i test del registry impediscono righe per fonti non attive; il watch giornaliero di `refresh-plate-auctions.yml` riapre questa issue finché la fonte resta pronta e non attivata.',
    '',
    '## Evidenza',
    '```json',
    JSON.stringify(evidence, null, 2),
    '```',
    ...(runUrl ? ['', `Run: ${runUrl}`] : []),
  ].join('\n');
  return { title: readinessAlertTitle(entry), description };
}

async function main() {
  const args = process.argv.slice(2);
  const get = (flag) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const from = get('--from');
  if (!from) throw new Error('--from <readiness.json> is required');
  const report = JSON.parse(readFileSync(from, 'utf8'));
  const runUrl = get('--run-url');
  for (const key of report.readyKeys || []) {
    const entry = (report.results || []).find((result) => result.key === key);
    if (!entry) continue;
    const { title, description } = formatReadinessAlert(entry, { runUrl });
    await createGithubIssue({
      title,
      description,
      priority: 3,
      labels: ['follow-up'],
      workflow: 'Refresh Plate Auctions',
    });
    console.log(`alerted: ${title}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('Plate-auction readiness alert failed:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
