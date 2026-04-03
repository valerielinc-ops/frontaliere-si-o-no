import { useState, useEffect, useCallback, type MouseEvent } from 'react';
import { Bell, X, Sparkles, Zap, Bug, ChevronRight, PartyPopper } from 'lucide-react';
import { useTranslation, useLocale } from '@/services/i18n';
import { useNavigationOptional } from '@/services/NavigationContext';
import { buildPath, type AppRoute } from '@/services/router';

// ─── Types ───────────────────────────────────────────────────────────────

type ReleaseItemType = 'feature' | 'improvement' | 'fix';

interface ReleaseItem {
  type: ReleaseItemType;
  titleKey: string;
  descKey: string;
  link?: { tab: string; subTab?: string };
}

interface Release {
  version: string;
  date: string;
  titleKey: string;
  items: ReleaseItem[];
}

// ─── Release Notes Data ──────────────────────────────────────────────────
// Add new releases at the TOP of this array (newest first).

export const RELEASES: Release[] = [
  {
    version: '3.43.0',
    date: '2026-03-24',
    titleKey: 'whatsNew.v3430.title',
    items: [
      {
        type: 'fix',
        titleKey: 'whatsNew.v3430.newsletter.title',
        descKey: 'whatsNew.v3430.newsletter.desc',
        link: { tab: 'job-board' },
      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3430.FRO-396.title',
        descKey: 'whatsNew.v3430.FRO-396.desc',

      },
      {
        type: 'feature',
        titleKey: 'whatsNew.v3430.FRO-398.title',
        descKey: 'whatsNew.v3430.FRO-398.desc',

      },
      {
        type: 'feature',
        titleKey: 'whatsNew.v3430.FRO-400.title',
        descKey: 'whatsNew.v3430.FRO-400.desc',
        link: { tab: 'job-board' },
      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3430.FRO-401,FRO-411.title',
        descKey: 'whatsNew.v3430.FRO-401,FRO-411.desc',
        link: { tab: 'job-board' },
      },
    ],
  },
  {
    version: '3.42.0',
    date: '2026-03-24',
    titleKey: 'whatsNew.v3420.title',
    items: [
      {
        type: 'feature',
        titleKey: 'whatsNew.v3420.FRO-399.title',
        descKey: 'whatsNew.v3420.FRO-399.desc',
        link: { tab: 'job-board' },
      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3420.build.title',
        descKey: 'whatsNew.v3420.build.desc',

      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3420.data.title',
        descKey: 'whatsNew.v3420.data.desc',
        link: { tab: 'job-board' },
      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3420.FRO-411,FRO-404.title',
        descKey: 'whatsNew.v3420.FRO-411,FRO-404.desc',

      },
      {
        type: 'feature',
        titleKey: 'whatsNew.v3420.FRO-406.title',
        descKey: 'whatsNew.v3420.FRO-406.desc',

      },
    ],
  },
  {
    version: '3.41.0',
    date: '2026-03-24',
    titleKey: 'whatsNew.v3410.title',
    items: [
      {
        type: 'feature',
        titleKey: 'whatsNew.v3410.blog.title',
        descKey: 'whatsNew.v3410.blog.desc',

      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3410.seo.title',
        descKey: 'whatsNew.v3410.seo.desc',
        link: { tab: 'calculator', subTab: 'calculator' },
      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3410.crawlers.title',
        descKey: 'whatsNew.v3410.crawlers.desc',
        link: { tab: 'job-board' },
      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3410.articles.title',
        descKey: 'whatsNew.v3410.articles.desc',

      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3410.tests.title',
        descKey: 'whatsNew.v3410.tests.desc',
        link: { tab: 'job-board' },
      },
    ],
  },
  {
    version: '3.40.0',
    date: '2026-03-23',
    titleKey: 'whatsNew.v3400.title',
    items: [
      {
        type: 'fix',
        titleKey: 'whatsNew.v3400.seo.title',
        descKey: 'whatsNew.v3400.seo.desc',
        link: { tab: 'job-board' },
      },
      {
        type: 'feature',
        titleKey: 'whatsNew.v3400.products.title',
        descKey: 'whatsNew.v3400.products.desc',

      },
      {
        type: 'feature',
        titleKey: 'whatsNew.v3400.alerts.title',
        descKey: 'whatsNew.v3400.alerts.desc',
        link: { tab: 'job-board' },
      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3400.build.title',
        descKey: 'whatsNew.v3400.build.desc',
        link: { tab: 'job-board' },
      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3400.tests.title',
        descKey: 'whatsNew.v3400.tests.desc',
        link: { tab: 'job-board' },
      },
    ],
  },
  {
    version: '3.39.0',
    date: '2026-03-23',
    titleKey: 'whatsNew.v3390.title',
    items: [
      {
        type: 'fix',
        titleKey: 'whatsNew.v3390.correct-distdir-path.title',
        descKey: 'whatsNew.v3390.correct-distdir-path.desc',

      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3390.exclude-yearlike-values.title',
        descKey: 'whatsNew.v3390.exclude-yearlike-values.desc',

      },
      {
        type: 'feature',
        titleKey: 'whatsNew.v3390.render-headings-and.title',
        descKey: 'whatsNew.v3390.render-headings-and.desc',

      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3390.show-adsense-ads.title',
        descKey: 'whatsNew.v3390.show-adsense-ads.desc',

      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3390.remove-www-from.title',
        descKey: 'whatsNew.v3390.remove-www-from.desc',

      },
    ],
  },
  {
    version: '3.38.0',
    date: '2026-03-23',
    titleKey: 'whatsNew.v3380.title',
    items: [
      {
        type: 'fix',
        titleKey: 'whatsNew.v3380.expired-job-pages.title',
        descKey: 'whatsNew.v3380.expired-job-pages.desc',
        link: { tab: 'job-board' },
      },
      {
        type: 'feature',
        titleKey: 'whatsNew.v3380.eeat.title',
        descKey: 'whatsNew.v3380.eeat.desc',

      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3380.seo.title',
        descKey: 'whatsNew.v3380.seo.desc',

      },
      {
        type: 'feature',
        titleKey: 'whatsNew.v3380.auth.title',
        descKey: 'whatsNew.v3380.auth.desc',
        link: { tab: 'job-board' },
      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3380.crawler.title',
        descKey: 'whatsNew.v3380.crawler.desc',
        link: { tab: 'job-board' },
      },
    ],
  },
  {
    version: '3.37.0',
    date: '2026-03-23',
    titleKey: 'whatsNew.v3370.title',
    items: [
      {
        type: 'fix',
        titleKey: 'whatsNew.v3370.repair-job-locale.title',
        descKey: 'whatsNew.v3370.repair-job-locale.desc',
        link: { tab: 'job-board' },
      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3370.correct-swapped-iten.title',
        descKey: 'whatsNew.v3370.correct-swapped-iten.desc',
        link: { tab: 'job-board' },
      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3370.remove-invalid-jobposting.title',
        descKey: 'whatsNew.v3370.remove-invalid-jobposting.desc',
        link: { tab: 'job-board' },
      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3370.increase-global-test.title',
        descKey: 'whatsNew.v3370.increase-global-test.desc',

      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3370.increase-waitforlivearticlemeta-test.title',
        descKey: 'whatsNew.v3370.increase-waitforlivearticlemeta-test.desc',

      },
    ],
  },
  {
    version: '3.36.0',
    date: '2026-03-23',
    titleKey: 'whatsNew.v3360.title',
    items: [
      {
        type: 'fix',
        titleKey: 'whatsNew.v3360.translation-pipeline.title',
        descKey: 'whatsNew.v3360.translation-pipeline.desc',

      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3360.lwphr.title',
        descKey: 'whatsNew.v3360.lwphr.desc',

      },
      {
        type: 'feature',
        titleKey: 'whatsNew.v3360.FRO-215.title',
        descKey: 'whatsNew.v3360.FRO-215.desc',

      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3360.validate-canonical.title',
        descKey: 'whatsNew.v3360.validate-canonical.desc',

      },
      {
        type: 'feature',
        titleKey: 'whatsNew.v3360.FRO-216.title',
        descKey: 'whatsNew.v3360.FRO-216.desc',

      },
    ],
  },
  {
    version: '3.35.0',
    date: '2026-03-22',
    titleKey: 'whatsNew.v3350.title',
    items: [
      {
        type: 'fix',
        titleKey: 'whatsNew.v3350.clear-untranslated-english.title',
        descKey: 'whatsNew.v3350.clear-untranslated-english.desc',

      },
      {
        type: 'feature',
        titleKey: 'whatsNew.v3350.extend-free-translation.title',
        descKey: 'whatsNew.v3350.extend-free-translation.desc',
        link: { tab: 'calculator', subTab: 'calculator' },
      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3350.FRO-150.title',
        descKey: 'whatsNew.v3350.FRO-150.desc',

      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3350.prune-dead-translation.title',
        descKey: 'whatsNew.v3350.prune-dead-translation.desc',

      },
      {
        type: 'feature',
        titleKey: 'whatsNew.v3350.expand-free-translation.title',
        descKey: 'whatsNew.v3350.expand-free-translation.desc',

      },
    ],
  },
  {
    version: '3.34.0',
    date: '2026-03-22',
    titleKey: 'whatsNew.v3340.title',
    items: [
      {
        type: 'feature',
        titleKey: 'whatsNew.v3340.update-jobs-stats.title',
        descKey: 'whatsNew.v3340.update-jobs-stats.desc',
        link: { tab: 'job-board' },
      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3340.fix-auth-debug.title',
        descKey: 'whatsNew.v3340.fix-auth-debug.desc',

      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3340.fix-seo-sitemap.title',
        descKey: 'whatsNew.v3340.fix-seo-sitemap.desc',

      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3340.fix-auth-and.title',
        descKey: 'whatsNew.v3340.fix-auth-and.desc',

      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3340.ci.title',
        descKey: 'whatsNew.v3340.ci.desc',

      },
    ],
  },
  {
    version: '3.33.0',
    date: '2026-03-20',
    titleKey: 'whatsNew.v3330.title',
    items: [
      {
        type: 'feature',
        titleKey: 'whatsNew.v3330.seo.title',
        descKey: 'whatsNew.v3330.seo.desc',

      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3330.quality.title',
        descKey: 'whatsNew.v3330.quality.desc',
        link: { tab: 'job-board' },
      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3330.assembler.title',
        descKey: 'whatsNew.v3330.assembler.desc',

      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3330.indexnow.title',
        descKey: 'whatsNew.v3330.indexnow.desc',

      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3330.limit-blockquote-rendering.title',
        descKey: 'whatsNew.v3330.limit-blockquote-rendering.desc',
        link: { tab: 'job-board' },
      },
    ],
  },
  {
    version: '3.32.0',
    date: '2026-03-19',
    titleKey: 'whatsNew.v3320.title',
    items: [
      {
        type: 'feature',
        titleKey: 'whatsNew.v3320.admin.title',
        descKey: 'whatsNew.v3320.admin.desc',
        link: { tab: 'stats' },
      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3320.alten.title',
        descKey: 'whatsNew.v3320.alten.desc',
        link: { tab: 'job-board' },
      },
      {
        type: 'feature',
        titleKey: 'whatsNew.v3320.a-plus-plus.title',
        descKey: 'whatsNew.v3320.a-plus-plus.desc',
        link: { tab: 'job-board' },
      },
      {
        type: 'feature',
        titleKey: 'whatsNew.v3320.dot-life.title',
        descKey: 'whatsNew.v3320.dot-life.desc',
        link: { tab: 'job-board' },
      },
      {
        type: 'feature',
        titleKey: 'whatsNew.v3320.newsletter.title',
        descKey: 'whatsNew.v3320.newsletter.desc',

      },
    ],
  },
  {
    version: '3.31.0',
    date: '2026-03-19',
    titleKey: 'whatsNew.v3310.title',
    items: [
      {
        type: 'feature',
        titleKey: 'whatsNew.v3310.boggi.title',
        descKey: 'whatsNew.v3310.boggi.desc',
        link: { tab: 'job-board' },
      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3310.tich.title',
        descKey: 'whatsNew.v3310.tich.desc',

      },
      {
        type: 'feature',
        titleKey: 'whatsNew.v3310.pipeline.title',
        descKey: 'whatsNew.v3310.pipeline.desc',
        link: { tab: 'job-board' },
      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3310.adapters.title',
        descKey: 'whatsNew.v3310.adapters.desc',
        link: { tab: 'job-board' },
      },
      {
        type: 'feature',
        titleKey: 'whatsNew.v3310.admin.title',
        descKey: 'whatsNew.v3310.admin.desc',
        link: { tab: 'stats' },
      },
    ],
  },
  {
    version: '3.30.0',
    date: '2026-03-18',
    titleKey: 'whatsNew.v3300.title',
    items: [
      {
        type: 'fix',
        titleKey: 'whatsNew.v3300.la-fonte.title',
        descKey: 'whatsNew.v3300.la-fonte.desc',

      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3300.oscam.title',
        descKey: 'whatsNew.v3300.oscam.desc',
        link: { tab: 'job-board' },
      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3300.cler.title',
        descKey: 'whatsNew.v3300.cler.desc',
        link: { tab: 'job-board' },
      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3300.crawler.title',
        descKey: 'whatsNew.v3300.crawler.desc',
        link: { tab: 'job-board' },
      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3300.data.title',
        descKey: 'whatsNew.v3300.data.desc',
        link: { tab: 'job-board' },
      },
    ],
  },
  {
    version: '3.29.1',
    date: '2026-03-16',
    titleKey: 'whatsNew.v3291.title',
    items: [
      {
        type: 'fix',
        titleKey: 'whatsNew.v3291.resolve-96-job.title',
        descKey: 'whatsNew.v3291.resolve-96-job.desc',
        link: { tab: 'job-board' },
      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3291.newsletter-url-validation.title',
        descKey: 'whatsNew.v3291.newsletter-url-validation.desc',

      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3291.guard-against-codescript.title',
        descKey: 'whatsNew.v3291.guard-against-codescript.desc',
        link: { tab: 'job-board' },
      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3291.enrich-73-thin.title',
        descKey: 'whatsNew.v3291.enrich-73-thin.desc',
        link: { tab: 'job-board' },
      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3291.eagerly-preload-job.title',
        descKey: 'whatsNew.v3291.eagerly-preload-job.desc',
        link: { tab: 'job-board' },
      },
    ],
  },
  {
    version: '3.29.0',
    date: '2026-03-16',
    titleKey: 'whatsNew.v3290.title',
    items: [
      {
        type: 'feature',
        titleKey: 'whatsNew.v3290.crawler.title',
        descKey: 'whatsNew.v3290.crawler.desc',
        link: { tab: 'job-board' },
      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3290.sync-blogarticleid-type.title',
        descKey: 'whatsNew.v3290.sync-blogarticleid-type.desc',

      },
      {
        type: 'feature',
        titleKey: 'whatsNew.v3290.newsletter.title',
        descKey: 'whatsNew.v3290.newsletter.desc',
        link: { tab: 'job-board' },
      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3290.eliminate-mobile-horizontal.title',
        descKey: 'whatsNew.v3290.eliminate-mobile-horizontal.desc',
        link: { tab: 'job-board' },
      },
      {
        type: 'feature',
        titleKey: 'whatsNew.v3290.add-adsense-infeed.title',
        descKey: 'whatsNew.v3290.add-adsense-infeed.desc',
        link: { tab: 'job-board' },
      },
    ],
  },
  {
    version: '3.28.0',
    date: '2026-03-16',
    titleKey: 'whatsNew.v3280.title',
    items: [
      {
        type: 'feature',
        titleKey: 'whatsNew.v3280.crawler.title',
        descKey: 'whatsNew.v3280.crawler.desc',
        link: { tab: 'job-board' },
      },
    ],
  },
  {
    version: '3.27.0',
    date: '2026-03-15',
    titleKey: 'whatsNew.v3270.title',
    items: [
      {
        type: 'fix',
        titleKey: 'whatsNew.v3270.admin-panel-stats.title',
        descKey: 'whatsNew.v3270.admin-panel-stats.desc',
        link: { tab: 'stats' },
      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3270.translate-job-detail.title',
        descKey: 'whatsNew.v3270.translate-job-detail.desc',
        link: { tab: 'job-board' },
      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3270.wrap-autocomplete-suggestions.title',
        descKey: 'whatsNew.v3270.wrap-autocomplete-suggestions.desc',

      },
      {
        type: 'feature',
        titleKey: 'whatsNew.v3270.add-confederazione-ticino.title',
        descKey: 'whatsNew.v3270.add-confederazione-ticino.desc',
        link: { tab: 'job-board' },
      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3270.repair-3-failing.title',
        descKey: 'whatsNew.v3270.repair-3-failing.desc',
        link: { tab: 'job-board' },
      },
    ],
  },
  {
    version: '3.26.0',
    date: '2026-03-15',
    titleKey: 'whatsNew.v3260.title',
    items: [
      {
        type: 'feature',
        titleKey: 'whatsNew.v3260.crawler.title',
        descKey: 'whatsNew.v3260.crawler.desc',
        link: { tab: 'job-board' },
      },
      {
        type: 'feature',
        titleKey: 'whatsNew.v3260.add-dedicated-crawler.title',
        descKey: 'whatsNew.v3260.add-dedicated-crawler.desc',
        link: { tab: 'job-board' },
      },
      {
        type: 'feature',
        titleKey: 'whatsNew.v3260.add-banca-raiffeisen.title',
        descKey: 'whatsNew.v3260.add-banca-raiffeisen.desc',
        link: { tab: 'job-board' },
      },
      {
        type: 'feature',
        titleKey: 'whatsNew.v3260.add-dedicated-baronie.title',
        descKey: 'whatsNew.v3260.add-dedicated-baronie.desc',
        link: { tab: 'job-board' },
      },
      {
        type: 'feature',
        titleKey: 'whatsNew.v3260.add-dedicated-centiel.title',
        descKey: 'whatsNew.v3260.add-dedicated-centiel.desc',
        link: { tab: 'job-board' },
      },
    ],
  },
  {
    version: '3.25.0',
    date: '2026-03-14',
    titleKey: 'whatsNew.v3250.title',
    items: [
      {
        type: 'fix',
        titleKey: 'whatsNew.v3250.add-spa-redirect.title',
        descKey: 'whatsNew.v3250.add-spa-redirect.desc',

      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3250.tolerate-missing-locale.title',
        descKey: 'whatsNew.v3250.tolerate-missing-locale.desc',
        link: { tab: 'job-board' },
      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3250.add-lingva-chunked.title',
        descKey: 'whatsNew.v3250.add-lingva-chunked.desc',
        link: { tab: 'job-board' },
      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3250.bypass-negative-cache.title',
        descKey: 'whatsNew.v3250.bypass-negative-cache.desc',

      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3250.add-translation-safety.title',
        descKey: 'whatsNew.v3250.add-translation-safety.desc',

      },
    ],
  },
  {
    version: '3.24.0',
    date: '2026-03-14',
    titleKey: 'whatsNew.v3240.title',
    items: [
      {
        type: 'fix',
        titleKey: 'whatsNew.v3240.newsletter-confirmation-link.title',
        descKey: 'whatsNew.v3240.newsletter-confirmation-link.desc',

      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3240.convert-newslettersendconfirmation-from.title',
        descKey: 'whatsNew.v3240.convert-newslettersendconfirmation-from.desc',

      },
      {
        type: 'feature',
        titleKey: 'whatsNew.v3240.add-welcome-overlay.title',
        descKey: 'whatsNew.v3240.add-welcome-overlay.desc',

      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3240.embed-signup-page.title',
        descKey: 'whatsNew.v3240.embed-signup-page.desc',

      },
      {
        type: 'feature',
        titleKey: 'whatsNew.v3240.auto-signin-user.title',
        descKey: 'whatsNew.v3240.auto-signin-user.desc',

      },
    ],
  },
  {
    version: '3.23.0',
    date: '2026-03-13',
    titleKey: 'whatsNew.v3230.title',
    items: [
      {
        type: 'fix',
        titleKey: 'whatsNew.v3230.FRO-29.title',
        descKey: 'whatsNew.v3230.FRO-29.desc',

      },
      {
        type: 'feature',
        titleKey: 'whatsNew.v3230.FRO-34.title',
        descKey: 'whatsNew.v3230.FRO-34.desc',

      },
      {
        type: 'feature',
        titleKey: 'whatsNew.v3230.i18n.title',
        descKey: 'whatsNew.v3230.i18n.desc',

      },
      {
        type: 'feature',
        titleKey: 'whatsNew.v3230.FRO-31.title',
        descKey: 'whatsNew.v3230.FRO-31.desc',

      },
      {
        type: 'feature',
        titleKey: 'whatsNew.v3230.FRO-30.title',
        descKey: 'whatsNew.v3230.FRO-30.desc',

      },
    ],
  },
  {
    version: '3.22.0',
    date: '2026-03-13',
    titleKey: 'whatsNew.v3220.title',
    items: [
      {
        type: 'fix',
        titleKey: 'whatsNew.v3220.FRO-6.title',
        descKey: 'whatsNew.v3220.FRO-6.desc',

      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3220.traffic.title',
        descKey: 'whatsNew.v3220.traffic.desc',

      },
      {
        type: 'feature',
        titleKey: 'whatsNew.v3220.use-real-firestore.title',
        descKey: 'whatsNew.v3220.use-real-firestore.desc',

      },
      {
        type: 'feature',
        titleKey: 'whatsNew.v3220.FRO-11.title',
        descKey: 'whatsNew.v3220.FRO-11.desc',

      },
      {
        type: 'feature',
        titleKey: 'whatsNew.v3220.schedule-newsletter-branded.title',
        descKey: 'whatsNew.v3220.schedule-newsletter-branded.desc',

      },
    ],
  },
  {
    version: '3.21.0',
    date: '2026-03-13',
    titleKey: 'whatsNew.v321.title',
    items: [
      {
        type: 'feature',
        titleKey: 'whatsNew.v321.emailConfirmed.title',
        descKey: 'whatsNew.v321.emailConfirmed.desc',
        link: { tab: 'email-confirmed' },
      },
      {
        type: 'feature',
        titleKey: 'whatsNew.v321.brandedEmail.title',
        descKey: 'whatsNew.v321.brandedEmail.desc',
      },
    ],
  },
  {
    version: '3.20.0',
    date: '2026-03-13',
    titleKey: 'whatsNew.v3200.title',
    items: [
      {
        type: 'feature',
        titleKey: 'whatsNew.v3200.add-dedicated-hoval.title',
        descKey: 'whatsNew.v3200.add-dedicated-hoval.desc',
        link: { tab: 'job-board' },
      },
      {
        type: 'feature',
        titleKey: 'whatsNew.v3200.add-dedicated-knowledge.title',
        descKey: 'whatsNew.v3200.add-dedicated-knowledge.desc',
        link: { tab: 'job-board' },
      },
      {
        type: 'feature',
        titleKey: 'whatsNew.v3200.add-dedicated-tarchini.title',
        descKey: 'whatsNew.v3200.add-dedicated-tarchini.desc',
        link: { tab: 'job-board' },
      },
      {
        type: 'feature',
        titleKey: 'whatsNew.v3200.add-dedicated-afry.title',
        descKey: 'whatsNew.v3200.add-dedicated-afry.desc',
        link: { tab: 'job-board' },
      },
      {
        type: 'feature',
        titleKey: 'whatsNew.v3200.add-dedicated-agie.title',
        descKey: 'whatsNew.v3200.add-dedicated-agie.desc',
        link: { tab: 'job-board' },
      },
    ],
  },
  {
    version: '3.19.0',
    date: '2026-03-12',
    titleKey: 'whatsNew.v3190.title',
    items: [
      {
        type: 'fix',
        titleKey: 'whatsNew.v3190.admin.title',
        descKey: 'whatsNew.v3190.admin.desc',
        link: { tab: 'job-board' },
      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3190.harden-createarticle-against.title',
        descKey: 'whatsNew.v3190.harden-createarticle-against.desc',

      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3190.guard-authisemaillinksignin-suppress.title',
        descKey: 'whatsNew.v3190.guard-authisemaillinksignin-suppress.desc',

      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3190.resolve-257-soft404.title',
        descKey: 'whatsNew.v3190.resolve-257-soft404.desc',

      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3190.resolve-thin-content.title',
        descKey: 'whatsNew.v3190.resolve-thin-content.desc',
        link: { tab: 'job-board' },
      },
    ],
  },
  {
    version: '3.18.0',
    date: '2026-03-12',
    titleKey: 'whatsNew.v3180.title',
    items: [
      {
        type: 'fix',
        titleKey: 'whatsNew.v3180.add-346-compat.title',
        descKey: 'whatsNew.v3180.add-346-compat.desc',

      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3180.seo.title',
        descKey: 'whatsNew.v3180.seo.desc',

      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3180.crawlers.title',
        descKey: 'whatsNew.v3180.crawlers.desc',
        link: { tab: 'job-board' },
      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3180.remove-4-compat.title',
        descKey: 'whatsNew.v3180.remove-4-compat.desc',

      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3180.preserve-hashbased-job.title',
        descKey: 'whatsNew.v3180.preserve-hashbased-job.desc',
        link: { tab: 'job-board' },
      },
    ],
  },
  {
    version: '3.17.0',
    date: '2026-03-12',
    titleKey: 'whatsNew.v3170.title',
    items: [
      {
        type: 'fix',
        titleKey: 'whatsNew.v3170.crawler-workflow-fixes.title',
        descKey: 'whatsNew.v3170.crawler-workflow-fixes.desc',
        link: { tab: 'job-board' },
      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3170.alten-graceful-siteblocking.title',
        descKey: 'whatsNew.v3170.alten-graceful-siteblocking.desc',

      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3170.add-missingdescription-tolerance.title',
        descKey: 'whatsNew.v3170.add-missingdescription-tolerance.desc',

      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3170.deduplicate-history-entries.title',
        descKey: 'whatsNew.v3170.deduplicate-history-entries.desc',

      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3170.increase-crawler-summaries.title',
        descKey: 'whatsNew.v3170.increase-crawler-summaries.desc',
        link: { tab: 'job-board' },
      },
    ],
  },
  {
    version: '3.16.0',
    date: '2026-03-12',
    titleKey: 'whatsNew.v3160.title',
    items: [
      {
        type: 'fix',
        titleKey: 'whatsNew.v3160.unblock-deploy-downgrade.title',
        descKey: 'whatsNew.v3160.unblock-deploy-downgrade.desc',
        link: { tab: 'job-board' },
      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3160.reorder-prepush-hook.title',
        descKey: 'whatsNew.v3160.reorder-prepush-hook.desc',

      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3160.make-streetaddress-blocking.title',
        descKey: 'whatsNew.v3160.make-streetaddress-blocking.desc',

      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3160.increase-test-timeouts.title',
        descKey: 'whatsNew.v3160.increase-test-timeouts.desc',

      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3160.add-missing-postchjobparser.title',
        descKey: 'whatsNew.v3160.add-missing-postchjobparser.desc',
        link: { tab: 'job-board' },
      },
    ],
  },
  {
    version: '3.15.1',
    date: '2026-03-11',
    titleKey: 'whatsNew.v3151.title',
    items: [
      {
        type: 'fix',
        titleKey: 'whatsNew.v3151.crawler-tab-shows.title',
        descKey: 'whatsNew.v3151.crawler-tab-shows.desc',
        link: { tab: 'job-board' },
      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3151.prevent-swcachestale-by.title',
        descKey: 'whatsNew.v3151.prevent-swcachestale-by.desc',

      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3151.seo.title',
        descKey: 'whatsNew.v3151.seo.desc',

      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3151.add-og-meta.title',
        descKey: 'whatsNew.v3151.add-og-meta.desc',

      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3151.use-relative-imports.title',
        descKey: 'whatsNew.v3151.use-relative-imports.desc',
        link: { tab: 'job-board' },
      },
    ],
  },
  {
    version: '3.15.0',
    date: '2026-03-10',
    titleKey: 'whatsNew.v3150.title',
    items: [
      {
        type: 'feature',
        titleKey: 'whatsNew.v3150.add-site-logo.title',
        descKey: 'whatsNew.v3150.add-site-logo.desc',

      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3150.render-only-hub.title',
        descKey: 'whatsNew.v3150.render-only-hub.desc',

      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3150.make-sitesearch-nonblocking.title',
        descKey: 'whatsNew.v3150.make-sitesearch-nonblocking.desc',

      },
      {
        type: 'feature',
        titleKey: 'whatsNew.v3150.add-reportcaughterror-to.title',
        descKey: 'whatsNew.v3150.add-reportcaughterror-to.desc',

      },
      {
        type: 'feature',
        titleKey: 'whatsNew.v3150.use-authfrontaliereticinoch-as.title',
        descKey: 'whatsNew.v3150.use-authfrontaliereticinoch-as.desc',

      },
    ],
  },
  {
    version: '3.14.0',
    date: '2026-03-10',
    titleKey: 'whatsNew.v3140.title',
    items: [
      {
        type: 'fix',
        titleKey: 'whatsNew.v3140.i18n.title',
        descKey: 'whatsNew.v3140.i18n.desc',

      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3140.ux.title',
        descKey: 'whatsNew.v3140.ux.desc',
        link: { tab: 'job-board' },
      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3140.report-caught-errors.title',
        descKey: 'whatsNew.v3140.report-caught-errors.desc',

      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3140.jobs.title',
        descKey: 'whatsNew.v3140.jobs.desc',
        link: { tab: 'job-board' },
      },
      {
        type: 'feature',
        titleKey: 'whatsNew.v3140.seo.title',
        descKey: 'whatsNew.v3140.seo.desc',

      },
    ],
  },
  {
    version: '3.13.0',
    date: '2026-03-10',
    titleKey: 'whatsNew.v3130.title',
    items: [
      {
        type: 'feature',
        titleKey: 'whatsNew.v3130.quickFilters.title',
        descKey: 'whatsNew.v3130.quickFilters.desc',
        link: { tab: 'job-board' },
      },
      {
        type: 'feature',
        titleKey: 'whatsNew.v3130.smartSearch.title',
        descKey: 'whatsNew.v3130.smartSearch.desc',
      },
      {
        type: 'feature',
        titleKey: 'whatsNew.v3130.taxTables.title',
        descKey: 'whatsNew.v3130.taxTables.desc',
        link: { tab: 'fisco', subTab: 'withholding-rates' },
      },
      {
        type: 'feature',
        titleKey: 'whatsNew.v3130.salaryBreakdown.title',
        descKey: 'whatsNew.v3130.salaryBreakdown.desc',
        link: { tab: 'calculator', subTab: 'calculator' },
      },
      {
        type: 'feature',
        titleKey: 'whatsNew.v3130.blogLabels.title',
        descKey: 'whatsNew.v3130.blogLabels.desc',
        link: { tab: 'blog' },
      },
    ],
  },
  {
    version: '3.12.0',
    date: '2026-03-09',
    titleKey: 'whatsNew.v3120.title',
    items: [
      {
        type: 'feature',
        titleKey: 'whatsNew.v3120.strict-4locale-translation.title',
        descKey: 'whatsNew.v3120.strict-4locale-translation.desc',
        link: { tab: 'job-board' },
      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3120.add-pdfjobcontent-moduletests.title',
        descKey: 'whatsNew.v3120.add-pdfjobcontent-moduletests.desc',
        link: { tab: 'job-board' },
      },
      {
        type: 'feature',
        titleKey: 'whatsNew.v3120.jobs.title',
        descKey: 'whatsNew.v3120.jobs.desc',
        link: { tab: 'job-board' },
      },
      {
        type: 'feature',
        titleKey: 'whatsNew.v3120.crawler.title',
        descKey: 'whatsNew.v3120.crawler.desc',
        link: { tab: 'job-board' },
      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3120.rhb-parser.title',
        descKey: 'whatsNew.v3120.rhb-parser.desc',

      },
    ],
  },
  {
    version: '3.11.0',
    date: '2026-03-09',
    titleKey: 'whatsNew.v3110.title',
    items: [
      {
        type: 'fix',
        titleKey: 'whatsNew.v3110.use-semver-comparison.title',
        descKey: 'whatsNew.v3110.use-semver-comparison.desc',

      },
      {
        type: 'feature',
        titleKey: 'whatsNew.v3110.centralized-error-reporting.title',
        descKey: 'whatsNew.v3110.centralized-error-reporting.desc',
        link: { tab: 'calculator', subTab: 'calculator' },
      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3110.use-service-account.title',
        descKey: 'whatsNew.v3110.use-service-account.desc',
        link: { tab: 'stats' },
      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3110.use-v1alpha-api.title',
        descKey: 'whatsNew.v3110.use-v1alpha-api.desc',

      },
      {
        type: 'feature',
        titleKey: 'whatsNew.v3110.add-bing-content.title',
        descKey: 'whatsNew.v3110.add-bing-content.desc',

      },
    ],
  },
  {
    version: '3.10.0',
    date: '2026-03-08',
    titleKey: 'whatsNew.v3100.title',
    items: [
      {
        type: 'fix',
        titleKey: 'whatsNew.v3100.prevent-crosslocale-content.title',
        descKey: 'whatsNew.v3100.prevent-crosslocale-content.desc',
        link: { tab: 'job-board' },
      },
      {
        type: 'feature',
        titleKey: 'whatsNew.v3100.add-educatore-infanzia.title',
        descKey: 'whatsNew.v3100.add-educatore-infanzia.desc',

      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v3100.resolve-unhandled-promise.title',
        descKey: 'whatsNew.v3100.resolve-unhandled-promise.desc',

      },
      {
        type: 'feature',
        titleKey: 'whatsNew.v3100.integrate-microsoft-clarity.title',
        descKey: 'whatsNew.v3100.integrate-microsoft-clarity.desc',

      },
      {
        type: 'feature',
        titleKey: 'whatsNew.v3100.expand-ai-coverage.title',
        descKey: 'whatsNew.v3100.expand-ai-coverage.desc',

      },
    ],
  },
  {
    version: '3.9.0',
    date: '2026-03-08',
    titleKey: 'whatsNew.v390.title',
    items: [
      {
        type: 'feature',
        titleKey: 'whatsNew.v390.jobs.title',
        descKey: 'whatsNew.v390.jobs.desc',
        link: { tab: 'job-board' },
      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v390.crawler-workflow-failures.title',
        descKey: 'whatsNew.v390.crawler-workflow-failures.desc',
        link: { tab: 'job-board' },
      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v390.robust-push-retry.title',
        descKey: 'whatsNew.v390.robust-push-retry.desc',

      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v390.add-untranslated-titleslug.title',
        descKey: 'whatsNew.v390.add-untranslated-titleslug.desc',

      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v390.lower-title-quality.title',
        descKey: 'whatsNew.v390.lower-title-quality.desc',

      },
    ],
  },
  {
    version: '3.8.0',
    date: '2026-03-07',
    titleKey: 'whatsNew.v380.title',
    items: [
      {
        type: 'fix',
        titleKey: 'whatsNew.v380.seo.title',
        descKey: 'whatsNew.v380.seo.desc',

      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v380.locale-metadata-on.title',
        descKey: 'whatsNew.v380.locale-metadata-on.desc',
        link: { tab: 'job-board' },
      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v380.crawler.title',
        descKey: 'whatsNew.v380.crawler.desc',
        link: { tab: 'job-board' },
      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v380.lis-crawler.title',
        descKey: 'whatsNew.v380.lis-crawler.desc',
        link: { tab: 'job-board' },
      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v380.lidl-crawler.title',
        descKey: 'whatsNew.v380.lidl-crawler.desc',
        link: { tab: 'job-board' },
      },
    ],
  },
  {
    version: '3.7.0',
    date: '2026-03-06',
    titleKey: 'whatsNew.v370.title',
    items: [
      {
        type: 'feature',
        titleKey: 'whatsNew.v370.jobTimeline.title',
        descKey: 'whatsNew.v370.jobTimeline.desc',
        link: { tab: 'job-board' },
      },
      {
        type: 'feature',
        titleKey: 'whatsNew.v370.relatedSearches.title',
        descKey: 'whatsNew.v370.relatedSearches.desc',
        link: { tab: 'job-board' },
      },
      {
        type: 'feature',
        titleKey: 'whatsNew.v370.companyCard.title',
        descKey: 'whatsNew.v370.companyCard.desc',
        link: { tab: 'job-board' },
      },
      {
        type: 'feature',
        titleKey: 'whatsNew.v370.mobileCalculator.title',
        descKey: 'whatsNew.v370.mobileCalculator.desc',
        link: { tab: 'calculator', subTab: 'calculator' },
      },
    ],
  },
  {
    version: '3.6.0',
    date: '2026-03-03',
    titleKey: 'whatsNew.v36.title',
    items: [
      {
        type: 'feature',
        titleKey: 'whatsNew.v36.permitQuiz.title',
        descKey: 'whatsNew.v36.permitQuiz.desc',
        link: { tab: 'permit-quiz' },
      },
      {
        type: 'feature',
        titleKey: 'whatsNew.v36.tredicesima.title',
        descKey: 'whatsNew.v36.tredicesima.desc',
        link: { tab: 'tredicesima' },
      },
      {
        type: 'feature',
        titleKey: 'whatsNew.v36.shareCard.title',
        descKey: 'whatsNew.v36.shareCard.desc',
      },
      {
        type: 'feature',
        titleKey: 'whatsNew.v36.weeklyDigest.title',
        descKey: 'whatsNew.v36.weeklyDigest.desc',
        link: { tab: 'weekly-digest' },
      },
      {
        type: 'feature',
        titleKey: 'whatsNew.v36.toolOfWeek.title',
        descKey: 'whatsNew.v36.toolOfWeek.desc',
        link: { tab: 'tool-of-week' },
      },
    ],
  },
  {
    version: '3.5.0',
    date: '2026-03-03',
    titleKey: 'whatsNew.v35.title',
    items: [
      {
        type: 'feature',
        titleKey: 'whatsNew.v35.eeat.title',
        descKey: 'whatsNew.v35.eeat.desc',
      },
      {
        type: 'feature',
        titleKey: 'whatsNew.v35.newsarticle.title',
        descKey: 'whatsNew.v35.newsarticle.desc',
      },
      {
        type: 'improvement',
        titleKey: 'whatsNew.v35.breadcrumbs.title',
        descKey: 'whatsNew.v35.breadcrumbs.desc',
      },
      {
        type: 'improvement',
        titleKey: 'whatsNew.v35.llmstxt.title',
        descKey: 'whatsNew.v35.llmstxt.desc',
      },
    ],
  },
  {
    version: '3.4.0',
    date: '2026-03-01',
    titleKey: 'whatsNew.v34.title',
    items: [
      {
        type: 'feature',
        titleKey: 'whatsNew.v34.newsletter.title',
        descKey: 'whatsNew.v34.newsletter.desc',
      },
      {
        type: 'feature',
        titleKey: 'whatsNew.v34.socialproof.title',
        descKey: 'whatsNew.v34.socialproof.desc',
      },
      {
        type: 'improvement',
        titleKey: 'whatsNew.v34.cta.title',
        descKey: 'whatsNew.v34.cta.desc',
      },
    ],
  },
  {
    version: '3.3.0',
    date: '2026-02-20',
    titleKey: 'whatsNew.v33.title',
    items: [
      {
        type: 'feature',
        titleKey: 'whatsNew.v33.salaryquiz.title',
        descKey: 'whatsNew.v33.salaryquiz.desc',
        link: { tab: 'calculator', subTab: 'salary-quiz' },
      },
      {
        type: 'feature',
        titleKey: 'whatsNew.v33.jobcomparator.title',
        descKey: 'whatsNew.v33.jobcomparator.desc',
        link: { tab: 'confronti', subTab: 'job-comparator' },
      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v33.darkmode.title',
        descKey: 'whatsNew.v33.darkmode.desc',
      },
    ],
  },
  {
    version: '3.2.0',
    date: '2026-02-10',
    titleKey: 'whatsNew.v32.title',
    items: [
      {
        type: 'feature',
        titleKey: 'whatsNew.v32.health.title',
        descKey: 'whatsNew.v32.health.desc',
        link: { tab: 'confronti', subTab: 'health-insurance' },
      },
      {
        type: 'feature',
        titleKey: 'whatsNew.v32.pension.title',
        descKey: 'whatsNew.v32.pension.desc',
        link: { tab: 'calculator', subTab: 'pension' },
      },
      {
        type: 'improvement',
        titleKey: 'whatsNew.v32.mobile.title',
        descKey: 'whatsNew.v32.mobile.desc',
      },
    ],
  },
  {
    version: '3.1.0',
    date: '2026-01-28',
    titleKey: 'whatsNew.v31.title',
    items: [
      {
        type: 'feature',
        titleKey: 'whatsNew.v31.currency.title',
        descKey: 'whatsNew.v31.currency.desc',
        link: { tab: 'vita', subTab: 'currency-exchange' },
      },
      {
        type: 'feature',
        titleKey: 'whatsNew.v31.costliving.title',
        descKey: 'whatsNew.v31.costliving.desc',
        link: { tab: 'vita', subTab: 'cost-of-living' },
      },
      {
        type: 'fix',
        titleKey: 'whatsNew.v31.performance.title',
        descKey: 'whatsNew.v31.performance.desc',
      },
    ],
  },
];

// ─── Constants ───────────────────────────────────────────────────────────

export const STORAGE_KEY = 'frontaliere_whats_new_last_seen';

const TYPE_CONFIG: Record<ReleaseItemType, { icon: typeof Sparkles; color: string; bg: string }> = {
  feature: {
    icon: Sparkles,
    color: 'text-violet-700 dark:text-violet-400',
    bg: 'bg-violet-100 dark:bg-violet-900/40',
  },
  improvement: {
    icon: Zap,
    color: 'text-blue-700 dark:text-blue-400',
    bg: 'bg-blue-100 dark:bg-blue-900/40',
  },
  fix: {
    icon: Bug,
    color: 'text-emerald-700 dark:text-emerald-400',
    bg: 'bg-emerald-100 dark:bg-emerald-900/40',
  },
};

// ─── Helpers ─────────────────────────────────────────────────────────────

function getLastSeen(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function setLastSeen(date: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, date);
  } catch { /* quota / private mode */ }
}

/** Count releases newer than the last-seen date. */
export function getUnreadCount(): number {
  const lastSeen = getLastSeen();
  if (!lastSeen) return RELEASES.length;
  return RELEASES.filter((r) => r.date > lastSeen).length;
}

/** Get all releases for external use (e.g. tests). */
export function getReleases(): Release[] {
  return RELEASES;
}

export function releaseLinkToRoute(link: NonNullable<ReleaseItem['link']>): AppRoute {
  switch (link.tab) {
    case 'calculator':
      return { activeTab: 'calculator', calcolatoreSubTab: (link.subTab as AppRoute['calcolatoreSubTab']) || 'calculator' };
    case 'confronti':
      return { activeTab: 'confronti', confrontiSubTab: (link.subTab as AppRoute['confrontiSubTab']) || 'exchange' };
    case 'fisco':
      return { activeTab: 'fisco', fiscoSubTab: (link.subTab as AppRoute['fiscoSubTab']) || 'tax-return' };
    case 'guida':
      return { activeTab: 'guida', guidaSubTab: (link.subTab as AppRoute['guidaSubTab']) || 'first-day' };
    case 'vita':
      return { activeTab: 'vita', vitaSubTab: (link.subTab as AppRoute['vitaSubTab']) || 'living-ch' };
    case 'stats':
      return { activeTab: 'stats', statsSubTab: (link.subTab as AppRoute['statsSubTab']) || 'overview' };
    case 'job-board':
      return { activeTab: 'job-board' };
    case 'blog':
      return { activeTab: 'blog' };
    case 'admin':
      return { activeTab: 'admin' };
    case 'email-confirmed':
      return { activeTab: 'email-confirmed' };
    case 'permit-quiz':
      return { activeTab: 'permit-quiz' };
    case 'tredicesima':
      return { activeTab: 'tredicesima' };
    case 'weekly-digest':
      return { activeTab: 'weekly-digest' };
    case 'tool-of-week':
      return { activeTab: 'tool-of-week' };
    default:
      return { activeTab: link.tab as AppRoute['activeTab'] };
  }
}

// ─── Bell Button (Header Trigger) ────────────────────────────────────────

interface BellButtonProps {
  onClick: () => void;
}

export function WhatsNewBell({ onClick }: BellButtonProps) {
  const { t } = useTranslation();
  const [unread, setUnread] = useState(() => getUnreadCount());
  const hasUnread = unread > 0;

  // Re-check on storage changes (e.g. other tab marked as read)
  useEffect(() => {
    const handler = () => setUnread(getUnreadCount());
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, []);

  return (
    <button
      onClick={() => {
        onClick();
        setUnread(0);
      }}
      className="relative p-2 rounded-lg transition-colors text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700"
      aria-label={t('whatsNew.title')}
      title={t('whatsNew.title')}
    >
      <Bell size={20} />
      {hasUnread && (
        <span
          aria-hidden="true"
          className="absolute -top-1 -right-1 bg-red-500 text-white text-xs font-bold min-w-[18px] h-[18px] rounded-full flex items-center justify-center px-1 shadow-sm"
        >
          {unread > 9 ? '9+' : unread}
        </span>
      )}
    </button>
  );
}

// ─── Modal ───────────────────────────────────────────────────────────────

interface WhatsNewModalProps {
  open: boolean;
  onClose: () => void;
}

export default function WhatsNewModal({ open, onClose }: WhatsNewModalProps) {
  const { t, locale } = useTranslation();
  const nav = useNavigationOptional();

  // Mark as read when modal opens
  useEffect(() => {
    if (open && RELEASES.length > 0) {
      setLastSeen(RELEASES[0].date);
      // Gamification
      import('@/components/community/GamificationWidget')
        .then((m) => m.unlockAchievement('whats_new_reader'))
        .catch(() => { /* ok if gamification not available */ });
    }
  }, [open]);

  const handleLinkClick = useCallback((e: MouseEvent<HTMLAnchorElement>, link: { tab: string; subTab?: string }) => {
    e.preventDefault();
    onClose();
    // Use SPA navigation when available; the href on the <a> element is a
    // deterministic fallback so the link works even if NavigationContext is absent.
    if (nav) {
      nav.navigateTo(link.tab as any, link.subTab);
    } else {
      window.location.href = e.currentTarget.getAttribute('href') || '/';
    }
  }, [nav, onClose]);

  if (!open) return null;

  const formatDate = (iso: string) => {
    try {
      const d = new Date(iso);
      return d.toLocaleDateString(locale === 'it' ? 'it-IT' : locale === 'de' ? 'de-DE' : locale === 'fr' ? 'fr-FR' : 'en-US', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      });
    } catch {
      return iso;
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label={t('whatsNew.title')}
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Card */}
      <div className="relative w-full max-w-lg max-h-[80vh] bg-white dark:bg-slate-800 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700 flex flex-col overflow-hidden animate-in fade-in zoom-in-95">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 dark:border-slate-700">
          <div className="flex items-center gap-2">
            <PartyPopper size={22} className="text-violet-600 dark:text-violet-400" />
            <h2 className="text-lg font-bold text-slate-800 dark:text-white">
              {t('whatsNew.title')}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
            aria-label={t('whatsNew.close')}
          >
            <X size={18} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
          {RELEASES.length === 0 ? (
            <p className="text-center text-slate-500 dark:text-slate-400 py-8">
              {t('whatsNew.noUpdates')}
            </p>
          ) : (
            RELEASES.map((release) => (
              <div key={release.version}>
                {/* Version Header */}
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-xs font-mono font-semibold text-violet-600 dark:text-violet-400 bg-violet-100 dark:bg-violet-900/40 px-2 py-0.5 rounded-full">
                    v{release.version}
                  </span>
                  <span className="text-xs text-slate-500 dark:text-slate-400">
                    {formatDate(release.date)}
                  </span>
                </div>
                <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-2">
                  {t(release.titleKey)}
                </h3>

                {/* Items */}
                <ul className="space-y-2">
                  {release.items.map((item, idx) => {
                    const cfg = TYPE_CONFIG[item.type];
                    const Icon = cfg.icon;
                    const route = item.link ? releaseLinkToRoute(item.link) : null;
                    const href = route ? buildPath(route, locale as any) : '';
                    const isClickable = !!item.link;
                    const cardContent = (
                      <>
                        <span className={`mt-0.5 p-1 rounded-md shrink-0 ${cfg.bg}`}>
                          <Icon size={14} className={cfg.color} />
                        </span>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-slate-700 dark:text-slate-200">
                            {t(item.titleKey)}
                          </p>
                          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                            {t(item.descKey)}
                          </p>
                        </div>
                        {isClickable && (
                          <ChevronRight size={16} className="mt-1 shrink-0 text-blue-500 dark:text-blue-400 transition-transform group-hover:translate-x-0.5" />
                        )}
                      </>
                    );
                    return isClickable ? (
                      <li key={idx}>
                        <a
                          href={href}
                          onClick={(e) => handleLinkClick(e, item.link!)}
                          className="w-full flex items-start gap-3 group p-2 -mx-2 rounded-lg cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-700/50 active:bg-slate-100 dark:active:bg-slate-700 transition-colors text-left no-underline"
                          aria-label={`${t(item.titleKey)} — ${t('whatsNew.goTo')}`}
                        >
                          {cardContent}
                        </a>
                      </li>
                    ) : (
                      <li
                        key={idx}
                        className="flex items-start gap-3 p-2 -mx-2"
                      >
                        {cardContent}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50">
          <p className="text-xs text-slate-500 dark:text-slate-400 text-center">
            {t('whatsNew.footer')}
          </p>
        </div>
      </div>
    </div>
  );
}
