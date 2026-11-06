function parseTichDetailUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase();
    const decodedPath = decodeURIComponent(parsed.pathname);
    if (!host.endsWith('concorsi.ti.ch') || decodedPath !== "/offerte-d'impieghi.html") return null;
    const yid = parsed.searchParams.get('yid') || '';
    if (!/^\d+$/.test(yid)) return null;
    return yid;
  } catch {
    return null;
  }
}

export function isTichDetailUrl(rawUrl) {
  return Boolean(parseTichDetailUrl(rawUrl));
}

export function isTichDetailHtmlForUrl(html, rawUrl) {
  const source = String(html || '')
    .replace(/&amp;/gi, '&')
    .replace(/%3d/gi, '=');
  const yid = parseTichDetailUrl(rawUrl);
  if (!source || !yid) return false;

  const hasPortalIdentity = /Amministrazione Cantonale Ticino Jobportal|rexx\s+Recruitment\s+-\s+Portal7/i.test(source);
  const hasRequestedYid = new RegExp(`(?:[?&])yid=${yid}(?:[&"'<>\\s]|$)`, 'i').test(source);
  return hasPortalIdentity && hasRequestedYid;
}
