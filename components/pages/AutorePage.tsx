import React from 'react';
import { ArrowLeft, Award, Globe } from 'lucide-react';
import { useNavigation } from '@/services/NavigationContext';
import { getAuthorBySlug, isEditorialProfile, isRealAuthor, type Author } from '@/data/authors';
import { getMergedAuthor } from '@/services/authorProfileService';
import { cdnImageUrl } from '@/services/cdnImageBase';
import { useTranslation } from '@/services/i18n';
import { EDITORIAL_PROFILE_DISCLOSURE, localizeAuthor } from '@/data/authorLocales';
import { AUTHOR_PAGE_COPY } from '@/services/authorPageCopy';
import { buildAuthorSeo } from '@/services/seo/seo-authors';

/**
 * AutorePage — `/autori/{slug}/` author profile page.
 *
 * Required for E-E-A-T compliance (Google News A1 — see
 * docs/GOOGLE-NEWS-COMPLIANCE-PLAN.md §4). Editorial signatures render as
 * Organization entities; real guest authors render as Person entities with
 * their public attribution fields.
 *
 * Renders:
 *   - Hero with author photo (400×400, explicit width/height for CLS).
 *   - Name (`<h1>`), role, biography paragraph.
 *   - Expertise tags and, for editorial profiles, the localized disclosure.
 *   - Inline `Person` or `Organization` JSON-LD via {@link buildAuthorSeo}.
 *
 * Layout mirrors `ChiSiamo.tsx` for visual consistency.
 */
interface AutorePageProps {
  slug: string;
}

export const AutorePage: React.FC<AutorePageProps> = ({ slug }) => {
  const nav = useNavigation();
  const { locale } = useTranslation();
  const copy = AUTHOR_PAGE_COPY[locale];
  const staticAuthor = getAuthorBySlug(slug);
  // Static registry renders first (matches the SSG snapshot, no CLS/flash);
  // an admin-set `author_profiles/{slug}` patch (see AdminPanel "Redazione"
  // section) is applied on top once fetched, client-side only.
  const [sourceAuthor, setAuthor] = React.useState<Author | undefined>(staticAuthor);

  React.useEffect(() => {
    setAuthor(staticAuthor);
    if (!staticAuthor) return;
    let cancelled = false;
    getMergedAuthor(slug).then((merged) => {
      if (!cancelled && merged) setAuthor(merged);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [slug]);

  const author = sourceAuthor ? localizeAuthor(sourceAuthor, locale) : undefined;

  if (!author) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-8 animate-fade-in">
        <button
          onClick={() => nav.navigateTo('chi-siamo' as any)}
          className="mb-6 inline-flex items-center gap-2 text-sm font-semibold text-accent hover:text-accent transition-colors"
        >
          <ArrowLeft size={16} />
          {copy.back}
        </button>
        <div className="bg-surface rounded-2xl border border-edge p-6 shadow-sm">
          <h1 className="text-2xl font-bold text-strong">{copy.missing}</h1>
          <p className="mt-2 text-sm text-subtle">
            {copy.missingDetail} {slug}
          </p>
        </div>
      </div>
    );
  }

  // Pass the CSR-merged author (admin public-profile patch applied on top of the
  // static registry), not the slug — otherwise buildAuthorSeo re-derives
  // from the static registry and the JSON-LD goes stale vs. the visible
  // visible description and illustration above.
  const { jsonLd } = buildAuthorSeo(author, locale);
  const realAuthor = isRealAuthor(author) ? author : undefined;
  const editorialProfile = isEditorialProfile(author);

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 animate-fade-in">
      {/* Inline author JSON-LD — key forces remount when a CSR patch changes the profile. */}
      <script
        key={`${author.slug}-jsonld`}
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      {/* Back Button */}
      <button
        onClick={() => nav.navigateTo('chi-siamo' as any)}
        className="mb-6 inline-flex items-center gap-2 text-sm font-semibold text-accent hover:text-accent transition-colors"
      >
        <ArrowLeft size={16} />
        {copy.back}
      </button>

      {/* Hero */}
      <div className="bg-surface rounded-2xl border border-edge p-5 sm:p-8 shadow-lg mb-6">
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-5">
          <img
            src={cdnImageUrl(author.photoPath)}
            alt={`${copy.photo} ${author.name}`}
            width={160}
            height={160}
            loading="eager"
            decoding="async"
            className="w-32 h-32 sm:w-40 sm:h-40 rounded-2xl object-cover shadow-md border border-edge shrink-0"
          />
          <div className="min-w-0">
            <h1 className="text-2xl sm:text-3xl font-extrabold font-display text-strong">
              {author.name}
            </h1>
            <p className="text-sm sm:text-base text-accent font-semibold mt-1">
              {author.role}
            </p>
            {editorialProfile && <p className="text-xs text-muted mt-2">{EDITORIAL_PROFILE_DISCLOSURE[locale]}</p>}
          </div>
        </div>
      </div>

      <div className="space-y-6">
        {/* Bio */}
        <Section icon={Globe} title={editorialProfile ? copy.editorialDescription : copy.biography}>
          <p lang={locale !== 'it' && author.bio === sourceAuthor?.bio ? 'it' : locale} className="whitespace-pre-line">{author.bio}</p>
        </Section>

        {/* Expertise */}
        <Section icon={Award} title={copy.expertise}>
          <ul className="flex flex-wrap gap-2 mt-1">
            {author.expertise.map((topic) => (
              <li
                key={topic}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-info text-on-accent text-xs font-semibold"
              >
                {topic}
              </li>
            ))}
          </ul>
        </Section>

        {realAuthor && (
          <Section icon={Globe} title={copy.publicProfile}>
            <div className="flex flex-wrap gap-3">
              {realAuthor.social.linkedin && (
                <a href={realAuthor.social.linkedin} target="_blank" rel="noopener noreferrer me" className="text-accent hover:underline">
                  {copy.linkedin}
                </a>
              )}
              {realAuthor.email && <a href={`mailto:${realAuthor.email}`} className="text-accent hover:underline">{copy.email}</a>}
              {realAuthor.cvPath && (
                <a href={realAuthor.cvPath} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
                  {copy.openCv}
                </a>
              )}
            </div>
            {realAuthor.cvPath && (
              <object data={realAuthor.cvPath} type="application/pdf" aria-label={copy.cv} className="mt-4 h-96 w-full rounded-lg border border-edge">
                <p>{copy.pdfUnavailable} <a href={realAuthor.cvPath} className="text-accent hover:underline">{copy.openCv}</a>.</p>
              </object>
            )}
          </Section>
        )}

        {/* Editorial trust footer */}
        <div className="bg-surface rounded-2xl border border-edge p-4 sm:p-6 shadow-sm">
          <h2 className="text-lg font-bold font-display text-strong mb-2">
            {copy.standards}
          </h2>
          <p className="text-sm text-subtle leading-relaxed">
            {copy.policyIntro}{' '}
            <button
              onClick={() => nav.navigateTo('chi-siamo' as any)}
              className="text-accent hover:underline font-medium"
            >
              {copy.policy}
            </button>
            : {copy.policyEnd}
          </p>
          {editorialProfile && <p className="mt-3 text-xs text-muted">{EDITORIAL_PROFILE_DISCLOSURE[locale]}</p>}
        </div>
      </div>
    </div>
  );
};

/* ── Reusable sub-components ── */

function Section({
  icon: Icon,
  title,
  children,
}: {
  icon: React.FC<{ size?: number; className?: string }>;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-surface rounded-2xl border border-edge p-4 sm:p-6 shadow-sm">
      <div className="flex items-center gap-3 mb-4">
        <Icon size={20} className="text-accent" />
        <h2 className="text-lg font-bold font-display text-strong">{title}</h2>
      </div>
      <div className="text-sm text-subtle leading-relaxed">{children}</div>
    </div>
  );
}

export default AutorePage;
