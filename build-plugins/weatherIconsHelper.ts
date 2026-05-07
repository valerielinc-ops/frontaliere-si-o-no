/**
 * Inline SVG icon helpers for weather build plugins. Static SSG can't use
 * React components (lucide-react), so we render the same paths as inline
 * `<svg>` tags. CSS classes apply via `currentColor` on stroke.
 */

const STROKE_DEFAULTS = 'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"';

export function svgSun(size = 24): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" ${STROKE_DEFAULTS} aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>`;
}

export function svgCloudSun(size = 24): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" ${STROKE_DEFAULTS} aria-hidden="true"><path d="M12 2v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="M20 12h2"/><path d="m19.07 4.93-1.41 1.41"/><path d="M15.947 12.65a4 4 0 0 0-5.925-4.128"/><path d="M13 22H7a5 5 0 1 1 4.9-6h.1a3 3 0 0 1 0 6Z"/></svg>`;
}

export function svgCloud(size = 24): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" ${STROKE_DEFAULTS} aria-hidden="true"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></svg>`;
}

export function svgCloudRain(size = 24): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" ${STROKE_DEFAULTS} aria-hidden="true"><path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="M16 14v6"/><path d="M8 14v6"/><path d="M12 16v6"/></svg>`;
}

export function svgCloudSnow(size = 24): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" ${STROKE_DEFAULTS} aria-hidden="true"><path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="M8 15h.01"/><path d="M8 19h.01"/><path d="M12 17h.01"/><path d="M12 21h.01"/><path d="M16 15h.01"/><path d="M16 19h.01"/></svg>`;
}

export function svgCloudFog(size = 24): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" ${STROKE_DEFAULTS} aria-hidden="true"><path d="M16 17H7"/><path d="M17 21H9"/><path d="M19 13a4.5 4.5 0 0 0-1.41-8.775 5.5 5.5 0 0 0-10.624 1.595A4 4 0 0 0 6.5 13Z"/></svg>`;
}

export function svgCloudLightning(size = 24): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" ${STROKE_DEFAULTS} aria-hidden="true"><path d="M6 16.326A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 .5 8.973"/><path d="m13 12-3 5h4l-3 5"/></svg>`;
}

export function svgWind(size = 16): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" ${STROKE_DEFAULTS} aria-hidden="true"><path d="M12.8 19.6A2 2 0 1 0 14 16H2"/><path d="M17.5 8a2.5 2.5 0 1 1 2 4H2"/><path d="M9.8 4.4A2 2 0 1 1 11 8H2"/></svg>`;
}

export function svgDroplet(size = 16): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" ${STROKE_DEFAULTS} aria-hidden="true"><path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C7 11.1 6 13 6 15a7 7 0 0 0 7 7Z"/></svg>`;
}

export function svgSunrise(size = 16): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" ${STROKE_DEFAULTS} aria-hidden="true"><path d="M12 2v8"/><path d="m4.93 10.93 1.41 1.41"/><path d="M2 18h2"/><path d="M20 18h2"/><path d="m19.07 10.93-1.41 1.41"/><path d="M22 22H2"/><path d="m8 6 4-4 4 4"/><path d="M16 18a4 4 0 0 0-8 0"/></svg>`;
}

export function svgSunset(size = 16): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" ${STROKE_DEFAULTS} aria-hidden="true"><path d="M12 10V2"/><path d="m4.93 10.93 1.41 1.41"/><path d="M2 18h2"/><path d="M20 18h2"/><path d="m19.07 10.93-1.41 1.41"/><path d="M22 22H2"/><path d="m16 6-4 4-4-4"/><path d="M16 18a4 4 0 0 0-8 0"/></svg>`;
}

export function svgMail(size = 18): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" ${STROKE_DEFAULTS} aria-hidden="true"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>`;
}

export function svgBell(size = 18): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" ${STROKE_DEFAULTS} aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>`;
}

export function svgArrowRight(size = 16): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" ${STROKE_DEFAULTS} aria-hidden="true"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>`;
}

export function svgFacebook(size = 20): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M9.198 21.5h4v-8.01h3.604l.396-3.98h-4V7.5a1 1 0 0 1 1-1h3v-4h-3a5 5 0 0 0-5 5v2.01h-2l-.396 3.98h2.396z"/></svg>`;
}

export function svgLinkedin(size = 20): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.063 2.063 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>`;
}

export function svgTelegram(size = 20): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>`;
}

/**
 * Map a WMO weather code (0-99) to the corresponding inline SVG icon at the
 * given size. Day vs night handling is approximate (Sun → "Moon" not yet
 * implemented; we keep Sun for now since night rendering is rare in the
 * static SSG hero — the cron snapshot generally hits during daytime hours).
 */
export function svgForWmo(code: number, size = 80, isDay = true): string {
  if (code === 0) return svgSun(size);
  if (code === 1 || code === 2) return svgCloudSun(size);
  if (code === 3) return svgCloud(size);
  if (code >= 45 && code <= 48) return svgCloudFog(size);
  if (code >= 51 && code <= 67) return svgCloudRain(size);
  if (code >= 71 && code <= 86) return svgCloudSnow(size);
  if (code >= 95) return svgCloudLightning(size);
  return svgSun(size);
}

/**
 * Renders an SVG `<symbol>` sprite once at the top of the body. Subsequent
 * `<use href="#id">` references (see `svgUse*`) point back to it. This
 * dedupes long path data: a city page repeats the same Sun/Cloud/Wind
 * paths 30+ times — keeping them inline blew the text-to-HTML ratio gate
 * (4.5 % vs 10 % threshold). With sprite + use, each repeat is ~70 bytes
 * instead of ~400.
 */
export function iconSprite(): string {
  const stroke = 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
  return `<svg style="display:none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">` +
    `<symbol id="i-sun" viewBox="0 0 24 24" ${stroke}><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></symbol>` +
    `<symbol id="i-cloud-sun" viewBox="0 0 24 24" ${stroke}><path d="M12 2v2M4.93 4.93l1.41 1.41M20 12h2M19.07 4.93l-1.41 1.41M15.947 12.65a4 4 0 0 0-5.925-4.128M13 22H7a5 5 0 1 1 4.9-6h.1a3 3 0 0 1 0 6Z"/></symbol>` +
    `<symbol id="i-cloud" viewBox="0 0 24 24" ${stroke}><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></symbol>` +
    `<symbol id="i-rain" viewBox="0 0 24 24" ${stroke}><path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242M16 14v6M8 14v6M12 16v6"/></symbol>` +
    `<symbol id="i-snow" viewBox="0 0 24 24" ${stroke}><path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242M8 15h.01M8 19h.01M12 17h.01M12 21h.01M16 15h.01M16 19h.01"/></symbol>` +
    `<symbol id="i-fog" viewBox="0 0 24 24" ${stroke}><path d="M16 17H7M17 21H9M19 13a4.5 4.5 0 0 0-1.41-8.775 5.5 5.5 0 0 0-10.624 1.595A4 4 0 0 0 6.5 13Z"/></symbol>` +
    `<symbol id="i-storm" viewBox="0 0 24 24" ${stroke}><path d="M6 16.326A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 .5 8.973M13 12l-3 5h4l-3 5"/></symbol>` +
    `<symbol id="i-wind" viewBox="0 0 24 24" ${stroke}><path d="M12.8 19.6A2 2 0 1 0 14 16H2M17.5 8a2.5 2.5 0 1 1 2 4H2M9.8 4.4A2 2 0 1 1 11 8H2"/></symbol>` +
    `<symbol id="i-droplet" viewBox="0 0 24 24" ${stroke}><path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C7 11.1 6 13 6 15a7 7 0 0 0 7 7Z"/></symbol>` +
    `<symbol id="i-sunrise" viewBox="0 0 24 24" ${stroke}><path d="M12 2v8M4.93 10.93l1.41 1.41M2 18h2M20 18h2M19.07 10.93l-1.41 1.41M22 22H2M8 6l4-4 4 4M16 18a4 4 0 0 0-8 0"/></symbol>` +
    `<symbol id="i-sunset" viewBox="0 0 24 24" ${stroke}><path d="M12 10V2M4.93 10.93l1.41 1.41M2 18h2M20 18h2M19.07 10.93l-1.41 1.41M22 22H2M16 6l-4 4-4-4M16 18a4 4 0 0 0-8 0"/></symbol>` +
    `<symbol id="i-mail" viewBox="0 0 24 24" ${stroke}><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></symbol>` +
    `<symbol id="i-arrow" viewBox="0 0 24 24" ${stroke}><path d="M5 12h14M12 5l7 7-7 7"/></symbol>` +
    `<symbol id="i-fb" viewBox="0 0 24 24" fill="currentColor"><path d="M9.198 21.5h4v-8.01h3.604l.396-3.98h-4V7.5a1 1 0 0 1 1-1h3v-4h-3a5 5 0 0 0-5 5v2.01h-2l-.396 3.98h2.396z"/></symbol>` +
    `<symbol id="i-li" viewBox="0 0 24 24" fill="currentColor"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.063 2.063 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></symbol>` +
    `</svg>`;
}

function svgUse(id: string, size: number): string {
  return `<svg width="${size}" height="${size}" aria-hidden="true"><use href="#${id}"/></svg>`;
}

export function useForWmo(code: number, size: number): string {
  let id = 'i-sun';
  if (code === 0) id = 'i-sun';
  else if (code === 1 || code === 2) id = 'i-cloud-sun';
  else if (code === 3) id = 'i-cloud';
  else if (code >= 45 && code <= 48) id = 'i-fog';
  else if (code >= 51 && code <= 67) id = 'i-rain';
  else if (code >= 71 && code <= 86) id = 'i-snow';
  else if (code >= 95) id = 'i-storm';
  return svgUse(id, size);
}

export const useWind = (size = 18) => svgUse('i-wind', size);
export const useDroplet = (size = 18) => svgUse('i-droplet', size);
export const useSunrise = (size = 18) => svgUse('i-sunrise', size);
export const useSunset = (size = 18) => svgUse('i-sunset', size);
export const useMail = (size = 22) => svgUse('i-mail', size);
export const useArrow = (size = 18) => svgUse('i-arrow', size);
export const useFacebook = (size = 16) => svgUse('i-fb', size);
export const useLinkedin = (size = 16) => svgUse('i-li', size);

/**
 * Tailwind text-color utility for a given WMO weather code. The icon should
 * "tell the weather" through hue: amber for sun, slate for cloud cover,
 * sky for rain, indigo for snow, etc. Used by the city page hero and hourly
 * cells so a quick scan reveals conditions before the user reads labels.
 */
export function colorForWmo(code: number): string {
  if (code === 0) return 'text-amber-500';
  if (code === 1) return 'text-amber-400';
  if (code === 2) return 'text-slate-400';
  if (code === 3) return 'text-slate-500';
  if (code >= 45 && code <= 48) return 'text-slate-400';
  if (code >= 51 && code <= 57) return 'text-sky-500';
  if (code >= 61 && code <= 67) return 'text-sky-600';
  if (code >= 71 && code <= 86) return 'text-indigo-400';
  if (code >= 95) return 'text-violet-600';
  return 'text-amber-500';
}
