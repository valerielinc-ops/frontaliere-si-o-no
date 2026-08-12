/**
 * emailScannerRanges.mjs — the IP ranges corporate mail scanners click from.
 *
 * DATA, NOT LOGIC (issue #5674). The detection lives in
 * scripts/lib/dailyBriefCadence.mjs; this file is the list it reads, so adding
 * a range is an edit to a table with a provenance column and not a change to a
 * classifier. Every entry carries the whois answer that justifies it and the
 * date it was checked, because a range that cannot be re-verified cannot be
 * defended when it demotes somebody.
 *
 * WHAT THIS LIST IS *NOT* GOOD FOR. Measured on the 433 recipients sitting on
 * the daily tier on 2026-08-12: this list matches 14 of them, and the
 * behavioural rule (`classifyClickEvents`, N distinct targets in a few seconds)
 * matches 17 — with only 6 in common. The six heaviest synthetic clickers,
 * ~230 clicks each, hit us from 86 to 122 distinct IPs spread over 52 to 88
 * distinct /16 prefixes — DigitalOcean, OVH, Hetzner, and a residential
 * Vodafone-IT DSL pool — with ZERO hits in any Microsoft range. No IP list was
 * ever going to catch them, which is why this file is the second signal and the
 * behavioural one is the first.
 *
 * IPv6 is deliberately unsupported: `ipInCidr` returns false for it rather than
 * guessing, and the behavioural rule covers what that costs.
 */

/**
 * @typedef {object} ScannerRange
 * @property {string} cidr      IPv4 CIDR
 * @property {string} org       whois OrgName
 * @property {string} product   what actually clicks from there, as far as we know
 * @property {string} verified  ISO date the whois answer above was read
 * @property {string} [seenAs]  an address observed in our own click log
 */

/**
 * Ranges whose clicks are never a human reading an email.
 *
 * All four Microsoft blocks below were confirmed by `whois` on 2026-08-12
 * (`OrgName: Microsoft Corporation`, `NetName: MSFT`) after showing up in
 * same-second bursts across every link of a message, unsubscribe included —
 * the Defender for Office 365 / Safe Links signature described in #5674.
 *
 * Two neighbouring blocks that behave identically in our log — 172.160.0.0/11
 * and 48.192.0.0/12, both seen bursting 7 to 10 targets in under two seconds —
 * are deliberately ABSENT: whois attributes them to the RIPE NCC and not to
 * Microsoft, and this table only carries ranges whose provenance we can quote.
 * The behavioural rule catches them anyway.
 *
 * @type {ReadonlyArray<ScannerRange>}
 */
export const EMAIL_SCANNER_IP_RANGES = Object.freeze([
  Object.freeze({
    cidr: '74.240.0.0/14',
    org: 'Microsoft Corporation (MSFT)',
    product: 'Defender for Office 365 — Safe Links',
    verified: '2026-08-12',
    seenAs: '74.242.242.134',
  }),
  Object.freeze({
    cidr: '74.176.0.0/14',
    org: 'Microsoft Corporation (MSFT)',
    product: 'Defender for Office 365 — Safe Links',
    verified: '2026-08-12',
    seenAs: '74.179.70.x',
  }),
  Object.freeze({
    cidr: '72.144.0.0/14',
    org: 'Microsoft Corporation (MSFT)',
    product: 'Defender for Office 365 — Safe Links',
    verified: '2026-08-12',
    seenAs: '72.145.93.142',
  }),
  Object.freeze({
    cidr: '72.152.0.0/14',
    org: 'Microsoft Corporation (MSFT)',
    product: 'Defender for Office 365 — Safe Links',
    verified: '2026-08-12',
    seenAs: '72.152.84.105',
  }),
]);

export default EMAIL_SCANNER_IP_RANGES;
