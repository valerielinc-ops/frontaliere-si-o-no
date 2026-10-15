/**
 * Shared client-side logo-fallback handler, externalised from the per-card
 * inline `onerror` data URI.
 *
 * Job cards (`jobCardHtml.ts`) and employer cards (`employerCardHtml.ts`) both
 * used to inline the full deterministic coloured-initials data URI inside the
 * image `onerror` attribute (`onerror="this.onerror=null;this.src=&quot;data:…
 * 543 B…&quot;"` ≈ 586 B per card). Across ~314 k job cards + employer cards
 * that was ~184 MB of byte-near-identical markup on the dist artifact.
 *
 * Instead each logo `<img>` now carries the tiny `onerror="jcLF(this)"` and the
 * page emits this `<script>` ONCE. On a logo 404 `jcLF` rebuilds the *same*
 * initials SVG from the company name in `alt="Logo {company}"`, producing the
 * byte-identical data URI that `generateInitialsLogo` would have inlined.
 *
 * ⚠️ The client logic below MUST stay in lockstep with `generateInitialsLogo`
 * in companyLogoResolver.ts (identical cleaning regex, hash, palette order and
 * initials rule) or the fallback visual drifts between server-rendered and
 * client-rebuilt logos. The parity is locked by
 * tests/build-plugins/logo-fallback-script.test.ts.
 *
 * CSP allows inline scripts (`script-src 'unsafe-inline'`). The script is
 * emitted before any card `<img>` in source order, so `jcLF` is defined by the
 * time an image error can fire. Re-emitting it on a page that has both job and
 * employer cards just harmlessly re-assigns `window.jcLF`.
 */
export const LOGO_FALLBACK_SCRIPT =
  `<script>window.jcLF=function(g){if(g.dataset.lf)return;g.dataset.lf='1';g.onerror=null;` +
  `var n=(g.alt||'').replace(/^Logo /,''),c=n.replace(/[^\\p{L}\\p{N}\\s]/gu,' ').replace(/\\s+/g,' ').trim(),` +
  `w=c.split(' ').filter(Boolean),` +
  `t=w.length===0?'?':w.length===1?w[0].slice(0,2).toUpperCase():(w[0][0]+w[1][0]).toUpperCase(),` +
  `h=0,i=0,p=[['#dbeafe','#1e40af'],['#dcfce7','#166534'],['#fef3c7','#92400e'],['#fce7f3','#9d174d'],['#e0e7ff','#3730a3'],['#f3e8ff','#6b21a8'],['#fee2e2','#991b1b'],['#ccfbf1','#115e59']];` +
  `for(;i<c.length;i++)h=(h*31+c.charCodeAt(i))>>>0;var q=p[h%8],` +
  `s='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="40" height="40"><rect width="40" height="40" rx="8" fill="'+q[0]+'"/><text x="50%" y="50%" text-anchor="middle" dominant-baseline="central" font-family="system-ui,-apple-system,Segoe UI,sans-serif" font-size="16" font-weight="700" fill="'+q[1]+'">'+t+'</text></svg>';` +
  `g.src='data:image/svg+xml;utf8,'+encodeURIComponent(s)};</script>`;
