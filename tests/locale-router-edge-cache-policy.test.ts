import { describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — plain JS Worker module
import {
  determineCachePolicy,
  INSIGHTS_CACHE_CONTROL,
  JOB_DETAIL_CACHE_CONTROL,
  JOB_LISTING_CACHE_CONTROL,
  PRIVATE_NO_STORE_CACHE_CONTROL,
} from '../infra/cloudflare-worker/locale-router.js';

describe('Cloudflare Worker determineCachePolicy', () => {
  it('applica la cache sub-50ms stale-while-revalidate sul dettaglio offerta', () => {
    const request = new Request('https://frontaliereticino.ch/offerte-lavoro-svizzera/fullstack-developer-zurigo');
    const url = new URL(request.url);
    const policy = determineCachePolicy(request, url);

    expect(policy).not.toBeNull();
    expect(policy?.cacheControl).toBe(JOB_DETAIL_CACHE_CONTROL);
    expect(policy?.cacheControl).toContain('s-maxage=86400');
    expect(policy?.cacheControl).toContain('stale-while-revalidate=86400');
    expect(policy?.bypassEdgeCache).toBe(false);
  });

  it('gestisce i dettagli offerta con prefisso di locale (es. /de/lavoro/slug)', () => {
    const request = new Request('https://frontaliereticino.ch/de/lavoro/senior-devops-engineer');
    const url = new URL(request.url);
    const policy = determineCachePolicy(request, url);

    expect(policy).not.toBeNull();
    expect(policy?.cacheControl).toBe(JOB_DETAIL_CACHE_CONTROL);
    expect(policy?.edgeTtl).toBe(86400);
  });

  it('applica la cache breve (5min edge + 24h SWR) sul listing principale delle offerte', () => {
    const request = new Request('https://frontaliereticino.ch/offerte-lavoro-svizzera');
    const url = new URL(request.url);
    const policy = determineCachePolicy(request, url);

    expect(policy).not.toBeNull();
    expect(policy?.cacheControl).toBe(JOB_LISTING_CACHE_CONTROL);
    expect(policy?.cacheControl).toContain('s-maxage=300');
    expect(policy?.cacheControl).toContain('stale-while-revalidate=86400');
    expect(policy?.edgeTtl).toBe(300);
  });

  it('applica la cache di 7 giorni SWR sulle pagine market insights / stipendi', () => {
    const request = new Request('https://frontaliereticino.ch/insights/salari-software-engineer-ticino');
    const url = new URL(request.url);
    const policy = determineCachePolicy(request, url);

    expect(policy).not.toBeNull();
    expect(policy?.cacheControl).toBe(INSIGHTS_CACHE_CONTROL);
    expect(policy?.cacheControl).toContain('stale-while-revalidate=604800');
  });

  it('forza private, no-store su qualsiasi richiesta con Cookie di sessione o auth', () => {
    const request = new Request('https://frontaliereticino.ch/offerte-lavoro-svizzera/rolex-watchmaker', {
      headers: {
        Cookie: '__session=user_abc_123',
      },
    });
    const url = new URL(request.url);
    const policy = determineCachePolicy(request, url);

    expect(policy).not.toBeNull();
    expect(policy?.cacheControl).toBe(PRIVATE_NO_STORE_CACHE_CONTROL);
    expect(policy?.bypassEdgeCache).toBe(true);
  });

  it('forza private, no-store su header Authorization', () => {
    const request = new Request('https://frontaliereticino.ch/lavoro/rolex-watchmaker', {
      headers: {
        Authorization: 'Bearer test-token',
      },
    });
    const url = new URL(request.url);
    const policy = determineCachePolicy(request, url);

    expect(policy).not.toBeNull();
    expect(policy?.cacheControl).toBe(PRIVATE_NO_STORE_CACHE_CONTROL);
    expect(policy?.bypassEdgeCache).toBe(true);
  });

  it('forza private, no-store sulle rotte di candidatura assistita e checkout', () => {
    const request = new Request('https://frontaliereticino.ch/candidatura-assistita/upload-cv');
    const url = new URL(request.url);
    const policy = determineCachePolicy(request, url);

    expect(policy).not.toBeNull();
    expect(policy?.cacheControl).toBe(PRIVATE_NO_STORE_CACHE_CONTROL);
    expect(policy?.bypassEdgeCache).toBe(true);
  });

  it('restituisce null per rotte generiche che devono mantenere il default origin', () => {
    const request = new Request('https://frontaliereticino.ch/chi-siamo');
    const url = new URL(request.url);
    const policy = determineCachePolicy(request, url);

    expect(policy).toBeNull();
  });
});
