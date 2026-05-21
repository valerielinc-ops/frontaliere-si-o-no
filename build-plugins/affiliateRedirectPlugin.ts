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
import { ANALYTICS_SNIPPET, BASE_URL, SEO_STATIC_CSS_LINK } from './constants';
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
 ${SEO_STATIC_CSS_LINK}
 ${ANALYTICS_SNIPPET}
 <script>window.location.replace(${JSON.stringify(targetUrl)})</script>
 </head>
 <body>
 <main class="s-9MsAg7">
 <p class="s-16ZGVZ">${partner.emoji}</p>
 <h1 class="s-0Ns7AE">Stai per visitare ${esc(partner.name)}</h1>
 <p class="s-a4vtCV">Verrai reindirizzato automaticamente. Se non succede, clicca il link qui sotto.</p>
 <p><a class="s-uJ0x5V" href="${esc(targetUrl)}" rel="noopener sponsored">Vai a ${esc(partner.name)} &rarr;</a></p>
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
 const writer = new WriteCollector({ distDir, pluginName: 'affiliateRedirectPlugin' });

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
