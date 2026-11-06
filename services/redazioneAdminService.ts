/**
 * redazioneAdminService.ts — client for the ADMIN-only `manageRedazioneAdmin`
 * Cloud Function (functions/src/redazioneAdminCore.js, region europe-west6).
 *
 * Mirrors services/journalistAdminService.ts's calling convention exactly:
 * same base URL host, same `Authorization: Bearer <idToken>` header, same
 * `{ ok, ... }` / `{ ok: false, error }` response shape. Consumed by
 * AdminPanel.tsx's "Redazione" section (superadmin article view across
 * both catalogs + persona profile editor).
 */

import type { AuthorProfilePatch, ArticleAuthorOverride } from '@/services/authorProfileService';

const MANAGE_REDAZIONE_ADMIN_ENDPOINT =
  'https://europe-west6-frontaliere-ticino.cloudfunctions.net/manageRedazioneAdmin';

export interface RedazioneJournalistArticle {
  id: string;
  authorUid: string;
  authorName: string;
  authorEmail: string;
  category: string;
  title: string;
  status: string;
  createdAt: string | null;
  updatedAt: string | null;
  publishedAt: string | null;
  publishedUrls: Partial<Record<string, string>> | null;
}

export interface RedazioneAdminData {
  journalistArticles: RedazioneJournalistArticle[];
  authorProfiles: Record<string, AuthorProfilePatch>;
  articleAuthorOverrides: Record<string, ArticleAuthorOverride>;
}

/** Minimal Firebase user shape — only getIdToken is needed. */
interface AuthLike {
  getIdToken: () => Promise<string>;
}

const ERROR_MESSAGES: Record<string, string> = {
  not_admin: 'Accesso negato: questo account non è autorizzato a gestire la redazione.',
  invalid_input: 'Dati non validi.',
};

function authErrorMessage(data: { error?: string }, res: Response, fallbackVerb: string): string {
  return ERROR_MESSAGES[data.error || ''] || `${fallbackVerb} (${data.error || res.status}).`;
}

/**
 * Loads real-journalist articles across every author plus the current
 * persona/article-author overrides. Throws a human-readable message on
 * auth failure or non-OK response.
 */
export async function fetchRedazioneAdminData(user: AuthLike | null | undefined): Promise<RedazioneAdminData> {
  if (!user) {
    throw new Error('Devi essere autenticato come admin per vedere la redazione.');
  }
  const idToken = await user.getIdToken();
  const res = await fetch(MANAGE_REDAZIONE_ADMIN_ENDPOINT, {
    method: 'GET',
    headers: { Authorization: `Bearer ${idToken}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(authErrorMessage(data, res, 'Impossibile caricare la redazione'));
  }
  return {
    journalistArticles: Array.isArray(data.journalistArticles) ? data.journalistArticles : [],
    authorProfiles: data.authorProfiles && typeof data.authorProfiles === 'object' ? data.authorProfiles : {},
    articleAuthorOverrides:
      data.articleAuthorOverrides && typeof data.articleAuthorOverrides === 'object' ? data.articleAuthorOverrides : {},
  };
}

/** Patches a persona's admin-editable profile fields (name/role/bio/photoPath/email/social). */
export async function updateAuthorProfile(
  user: AuthLike | null | undefined,
  slug: string,
  patch: AuthorProfilePatch,
): Promise<void> {
  if (!user) {
    throw new Error('Devi essere autenticato come admin per modificare un profilo.');
  }
  const idToken = await user.getIdToken();
  const res = await fetch(MANAGE_REDAZIONE_ADMIN_ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'updateProfile', slug, patch }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(authErrorMessage(data, res, 'Salvataggio profilo non riuscito'));
  }
}

/** Reassigns the byline of an AI-catalog article (`data/blog-articles-data.ts` entry). */
export async function reassignArticleAuthor(
  user: AuthLike | null | undefined,
  articleId: string,
  authorSlug: string,
  authorName: string,
): Promise<void> {
  if (!user) {
    throw new Error('Devi essere autenticato come admin per riassegnare un articolo.');
  }
  const idToken = await user.getIdToken();
  const res = await fetch(MANAGE_REDAZIONE_ADMIN_ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'reassignArticle', articleId, authorSlug, authorName }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(authErrorMessage(data, res, 'Riassegnazione non riuscita'));
  }
}
