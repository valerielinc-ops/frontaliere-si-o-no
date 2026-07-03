/**
 * authorProfileService.ts — runtime overrides on top of the static
 * `data/authors.ts` persona registry and `data/blog-articles-data.ts`
 * byline, written admin-only via the `manageRedazioneAdmin` Cloud
 * Function (see services/redazioneAdminService.ts + AdminPanel.tsx's
 * "Redazione" section).
 *
 * Both override collections are small (a handful of personas / rare
 * reassignments), so each is fetched once per session and cached — same
 * shape as exchangeRateService.ts's Firestore-then-fallback pattern, but
 * with no expiry: an override changes only via an explicit admin action,
 * not on a schedule, so a stale in-memory copy is only ever stale until
 * the next page load.
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

let profilesCache: Map<string, AuthorProfilePatch> | null = null;
let profilesPromise: Promise<Map<string, AuthorProfilePatch>> | null = null;
let overridesCache: Map<string, ArticleAuthorOverride> | null = null;
let overridesPromise: Promise<Map<string, ArticleAuthorOverride>> | null = null;

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
  if (!profilesPromise) {
    profilesPromise = (async () => {
      const map = new Map<string, AuthorProfilePatch>();
      if (IS_TEST_ENV) return map;
      try {
        const { collection, getDocs } = await resilientImport(
          () => import('firebase/firestore'),
          (m) => typeof m.getDocs === 'function',
        );
        const db = await getDb();
        const snap = await getDocs(collection(db, 'author_profiles'));
        snap.forEach((doc) => map.set(doc.id, doc.data() as AuthorProfilePatch));
      } catch {
        // Offline / permission edge cases — fall back to the static registry only.
      }
      profilesCache = map;
      return map;
    })();
  }
  return profilesPromise;
}

async function loadOverrides(): Promise<Map<string, ArticleAuthorOverride>> {
  if (overridesCache) return overridesCache;
  if (!overridesPromise) {
    overridesPromise = (async () => {
      const map = new Map<string, ArticleAuthorOverride>();
      if (IS_TEST_ENV) return map;
      try {
        const { collection, getDocs } = await resilientImport(
          () => import('firebase/firestore'),
          (m) => typeof m.getDocs === 'function',
        );
        const db = await getDb();
        const snap = await getDocs(collection(db, 'article_author_overrides'));
        snap.forEach((doc) => {
          const d = doc.data() as ArticleAuthorOverride;
          if (d?.authorSlug && d?.authorName) map.set(doc.id, d);
        });
      } catch {
        // Offline / permission edge cases — fall back to the static byline only.
      }
      overridesCache = map;
      return map;
    })();
  }
  return overridesPromise;
}

/** Static author merged with its admin-set `author_profiles/{slug}` patch, if any. */
export async function getMergedAuthor(slug: string): Promise<Author | undefined> {
  const base = getAuthorBySlug(slug);
  if (!base) return undefined;
  const profiles = await loadProfiles();
  const patch = profiles.get(slug);
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
  const overrides = await loadOverrides();
  return overrides.get(articleId);
}

/** Resolves the byline to show for an AI-catalog article, override applied. */
export async function getEffectiveArticleByline(
  article: { id: string; authorSlug?: string; authorName?: string },
): Promise<{ authorSlug?: string; authorName?: string }> {
  const override = await getArticleAuthorOverride(article.id);
  if (override) return override;
  return { authorSlug: article.authorSlug, authorName: article.authorName };
}
