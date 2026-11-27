export function slugify(raw: string | null | undefined): string;
export function buildStationSlug(opts: {
  brand?: string | null;
  name?: string | null;
  address?: string | null;
}): string;
export function assignItalianStationSlugs(
  stations: ReadonlyArray<{ id?: string; brand?: string; stationName?: string; address?: string }>,
  recorded?: Readonly<Record<string, string>>,
): Map<string, string>;
export interface ItalianStationPagesManifest {
  /** Written benzina pages, `{citySlug}/{stationSlug}`. */
  pages: ReadonlySet<string>;
  /** Station id → written page; `null` for a manifest that predates it. */
  byStationId: Readonly<Record<string, string>> | null;
}
export function resolveItalianStationRoute(
  stationId: string,
  derived: { citySlug: string | null; stationSlug: string | undefined },
  manifest: ItalianStationPagesManifest | null,
): { citySlug: string; stationSlug: string } | null;
