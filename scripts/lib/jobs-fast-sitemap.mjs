import { emitSitemapXml } from "./sitemap-shard.mjs";

const URL_BLOCK_RX = /<url>[\s\S]*?<\/url>/g;
const LOC_RX = /<loc>\s*([^<]+?)\s*<\/loc>/;
const SITEMAP_BLOCK_RX = /<sitemap>[\s\S]*?<\/sitemap>/g;

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
  { label, maxUrls = 50_000, removeLocs = [], renderEntry },
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

export const JOBS_FAST_SITEMAP_DEFAULTS = Object.freeze({ maxUrls: 50_000 });
