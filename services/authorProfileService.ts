/**
 * authorProfileService.ts — runtime overrides on top of the static
 * `data/authors.ts` persona registry and `data/blog-articles-data.ts`
 * byline, written admin-only via the `manageRedazioneAdmin` Cloud
 * Function (see services/redazioneAdminService.ts + AdminPanel.tsx's
 * "Redazione" section).
 *
 * Both override collections are small (a handful of personas / rare
 * reassignments), but `getMergedAuthor`/`getArticleAuthorOverride` run on
 * essentially every author-page and article-page view (the SEO funnel's
 * core traffic), so those two paths do a targeted `getDoc` by slug/id
 * instead of scanning the whole collection — 1 read regardless of
 * collection size, cached per-key (in-memory for the session, then
 * localStorage TTL for repeat visits). `getAllMergedAuthors` genuinely
 * needs every persona (author directory), so it keeps the original
 * collection-scan-then-cache-everything shape.
 *
 * No expiry beyond the TTL: an override changes only via an explicit
 * admin action, not on a schedule, so a stale cached copy is only ever
 * stale until the next page load past the TTL.
 *
 * These overrides only affect client-side rendering (CSR). Already-built
 * static HTML/JSON-LD for SSG pages stays as it was at build time until
 * the next scheduled rebuild — same limitation as any other `data/*.ts`
 * edit in this SSG architecture.
 */

import { AUTHORS, getAuthorBySlug, type Author, type AuthorSocial } from '@/data/authors';
import { resilientImport } from '@/services/resilientImport';

const IS_TEST_ENV = typeof process !== 'undefined' && (process.env.NODE_ENV === 'test' || !!process.env.VITEST);

export type AuthorProfilePatch = Partial<Pick<Author, 'name' | 'role' | 'bio' | 'photoPath' | 'email'>> & {
  social?: Partial<AuthorSocial>;
};

export interface ArticleAuthorOverride {
  authorSlug: string;
  authorName: string;
}

const PROFILES_LS_KEY = 'author_profiles_cache';
const OVERRIDES_LS_KEY = 'article_author_overrides_cache';
const LS_TTL_MS = 60 * 60 * 1000; // 1 hour — admin changes are visible on the next fetch past TTL

function readLocalMap<T>(key: string): Map<string, T> | null {
  if (IS_TEST_ENV) return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.data || typeof parsed.timestamp !== 'number') return null;
    if ((Date.now() - parsed.timestamp) >= LS_TTL_MS) return null;
    return new Map<string, T>(Object.entries(parsed.data) as [string, T][]);
  } catch { return null; }
}

function writeLocalMap<T>(key: string, map: Map<string, T>): void {
  if (IS_TEST_ENV) return;
  try {
    localStorage.setItem(key, JSON.stringify({ data: Object.fromEntries(map), timestamp: Date.now() }));
  } catch { /* ignore */ }
}

let profilesCache: Map<string, AuthorProfilePatch> | null = null;
let profilesPromise: Promise<Map<string, AuthorProfilePatch>> | null = null;

// Per-key caches for the hot targeted-lookup paths (getMergedAuthor,
// getArticleAuthorOverride) — populated lazily, one getDoc per new key
// instead of one getDocs-the-whole-collection per session.
const profileBySlugCache = new Map<string, AuthorProfilePatch | undefined>();
const profileBySlugInFlight = new Map<string, Promise<AuthorProfilePatch | undefined>>();
const overrideByIdCache = new Map<string, ArticleAuthorOverride | undefined>();
const overrideByIdInFlight = new Map<string, Promise<ArticleAuthorOverride | undefined>>();

async function getDb() {
  const { getFirestore } = await resilientImport(
    () => import('firebase/firestore'),
    (m) => typeof m.getFirestore === 'function',
  );
  const { getApp } = await resilientImport(
    () => import('@/services/firebase'),
    (m) => typeof m.getApp === 'function',
  );
  return getFirestore(await getApp());
}

async function loadProfiles(): Promise<Map<string, AuthorProfilePatch>> {
  if (profilesCache) return profilesCache;

  // 2. localStorage cache (skip Firestore on repeat page loads within TTL)
  const local = readLocalMap<AuthorProfilePatch>(PROFILES_LS_KEY);
  if (local) {
    profilesCache = local;
    return local;
  }

  if (!profilesPromise) {
    profilesPromise = (async () => {
      const map = new Map<string, AuthorProfilePatch>();
      if (IS_TEST_ENV) {
        profilesCache = map;
        return map;
      }
      try {
        const { collection, getDocs } = await resilientImport(
          () => import('firebase/firestore'),
          (m) => typeof m.getDocs === 'function',
        );
        const db = await getDb();
        const snap = await getDocs(collection(db, 'author_profiles'));
        snap.forEach((doc) => map.set(doc.id, doc.data() as AuthorProfilePatch));
        writeLocalMap(PROFILES_LS_KEY, map);
      } catch {
        // Offline / permission edge cases — fall back to the static registry only.
      }
      profilesCache = map;
      return map;
    })();
  }
  return profilesPromise;
}

/**
 * Targeted lookup for a single author's admin patch — used by
 * getMergedAuthor, called on essentially every author-page view. A
 * `getDoc` by slug costs 1 read regardless of collection size, vs.
 * `loadProfiles`'s `getDocs` which costs 1 read per document in the
 * collection every time the whole-collection cache is cold.
 */
async function loadProfile(slug: string): Promise<AuthorProfilePatch | undefined> {
  if (profileBySlugCache.has(slug)) return profileBySlugCache.get(slug);

  // Whole-collection cache already warm (e.g. getAllMergedAuthors ran
  // first this session) — serve from it instead of a separate read.
  if (profilesCache) {
    const patch = profilesCache.get(slug);
    profileBySlugCache.set(slug, patch);
    return patch;
  }

  const local = readLocalMap<AuthorProfilePatch>(PROFILES_LS_KEY);
  if (local?.has(slug)) {
    const patch = local.get(slug);
    profileBySlugCache.set(slug, patch);
    return patch;
  }

  if (IS_TEST_ENV) {
    profileBySlugCache.set(slug, undefined);
    return undefined;
  }

  let inFlight = profileBySlugInFlight.get(slug);
  if (!inFlight) {
    inFlight = (async () => {
      let result: AuthorProfilePatch | undefined;
      try {
        const { doc, getDoc } = await resilientImport(
          () => import('firebase/firestore'),
          (m) => typeof m.getDoc === 'function',
        );
        const db = await getDb();
        const snap = await getDoc(doc(db, 'author_profiles', slug));
        if (snap.exists()) result = snap.data() as AuthorProfilePatch;
      } catch {
        // Offline / permission edge cases — fall back to the static registry only.
      }
      profileBySlugCache.set(slug, result);
      const existing = readLocalMap<AuthorProfilePatch>(PROFILES_LS_KEY) ?? new Map<string, AuthorProfilePatch>();
      if (result) existing.set(slug, result);
      writeLocalMap(PROFILES_LS_KEY, existing);
      profileBySlugInFlight.delete(slug);
      return result;
    })();
    profileBySlugInFlight.set(slug, inFlight);
  }
  return inFlight;
}

/**
 * Targeted lookup for a single article's author override — used by
 * getArticleAuthorOverride, called on essentially every article-page
 * view (the SEO funnel's core traffic). A `getDoc` by article id costs
 * 1 read regardless of collection size, vs. the previous `getDocs` over
 * the whole `article_author_overrides` collection on every session's
 * first article view.
 */
async function loadOverride(articleId: string): Promise<ArticleAuthorOverride | undefined> {
  if (overrideByIdCache.has(articleId)) return overrideByIdCache.get(articleId);

  const local = readLocalMap<ArticleAuthorOverride>(OVERRIDES_LS_KEY);
  if (local?.has(articleId)) {
    const hit = local.get(articleId);
    overrideByIdCache.set(articleId, hit);
    return hit;
  }

  if (IS_TEST_ENV) {
    overrideByIdCache.set(articleId, undefined);
    return undefined;
  }

  let inFlight = overrideByIdInFlight.get(articleId);
  if (!inFlight) {
    inFlight = (async () => {
      let result: ArticleAuthorOverride | undefined;
      try {
        const { doc, getDoc } = await resilientImport(
          () => import('firebase/firestore'),
          (m) => typeof m.getDoc === 'function',
        );
        const db = await getDb();
        const snap = await getDoc(doc(db, 'article_author_overrides', articleId));
        if (snap.exists()) {
          const d = snap.data() as ArticleAuthorOverride;
          if (d?.authorSlug && d?.authorName) result = d;
        }
      } catch {
        // Offline / permission edge cases — fall back to static byline only.
      }
      overrideByIdCache.set(articleId, result);
      const existing = readLocalMap<ArticleAuthorOverride>(OVERRIDES_LS_KEY) ?? new Map<string, ArticleAuthorOverride>();
      if (result) existing.set(articleId, result);
      writeLocalMap(OVERRIDES_LS_KEY, existing);
      overrideByIdInFlight.delete(articleId);
      return result;
    })();
    overrideByIdInFlight.set(articleId, inFlight);
  }
  return inFlight;
}

/** Static author merged with its admin-set `author_profiles/{slug}` patch, if any. */
export async function getMergedAuthor(slug: string): Promise<Author | undefined> {
  const base = getAuthorBySlug(slug);
  if (!base) return undefined;
  const patch = await loadProfile(slug);
  if (!patch) return base;
  return {
    ...base,
    ...patch,
    social: { ...base.social, ...patch.social },
  };
}

/** Every persona, each merged with its override if one exists. */
export async function getAllMergedAuthors(): Promise<Author[]> {
  const profiles = await loadProfiles();
  return AUTHORS.map((base) => {
    const patch = profiles.get(base.slug);
    if (!patch) return base;
    return { ...base, ...patch, social: { ...base.social, ...patch.social } };
  });
}

/** Admin-set author reassignment for this AI-catalog article id, if any. */
export async function getArticleAuthorOverride(articleId: string): Promise<ArticleAuthorOverride | undefined> {
  return loadOverride(articleId);
}

/**
 * Pure override-then-fallback merge, per field. Shared by
 * `getEffectiveArticleByline` (fetch + merge) and `BlogArticles.tsx` (which
 * already holds a fetched override in state and only needs the merge step) —
 * kept as one function so the two call sites can't drift (review nit, PR #3356).
 */
export function mergeArticleByline(
  override: ArticleAuthorOverride | null | undefined,
  article: { authorSlug?: string; authorName?: string },
): { authorSlug?: string; authorName?: string } {
  return {
    authorSlug: override?.authorSlug ?? article.authorSlug,
    authorName: override?.authorName ?? article.authorName,
  };
}

/** Resolves the byline to show for an AI-catalog article, override applied. */
export async function getEffectiveArticleByline(
  article: { id: string; authorSlug?: string; authorName?: string },
): Promise<{ authorSlug?: string; authorName?: string }> {
  const override = await getArticleAuthorOverride(article.id);
  return mergeArticleByline(override, article);
}
