#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs, { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isFixtureJob } from "./lib/fixture-data-filter.mjs";
import {
  discoverFastPublishJobs,
  markFastPublishJobsPublished,
} from "./lib/jobs-fast-publish-state.mjs";
import {
  mergeFastJobSitemapIndex,
  mergeFastJobVariantShard,
  mergeFastJobsSitemap,
  listJobVariantShardFilenames,
  nextJobVariantShardFilename,
  selectJobVariantShardFilename,
} from "./lib/jobs-fast-sitemap.mjs";
import {
  acquireShardWriterLeases,
  releaseShardWriterLeases,
  renewShardWriterLeases,
  SHARD_WRITER_LOCK_DEFAULTS,
} from "./lib/shard-writer-lease.mjs";
import { stableJobId } from "../build-plugins/shared/stableJobId.mjs";
import {
  isListingInventoryJob,
  normalizeListingIdentity,
} from "../services/jobBoardInventory.ts";
import { SPA_ENTRY_JS_FILENAME } from "../build-plugins/shared/spaEntryFilenames.ts";
import { validateMandatoryJobPostingFields } from "./lib/jobposting-mandatory-fields.mjs";
import { APEX_HOST } from "./lib/cf-worker-routes.mjs";
import { MAX_TARGETED_FILES } from "./lib/cf-purge-limits.mjs";
import { SECTION_ORIGIN } from "../infra/cloudflare-worker/locale-router.js";

const BASE_URL = "https://frontaliereticino.ch";
const LOCALES = ["it", "en", "de", "fr"];
const MAX_PAGES_PER_RUN = 200;
const MAX_OFFERS_PER_RUN = 50;
const REQUEST_TIMEOUT_MS = 15_000;
const RENDER_RECEIPT_SCHEMA = "jobs-fast-render/v1";
const FAST_LANE_USER_AGENT =
  "FrontaliereJobsFastPublisher/1.0 (+https://frontaliereticino.ch)";

export function buildFastLaneRequestHeaders(accept = "*/*") {
  return { accept, "user-agent": FAST_LANE_USER_AGENT };
}

function parseArgs(argv) {
  const args = { dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--publish") args.dryRun = false;
    else throw new Error(`[jobs-fast] unexpected argument ${arg}`);
  }
  return args;
}

function rootFromEnv() {
  return path.resolve(process.env.GITHUB_WORKSPACE || process.cwd());
}

function fastLaneLocalizedSlug(job, locale) {
  return String(job?.slugByLocale?.[locale] || job?.slug || "").trim();
}

function canonicalPathsForFastLaneJob(
  job,
  { buildCanonicalJobDetailPath, resolveJobCanton },
) {
  const canton = resolveJobCanton(job);
  return LOCALES.map((locale) =>
    buildCanonicalJobDetailPath(
      locale,
      job,
      fastLaneLocalizedSlug(job, locale),
      canton,
    ),
  );
}

async function getLiveBuildId() {
  const response = await fetch(`${BASE_URL}/build-id.txt`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: buildFastLaneRequestHeaders("text/plain"),
  });
  if (!response.ok)
    throw new Error(
      `[jobs-fast] live build-id.txt returned HTTP ${response.status}`,
    );
  const buildId = (await response.text()).trim();
  if (!/^\d{10,16}$/u.test(buildId))
    throw new Error("[jobs-fast] live build id is missing or malformed");
  return buildId;
}

async function fetchLiveText(url, { allowMissing = false } = {}) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: buildFastLaneRequestHeaders(
      "text/html,application/xml,text/plain;q=0.9,*/*;q=0.5",
    ),
  });
  if (allowMissing && response.status === 404) return null;
  if (!response.ok)
    throw new Error(
      `[jobs-fast] GET ${new URL(url).pathname} returned HTTP ${response.status}`,
    );
  return response.text();
}

async function fetchLiveTextWithRetry(
  url,
  { attempts = 6, initialDelayMs = 1_500 } = {},
) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fetchLiveText(url);
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts)
        await new Promise((resolve) =>
          setTimeout(resolve, initialDelayMs * 2 ** attempt),
        );
    }
  }
  throw (
    lastError ||
    new Error(
      `[jobs-fast] live verification failed for ${new URL(url).pathname}`,
    )
  );
}

async function fetchLiveStatus(url) {
  const response = await fetch(url, {
    method: "GET",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: buildFastLaneRequestHeaders("text/html"),
  });
  return response.status;
}

function extractAttr(tag, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return (
    tag
      .match(
        new RegExp(
          `(?:^|\\s)${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
          "iu",
        ),
      )
      ?.slice(1)
      .find((value) => value != null) || ""
  );
}

/** A static page has analytics through gtag.js or the hydrating SPA entry. */
export function hasGoogleAnalyticsRuntime(html) {
  const scriptTags = [...String(html || "").matchAll(/<script\b[^>]*>/giu)].map(
    (match) => match[0],
  );
  return scriptTags.some((tag) => {
    const src = extractAttr(tag, "src");
    if (!src) return false;
    try {
      const asset = new URL(src, BASE_URL);
      if (
        asset.protocol === "https:" &&
        asset.hostname === "www.googletagmanager.com" &&
        asset.pathname === "/gtag/js"
      ) {
        return true;
      }
      return (
        asset.origin === BASE_URL &&
        asset.pathname === `/assets/${SPA_ENTRY_JS_FILENAME}`
      );
    } catch {
      return false;
    }
  });
}

function extractJobPosting(html) {
  const scripts = [
    ...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/giu),
  ];
  for (const match of scripts) {
    if (!/application\/ld\+json/iu.test(match[1])) continue;
    let parsed;
    try {
      parsed = JSON.parse(match[2].trim());
    } catch {
      continue;
    }
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    for (const row of rows) {
      const graph = Array.isArray(row?.["@graph"]) ? row["@graph"] : [];
      const candidate = [row, ...graph].find((item) => {
        const type = Array.isArray(item?.["@type"])
          ? item["@type"]
          : [item?.["@type"]];
        return type.includes("JobPosting");
      });
      if (candidate) return candidate;
    }
  }
  return null;
}

function extractLink(html, rel) {
  const tags = [...html.matchAll(/<link\b[^>]*>/giu)].map((match) => match[0]);
  const hrefs = tags
    .filter((tag) =>
      extractAttr(tag, "rel").toLowerCase().split(/\s+/u).includes(rel),
    )
    .map((tag) => extractAttr(tag, "href"));
  return hrefs.length === 1 ? hrefs[0] : "";
}

function extractAlternates(html) {
  const alternates = new Map();
  for (const match of html.matchAll(/<link\b[^>]*>/giu)) {
    const tag = match[0];
    if (
      !extractAttr(tag, "rel").toLowerCase().split(/\s+/u).includes("alternate")
    )
      continue;
    const locale = extractAttr(tag, "hreflang").toLowerCase();
    const href = extractAttr(tag, "href");
    if (locale)
      alternates.set(locale, [...(alternates.get(locale) || []), href]);
  }
  return alternates;
}

function extractRobots(html) {
  const values = [];
  for (const match of html.matchAll(/<meta\b[^>]*>/giu)) {
    const tag = match[0];
    const name = extractAttr(tag, "name").toLowerCase();
    if (name === "robots" || name === "googlebot")
      values.push(extractAttr(tag, "content").toLowerCase());
  }
  return values;
}

/** Collect fetchable same-origin resources without treating SEO links as assets. */
export function extractFirstPartyAssetUrls(html) {
  const assets = new Set();
  for (const match of html.matchAll(/<(?:script|img|source)\b[^>]*>/giu)) {
    const value = extractAttr(match[0], "src");
    if (value) assets.add(value);
  }
  for (const match of html.matchAll(/<meta\b[^>]*>/giu)) {
    const tag = match[0];
    if (extractAttr(tag, "property").toLowerCase() === "og:image") {
      const value = extractAttr(tag, "content");
      if (value) assets.add(value);
    }
  }
  const fetchableLinkRels = new Set([
    "stylesheet",
    "modulepreload",
    "icon",
    "apple-touch-icon",
    "mask-icon",
  ]);
  for (const match of html.matchAll(/<link\b[^>]*>/giu)) {
    const tag = match[0];
    const rels = extractAttr(tag, "rel").toLowerCase().split(/\s+/u);
    if (!rels.some((rel) => fetchableLinkRels.has(rel))) continue;
    const value = extractAttr(tag, "href");
    if (value) assets.add(value);
  }
  return [...assets]
    .filter((asset) => {
      try {
        const url = new URL(asset, BASE_URL);
        return (
          url.protocol === "https:" &&
          ["frontaliereticino.ch", "cdn.frontaliereticino.ch"].includes(
            url.hostname,
          )
        );
      } catch {
        return false;
      }
    })
    .sort();
}

function checkJobPageContracts(receipt, batchIds) {
  if (
    receipt?.schema !== RENDER_RECEIPT_SCHEMA ||
    !Array.isArray(receipt.pages)
  ) {
    throw new Error(
      "[jobs-fast] renderer receipt is missing or has an unknown schema",
    );
  }
  const expected = new Set(batchIds);
  const pagesById = new Map();
  const urlOwner = new Map();
  for (const page of receipt.pages) {
    if (
      !expected.has(page.id) ||
      !LOCALES.includes(page.locale) ||
      !String(page.path).endsWith("/")
    ) {
      throw new Error(
        "[jobs-fast] renderer returned an unexpected or non-canonical offer path",
      );
    }
    const key = `${page.id}:${page.locale}`;
    if (urlOwner.has(key))
      throw new Error("[jobs-fast] renderer returned duplicate locale pages");
    urlOwner.set(key, page.path);
    if (!pagesById.has(page.id)) pagesById.set(page.id, []);
    pagesById.get(page.id).push(page);
  }
  for (const id of expected) {
    const pages = pagesById.get(id) || [];
    if (
      pages.length !== LOCALES.length ||
      new Set(pages.map((page) => page.locale)).size !== LOCALES.length
    ) {
      throw new Error(
        "[jobs-fast] each active offer must render exactly four locale pages",
      );
    }
  }

  for (const page of receipt.pages) {
    const file = path.resolve(
      process.env.JOBS_FAST_DIST_DIR,
      page.path.replace(/^\/+|\/+$/gu, ""),
      "index.html",
    );
    const relative = path.relative(process.env.JOBS_FAST_DIST_DIR, file);
    if (
      !relative ||
      relative.startsWith("..") ||
      path.isAbsolute(relative) ||
      !fs.existsSync(file)
    ) {
      throw new Error(
        "[jobs-fast] rendered offer page is missing or escaped dist",
      );
    }
    const html = fs.readFileSync(file, "utf8");
    const posting = extractJobPosting(html);
    if (!posting)
      throw new Error(
        `[jobs-fast] JobPosting JSON-LD is missing for ${page.locale} offer page`,
      );
    const errors = validateMandatoryJobPostingFields(posting);
    if (errors.length > 0) {
      throw new Error(
        `[jobs-fast] JobPosting mandatory field validation failed for ${page.locale}: ${errors.map((item) => item.field).join(", ")}`,
      );
    }
    const canonical = extractLink(html, "canonical");
    if (canonical !== `${BASE_URL}${page.path}`)
      throw new Error(
        `[jobs-fast] canonical URL mismatch for ${page.locale} offer page`,
      );
    const robots = extractRobots(html);
    const noindex = robots.some((value) => /\bnoindex\b/u.test(value));
    if (!noindex && !robots.some((value) => /\bindex\b/u.test(value))) {
      throw new Error(
        `[jobs-fast] robots directives are missing for ${page.locale} offer page`,
      );
    }
    if (
      !html.includes("adsbygoogle") ||
      !hasGoogleAnalyticsRuntime(html)
    ) {
      throw new Error(
        `[jobs-fast] AdSense or Google Analytics runtime is missing for ${page.locale} offer page`,
      );
    }
    page._html = html;
    page._noindex = noindex;
    page._alternates = extractAlternates(html);
  }

  const sitemapLocs = new Set(
    (receipt.sitemapEntries || []).flatMap((entry) => [
      entry.loc,
      ...(entry.variants || []).map((variant) => variant.loc),
    ]),
  );
  for (const pages of pagesById.values()) {
    const expectedAlternates = new Set(
      pages.map((page) => `${BASE_URL}${page.path}`),
    );
    for (const page of pages) {
      const alternates = page._alternates;
      for (const locale of LOCALES) {
        const hrefs = alternates.get(locale) || [];
        if (hrefs.length !== 1 || !expectedAlternates.has(hrefs[0]))
          throw new Error(
            `[jobs-fast] incomplete or duplicate hreflang set for ${page.locale} offer page`,
          );
      }
      const xDefaults = alternates.get("x-default") || [];
      if (
        xDefaults.length !== 1 ||
        xDefaults[0] !==
          `${BASE_URL}${pages.find((candidate) => candidate.locale === "it")?.path}`
      ) {
        throw new Error(
          `[jobs-fast] x-default is missing, duplicated, or does not point to the Italian page for ${page.locale} offer page`,
        );
      }
      const pageUrl = `${BASE_URL}${page.path}`;
      if (!page._noindex && !sitemapLocs.has(pageUrl)) {
        throw new Error(
          `[jobs-fast] indexable offer page is missing from the jobs sitemap receipt: ${page.path}`,
        );
      }
      if (page._noindex && sitemapLocs.has(pageUrl)) {
        throw new Error(
          "[jobs-fast] noindex offer page is present in the jobs sitemap receipt",
        );
      }
      delete page._html;
      delete page._noindex;
      delete page._alternates;
    }
  }
}

function routeToDistFile(distDir, route) {
  if (
    typeof route !== "string" ||
    !route.startsWith("/") ||
    !route.endsWith("/")
  ) {
    throw new Error(
      `[jobs-fast] route must be an absolute trailing-slash path: ${route}`,
    );
  }
  const segments = route.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === ".."))
    throw new Error("[jobs-fast] route escaped dist");
  return path.join(distDir, ...segments, "index.html");
}

function sectionForRoute(route, slugToSection) {
  const segments = route.split("/").filter(Boolean);
  if (["en", "de", "fr"].includes(segments[0])) segments.shift();
  const section = slugToSection.get(segments[0]);
  if (!section)
    throw new Error(`[jobs-fast] cannot resolve section shard for ${route}`);
  return section;
}

function localeForRoute(route) {
  const first = route.split("/").filter(Boolean)[0];
  return ["en", "de", "fr"].includes(first) ? first : "it";
}

function copyRenderedRoute(sourceDist, targetDist, route) {
  const source = routeToDistFile(sourceDist, route);
  if (!fs.existsSync(source) || !fs.statSync(source).isFile())
    throw new Error(`[jobs-fast] rendered output is missing for ${route}`);
  const target = routeToDistFile(targetDist, route);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  return target;
}

function buildScopePlan(receipt, slugToSection, sourceDist, rootTemp) {
  const sections = new Map();
  const register = (route, copySource = true) => {
    const section = sectionForRoute(route, slugToSection);
    const locale = localeForRoute(route);
    const key = `${section}:${locale}`;
    if (!sections.has(key)) {
      const distDir = path.join(
        rootTemp,
        "section-payloads",
        section,
        locale,
        "dist",
      );
      sections.set(key, { section, locale, distDir, routes: new Set() });
    }
    const target = sections.get(key);
    const targetFile = routeToDistFile(target.distDir, route);
    if (!target.routes.has(route)) {
      if (copySource) copyRenderedRoute(sourceDist, target.distDir, route);
      else fs.mkdirSync(path.dirname(targetFile), { recursive: true });
      target.routes.add(route);
    }
    return targetFile;
  };
  for (const page of receipt.pages) register(page.path);
  return { sections, register };
}

async function validateFirstPartyAssets(receipt) {
  const assets = new Set();
  for (const page of receipt.pages) {
    const file = routeToDistFile(process.env.JOBS_FAST_DIST_DIR, page.path);
    const html = fs.readFileSync(file, "utf8");
    for (const asset of extractFirstPartyAssetUrls(html)) assets.add(asset);
  }
  const unique = [...assets];
  let next = 0;
  const failures = [];
  const workers = Array.from(
    { length: Math.min(12, unique.length) },
    async () => {
      while (next < unique.length) {
        const asset = unique[next++];
        const url = new URL(asset, BASE_URL);
        try {
          let response = await fetch(url, {
            method: "HEAD",
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            headers: buildFastLaneRequestHeaders(),
          });
          if (
            !response.ok &&
            (response.status === 405 || response.status === 501)
          ) {
            response = await fetch(url, {
              method: "GET",
              signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
              headers: buildFastLaneRequestHeaders(),
            });
          }
          if (!response.ok)
            failures.push(`${url.pathname} HTTP ${response.status}`);
        } catch (error) {
          failures.push(`${url.pathname} ${error?.name || "request failed"}`);
        }
      }
    },
  );
  await Promise.all(workers);
  if (failures.length > 0)
    throw new Error(
      `[jobs-fast] first-party page assets are unavailable (${failures.slice(0, 8).join("; ")})`,
    );
  console.log(`[jobs-fast] first-party assets verified=${unique.length}`);
}

function prepareOffloadedSample(rootDir, samplePage, stagingRoot) {
  const input = routeToDistFile(
    process.env.JOBS_FAST_DIST_DIR,
    samplePage.path,
  );
  const relative = path
    .relative(process.env.JOBS_FAST_DIST_DIR, input)
    .split(path.sep)
    .join("/");
  const sampleRoot = path.join(stagingRoot, "parity");
  const distDir = path.join(sampleRoot, "dist");
  const output = routeToDistFile(distDir, samplePage.path);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.copyFileSync(input, output);
  const fileList = path.join(sampleRoot, "files.txt");
  fs.writeFileSync(fileList, `${relative}\n`);
  return {
    sampleRoot,
    distDir,
    fileList,
    output,
    script: path.join(rootDir, "scripts/offload-generated-images-cdn.mjs"),
  };
}

async function verifyDryRunParity(
  rootDir,
  receipt,
  batchIds,
  liveEligibleSample,
  stagingRoot,
) {
  let compared = 0;
  for (const locale of LOCALES) {
    const sample = receipt.pages.find(
      (page) => page.id === liveEligibleSample.id && page.locale === locale,
    );
    if (!sample)
      throw new Error(
        `[jobs-fast] parity sample was not rendered in ${locale}`,
      );
    const staged = prepareOffloadedSample(rootDir, sample, stagingRoot);
    const result = spawnSync(
      process.execPath,
      [staged.script, "--files-from", staged.fileList],
      {
        cwd: staged.sampleRoot,
        env: { ...process.env, CDN_BASE: "https://cdn.frontaliereticino.ch" },
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    if (result.status !== 0)
      throw new Error(
        `[jobs-fast] parity CDN rewrite failed: ${(result.stderr || result.stdout || "").trim()}`,
      );
    const live = await fetchLiveText(`${BASE_URL}${sample.path}`);
    const expected = fs.readFileSync(staged.output, "utf8");
    if (live !== expected) {
      throw new Error(
        `[jobs-fast] dry-run byte parity failed for ${locale} sample (${sample.path}); no pages were published`,
      );
    }
    compared += 1;
  }
  console.log(
    `[jobs-fast] dry-run byte parity=identical sample_pages=${compared} offers=${batchIds.length}`,
  );
}

async function prepareSitemapUpdates(
  receipt,
  tempDir,
  previousPaths,
  slugToSection,
  sectionSlugs,
  liveJobsSitemapXml,
) {
  const sitemapDir = path.join(tempDir, "sitemap-payload");
  fs.mkdirSync(sitemapDir, { recursive: true });
  const updates = new Map();
  const removalsByPath = new Map();
  const recordRemoval = (pathname, loc) => {
    if (!removalsByPath.has(pathname)) removalsByPath.set(pathname, new Set());
    removalsByPath.get(pathname).add(loc);
  };
  const entries = Array.isArray(receipt.sitemapEntries)
    ? receipt.sitemapEntries
    : [];
  const currentLocs = new Set(
    entries.flatMap((entry) => [
      entry.loc,
      ...(entry.variants || []).map((variant) => variant.loc),
    ]),
  );
  const oldPaths = [...new Set(previousPaths)].filter(
    (route) =>
      typeof route === "string" && route.startsWith("/") && route.endsWith("/"),
  );
  const oldLocs = oldPaths
    .map((route) => ({
      route,
      loc: `${BASE_URL}${route}`,
      locale: localeForRoute(route),
    }))
    .filter(({ loc }) => !currentLocs.has(loc));
  const itRemovals = oldLocs
    .filter((item) => item.locale === "it")
    .map((item) => item.loc);
  if (entries.length > 0 || itRemovals.length > 0) {
    const jobsXml =
      liveJobsSitemapXml ??
      (await fetchLiveText(`${BASE_URL}/sitemap-jobs.xml`));
    updates.set(
      "/sitemap-jobs.xml",
      mergeFastJobsSitemap(jobsXml, entries, { removeLocs: itRemovals }),
    );
    for (const loc of itRemovals) recordRemoval("/sitemap-jobs.xml", loc);
  }

  const variants = new Map();
  for (const entry of entries) {
    for (const variant of entry.variants || []) {
      const key = `${variant.cantonSlug}:${variant.locale}`;
      if (!variants.has(key)) variants.set(key, { entries: [], removals: [] });
      variants.get(key).entries.push(variant);
    }
  }
  for (const old of oldLocs.filter((item) => item.locale !== "it")) {
    const section = sectionForRoute(old.route, slugToSection);
    const cantonSlug = sectionSlugs[section]?.it;
    if (!cantonSlug)
      throw new Error(
        `[jobs-fast] cannot resolve previous sitemap shard for ${old.route}`,
      );
    const key = `${cantonSlug}:${old.locale}`;
    if (!variants.has(key)) variants.set(key, { entries: [], removals: [] });
    variants.get(key).removals.push(old.loc);
  }

  if (variants.size === 0)
    return { ...writeSitemapPayloads(updates, sitemapDir), removalsByPath };
  let indexXml = await fetchLiveText(`${BASE_URL}/sitemap-index.xml`);
  let indexChanged = false;
  const createdFiles = new Set();
  const liveFiles = new Map();
  const loadFile = async (filename) => {
    if (liveFiles.has(filename)) return liveFiles.get(filename);
    if (createdFiles.has(filename)) return "";
    const published = indexXml.includes(
      `https://frontaliereticino.ch/${filename}`,
    );
    const xml = published ? await fetchLiveText(`${BASE_URL}/${filename}`) : "";
    liveFiles.set(filename, xml);
    return xml;
  };
  const mutations = new Map();
  const mutation = (filename) => {
    if (!mutations.has(filename))
      mutations.set(filename, { entries: [], removals: new Set() });
    return mutations.get(filename);
  };

  for (const [key, shardChanges] of variants) {
    const [cantonSlug, locale] = key.split(":");
    const filenames = listJobVariantShardFilenames(
      indexXml,
      cantonSlug,
      locale,
    );
    for (const oldLoc of shardChanges.removals) {
      for (const filename of [...filenames].reverse()) {
        const xml = await loadFile(filename);
        if (extractXmlLocs(xml).has(oldLoc)) {
          mutation(filename).removals.add(oldLoc);
          recordRemoval(`/${filename}`, oldLoc);
          break;
        }
      }
    }

    if (shardChanges.entries.length > 0) {
      let filename = selectJobVariantShardFilename(
        indexXml,
        cantonSlug,
        locale,
      );
      const wasPublished = indexXml.includes(
        `https://frontaliereticino.ch/${filename}`,
      );
      const existing = await loadFile(filename);
      try {
        mergeFastJobVariantShard(existing, shardChanges.entries, {
          removeLocs: [...mutation(filename).removals],
        });
      } catch (error) {
        if (!/would exceed 50000 URLs/u.test(String(error?.message || error)))
          throw error;
        filename = nextJobVariantShardFilename(indexXml, cantonSlug, locale);
        indexXml = mergeFastJobSitemapIndex(indexXml, [filename]);
        indexChanged = true;
        createdFiles.add(filename);
      }
      if (
        filename ===
          selectJobVariantShardFilename(indexXml, cantonSlug, locale) &&
        !wasPublished
      ) {
        indexXml = mergeFastJobSitemapIndex(indexXml, [filename]);
        indexChanged = true;
        createdFiles.add(filename);
      }
      mutation(filename).entries.push(...shardChanges.entries);
    }
  }

  for (const [filename, changes] of mutations) {
    const liveXml = await loadFile(filename);
    const xml = mergeFastJobVariantShard(liveXml, changes.entries, {
      removeLocs: [...changes.removals],
    });
    updates.set(`/${filename}`, xml);
  }
  if (indexChanged) updates.set("/sitemap-index.xml", indexXml);
  return { ...writeSitemapPayloads(updates, sitemapDir), removalsByPath };
}

function writeSitemapPayloads(updates, sitemapDir) {
  for (const [pathname, xml] of updates) {
    if (
      typeof xml !== "string" ||
      !xml.startsWith("<?xml") ||
      !xml.includes("</")
    ) {
      throw new Error(`[jobs-fast] merged sitemap is malformed: ${pathname}`);
    }
    fs.writeFileSync(path.join(sitemapDir, pathname.slice(1)), xml);
  }
  return { updates, sitemapDir };
}

function shardPurgeBatches(receipt, slugToSection) {
  const urls = new Set();
  const routes = [
    ...(receipt.pages || []).map((page) => page.path),
    ...(receipt.hubUpdates || []).map((update) => update.path),
  ];
  for (const route of routes) {
    const section = sectionForRoute(route, slugToSection);
    const locale = localeForRoute(route);
    const origin = SECTION_ORIGIN[section]?.[locale];
    if (!origin)
      throw new Error(
        `[jobs-fast] no Worker origin for ${section}/${locale} (${route})`,
      );
    urls.add(`https://${APEX_HOST}${route}`);
    urls.add(`https://${origin}${route}`);
  }
  const values = [...urls];
  const batches = [];
  for (let index = 0; index < values.length; index += MAX_TARGETED_FILES) {
    batches.push(values.slice(index, index + MAX_TARGETED_FILES));
  }
  return batches;
}

async function purgePublishedShardPages(
  rootDir,
  receipt,
  slugToSection,
  heartbeat,
) {
  if (!process.env.CF_API_TOKEN)
    throw new Error(
      "[jobs-fast] CF_API_TOKEN is required to purge updated shard pages",
    );
  const batches = shardPurgeBatches(receipt, slugToSection);
  for (const urls of batches) {
    heartbeat.assertHealthy();
    const result = await runChild(
      process.execPath,
      [
        path.join(rootDir, "scripts/cf-purge-cache.mjs"),
        `--files=${urls.join(",")}`,
      ],
      (running) => heartbeat.setChild(running),
    );
    heartbeat.setChild(null);
    heartbeat.assertHealthy();
    if (result.error) throw result.error;
    if (result.code !== 0)
      throw new Error(
        `[jobs-fast] section-page cache purge failed (exit ${result.code})`,
      );
  }
  console.log(
    `[jobs-fast] shard page cache purges=${batches.length} urls=${batches.reduce((count, batch) => count + batch.length, 0)}`,
  );
}

function extractXmlLocs(xml) {
  return new Set(
    [...String(xml).matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gu)].map((match) =>
      match[1].trim(),
    ),
  );
}

function extractSitemapUrls(xml) {
  const urls = extractXmlLocs(xml);
  for (const match of String(xml).matchAll(/\bhref\s*=\s*["']([^"']+)['"]/gu))
    urls.add(match[1].trim());
  return urls;
}

export function buildFastLaneHubVisibleJobIdsByLocale(
  jobs,
  selectedIds,
  liveJobsSitemapXml,
  { buildCanonicalJobDetailPath, resolveJobCanton },
) {
  if (!Array.isArray(jobs) || !Array.isArray(selectedIds))
    throw new Error("[jobs-fast] hub visibility inputs must be arrays");
  const liveUrls = extractSitemapUrls(liveJobsSitemapXml);
  const selected = new Set(
    selectedIds.map((id) => String(id).trim()).filter(Boolean),
  );
  const visibleByLocale = {};
  for (const locale of LOCALES) {
    const visible = new Set(selected);
    for (const job of jobs) {
      const id = stableJobId(job);
      if (!id || visible.has(id)) continue;
      const slug = fastLaneLocalizedSlug(job, locale);
      if (!slug) continue;
      const path = buildCanonicalJobDetailPath(
        locale,
        job,
        slug,
        resolveJobCanton(job),
      );
      if (liveUrls.has(`${BASE_URL}${path}`)) visible.add(id);
    }
    visibleByLocale[locale] = [...visible].sort();
  }
  return visibleByLocale;
}

async function verifyPublishedPagesAndSitemaps(
  receipt,
  sitemapUpdates,
  sourceDist,
  removalsByPath = new Map(),
) {
  const pagesById = new Map();
  for (const page of receipt.pages || []) {
    if (!pagesById.has(page.id)) pagesById.set(page.id, []);
    pagesById.get(page.id).push(page);
  }
  for (const page of receipt.pages || []) {
    const html = await fetchLiveTextWithRetry(`${BASE_URL}${page.path}`);
    const posting = extractJobPosting(html);
    const sourceHtml = fs.readFileSync(
      routeToDistFile(sourceDist, page.path),
      "utf8",
    );
    const sourcePosting = extractJobPosting(sourceHtml);
    if (!posting || validateMandatoryJobPostingFields(posting).length > 0) {
      throw new Error(
        `[jobs-fast] live JobPosting contract failed for ${page.locale} ${page.path}`,
      );
    }
    if (
      !sourcePosting ||
      JSON.stringify(posting) !== JSON.stringify(sourcePosting)
    ) {
      throw new Error(
        `[jobs-fast] live JobPosting differs from the rendered offer for ${page.locale} ${page.path}`,
      );
    }
    if (extractLink(html, "canonical") !== `${BASE_URL}${page.path}`) {
      throw new Error(
        `[jobs-fast] live canonical mismatch for ${page.locale} ${page.path}`,
      );
    }
    if (
      !html.includes("adsbygoogle") ||
      !hasGoogleAnalyticsRuntime(html)
    ) {
      throw new Error(
        `[jobs-fast] live AdSense or analytics runtime is missing for ${page.locale} ${page.path}`,
      );
    }
    const robots = extractRobots(html);
    const sourceRobots = extractRobots(sourceHtml);
    if (
      robots.some((value) => /\bnoindex\b/u.test(value)) !==
      sourceRobots.some((value) => /\bnoindex\b/u.test(value))
    ) {
      throw new Error(
        `[jobs-fast] live robots directive differs from the rendered offer for ${page.locale} ${page.path}`,
      );
    }
    const alternates = extractAlternates(html);
    const expectedPages = pagesById.get(page.id) || [];
    const expectedByLocale = new Map(
      expectedPages.map((candidate) => [
        candidate.locale,
        `${BASE_URL}${candidate.path}`,
      ]),
    );
    for (const locale of LOCALES) {
      const hrefs = alternates.get(locale) || [];
      if (hrefs.length !== 1 || hrefs[0] !== expectedByLocale.get(locale)) {
        throw new Error(
          `[jobs-fast] live hreflang ${locale} is missing, duplicated, or mismatched for ${page.path}`,
        );
      }
    }
    const xDefaults = alternates.get("x-default") || [];
    if (xDefaults.length !== 1 || xDefaults[0] !== expectedByLocale.get("it")) {
      throw new Error(`[jobs-fast] live x-default mismatch for ${page.path}`);
    }
  }

  for (const update of receipt.hubUpdates || []) {
    const expectedBlock = String(
      update.kind === "ticino" ? update.block || "" : update.grid || "",
    );
    if (!expectedBlock)
      throw new Error(
        `[jobs-fast] rendered hub update is empty for ${update.path}`,
      );
    const html = await fetchLiveTextWithRetry(`${BASE_URL}${update.path}`);
    if (!html.includes(expectedBlock))
      throw new Error(
        `[jobs-fast] live hub/list update is missing for ${update.path}`,
      );
  }

  for (const [pathname, expectedXml] of sitemapUpdates) {
    const liveXml = await fetchLiveTextWithRetry(`${BASE_URL}${pathname}`);
    const expectedLocs = extractXmlLocs(expectedXml);
    const liveLocs = extractXmlLocs(liveXml);
    for (const loc of expectedLocs) {
      if (!liveLocs.has(loc))
        throw new Error(
          `[jobs-fast] live sitemap ${pathname} is missing ${loc}`,
        );
    }
    for (const loc of removalsByPath.get(pathname) || []) {
      if (liveLocs.has(loc))
        throw new Error(
          `[jobs-fast] live sitemap ${pathname} still contains removed ${loc}`,
        );
    }
  }
  console.log(
    `[jobs-fast] live verification=passed detail_pages=${(receipt.pages || []).length} sitemap_files=${sitemapUpdates.size}`,
  );
}

async function selectLiveParitySample(validJobs, pendingIds, helpers) {
  const { buildCanonicalJobDetailPath, resolveJobCanton } = helpers;
  let tried = 0;
  for (const job of validJobs) {
    const id = stableJobId(job);
    if (!id || pendingIds.has(id)) continue;
    const canton = resolveJobCanton(job);
    const pathIt = buildCanonicalJobDetailPath(
      "it",
      job,
      job.slugByLocale?.it || job.slug,
      canton,
    );
    try {
      const status = await fetchLiveStatus(`${BASE_URL}${pathIt}`);
      if (status === 200) return { id };
    } catch {
      // The bounded scan moves to the next candidate; no partial publish follows a failed parity check.
    }
    tried += 1;
    if (tried >= 30) break;
  }
  throw new Error(
    "[jobs-fast] no already-live active offer is available for byte-parity sampling",
  );
}

function selectBatch(candidates, resolveJobCanton) {
  const selected = [];
  const cantons = new Set();
  for (const candidate of candidates) {
    if (selected.length >= MAX_OFFERS_PER_RUN) break;
    const canton = resolveJobCanton(candidate.job);
    const nextCantons = new Set(cantons);
    nextCantons.add(canton);
    const expectedPageCount =
      (selected.length + 1) * LOCALES.length +
      (nextCantons.size + 1) * LOCALES.length;
    if (expectedPageCount > MAX_PAGES_PER_RUN) break;
    selected.push(candidate);
    cantons.add(canton);
  }
  return selected;
}

async function acquireFastLaneLeases(scopes) {
  const leaseSet = await acquireShardWriterLeases(scopes, {
    policy: "skip",
    owner: `jobs-fast:${process.env.GITHUB_RUN_ID || "local"}:${process.env.GITHUB_RUN_ATTEMPT || "1"}`,
  });
  if (!leaseSet.acquired) {
    console.log(
      `[jobs-fast] skipped busy writer scopes=${leaseSet.busy.join(",")}`,
    );
    return null;
  }
  return leaseSet;
}

function assertPublishPrerequisites(rootDir, scopes) {
  const required = [
    "CF_API_TOKEN",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_S3_ENDPOINT",
    "R2_BUCKET",
  ];
  const missing = required.filter((name) => !process.env[name]);
  const owners = JSON.parse(
    fs.readFileSync(
      path.join(rootDir, "scripts/lib/section-shard-owners.json"),
      "utf8",
    ),
  );
  for (const { section, locale } of scopes) {
    if (section === "__sitemaps__") continue;
    const owner = owners[section] || "valerielinc-ops";
    const tokenName =
      owner === "nanakokyobashi-rgb" ? "GITHUB_PAT_NANAKO" : "GITHUB_PAT";
    const deployKeyName = `SHARD_${section.toUpperCase()}_${locale.toUpperCase()}_DEPLOY_KEY`;
    if (!process.env[tokenName] && !process.env[deployKeyName])
      missing.push(tokenName);
  }
  if (missing.length > 0)
    throw new Error(
      `[jobs-fast] publish credentials are missing: ${[...new Set(missing)].join(", ")}`,
    );
}

function runChild(command, args, onSpawn = () => {}, env = process.env) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "inherit", env });
    onSpawn(child);
    let signal = null;
    let settled = false;
    const onSignal = (received) => {
      signal = received;
      if (child.exitCode === null) child.kill(received);
    };
    const onTerm = () => onSignal("SIGTERM");
    const onInt = () => onSignal("SIGINT");
    process.once("SIGTERM", onTerm);
    process.once("SIGINT", onInt);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      process.off("SIGTERM", onTerm);
      process.off("SIGINT", onInt);
      resolve({ code: 1, error });
    });
    child.once("exit", (code, childSignal) => {
      if (settled) return;
      settled = true;
      process.off("SIGTERM", onTerm);
      process.off("SIGINT", onInt);
      resolve({
        code: signal ? 128 + (signal === "SIGINT" ? 2 : 15) : (code ?? 1),
        signal: childSignal,
      });
    });
  });
}

function startLeaseHeartbeat(leaseSet) {
  let renewalError = null;
  let renewing = false;
  let activeChild = null;
  const interval = setInterval(async () => {
    if (renewing || renewalError) return;
    renewing = true;
    try {
      await renewShardWriterLeases(leaseSet);
    } catch (error) {
      renewalError = error;
      console.error(
        `[jobs-fast] writer lease renewal failed: ${error?.message || error}`,
      );
      if (activeChild?.exitCode === null) activeChild.kill("SIGTERM");
    } finally {
      renewing = false;
    }
  }, SHARD_WRITER_LOCK_DEFAULTS.heartbeatMs);
  interval.unref?.();
  return {
    assertHealthy() {
      if (renewalError) throw renewalError;
    },
    setChild(child) {
      activeChild = child;
      if (renewalError && child?.exitCode === null) child.kill("SIGTERM");
    },
    async close() {
      clearInterval(interval);
      if (renewing)
        while (renewing)
          await new Promise((resolve) => setTimeout(resolve, 25));
      if (renewalError) throw renewalError;
    },
  };
}

async function publishSectionPayloads(sections, heartbeat, runnerTemp) {
  for (const { section, locale, distDir } of sections.values()) {
    heartbeat.assertHealthy();
    const env = {
      ...process.env,
      SHARD_PUSH_MODE: "fast-overlay",
      SHARD_FAST_OVERLAY_ONLY: "1",
      SHARD_HISTORY_CAP: process.env.SHARD_HISTORY_CAP || "50",
      RUNNER_TEMP: runnerTemp,
    };
    const result = await runChild(
      "bash",
      ["scripts/lib/push-section-shard.sh", section, locale, distDir],
      (running) => {
        heartbeat.setChild(running);
        heartbeat.assertHealthy();
      },
      env,
    );
    heartbeat.setChild(null);
    heartbeat.assertHealthy();
    if (result.error) throw result.error;
    if (result.code !== 0)
      throw new Error(
        `[jobs-fast] section push failed for ${section}-${locale} (exit ${result.code})`,
      );
  }
}

function parseJobInput(raw) {
  const data = JSON.parse(raw);
  return Array.isArray(data) ? data : [];
}

export async function runJobsFastPublish({
  dryRun = false,
  rootDir = rootFromEnv(),
} = {}) {
  const startedAt = Date.now();
  const flagEnabled =
    String(process.env.JOBS_FAST_PUBLISH_ENABLED || "")
      .trim()
      .toLowerCase() === "true";
  if (!dryRun && !flagEnabled) {
    console.log(
      "[jobs-fast] Remote Config flag is OFF; no render, lock, or publish was performed",
    );
    return { outcome: "flag-off", offers: 0, pages: 0 };
  }
  if (process.env.JOBS_SEO_SAMPLE)
    throw new Error(
      "[jobs-fast] JOBS_SEO_SAMPLE must be unset for production rendering",
    );

  const buildId = await getLiveBuildId();
  process.env.DEPLOY_BUILD_ID = buildId;
  delete process.env.BUILD_LOCALE;
  delete process.env.JOBS_SEO_SAMPLE;
  const dataPath = path.join(rootDir, "data/jobs.json");
  if (!fs.existsSync(dataPath))
    throw new Error("[jobs-fast] data/jobs.json is missing");

  const [jobRenderer, employerRenderer, jobDetailPath, canton, companyProfile] =
    await Promise.all([
      import("../build-plugins/jobsSeoPagesPlugin.ts"),
      import("../build-plugins/employerProfilePagesPlugin.ts"),
      import("../build-plugins/shared/jobDetailPath.ts"),
      import("../build-plugins/shared/cantonSection.ts"),
      import("../build-plugins/shared/companyProfileSlug.mjs"),
    ]);
  const { jobsSeoPagesPlugin, compareActiveJobsByStableOrder } = jobRenderer;
  const { employerProfilePagesPlugin } = employerRenderer;
  const rawJobs = parseJobInput(fs.readFileSync(dataPath, "utf8"));
  let validJobs = rawJobs
    .filter((job) => !isFixtureJob(job))
    .filter((job) => isListingInventoryJob(job))
    .map((job) => normalizeListingIdentity(job))
    .filter((job) => Boolean(job.slug))
    .sort(compareActiveJobsByStableOrder);
  rawJobs.length = 0;

  const pathsForJob = (job) =>
    canonicalPathsForFastLaneJob(job, {
      buildCanonicalJobDetailPath: jobDetailPath.buildCanonicalJobDetailPath,
      resolveJobCanton: canton.resolveJobCanton,
    });
  const discovered = await discoverFastPublishJobs(validJobs, {
    write: !dryRun,
    pathsForJob,
  });
  const discoveredCount = discovered.length;
  const discoveredIds = new Set(discovered.map((record) => record.id));
  const pendingIds = new Set(discoveredIds);
  let candidates = selectBatch(discovered, canton.resolveJobCanton);
  discovered.length = 0;
  let paritySample = null;
  if (dryRun) {
    paritySample = await selectLiveParitySample(validJobs, pendingIds, {
      buildCanonicalJobDetailPath: jobDetailPath.buildCanonicalJobDetailPath,
      resolveJobCanton: canton.resolveJobCanton,
    });
    if (!candidates.some((candidate) => candidate.id === paritySample.id)) {
      const sampleCandidate = validJobs.find(
        (job) => stableJobId(job) === paritySample.id,
      );
      if (!sampleCandidate)
        throw new Error(
          "[jobs-fast] parity sample disappeared from the active corpus",
        );
      const sampleCanton = canton.resolveJobCanton(sampleCandidate);
      while (candidates.length > 0) {
        const affected = new Set(
          candidates.map((candidate) => canton.resolveJobCanton(candidate.job)),
        );
        affected.add(sampleCanton);
        if (
          (candidates.length + 1) * LOCALES.length +
            (affected.size + 1) * LOCALES.length <=
          MAX_PAGES_PER_RUN
        )
          break;
        candidates.pop();
      }
      candidates = [...candidates];
      candidates.push({
        id: paritySample.id,
        hash: "",
        previousPaths: [],
        job: sampleCandidate,
      });
    }
  }

  if (candidates.length === 0) {
    console.log(
      `[jobs-fast] no pending active offers; candidates=${discoveredCount} dry_run=${dryRun}`,
    );
    return { outcome: "empty", offers: 0, pages: 0 };
  }

  const batchIds = candidates.map((candidate) => candidate.id);
  const liveJobsSitemapBeforeRender = await fetchLiveText(
    `${BASE_URL}/sitemap-jobs.xml`,
  );
  const fastLaneVisibleJobIdsByLocale =
    buildFastLaneHubVisibleJobIdsByLocale(
      validJobs,
      batchIds,
      liveJobsSitemapBeforeRender,
      {
        buildCanonicalJobDetailPath:
          jobDetailPath.buildCanonicalJobDetailPath,
        resolveJobCanton: canton.resolveJobCanton,
      },
    );
  const employerSlugs = [
    ...new Set(
      candidates
        .map(({ job }) =>
          companyProfile.canonicalCompanyProfileSlug(
            job.company || "",
            job.companyKey || "",
          ),
        )
        .filter(Boolean),
    ),
  ];
  for (const candidate of candidates) delete candidate.job;
  validJobs.length = 0;
  const distDir = path.resolve(
    process.env.JOBS_FAST_DIST_DIR || path.join(rootDir, "dist"),
  );
  fs.rmSync(distDir, { recursive: true, force: true });
  fs.mkdirSync(distDir, { recursive: true });
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "frontaliere-jobs-fast-"),
  );
  fs.mkdirSync(tempDir, { recursive: true });
  const receiptFile = path.join(tempDir, "render-receipt.json");
  process.env.JOBS_FAST_DIST_DIR = distDir;
  process.env.JOBS_FAST_RESULT_FILE = receiptFile;
  const renderStartedAt = Date.now();

  try {
    await employerProfilePagesPlugin(rootDir, {
      metadataOnlySlugs: employerSlugs,
    }).closeBundle();
    await jobsSeoPagesPlugin(rootDir, {
      activeJobIds: batchIds,
      fastLaneVisibleJobIdsByLocale,
      fastLaneDistDir: distDir,
      fastLane: true,
      fastLaneResultFile: receiptFile,
    }).closeBundle();

    const receipt = JSON.parse(fs.readFileSync(receiptFile, "utf8"));
    const actualBatchIds = candidates
      .filter(
        (candidate) =>
          !paritySample ||
          candidate.id !== paritySample.id ||
          discoveredIds.has(candidate.id),
      )
      .map((candidate) => candidate.id);
    checkJobPageContracts(receipt, batchIds);
    const outputPageCount =
      receipt.pages.length + (receipt.hubUpdates || []).length;
    if (outputPageCount > MAX_PAGES_PER_RUN)
      throw new Error(
        `[jobs-fast] output page cap exceeded (${outputPageCount} > ${MAX_PAGES_PER_RUN})`,
      );
    console.log(
      `[jobs-fast] rendered offers=${new Set(receipt.pages.map((page) => page.id)).size} detail_pages=${receipt.pages.length} hub_pages=${(receipt.hubUpdates || []).length} total_pages=${outputPageCount} latency_ms=${Date.now() - renderStartedAt}`,
    );
    await validateFirstPartyAssets(receipt);

    const slugToSection = new Map();
    const sectionSlugs = JSON.parse(
      fs.readFileSync(
        path.join(rootDir, "scripts/lib/section-shard-slugs.json"),
        "utf8",
      ),
    );
    for (const [section, locales] of Object.entries(sectionSlugs)) {
      if (section.startsWith("articoli")) continue;
      for (const slug of Object.values(locales))
        slugToSection.set(slug, section);
    }
    const scopePlan = buildScopePlan(receipt, slugToSection, distDir, tempDir);
    for (const update of receipt.hubUpdates || [])
      scopePlan.register(update.path, false);
    const prepareHubUpdates = async (heartbeat = null) => {
      for (const update of receipt.hubUpdates || []) {
        heartbeat?.assertHealthy();
        const live = await fetchLiveText(`${BASE_URL}${update.path}`);
        let patched;
        if (update.kind === "ticino") {
          const ti = await import("../build-plugins/shared/tiHubLatestJobs.ts");
          const result = ti.applyTiHubLatestJobsSlot(
            live,
            String(update.block || ""),
          );
          if (result.outcome === "no-slot")
            throw new Error(
              `[jobs-fast] Ticino hub latest-jobs slot is missing: ${update.path}`,
            );
          patched = result.html;
        } else if (update.kind === "canton-list") {
          const grid =
            await import("../build-plugins/shared/cantonJobListingGrid.ts");
          patched = grid.replaceCantonJobListingGrid(
            live,
            String(update.grid || ""),
          );
        } else
          throw new Error(`[jobs-fast] unknown hub update kind ${update.kind}`);
        const target = scopePlan.register(update.path, false);
        fs.writeFileSync(target, patched, "utf8");
      }
    };

    if (dryRun) {
      await prepareHubUpdates();
      await verifyDryRunParity(
        rootDir,
        receipt,
        actualBatchIds,
        paritySample,
        tempDir,
      );
      console.log(
        `[jobs-fast] dry_run=true delta_candidates=${discoveredCount} selected_offers=${new Set(batchIds).size} pages=${outputPageCount} published=0 state_written=0 flag=${flagEnabled ? "on" : "off"}`,
      );
      return {
        outcome: "dry-run-clean",
        offers: new Set(batchIds).size,
        pages: outputPageCount,
      };
    }

    if (!flagEnabled)
      throw new Error(
        "[jobs-fast] flag changed after command admission; refusing to publish",
      );
    const pagesById = new Map();
    for (const page of receipt.pages) {
      if (!pagesById.has(page.id)) pagesById.set(page.id, []);
      pagesById.get(page.id).push(page.path);
    }
    for (const candidate of candidates) {
      if (candidate.previousPaths.length > 0) {
        const currentPaths = [...(pagesById.get(candidate.id) || [])].sort();
        if (
          JSON.stringify([...candidate.previousPaths].sort()) !==
          JSON.stringify(currentPaths)
        ) {
          for (const page of receipt.pages.filter(
            (row) => row.id === candidate.id,
          )) {
            const live = await fetchLiveText(`${BASE_URL}${page.path}`);
            const rendered = fs.readFileSync(
              routeToDistFile(distDir, page.path),
              "utf8",
            );
            if (live !== rendered) {
              throw new Error(
                `[jobs-fast] canonical route changed and full deploy has not published ${page.path}; deferring this batch`,
              );
            }
          }
          console.log(
            `[jobs-fast] canonical route already converged by full deploy id=${candidate.id}; reconciling sitemap and durable state`,
          );
        }
      }
    }

    const scopes = [
      ...[...scopePlan.sections.values()].map(({ section, locale }) => ({
        section,
        locale,
      })),
      { section: "__sitemaps__", locale: "it" },
    ];
    assertPublishPrerequisites(rootDir, scopes);
    const leaseSet = await acquireFastLaneLeases(scopes);
    if (!leaseSet) return { outcome: "writer-busy", offers: 0, pages: 0 };
    const heartbeat = startLeaseHeartbeat(leaseSet);
    try {
      const liveJobsSitemap = await fetchLiveText(
        `${BASE_URL}/sitemap-jobs.xml`,
      );
      if (liveJobsSitemap !== liveJobsSitemapBeforeRender) {
        console.log(
          "[jobs-fast] live job sitemap changed during render; deferring the batch before publish",
        );
        return { outcome: "stale-sitemap-snapshot", offers: 0, pages: 0 };
      }
      await prepareHubUpdates(heartbeat);
      heartbeat.assertHealthy();
      const sitemapPayload = await prepareSitemapUpdates(
        receipt,
        tempDir,
        candidates.flatMap((candidate) => candidate.previousPaths || []),
        slugToSection,
        sectionSlugs,
        liveJobsSitemap,
      );
      heartbeat.assertHealthy();
      const runnerTemp = path.join(tempDir, "runner-temp");
      fs.mkdirSync(runnerTemp, { recursive: true });
      await publishSectionPayloads(scopePlan.sections, heartbeat, runnerTemp);
      await purgePublishedShardPages(
        rootDir,
        receipt,
        slugToSection,
        heartbeat,
      );
      if (sitemapPayload.updates.size > 0) {
        const only = [...sitemapPayload.updates.keys()].join(",");
        const result = await runChild(
          process.execPath,
          [
            path.join(rootDir, "scripts/publish-edge-files.mjs"),
            `--only=${only}`,
            `--from-dir=${sitemapPayload.sitemapDir}`,
            "--strict",
          ],
          (running) => heartbeat.setChild(running),
        );
        heartbeat.setChild(null);
        heartbeat.assertHealthy();
        if (result.error) throw result.error;
        if (result.code !== 0)
          throw new Error(
            `[jobs-fast] edge sitemap publish failed (exit ${result.code})`,
          );
      }
      await verifyPublishedPagesAndSitemaps(
        receipt,
        sitemapPayload.updates,
        distDir,
        sitemapPayload.removalsByPath,
      );
      const verifiedAtMs = Date.now();
      const stateRecords = candidates
        .filter((candidate) => discoveredIds.has(candidate.id))
        .map((candidate) => ({
          id: candidate.id,
          hash: candidate.hash,
          paths: [...new Set(pagesById.get(candidate.id) || [])],
        }));
      if (process.env.JOBS_FAST_PRIORITY_FILE) {
        const priorityUrls = (receipt.sitemapEntries || [])
          .flatMap((entry) => [
            entry.loc,
            ...(entry.variants || []).map((variant) => variant.loc),
          ])
          .filter((url) => typeof url === "string");
        fs.mkdirSync(path.dirname(process.env.JOBS_FAST_PRIORITY_FILE), {
          recursive: true,
        });
        fs.writeFileSync(
          process.env.JOBS_FAST_PRIORITY_FILE,
          `${JSON.stringify({ urls: [...new Set(priorityUrls)] })}\n`,
        );
      }
      await markFastPublishJobsPublished(stateRecords);
      const crawlToLiveSamples = candidates
        .filter((candidate) => discoveredIds.has(candidate.id))
        .map((candidate) => candidate.crawlAtMs)
        .filter(
          (crawlAtMs) =>
            Number.isFinite(crawlAtMs) && crawlAtMs <= verifiedAtMs,
        )
        .map((crawlAtMs) => verifiedAtMs - crawlAtMs);
      const averageCrawlToLiveMs = crawlToLiveSamples.length
        ? Math.round(
            crawlToLiveSamples.reduce((sum, value) => sum + value, 0) /
              crawlToLiveSamples.length,
          )
        : "unknown";
      const maxCrawlToLiveMs = crawlToLiveSamples.length
        ? Math.max(...crawlToLiveSamples)
        : "unknown";
      console.log(
        `[jobs-fast] published offers=${stateRecords.length} detail_pages=${stateRecords.length * LOCALES.length} updated_hubs=${(receipt.hubUpdates || []).length} sitemap_files=${sitemapPayload.updates.size} total_pages=${outputPageCount} crawl_to_live_avg_ms=${averageCrawlToLiveMs} crawl_to_live_max_ms=${maxCrawlToLiveMs} crawl_timestamps=${crawlToLiveSamples.length}/${stateRecords.length} latency_ms=${Date.now() - startedAt}`,
      );
      return {
        outcome: "published",
        offers: stateRecords.length,
        pages: outputPageCount,
      };
    } finally {
      try {
        await heartbeat.close();
      } finally {
        await releaseShardWriterLeases(leaseSet);
      }
    }
  } finally {
    delete process.env.JOBS_FAST_DIST_DIR;
    delete process.env.JOBS_FAST_RESULT_FILE;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  (() => {
    try {
      return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
    } catch {
      return false;
    }
  })()
) {
  runJobsFastPublish(parseArgs(process.argv.slice(2)))
    .then((result) => {
      if (process.env.GITHUB_OUTPUT)
        fs.appendFileSync(
          process.env.GITHUB_OUTPUT,
          `outcome=${result.outcome}\n`,
        );
      process.stdout.write(`[jobs-fast] result=${JSON.stringify(result)}\n`);
    })
    .catch((error) => {
      console.error(`[jobs-fast] ${error?.stack || error}`);
      process.exitCode = 1;
    });
}
