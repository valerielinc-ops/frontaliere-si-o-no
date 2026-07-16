import React from 'react';
import { ArrowLeft, Linkedin, Twitter, Mail, Award, Globe, FileText } from 'lucide-react';
import { useNavigation } from '@/services/NavigationContext';
import { getAuthorBySlug, type Author } from '@/data/authors';
import { getMergedAuthor } from '@/services/authorProfileService';
import { cdnImageUrl } from '@/services/cdnImageBase';
import { buildAuthorSeo } from '@/services/seo/seo-authors';

/**
 * AutorePage — `/autori/{slug}/` author profile page.
 *
 * Required for E-E-A-T compliance (Google News A1 — see
 * docs/GOOGLE-NEWS-COMPLIANCE-PLAN.md §4). Every published article points
 * to an author entity here so Google can attribute expertise and resolve
 * the byline against the public Knowledge Graph (LinkedIn / Wikidata).
 *
 * Renders:
 *   - Hero with author photo (400×400, explicit width/height for CLS).
 *   - Name (`<h1>`), role, biography paragraph.
 *   - Expertise tags + social links (LinkedIn always, Twitter / email when present).
 *   - Inline `Person` JSON-LD via {@link buildAuthorSeo}.
 *
 * Layout mirrors `ChiSiamo.tsx` for visual consistency.
 */
interface AutorePageProps {
  slug: string;
}

export const AutorePage: React.FC<AutorePageProps> = ({ slug }) => {
  const nav = useNavigation();
  const staticAuthor = getAuthorBySlug(slug);
  // Static registry renders first (matches the SSG snapshot, no CLS/flash);
  // an admin-set `author_profiles/{slug}` patch (see AdminPanel "Redazione"
  // section) is applied on top once fetched, client-side only.
  const [author, setAuthor] = React.useState<Author | undefined>(staticAuthor);

  React.useEffect(() => {
    setAuthor(staticAuthor);
    if (!staticAuthor) return;
    let cancelled = false;
    getMergedAuthor(slug).then((merged) => {
      if (!cancelled && merged) setAuthor(merged);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [slug]);

  if (!author) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-8 animate-fade-in">
        <button
          onClick={() => nav.navigateTo('chi-siamo' as any)}
          className="mb-6 inline-flex items-center gap-2 text-sm font-semibold text-accent hover:text-accent transition-colors"
        >
          <ArrowLeft size={16} />
          Torna a Chi Siamo
        </button>
        <div className="bg-surface rounded-2xl border border-edge p-6 shadow-sm">
          <h1 className="text-2xl font-bold text-strong">Autore non trovato</h1>
          <p className="mt-2 text-sm text-subtle">
            Lo slug «{slug}» non corrisponde a nessun membro della redazione.
          </p>
        </div>
      </div>
    );
  }

  // Pass the CSR-merged author (admin persona patch applied on top of the
  // static registry), not the slug — otherwise buildAuthorSeo re-derives
  // from the static registry and the JSON-LD goes stale vs. the visible
  // bio/photo/social above (review nit, PR #3356).
  const { jsonLd } = buildAuthorSeo(author, 'it');

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 animate-fade-in">
      {/* Inline Person JSON-LD — key forces remount (not just innerHTML patch) when author changes, guarding SSR-hydrated stale state after CSR merge. */}
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
        Torna a Chi Siamo
      </button>

      {/* Hero */}
      <div className="bg-surface rounded-2xl border border-edge p-5 sm:p-8 shadow-lg mb-6">
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-5">
          <img
            src={cdnImageUrl(author.photoPath)}
            alt={`Foto di ${author.name}`}
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
            <SocialLinks author={author} />
          </div>
        </div>
      </div>

      <div className="space-y-6">
        {/* Bio */}
        <Section icon={Globe} title="Biografia">
          <p className="whitespace-pre-line">{author.bio}</p>
        </Section>

        {/* Expertise */}
        <Section icon={Award} title="Aree di competenza">
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

        {/* Editorial trust footer */}
        <div className="bg-surface rounded-2xl border border-edge p-4 sm:p-6 shadow-sm">
          <h2 className="text-lg font-bold font-display text-strong mb-2">
            Standard editoriali
          </h2>
          <p className="text-sm text-subtle leading-relaxed">
            Tutti gli articoli firmati sono pubblicati nel rispetto della{' '}
            <button
              onClick={() => nav.navigateTo('chi-siamo' as any)}
              className="text-accent hover:underline font-medium"
            >
              politica editoriale di Frontaliere Ticino
            </button>
            : verifica delle fonti primarie, separazione fatti/opinioni e correzioni
            tracciabili.
          </p>
          {author.email ? (
            <p className="mt-3 text-xs text-muted">
              Per segnalazioni dirette:{' '}
              <a href={`mailto:${author.email}`} className="text-accent hover:underline">
                {author.email}
              </a>
            </p>
          ) : null}
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

function SocialLinks({ author }: { author: Author }) {
  const items: Array<{
    key: string;
    href: string;
    label: string;
    Icon: React.FC<{ size?: number; className?: string }>;
    download?: boolean;
  }> = [];
  if (author.social.linkedin) {
    items.push({
      key: 'linkedin',
      href: author.social.linkedin,
      label: `Profilo LinkedIn di ${author.name}`,
      Icon: Linkedin,
    });
  }
  if (author.social.twitter) {
    items.push({
      key: 'twitter',
      href: author.social.twitter,
      label: `Profilo Twitter di ${author.name}`,
      Icon: Twitter,
    });
  }
  if (author.email) {
    items.push({
      key: 'email',
      href: `mailto:${author.email}`,
      label: `Email a ${author.name}`,
      Icon: Mail,
    });
  }
  if (author.cvPath) {
    items.push({
      key: 'cv',
      href: author.cvPath,
      label: `Scarica il CV di ${author.name} (PDF)`,
      Icon: FileText,
      download: true,
    });
  }
  if (items.length === 0) return null;
  return (
    <ul className="flex items-center gap-3 mt-3">
      {items.map(({ key, href, label, Icon, download }) => (
        <li key={key}>
          <a
            href={href}
            target={href.startsWith('mailto:') ? undefined : '_blank'}
            rel={href.startsWith('mailto:') ? undefined : download ? 'noopener noreferrer' : 'noopener me'}
            download={download || undefined}
            aria-label={label}
            title={label}
            className="inline-flex items-center justify-center w-9 h-9 rounded-full bg-info text-on-accent hover:opacity-90 transition-opacity"
          >
            <Icon size={16} />
          </a>
        </li>
      ))}
    </ul>
  );
}

export default AutorePage;
