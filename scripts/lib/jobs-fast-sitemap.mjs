import {
  emitSitemapXml,
  isAuthoritativeJobSitemapShardFilename,
} from "./sitemap-shard.mjs";
import {
  isJobBoardCategoryHubPath,
  isJobBoardSitemapDetailPath,
} from "./job-board-detail-path.mjs";
import { SITEMAP_SHARD_CAP } from "./sitemap-limits.mjs";

const URL_BLOCK_RX = /<url>[\s\S]*?<\/url>/g;
const LOC_RX = /<loc>\s*([^<]+?)\s*<\/loc>/;
const SITEMAP_BLOCK_RX = /<sitemap>[\s\S]*?<\/sitemap>/g;

function assertLocSet(value, label) {
  if (!value || typeof value.has !== "function" || typeof value[Symbol.iterator] !== "function") {
    throw new Error(`[jobs-fast-sitemap] ${label} must be a complete URL set`);
  }
}

/**
 * Return every current active job-detail URL that the full build no longer
 * admits to the sitemap. The active-detail inventory is intentionally a
 * separate input from the sitemap allowlist: it identifies the URL family,
 * while the allowlist owns the current indexability decision. That keeps
 * hubs and previous-slug bridges out of the subtraction by construction.
 */
export function staleActiveJobDetailLocs(
  activeJobDetailLocs,
  currentReceiptLocs,
  fullBuildSitemapLocs,
) {
  assertLocSet(activeJobDetailLocs, "active job-detail inventory");
  assertLocSet(currentReceiptLocs, "current receipt locations");
  assertLocSet(fullBuildSitemapLocs, "full-build sitemap allowlist");

  const stale = [];
  for (const rawLoc of activeJobDetailLocs) {
    if (typeof rawLoc !== "string") {
      throw new Error("[jobs-fast-sitemap] active job-detail inventory contains a non-string URL");
    }
    let parsed;
    try {
      parsed = new URL(rawLoc);
    } catch {
      throw new Error(`[jobs-fast-sitemap] invalid active job-detail URL ${rawLoc}`);
    }
    if (
      parsed.origin !== "https://frontaliereticino.ch" ||
      parsed.search ||
      parsed.hash ||
      !parsed.pathname.endsWith("/")
    ) {
      throw new Error(`[jobs-fast-sitemap] invalid active job-detail URL ${rawLoc}`);
    }
    const loc = parsed.href;
    if (!currentReceiptLocs.has(loc) && !fullBuildSitemapLocs.has(loc)) stale.push(loc);
  }
  return [...new Set(stale)].sort();
}

function isActiveJobDetailSitemapPath(pathname) {
  if (pathname === "/sitemap-jobs.xml") return true;
  const filename = String(pathname || "").replace(/^\//u, "");
  if (isAuthoritativeJobSitemapShardFilename(filename)) return true;
  return /^sitemap-jobs-[a-z0-9-]+-(?:en|de|fr)(?:-\d{3})?\.xml$/u.test(filename);
}

/** List every currently indexed file in the active job-detail sitemap family. */
export function listActiveJobSitemapFilenames(indexXml) {
  return [
    ...new Set(
      [...String(indexXml || "").matchAll(
        /<loc>\s*https:\/\/frontaliereticino\.ch\/([^<]+?)\s*<\/loc>/gu,
      )]
        .map((match) => match[1].trim())
        .filter((filename) => isActiveJobDetailSitemapPath(`/${filename}`)),
    ),
  ].sort();
}

/**
 * Find detail URLs left in a live job sitemap after their full-build owner
 * disappeared. Firestore previous-path state cannot see a stable ID that was
 * retired entirely, so the live sitemap is the authoritative cleanup input.
 * Only the shared positive detail matcher is eligible; hubs and other URLs
 * remain untouched by construction.
 */
export function stalePublishedActiveJobDetailLocs(
  sitemapXmlByPath,
  fullBuildSitemapLocs,
  emittedCategoryHubLocs = null,
) {
  if (!(sitemapXmlByPath instanceof Map)) {
    throw new Error("[jobs-fast-sitemap] sitemap sources must be a Map");
  }
  assertLocSet(fullBuildSitemapLocs, "full-build sitemap allowlist");
  // Optional positive set of the category hubs the full build emits, in every
  // locale. When given, a published category hub outside it is stale too;
  // `null` (producer undecided) keeps the hubs untouched.
  if (emittedCategoryHubLocs !== null) {
    assertLocSet(emittedCategoryHubLocs, "emitted category-hub set");
  }

  const staleByPath = new Map();
  for (const [pathname, xml] of sitemapXmlByPath) {
    if (!isActiveJobDetailSitemapPath(pathname)) continue;
    assertUrlset(xml, pathname);
    for (const block of String(xml).match(URL_BLOCK_RX) || []) {
      const rawLoc = block.match(LOC_RX)?.[1]?.trim();
      if (!rawLoc) continue;
      let parsed;
      try {
        parsed = new URL(rawLoc);
      } catch {
        continue;
      }
      if (
        parsed.origin !== "https://frontaliereticino.ch" ||
        parsed.search ||
        parsed.hash ||
        !parsed.pathname.endsWith("/")
      ) {
        continue;
      }
      const loc = parsed.href;
      if (isJobBoardCategoryHubPath(parsed.pathname)) {
        if (emittedCategoryHubLocs === null || emittedCategoryHubLocs.has(loc)) continue;
      } else if (
        !isJobBoardSitemapDetailPath(parsed.pathname) ||
        fullBuildSitemapLocs.has(loc)
      ) {
        continue;
      }
      if (!staleByPath.has(pathname)) staleByPath.set(pathname, new Set());
      staleByPath.get(pathname).add(loc);
    }
  }
  return staleByPath;
}

/**
 * Locate removals in the active job-detail sitemap files already loaded by
 * the publisher. The returned map is also the post-publish verification
 * ledger (`pathname -> removed locs`), so dispatch and tracking cannot drift.
 */
export function routeActiveJobSitemapRemovals(removalLocs, sitemapXmlByPath) {
  if (!removalLocs || typeof removalLocs[Symbol.iterator] !== "function") {
    throw new Error("[jobs-fast-sitemap] removal locations must be iterable");
  }
  if (!(sitemapXmlByPath instanceof Map)) {
    throw new Error("[jobs-fast-sitemap] sitemap sources must be a Map");
  }

  const locsByPath = new Map();
  const activeSources = [...sitemapXmlByPath]
    .filter(([pathname]) => isActiveJobDetailSitemapPath(pathname))
    .map(([pathname, xml]) => {
      assertUrlset(xml, pathname);
      return [pathname, new Set(
        [...String(xml).matchAll(URL_BLOCK_RX)]
          .map((block) => block[0].match(LOC_RX)?.[1]?.trim())
          .filter(Boolean),
      )];
    });

  for (const loc of new Set(removalLocs)) {
    if (typeof loc !== "string") {
      throw new Error("[jobs-fast-sitemap] removal locations contain a non-string URL");
    }
    const matches = activeSources.filter(([, locs]) => locs.has(loc));
    if (matches.length > 1) {
      throw new Error(`[jobs-fast-sitemap] active detail URL appears in multiple sitemap files: ${loc}`);
    }
    if (matches.length === 0) continue;
    const pathname = matches[0][0];
    if (!locsByPath.has(pathname)) locsByPath.set(pathname, new Set());
    locsByPath.get(pathname).add(loc);
  }
  return locsByPath;
}

function assertUrlset(xml, label) {
  if (
    typeof xml !== "string" ||
    !xml.includes("<urlset") ||
    !xml.includes("</urlset>")
  ) {
    throw new Error(`[jobs-fast-sitemap] invalid ${label} urlset`);
  }
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function mergeUrlset(
  xml,
  entries,
  { label, maxUrls = SITEMAP_SHARD_CAP, removeLocs = [], renderEntry },
) {
  const rows = Array.isArray(entries) ? entries : [];
  const removals = new Set(
    (Array.isArray(removeLocs) ? removeLocs : []).filter(
      (loc) => typeof loc === "string",
    ),
  );
  if (rows.length === 0 && removals.size === 0) return xml;
  const source =
    xml ||
    '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n</urlset>\n';
  assertUrlset(source, label);
  const targetLocs = new Set();
  for (const entry of rows) {
    if (
      !entry ||
      typeof entry.loc !== "string" ||
      !entry.loc.startsWith("https://frontaliereticino.ch/")
    ) {
      throw new Error(`[jobs-fast-sitemap] invalid ${label} entry location`);
    }
    if (targetLocs.has(entry.loc))
      throw new Error(
        `[jobs-fast-sitemap] duplicate ${label} location ${entry.loc}`,
      );
    targetLocs.add(entry.loc);
  }
  let output = source.replace(URL_BLOCK_RX, (block) => {
    const loc = block.match(LOC_RX)?.[1]?.trim();
    return loc && (targetLocs.has(loc) || removals.has(loc)) ? "" : block;
  });
  const closeIndex = output.lastIndexOf("</urlset>");
  const addition = rows.map(renderEntry).join("\n");
  output = `${output.slice(0, closeIndex).trimEnd()}\n${addition}\n${output.slice(closeIndex)}`;
  const count = [...output.matchAll(URL_BLOCK_RX)].length;
  if (count > maxUrls)
    throw new Error(
      `[jobs-fast-sitemap] ${label} would exceed ${maxUrls} URLs (${count})`,
    );
  return output;
}

/** Add/update job detail entries while retaining every unrelated live URL. */
export function mergeFastJobsSitemap(xml, entries, options = {}) {
  return mergeUrlset(xml, entries, {
    label: "sitemap-jobs.xml",
    ...options,
    renderEntry: (entry) => {
      if (
        typeof entry.urlEntry !== "string" ||
        !entry.urlEntry.startsWith(" <url>")
      ) {
        throw new Error(
          "[jobs-fast-sitemap] missing renderer-owned IT URL entry",
        );
      }
      return entry.urlEntry;
    },
  });
}

/** Add/update non-IT variants using the same formatter as full sitemap builds. */
export function mergeFastJobVariantShard(xml, entries, options = {}) {
  return mergeUrlset(xml, entries, {
    label: "localized job sitemap shard",
    ...options,
    renderEntry: (entry) => {
      const rendered = emitSitemapXml([entry]);
      const block = rendered.match(URL_BLOCK_RX)?.[0];
      if (!block)
        throw new Error("[jobs-fast-sitemap] could not render variant entry");
      return block;
    },
  });
}

/** List the indexed parts of one canton/locale's bounded shard set. */
export function listJobVariantShardFilenames(indexXml, cantonSlug, locale) {
  if (
    !/^[a-z0-9-]+$/u.test(cantonSlug) ||
    !["en", "de", "fr"].includes(locale)
  ) {
    throw new Error("[jobs-fast-sitemap] invalid canton/locale shard key");
  }
  const prefix = `sitemap-jobs-${cantonSlug}-${locale}`;
  const rx = new RegExp(`^${prefix}(?:-(\\d{3}))?\\.xml$`, "u");
  const names = [
    ...new Set(
      [
        ...String(indexXml || "").matchAll(
          /<loc>\s*https:\/\/frontaliereticino\.ch\/([^<]+?)\s*<\/loc>/g,
        ),
      ]
        .map((match) => match[1].trim())
        .filter((name) => rx.test(name)),
    ),
  ];
  names.sort((a, b) => {
    const na = Number(rx.exec(a)?.[1] || 0);
    const nb = Number(rx.exec(b)?.[1] || 0);
    return na - nb;
  });
  return names;
}

/** Pick the highest published part of one canton/locale's bounded shard set. */
export function selectJobVariantShardFilename(indexXml, cantonSlug, locale) {
  const prefix = `sitemap-jobs-${cantonSlug}-${locale}`;
  const names = listJobVariantShardFilenames(indexXml, cantonSlug, locale);
  return names.at(-1) || `${prefix}.xml`;
}

/** Select the next bounded part after the current highest variant shard. */
export function nextJobVariantShardFilename(indexXml, cantonSlug, locale) {
  const current = selectJobVariantShardFilename(indexXml, cantonSlug, locale);
  const suffix = current.match(/-(\d{3})\.xml$/u)?.[1];
  const nextPart = suffix ? Number(suffix) + 1 : 1;
  if (nextPart > 999)
    throw new Error(
      `[jobs-fast-sitemap] variant shard limit reached for ${cantonSlug}-${locale}`,
    );
  return `sitemap-jobs-${cantonSlug}-${locale}-${String(nextPart).padStart(3, "0")}.xml`;
}

/** Ensure updated variant shards remain discoverable from sitemap-index.xml. */
export function mergeFastJobSitemapIndex(
  indexXml,
  filenames,
  lastmod = new Date().toISOString().slice(0, 10),
) {
  if (
    typeof indexXml !== "string" ||
    !indexXml.includes("<sitemapindex") ||
    !indexXml.includes("</sitemapindex>")
  ) {
    throw new Error("[jobs-fast-sitemap] invalid sitemap-index.xml");
  }
  const wanted = [...new Set(filenames)].sort();
  let output = indexXml;
  for (const filename of wanted) {
    if (!/^sitemap-jobs-[a-z0-9-]+\.xml$/u.test(filename)) {
      throw new Error(`[jobs-fast-sitemap] invalid shard filename ${filename}`);
    }
    const loc = `https://frontaliereticino.ch/${filename}`;
    let found = false;
    output = output.replace(SITEMAP_BLOCK_RX, (block) => {
      if (!block.includes(`<loc>${loc}</loc>`)) return block;
      found = true;
      if (/<lastmod>[^<]*<\/lastmod>/.test(block)) {
        return block.replace(
          /<lastmod>[^<]*<\/lastmod>/,
          `<lastmod>${escapeXml(lastmod)}</lastmod>`,
        );
      }
      return block.replace(
        "</sitemap>",
        `  <lastmod>${escapeXml(lastmod)}</lastmod>\n</sitemap>`,
      );
    });
    if (!found) {
      output = output.replace(
        "</sitemapindex>",
        `  <sitemap>\n    <loc>${loc}</loc>\n    <lastmod>${escapeXml(lastmod)}</lastmod>\n  </sitemap>\n</sitemapindex>`,
      );
    }
  }
  return output;
}

export const JOBS_FAST_SITEMAP_DEFAULTS = Object.freeze({ maxUrls: SITEMAP_SHARD_CAP });
