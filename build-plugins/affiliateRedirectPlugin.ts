/**
 * Affiliate Redirect Plugin — /go/{partner} static redirect pages.
 *
 * Generates a lightweight redirect page for each affiliate partner.
 * Users land on /go/wise, /go/fineco, etc. and get redirected to the
 * partner URL with UTM tracking. The static page also contains a visible
 * fallback link, so the redirect works even with JS disabled.
 *
 * Pages are noindex (no SEO value, just a tracking intermediary).
 */
import path from 'node:path';
import type { Plugin } from 'vite';
import { PARTNERS, buildAffiliateUrl } from '../services/affiliateService';
import { GTAG_SNIPPET, BASE_URL } from './constants';
import { WriteCollector } from './batchWrite';

function buildRedirectPage(partner: typeof PARTNERS[number]): string {
 const targetUrl = buildAffiliateUrl(partner, 'go-redirect');
 const esc = (s: string) =>
 s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

 return `<!DOCTYPE html>
<html lang="it">
 <head>
 <meta charset="utf-8">
 <meta name="viewport" content="width=device-width,initial-scale=1">
 <title>${esc(partner.name)} | Frontaliere Ticino</title>
 <meta name="robots" content="noindex,nofollow">
 <link rel="canonical" href="${BASE_URL}/go/${partner.id}/">
 ${GTAG_SNIPPET}
 <script>window.location.replace(${JSON.stringify(targetUrl)})</script>
 </head>
 <body>
 <main style="font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:480px;margin:60px auto;padding:0 16px;text-align:center;color:#0f172a">
 <p style="font-size:48px;margin:0 0 16px">${partner.emoji}</p>
 <h1 style="font-size:24px;margin:0 0 12px">Stai per visitare ${esc(partner.name)}</h1>
 <p style="margin:0 0 20px;color:#475569">Verrai reindirizzato automaticamente. Se non succede, clicca il link qui sotto.</p>
 <p><a href="${esc(targetUrl)}" rel="noopener sponsored" style="color:#1d4ed8;font-weight:700;text-decoration:none">Vai a ${esc(partner.name)} &rarr;</a></p>
 </main>
 </body>
</html>`;
}

export function affiliateRedirectPlugin(rootDir: string): Plugin {
 return {
 name: 'affiliate-redirect-pages',
 apply: 'build',
 async closeBundle() {
 const distDir = path.resolve(rootDir, 'dist');
 const writer = new WriteCollector({ distDir });

 for (const partner of PARTNERS) {
 const html = buildRedirectPage(partner);
 const filePath = path.join(distDir, 'go', partner.id, 'index.html');
 writer.add(filePath, html);
 }

 const written = await writer.flush();
 console.log(` [affiliate-redirects] ${written} /go/{partner} redirect pages`);
 },
 };
}
