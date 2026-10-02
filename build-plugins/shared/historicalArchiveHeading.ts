/**
 * Visible `<h1>` of a historical job archive page (the self-healing pass of
 * `jobsSeoPagesPlugin`, pages kept `index, follow` since #10481).
 *
 * The page `<title>` is `composeSerpJobTitle(role, company, location)`, which
 * drops the location whenever "role — company a {city}" does not fit the SERP
 * budget, and the heading used to be "role — company" with no location at
 * all. Every archive page whose title had lost its city therefore had
 * `<title>` identical to `<h1>`. Measured on build f3659686, Zurich IT
 * section: all 3 874 `audit:all/h1-title-duplicates` job-board offenders are
 * this template; 633 of them have a known location the heading did not show.
 *
 * The heading now carries the location when the archive knows it, the same
 * "role — company, location" shape the page's meta description already uses.
 * Pages whose archive record has neither company nor location (the slug is
 * the only source: 2 295 of the 3 874) keep "role" as both title and
 * heading — nothing true can be added to them from this data.
 */
export function historicalArchiveHeading(role: string, company: string, location: string): string {
  const c = String(company || '').trim();
  const l = String(location || '').trim();
  return `${String(role || '').trim()}${c ? ` — ${c}` : ''}${l ? `, ${l}` : ''}`;
}
