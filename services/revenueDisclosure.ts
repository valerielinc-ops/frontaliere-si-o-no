/**
 * How the site earns money, in one place: the funding section of /chi-siamo/
 * and the short note on pages with partner links.
 *
 * The wording says "invito, referral o affiliazione" on purpose. The partner
 * registry (`services/affiliatePartnersRegistry.mjs`) marks no agreement as
 * commercially active, but the links do carry the owner's codes: a reader must
 * be told about a possible benefit without the site claiming a contract, or the
 * absence of one, that the registry alone cannot prove.
 *
 * Pure strings and paths: imported by the SPA and by the build plugins.
 */
import { SLUG_TABLES } from './routeSlugs.data';

export type RevenueLocale = 'it' | 'en' | 'de' | 'fr';

/** `id` of the funding section, in both the React and the static /chi-siamo/. */
export const FUNDING_SECTION_ID = 'finanziamento';

export const REVENUE_MODEL: Readonly<Record<RevenueLocale, { title: string; bullets: string[] }>> = {
  it: {
    title: 'Come si finanzia il sito',
    bullets: [
      'Il sito si finanzia con pubblicità contestuale (Google AdSense), con link di invito, referral o affiliazione e con servizi a pagamento descritti nelle rispettive pagine.',
      'I link che passano da /go/ (per esempio Wise e Fineco) sono marcati rel="sponsored": se li usi per aprire un conto o acquistare un servizio, il sito può ricevere un bonus o una commissione dal partner.',
      'Banche, casse malati, datori di lavoro e istituzioni citati negli articoli non pagano per esserci.',
      'Nessun contenuto sponsorizzato: gli articoli redazionali non sono mai pubblicità mascherata. Se in futuro venissero pubblicati contenuti sponsorizzati, sarebbero chiaramente etichettati.',
      'La redazione è editorialmente indipendente dagli inserzionisti.',
    ],
  },
  en: {
    title: 'How the site is funded',
    bullets: [
      'The site is funded by contextual advertising (Google AdSense), by invitation, referral or affiliate links, and by paid services described on their own pages.',
      'Links that go through /go/ (for example Wise and Fineco) are marked rel="sponsored": if you use them to open an account or buy a service, the site may receive a bonus or a commission from the partner.',
      'Banks, health insurers, employers and institutions mentioned in articles do not pay to be there.',
      'No sponsored content: editorial articles are never disguised advertising. Any sponsored content published in the future would be clearly labelled.',
      'The editorial team is editorially independent of advertisers.',
    ],
  },
  de: {
    title: 'Wie sich die Website finanziert',
    bullets: [
      'Die Website finanziert sich durch kontextbezogene Werbung (Google AdSense), durch Einladungs-, Empfehlungs- oder Affiliate-Links und durch kostenpflichtige Dienste, die auf ihren eigenen Seiten beschrieben sind.',
      'Links über /go/ (zum Beispiel Wise und Fineco) sind mit rel="sponsored" gekennzeichnet: Wenn Sie damit ein Konto eröffnen oder einen Dienst kaufen, kann die Website vom Partner einen Bonus oder eine Provision erhalten.',
      'Banken, Krankenkassen, Arbeitgeber und Institutionen, die in Artikeln genannt werden, zahlen nicht dafür.',
      'Keine gesponserten Inhalte: Redaktionelle Artikel sind niemals verdeckte Werbung. Künftige gesponserte Inhalte würden deutlich gekennzeichnet.',
      'Die Redaktion ist inhaltlich unabhängig von den Werbetreibenden.',
    ],
  },
  fr: {
    title: 'Comment le site est financé',
    bullets: [
      'Le site est financé par la publicité contextuelle (Google AdSense), par des liens d’invitation, de parrainage ou d’affiliation et par des services payants décrits sur leurs propres pages.',
      'Les liens qui passent par /go/ (par exemple Wise et Fineco) sont marqués rel="sponsored" : si vous les utilisez pour ouvrir un compte ou acheter un service, le site peut recevoir un bonus ou une commission du partenaire.',
      'Les banques, caisses maladie, employeurs et institutions cités dans les articles ne paient pas pour y figurer.',
      'Aucun contenu sponsorisé : les articles rédactionnels ne sont jamais de la publicité déguisée. Tout contenu sponsorisé publié à l’avenir serait clairement identifié.',
      'La rédaction est indépendante des annonceurs sur le plan éditorial.',
    ],
  },
};

const REVENUE_NOTE: Readonly<Record<RevenueLocale, { text: string; link: string }>> = {
  it: { text: 'Trasparenza: questa pagina può contenere pubblicità e link di invito, referral o affiliazione. Se li usi, il sito può ricevere un bonus o una commissione dal partner.', link: 'Come si finanzia il sito' },
  en: { text: 'Transparency: this page may contain advertising and invitation, referral or affiliate links. If you use them, the site may receive a bonus or a commission from the partner.', link: 'How the site is funded' },
  de: { text: 'Transparenz: Diese Seite kann Werbung sowie Einladungs-, Empfehlungs- oder Affiliate-Links enthalten. Wenn Sie sie nutzen, kann die Website vom Partner einen Bonus oder eine Provision erhalten.', link: 'Wie sich die Website finanziert' },
  fr: { text: 'Transparence : cette page peut contenir de la publicité et des liens d’invitation, de parrainage ou d’affiliation. Si vous les utilisez, le site peut recevoir un bonus ou une commission du partenaire.', link: 'Comment le site est financé' },
};

export function revenueNote(locale: RevenueLocale): { text: string; link: string; href: string } {
  const prefix = locale === 'it' ? '' : `/${locale}`;
  return { ...REVENUE_NOTE[locale], href: `${prefix}/${SLUG_TABLES[locale].chiSiamo}/#${FUNDING_SECTION_ID}` };
}

/** The note for static pages. `fh-disc` is the shared small-print style of seo-static.css. */
export function renderRevenueNoteHtml(locale: RevenueLocale): string {
  const note = revenueNote(locale);
  return `<p class="fh-disc" role="note" data-revenue-note>${note.text} <a href="${note.href}">${note.link}</a></p>`;
}

/** The funding section for static pages. */
export function renderRevenueModelHtml(locale: RevenueLocale): string {
  const { title, bullets } = REVENUE_MODEL[locale];
  const items = bullets.map((bullet) => `<li>${bullet.replace(/"/g, '&quot;')}</li>`).join('');
  return `<h2 id="${FUNDING_SECTION_ID}">${title}</h2><ul>${items}</ul>`;
}
