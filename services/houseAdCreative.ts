import type { HouseAdCreativeContext } from './houseAdContext';

export const HOUSE_AD_VARIANTS = ['control', 'time_saved', 'profile_match', 'in_control', 'swiss_work', 'next_chapter'] as const;
export type HouseAdVariant = (typeof HOUSE_AD_VARIANTS)[number];
export type HouseAdFormat = 'mobile_banner' | 'mobile_large' | 'rectangle' | 'leaderboard' | 'billboard' | 'skyscraper';
export type HouseAdLocale = 'it' | 'en' | 'de' | 'fr';

/** The same compositions render in React and in the independently booted static shell. */
export function createHouseAdCreative(options: {
  campaign?: 'job_search_automation' | 'reader_subscription';
  variant: HouseAdVariant;
  format: HouseAdFormat;
  locale: HouseAdLocale;
  placement: string;
  destinationPath?: string;
  context?: HouseAdCreativeContext;
  portraitArtwork?: boolean;
  assetBase?: string;
  onClick?: () => void;
}): HTMLAnchorElement {
  const { variant, format, locale, placement } = options;
  if (options.campaign === 'reader_subscription') {
    const words = {
      it: { title: 'Naviga senza pubblicità', body: 'Sostieni Frontaliereticino.ch e usa il sito senza banner.', price: 'CHF 2.99 al mese', cta: 'Scopri l’abbonamento', shortCta: 'Scopri' },
      en: { title: 'Browse without ads', body: 'Support Frontaliereticino.ch and browse without display ads.', price: 'CHF 2.99 per month', cta: 'See the subscription', shortCta: 'Explore' },
      de: { title: 'Ohne Werbung surfen', body: 'Unterstützen Sie Frontaliereticino.ch und nutzen Sie die Website werbefrei.', price: 'CHF 2.99 pro Monat', cta: 'Abo entdecken', shortCta: 'Entdecken' },
      fr: { title: 'Naviguez sans publicité', body: 'Soutenez Frontaliereticino.ch et consultez le site sans bannières.', price: 'CHF 2.99 par mois', cta: 'Découvrir l’abonnement', shortCta: 'Découvrir' },
    }[locale];
    const compact = format === 'mobile_banner' || format === 'mobile_large';
    const anchor = document.createElement('a');
    anchor.className = 'ft-house-creative ft-reader-subscription';
    anchor.dataset.houseFormat = format;
    anchor.dataset.houseCampaign = 'reader_subscription';
    anchor.dataset.houseCreative = 'subscription_v1';
    anchor.dataset.houseArtwork = 'none';
    const query = new URLSearchParams({ utm_source: 'house_ads', utm_medium: 'display', utm_campaign: 'reader_subscription_house', utm_content: 'subscription_v1', utm_term: `${format}.${placement}` });
    anchor.href = `${options.destinationPath || '/abbonamento/'}?${query}`;
    anchor.setAttribute('aria-label', `${words.title}. ${words.body} ${words.price}. ${words.cta}`);
    const copy = document.createElement('span'); copy.className = 'ft-house-copy';
    const title = document.createElement('span'); title.className = 'ft-house-title'; title.textContent = words.title;
    const body = document.createElement('span'); body.className = 'ft-house-body'; body.textContent = words.body;
    const price = document.createElement('span'); price.className = 'ft-reader-price'; price.textContent = words.price;
    const cta = document.createElement('span'); cta.className = 'ft-house-cta'; cta.textContent = compact ? words.shortCta : words.cta;
    copy.append(title, body, price, cta);
    anchor.append(copy);
    if (options.onClick) anchor.addEventListener('click', options.onClick);
    return anchor;
  }
  const words = {
    it: { cta: 'Scopri come funziona', shortCta: 'Scopri', bannerTitle: 'Lavoro in Svizzera?', body: 'Troviamo le offerte adatte al tuo mestiere e prepariamo le candidature per te.',
      titles: { control: 'Lavoro in Svizzera?', time_saved: 'Vuoi lavorare in Svizzera?', profile_match: 'Il tuo mestiere in Svizzera?', in_control: 'Svizzera: da dove iniziare?', swiss_work: 'Vuoi un lavoro in Svizzera?', next_chapter: 'La ricerca in Svizzera prende tempo?' },
      short: { control: 'Lavoro in Svizzera?', time_saved: 'Vuoi lavorare in Svizzera?', profile_match: 'Il tuo mestiere in Svizzera?', in_control: 'Svizzera: da dove iniziare?', swiss_work: 'Lavoro in Svizzera?', next_chapter: 'Lavoro in Svizzera?' },
      promises: { control: 'Lo cerchiamo noi per te.', time_saved: 'Alla ricerca pensiamo noi.', profile_match: 'Troviamo offerte per il tuo mestiere.', in_control: 'Ti aiutiamo a iniziare.', swiss_work: 'Partiamo dal tuo mestiere.', next_chapter: 'Meno ricerche. Più tempo per te.' },
      bannerPromises: { control: 'Lo cerchiamo noi.', time_saved: 'Ci pensiamo noi.', profile_match: 'Offerte per te.', in_control: 'Ti aiutiamo noi.', swiss_work: 'Partiamo da te.', next_chapter: 'Più tempo per te.' },
      shortPromises: { control: 'Ci pensiamo noi.', time_saved: 'La ricerca la facciamo noi.', profile_match: 'Offerte per il tuo mestiere.', in_control: 'Ti aiutiamo a iniziare.', swiss_work: 'Partiamo dal tuo mestiere.', next_chapter: 'Più tempo per te.' } },
    en: { cta: 'See how it works', shortCta: 'Explore', bannerTitle: 'Work in Switzerland?', body: 'We find job offers that fit your profession and prepare the applications for you.',
      titles: { control: 'A job in Switzerland?', time_saved: 'Want to work in Switzerland?', profile_match: 'Your profession in Switzerland?', in_control: 'Working in Switzerland: where to start?', swiss_work: 'Looking for a job in Switzerland?', next_chapter: 'Swiss job searches take time?' },
      short: { control: 'A job in Switzerland?', time_saved: 'Work in Switzerland?', profile_match: 'Your profession in Switzerland?', in_control: 'Switzerland: where to start?', swiss_work: 'A Swiss job?', next_chapter: 'Work in Switzerland?' },
      promises: { control: 'We search for you.', time_saved: 'Leave the search to us.', profile_match: 'We find offers for your profession.', in_control: 'We help you get started.', swiss_work: 'We start with your profession.', next_chapter: 'Less searching. More time for you.' },
      bannerPromises: { control: 'We search for you.', time_saved: 'We handle it.', profile_match: 'Offers for you.', in_control: 'We help you start.', swiss_work: 'We start with you.', next_chapter: 'More time for you.' },
      shortPromises: { control: 'We do the search.', time_saved: 'We handle the search.', profile_match: 'Offers for your profession.', in_control: 'We help you start.', swiss_work: 'We start with your profession.', next_chapter: 'More time for you.' } },
    de: { cta: 'So funktioniert es', shortCta: 'Entdecken', bannerTitle: 'Arbeit in der Schweiz?', body: 'Wir suchen passende Stellen für Ihren Beruf und bereiten Ihre Bewerbungen vor.',
      titles: { control: 'Arbeit in der Schweiz?', time_saved: 'Möchten Sie in der Schweiz arbeiten?', profile_match: 'Ihr Beruf in der Schweiz?', in_control: 'Arbeit in der Schweiz: Wo anfangen?', swiss_work: 'Eine Stelle in der Schweiz?', next_chapter: 'Die Stellensuche in der Schweiz kostet Zeit?' },
      short: { control: 'Arbeit in der Schweiz?', time_saved: 'Arbeit in der Schweiz?', profile_match: 'Ihr Beruf in der Schweiz?', in_control: 'Schweiz: Wo anfangen?', swiss_work: 'Eine Schweizer Stelle?', next_chapter: 'Arbeit in der Schweiz?' },
      promises: { control: 'Wir suchen für Sie.', time_saved: 'Die Suche übernehmen wir.', profile_match: 'Wir finden Stellen für Ihren Beruf.', in_control: 'Wir helfen Ihnen beim Start.', swiss_work: 'Wir beginnen mit Ihrem Beruf.', next_chapter: 'Weniger suchen. Mehr Zeit für Sie.' },
      bannerPromises: { control: 'Wir suchen für Sie.', time_saved: 'Wir kümmern uns.', profile_match: 'Stellen für Sie.', in_control: 'Wir helfen beim Start.', swiss_work: 'Wir starten mit Ihnen.', next_chapter: 'Mehr Zeit für Sie.' },
      shortPromises: { control: 'Wir suchen für Sie.', time_saved: 'Die Suche übernehmen wir.', profile_match: 'Stellen für Ihren Beruf.', in_control: 'Wir helfen beim Start.', swiss_work: 'Wir beginnen mit Ihrem Beruf.', next_chapter: 'Mehr Zeit für Sie.' } },
    fr: { cta: 'Voir comment ça marche', shortCta: 'Découvrir', bannerTitle: 'Un emploi en Suisse ?', body: 'Nous cherchons les offres adaptées à votre métier et préparons vos candidatures.',
      titles: { control: 'Un emploi en Suisse ?', time_saved: 'Vous voulez travailler en Suisse ?', profile_match: 'Votre métier en Suisse ?', in_control: 'Travailler en Suisse : par où commencer ?', swiss_work: 'Un emploi en Suisse ?', next_chapter: 'Chercher en Suisse prend du temps ?' },
      short: { control: 'Un emploi en Suisse ?', time_saved: 'Travailler en Suisse ?', profile_match: 'Votre métier en Suisse ?', in_control: 'La Suisse : par où commencer ?', swiss_work: 'Un emploi en Suisse ?', next_chapter: 'Travailler en Suisse ?' },
      promises: { control: 'Nous cherchons pour vous.', time_saved: 'On s’occupe de la recherche.', profile_match: 'Des offres pour votre métier.', in_control: 'Nous vous aidons à démarrer.', swiss_work: 'Nous partons de votre métier.', next_chapter: 'Moins chercher. Plus de temps pour vous.' },
      bannerPromises: { control: 'Nous cherchons pour vous.', time_saved: 'On s’en occupe.', profile_match: 'Des offres pour vous.', in_control: 'Nous vous aidons.', swiss_work: 'Partons de vous.', next_chapter: 'Plus de temps pour vous.' },
      shortPromises: { control: 'Nous cherchons pour vous.', time_saved: 'On s’occupe de la recherche.', profile_match: 'Des offres pour votre métier.', in_control: 'Nous vous aidons à démarrer.', swiss_work: 'Nous partons de votre métier.', next_chapter: 'Plus de temps pour vous.' } },
  }[locale];
  const narrow = options.portraitArtwork || format === 'rectangle' || format === 'mobile_banner' || format === 'mobile_large' || format === 'skyscraper';
  const compact = format === 'mobile_banner' || format === 'mobile_large';
  const cleanContextText = (value: unknown, maxLength: number): string => {
    const clean = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    const characters = Array.from(clean);
    if (characters.length <= maxLength) return clean;
    const clipped = characters.slice(0, maxLength).join('');
    const wordBoundary = clipped.lastIndexOf(' ');
    return (wordBoundary >= Math.floor(maxLength * 0.55) ? clipped.slice(0, wordBoundary) : clipped).trim();
  };
  const contextRole = cleanContextText(options.context?.role, 52);
  const contextPlace = cleanContextText(options.context?.place, 36);
  const firstRoleWord = contextRole.split(/\s+/)[0] || '';
  const compactRole = Array.from(firstRoleWord).length <= 15 ? firstRoleWord : '';
  const isJobFilterContext = options.context?.source === 'job_filter';
  const frenchRole = contextRole ? `${Array.from(contextRole)[0].toLocaleLowerCase('fr')}${Array.from(contextRole).slice(1).join('')}` : '';
  const frenchRolePreposition = frenchRole
    ? /^[aeiouyàâäéèêëîïôöùûü]/u.test(frenchRole) ? `d’${frenchRole}` : `de ${frenchRole}`
    : '';
  const contextStrings = {
    it: {
      title: contextRole
        ? isJobFilterContext ? `Cerchi lavoro nel settore ${contextRole} in Svizzera?` : `Cerchi lavoro come ${contextRole} in Svizzera?`
        : 'Lavoro in Svizzera?',
      tightTitle: compactRole ? `${compactRole} in Svizzera?` : 'Lavoro in Svizzera?',
      billboardTitle: compactRole ? `${compactRole} in Svizzera?` : 'Lavoro in Svizzera?',
      leaderboardTitle: compactRole ? `${compactRole} in Svizzera?` : 'Lavoro in Svizzera?',
      mobileTitle: compactRole ? `${compactRole} in Svizzera?` : 'Lavoro in Svizzera?',
      promise: 'Lo cerchiamo noi per te.',
      compactPromise: compactRole ? `Cerchiamo ${compactRole}.` : 'Ci pensiamo noi.',
      body: contextRole && contextPlace
        ? `Troviamo offerte per ${contextRole} nella zona di ${contextPlace} e prepariamo le candidature per te.`
        : contextRole ? `Troviamo offerte per ${contextRole} e prepariamo le candidature per te.`
          : contextPlace ? `Troviamo offerte nella zona di ${contextPlace} e prepariamo le candidature per te.` : words.body,
      billboardBody: contextRole && contextPlace
        ? `Offerte per ${contextRole} a ${contextPlace}. Candidature pronte per te.`
        : contextRole ? `Offerte per ${contextRole}. Candidature pronte per te.`
          : contextPlace ? `Offerte nella zona di ${contextPlace}. Candidature pronte per te.` : 'Offerte adatte al tuo mestiere. Candidature pronte per te.',
    },
    en: {
      title: contextRole ? `Looking for ${contextRole} work in Switzerland?` : 'A job in Switzerland?',
      tightTitle: compactRole ? `Looking for ${compactRole} work in Switzerland?` : 'A job in Switzerland?',
      billboardTitle: compactRole ? `${compactRole} jobs in Switzerland?` : 'A job in Switzerland?',
      leaderboardTitle: compactRole ? `${compactRole} jobs in Switzerland?` : 'A job in Switzerland?',
      mobileTitle: compactRole ? `${compactRole} in Switzerland?` : 'Work in Switzerland?',
      promise: 'We search for you.',
      compactPromise: compactRole ? `We find ${compactRole} roles.` : 'We do the search.',
      body: contextRole && contextPlace
        ? `We find ${contextRole} roles around ${contextPlace} and prepare the applications for you.`
        : contextRole ? `We find ${contextRole} roles and prepare the applications for you.`
          : contextPlace ? `We find suitable offers around ${contextPlace} and prepare the applications for you.` : words.body,
      billboardBody: contextRole && contextPlace
        ? `${contextRole} roles near ${contextPlace}. Applications prepared for you.`
        : contextRole ? `${contextRole} roles. Applications prepared for you.`
          : contextPlace ? `Offers near ${contextPlace}. Applications prepared for you.` : 'Offers that fit your profession. Applications prepared for you.',
    },
    de: {
      title: contextRole
        ? isJobFilterContext ? `Jobs im Bereich ${contextRole} in der Schweiz?` : `${contextRole} in der Schweiz gesucht?`
        : 'Arbeit in der Schweiz?',
      tightTitle: compactRole ? `Job als ${compactRole} in der Schweiz?` : 'Arbeit in der Schweiz?',
      billboardTitle: compactRole ? `${compactRole} in der Schweiz?` : 'Arbeit in der Schweiz?',
      leaderboardTitle: compactRole ? `${compactRole}-Jobs in der Schweiz?` : 'Arbeit in der Schweiz?',
      mobileTitle: compactRole ? `${compactRole} in der Schweiz?` : 'Arbeit in der Schweiz?',
      promise: 'Wir suchen für Sie.',
      compactPromise: compactRole ? `Wir suchen ${compactRole}.` : 'Wir suchen für Sie.',
      body: contextRole && contextPlace
        ? `Wir finden passende Stellen für ${contextRole} in der Region ${contextPlace} und bereiten Ihre Bewerbungen vor.`
        : contextRole ? `Wir finden passende Stellen für ${contextRole} und bereiten Ihre Bewerbungen vor.`
          : contextPlace ? `Wir finden passende Stellen in der Region ${contextPlace} und bereiten Ihre Bewerbungen vor.` : words.body,
      billboardBody: contextRole && contextPlace
        ? `Stellen für ${contextRole} in ${contextPlace}. Bewerbungen für Sie vorbereitet.`
        : contextRole ? `Stellen für ${contextRole}. Bewerbungen für Sie vorbereitet.`
          : contextPlace ? `Stellen in der Region ${contextPlace}. Bewerbungen für Sie vorbereitet.` : 'Passende Stellen. Bewerbungen für Sie vorbereitet.',
    },
    fr: {
      title: contextRole
        ? isJobFilterContext ? `Un emploi dans le secteur ${contextRole} en Suisse ?` : `${contextRole} en Suisse ?`
        : 'Un emploi en Suisse ?',
      tightTitle: compactRole ? `${compactRole} en Suisse ?` : 'Un emploi en Suisse ?',
      billboardTitle: compactRole ? `${compactRole} en Suisse ?` : 'Un emploi en Suisse ?',
      leaderboardTitle: compactRole ? `${compactRole} en Suisse ?` : 'Un emploi en Suisse ?',
      mobileTitle: compactRole ? `${compactRole} en Suisse ?` : 'Un emploi en Suisse ?',
      promise: 'Nous cherchons pour vous.',
      compactPromise: compactRole ? `Nous cherchons ${compactRole}.` : 'Nous cherchons pour vous.',
      body: contextRole && contextPlace
        ? `Nous trouvons des offres ${frenchRolePreposition} dans la région de ${contextPlace} et préparons vos candidatures.`
        : contextRole ? `Nous trouvons des offres ${frenchRolePreposition} et préparons vos candidatures.`
          : contextPlace ? `Nous trouvons des offres dans la région de ${contextPlace} et préparons vos candidatures.` : words.body,
      billboardBody: contextRole && contextPlace
        ? `Offres ${frenchRolePreposition} à ${contextPlace}. Candidatures prêtes pour vous.`
        : contextRole ? `Offres ${frenchRolePreposition}. Candidatures prêtes pour vous.`
          : contextPlace ? `Offres près de ${contextPlace}. Candidatures prêtes pour vous.` : 'Offres adaptées à votre métier. Candidatures prêtes pour vous.',
    },
  }[locale];
  const hasContext = Boolean(options.context);
  const useProfileContextPromise = variant === 'profile_match' && hasContext;
  const creativeTitle = hasContext
    ? format === 'mobile_banner' || format === 'mobile_large' ? contextStrings.mobileTitle
        : format === 'leaderboard' ? contextStrings.leaderboardTitle
          : format === 'billboard' ? contextStrings.billboardTitle
            : format === 'rectangle' ? contextStrings.tightTitle
            : contextStrings.title
    : format === 'mobile_banner' ? words.bannerTitle : compact ? words.short[variant] : words.titles[variant];
  const creativePromise = useProfileContextPromise
    ? format === 'mobile_banner' ? words.bannerPromises[variant]
      : format === 'mobile_large' ? contextStrings.compactPromise
        : contextStrings.promise
    : format === 'mobile_banner' ? words.bannerPromises[variant] : compact ? words.shortPromises[variant] : words.promises[variant];
  const creativeBody = hasContext
    ? format === 'billboard' ? contextStrings.billboardBody : contextStrings.body
    : words.body;
  let artwork: string = {
    control: narrow ? 'construction-portrait-v1' : 'construction-wide-v1',
    time_saved: narrow ? 'logistics-portrait-v1' : 'logistics-wide-v1',
    profile_match: narrow ? 'production-portrait-v1' : 'production-wide-v1',
    in_control: narrow ? 'maintenance-portrait-v1' : 'maintenance-wide-v1',
    swiss_work: narrow ? 'electrician-portrait-v1' : 'electrician-wide-v1',
    next_chapter: narrow ? 'hospitality-portrait-v1' : 'hospitality-wide-v1',
  }[variant];
  if (variant === 'time_saved' && (format === 'billboard' || format === 'skyscraper')) {
    artwork = narrow ? 'commute-portrait-v1' : 'commute-wide-v1';
  }
  if (options.context) artwork = `${options.context.sector}-${narrow ? 'portrait' : 'wide'}-v1`;
  const sizes: Record<string, [number, number]> = {
    'construction-portrait-v1': [600, 1200], 'construction-wide-v1': [1456, 486],
    'commute-portrait-v1': [887, 1774], 'commute-wide-v1': [2172, 724],
    'maintenance-portrait-v1': [600, 1200], 'maintenance-wide-v1': [1456, 486],
    'logistics-portrait-v1': [600, 1200], 'logistics-wide-v1': [1456, 486],
    'production-portrait-v1': [600, 1200], 'production-wide-v1': [1456, 486],
    'electrician-portrait-v1': [600, 1200], 'electrician-wide-v1': [1456, 486],
    'hospitality-portrait-v1': [600, 1200], 'hospitality-wide-v1': [1456, 486],
  };
  const anchor = document.createElement('a');
  anchor.className = 'ft-house-creative';
  anchor.dataset.houseFormat = format;
  anchor.dataset.houseCampaign = 'job_search_automation';
  anchor.dataset.houseCreative = `${variant}_v1`;
  anchor.dataset.houseArtwork = narrow ? 'portrait' : 'wide';
  anchor.dataset.houseAsset = artwork;
  if (options.context) {
    anchor.dataset.houseContextSource = options.context.source;
    anchor.dataset.houseContextSector = options.context.sector;
  }
  const query = new URLSearchParams({ utm_source: 'house_ads', utm_medium: 'display', utm_campaign: 'job_search_automation', utm_content: `${variant}_v1`, utm_term: `${format}.${placement}` });
  const destination = options.destinationPath || ({ it: '/automatizza-ricerca-lavoro-svizzera/', en: '/en/automate-job-search-switzerland/', de: '/de/arbeitssuche-schweiz-automatisieren/', fr: '/fr/automatiser-recherche-emploi-suisse/' })[locale];
  anchor.href = `${destination}?${query}`;
  anchor.setAttribute('aria-label', `${creativeTitle} ${creativePromise} ${creativeBody} ${words.cta}`);
  const image = document.createElement('img');
  image.className = 'ft-house-art'; image.alt = ''; image.decoding = 'async'; image.loading = 'lazy';
  image.addEventListener('error', () => { anchor.dataset.houseImageUnavailable = 'true'; }, { once: true });
  image.width = sizes[artwork][0]; image.height = sizes[artwork][1];
  image.src = `${options.assetBase || '/images/job-search-campaign/'}${artwork}.webp`;
  const text = document.createElement('span'); text.className = 'ft-house-copy';
  const title = document.createElement('span'); title.className = 'ft-house-title';
  title.textContent = creativeTitle;
  const promise = document.createElement('span'); promise.className = 'ft-house-promise';
  promise.textContent = creativePromise;
  const body = document.createElement('span'); body.className = 'ft-house-body'; body.textContent = creativeBody;
  const cta = document.createElement('span'); cta.className = 'ft-house-cta'; cta.textContent = compact ? words.shortCta : words.cta;
  text.append(title, promise, body, cta);
  anchor.append(image, text);
  if (options.onClick) anchor.addEventListener('click', options.onClick);
  return anchor;
}

export const HOUSE_AD_CREATIVE_CSS = `
.ft-house-creative{box-sizing:border-box;container-type:inline-size;display:grid;grid-template-columns:38% minmax(0,1fr);width:100%;height:100%;min-width:0;overflow:hidden;border:1px solid var(--_edge,ButtonBorder);border-radius:8px;background:var(--_surface,Canvas);text-align:left;isolation:isolate}
a.ft-house-creative[data-house-format][data-house-creative]{color:var(--_heading,CanvasText);text-decoration:none;font:400 14px/1.4 var(--font-sans,Inter,system-ui,sans-serif)}
.ft-house-creative *{box-sizing:border-box;min-width:0}
.ft-house-art{grid-column:1;grid-row:1;display:block;width:100%;height:100%;min-width:0;min-height:0;object-fit:cover;object-position:center 28%}
.ft-house-copy{grid-column:2;grid-row:1;display:flex;flex-direction:column;justify-content:center;align-items:flex-start;gap:8px;min-width:0;min-height:0;padding:16px}
.ft-house-title{max-width:100%;font:700 28px/1.06 var(--font-display,"Space Grotesk",system-ui,sans-serif);letter-spacing:-.02em;text-transform:uppercase;text-wrap:balance;overflow-wrap:anywhere}
.ft-house-promise{max-width:100%;padding:8px 10px;border-radius:4px;background:#b91c1c;color:#fff;font-family:var(--font-display,"Space Grotesk",system-ui,sans-serif);font-size:18px;line-height:1.12;font-weight:700;text-transform:uppercase;text-wrap:balance;overflow-wrap:anywhere}
.ft-house-body{max-width:38ch;color:var(--_body,CanvasText);font-size:13px;line-height:1.4}
.ft-house-cta{display:inline-flex;min-height:40px;max-width:100%;align-items:center;justify-content:center;padding:8px 14px;border-radius:8px;background:var(--_accent,#533afd);color:var(--_on-accent,#fff);font-family:var(--font-display,"Space Grotesk",system-ui,sans-serif);font-size:13px;font-weight:700;line-height:1.25;text-align:center}
.ft-house-creative:hover .ft-house-cta{background:var(--_accent-hover,#4529e6)}
.ft-house-creative:focus-visible{outline:3px solid var(--_accent,#533afd);outline-offset:2px}
.ft-reader-subscription{display:flex!important;align-items:center;justify-content:center;background:var(--_surface-inverted,#0a2540)!important;color:var(--_on-accent,#fff)!important;border-color:color-mix(in srgb,var(--_accent,#533afd) 48%,transparent)!important}
.ft-reader-subscription .ft-house-copy{display:flex;flex-direction:row;align-items:center;justify-content:space-between;gap:12px;width:100%;padding:18px}
.ft-reader-subscription .ft-house-title{flex:1 1 auto;color:#fff;font-size:25px;line-height:1.05}
.ft-reader-subscription .ft-house-body{flex:1 1 24ch;max-width:34ch;color:color-mix(in srgb,var(--_on-accent,#fff) 88%,transparent);font-size:13px;line-height:1.35}
.ft-reader-price{flex:0 0 auto;color:#fff;font-size:14px;font-weight:700;line-height:1.25;white-space:nowrap}
.ft-reader-subscription .ft-house-cta{flex:0 0 auto;min-height:42px;background:var(--_accent,#533afd);color:var(--_on-accent,#fff)}
.ft-reader-subscription:hover .ft-house-cta{background:var(--_accent-hover,#4529e6)}
.ft-reader-subscription[data-house-format=mobile_banner] .ft-house-copy{gap:8px;padding:5px 10px}
.ft-reader-subscription[data-house-format=mobile_banner] .ft-house-title{font-size:12px;line-height:1.05}
.ft-reader-subscription[data-house-format=mobile_banner] .ft-house-body{display:none}
.ft-reader-subscription[data-house-format=mobile_banner] .ft-reader-price{font-size:10px}
.ft-reader-subscription[data-house-format=mobile_banner] .ft-house-cta{min-height:30px;padding:5px 9px;font-size:11px}
.ft-reader-subscription[data-house-format=mobile_large] .ft-house-copy{gap:8px;padding:8px 12px}
.ft-reader-subscription[data-house-format=mobile_large] .ft-house-title{font-size:16px}
.ft-reader-subscription[data-house-format=mobile_large] .ft-house-body{display:none}
.ft-reader-subscription[data-house-format=mobile_large] .ft-reader-price{font-size:11px}
.ft-reader-subscription[data-house-format=mobile_large] .ft-house-cta{min-height:34px;padding:6px 10px;font-size:11px}
.ft-reader-subscription[data-house-format=rectangle] .ft-house-copy{flex-direction:column;align-items:flex-start;justify-content:center;gap:14px;padding:22px}
.ft-reader-subscription[data-house-format=rectangle] .ft-house-title{font-size:26px}
.ft-reader-subscription[data-house-format=rectangle] .ft-house-body{flex:none;max-width:32ch;font-size:14px}
.ft-reader-subscription[data-house-format=rectangle] .ft-reader-price{font-size:15px}
.ft-reader-subscription[data-house-format=leaderboard] .ft-house-title{font-size:21px}
.ft-reader-subscription[data-house-format=leaderboard] .ft-house-body{font-size:12px}
.ft-reader-subscription[data-house-format=billboard] .ft-house-copy{padding:22px 28px}
.ft-reader-subscription[data-house-format=billboard] .ft-house-title{font-size:31px}
.ft-reader-subscription[data-house-format=billboard] .ft-house-body{font-size:14px}
.ft-reader-subscription[data-house-format=skyscraper] .ft-house-copy{flex-direction:column;align-items:flex-start;justify-content:space-between;gap:12px;padding:24px 20px}
.ft-reader-subscription[data-house-format=skyscraper] .ft-house-title{font-size:28px}
.ft-reader-subscription[data-house-format=skyscraper] .ft-house-body{flex:none;font-size:14px}
.ft-reader-subscription[data-house-format=skyscraper] .ft-reader-price{font-size:19px;white-space:normal}
.ft-reader-subscription[data-house-format=skyscraper] .ft-house-cta{width:100%}
@container (max-height:230px) and (min-width:260px){
  .ft-reader-subscription[data-house-format=rectangle] .ft-house-copy,.ft-reader-subscription[data-house-format=billboard] .ft-house-copy{gap:8px;padding:12px 16px}
  .ft-reader-subscription[data-house-format=rectangle] .ft-house-title{font-size:22px}
  .ft-reader-subscription[data-house-format=rectangle] .ft-house-body,.ft-reader-subscription[data-house-format=billboard] .ft-house-body{font-size:12px}
  .ft-reader-subscription[data-house-format=billboard] .ft-house-title{font-size:25px}
  .ft-reader-subscription[data-house-format=rectangle] .ft-house-cta,.ft-reader-subscription[data-house-format=billboard] .ft-house-cta{min-height:36px}
}
@container (max-width:260px){
  .ft-reader-subscription[data-house-format=mobile_banner] .ft-house-copy,.ft-reader-subscription[data-house-format=mobile_large] .ft-house-copy{gap:6px;padding:5px 8px}
  .ft-reader-subscription[data-house-format=mobile_banner] .ft-reader-price,.ft-reader-subscription[data-house-format=mobile_large] .ft-reader-price{display:none}
  .ft-reader-subscription[data-house-format=mobile_banner] .ft-house-title{font-size:11px}
  .ft-reader-subscription[data-house-format=mobile_large] .ft-house-title{font-size:13px}
  .ft-reader-subscription[data-house-format=mobile_banner] .ft-house-cta,.ft-reader-subscription[data-house-format=mobile_large] .ft-house-cta{min-height:30px;padding:5px 8px;font-size:10px}
}
@container (min-width:700px) and (max-width:800px){
  .ft-reader-subscription[data-house-format=leaderboard] .ft-house-copy{gap:8px;padding:10px 12px}
  .ft-reader-subscription[data-house-format=leaderboard] .ft-house-title{font-size:18px}
  .ft-reader-subscription[data-house-format=leaderboard] .ft-house-body{flex-basis:16ch;max-width:22ch;font-size:11px}
  .ft-reader-subscription[data-house-format=leaderboard] .ft-reader-price{font-size:12px}
  .ft-reader-subscription[data-house-format=leaderboard] .ft-house-cta{min-height:36px;padding:7px 9px;font-size:11px}
}
.ft-house-creative[data-house-image-unavailable=true]{grid-template-columns:minmax(0,1fr)}
.ft-house-creative[data-house-image-unavailable=true] .ft-house-art{display:none}
.ft-house-creative[data-house-image-unavailable=true] .ft-house-copy{grid-column:1}
.ft-house-creative:not(.ft-reader-subscription)[data-house-format=rectangle]{grid-template-columns:36% minmax(0,1fr)}
.ft-house-creative:not(.ft-reader-subscription)[data-house-format=rectangle] .ft-house-copy{gap:7px;padding:12px}
.ft-house-creative:not(.ft-reader-subscription)[data-house-format=rectangle] .ft-house-title{font-size:19px}
.ft-house-creative:not(.ft-reader-subscription)[data-house-format=rectangle] .ft-house-promise{font-size:14px;padding:6px 8px}
.ft-house-creative:not(.ft-reader-subscription)[data-house-format=rectangle] .ft-house-body{display:none}
.ft-house-creative:not(.ft-reader-subscription)[data-house-format=rectangle] .ft-house-cta{min-height:36px;padding:7px 10px;font-size:12px}
.ft-house-creative:not(.ft-reader-subscription)[data-house-format=billboard]{grid-template-columns:minmax(0,1fr) 42%}
.ft-house-creative:not(.ft-reader-subscription)[data-house-format=billboard] .ft-house-art{grid-column:2;grid-row:1;object-position:right center}
.ft-house-creative:not(.ft-reader-subscription)[data-house-format=billboard] .ft-house-copy{grid-column:1;grid-row:1;gap:8px;padding:20px}
.ft-house-creative:not(.ft-reader-subscription)[data-house-format=billboard] .ft-house-title{font-size:34px}
.ft-house-creative:not(.ft-reader-subscription)[data-house-format=billboard] .ft-house-promise{font-size:21px;padding:8px 12px}
.ft-house-creative:not(.ft-reader-subscription)[data-house-format=billboard] .ft-house-body{font-size:14px}
.ft-house-creative:not(.ft-reader-subscription)[data-house-format=skyscraper]{position:relative;grid-template-columns:1fr;grid-template-rows:1fr;background:#0f172a}
.ft-house-creative:not(.ft-reader-subscription)[data-house-format=skyscraper] .ft-house-art{grid-column:1;grid-row:1;object-position:center center}
.ft-house-creative:not(.ft-reader-subscription)[data-house-format=skyscraper] .ft-house-copy{z-index:1;grid-column:1;grid-row:1;justify-content:flex-end;gap:8px;padding:16px;background:linear-gradient(to bottom,transparent 30%,rgba(5,14,27,.08) 48%,rgba(5,14,27,.82) 73%,#050b14 100%);color:#fff}
.ft-house-creative:not(.ft-reader-subscription)[data-house-format=skyscraper] .ft-house-title{font-size:25px;color:#fff}
.ft-house-creative:not(.ft-reader-subscription)[data-house-format=skyscraper] .ft-house-promise{font-size:16px}
.ft-house-creative:not(.ft-reader-subscription)[data-house-format=skyscraper] .ft-house-body{font-size:12px;line-height:1.35;color:#fff}
.ft-house-creative:not(.ft-reader-subscription)[data-house-format=skyscraper] .ft-house-cta{align-self:stretch}
.ft-house-creative:not(.ft-reader-subscription)[data-house-format=skyscraper][data-house-image-unavailable=true]{background:var(--_surface,#fff)}
.ft-house-creative:not(.ft-reader-subscription)[data-house-format=skyscraper][data-house-image-unavailable=true] .ft-house-copy{background:var(--_surface,#fff);color:var(--_heading,#0f172a)}
.ft-house-creative:not(.ft-reader-subscription)[data-house-format=skyscraper][data-house-image-unavailable=true] .ft-house-title,.ft-house-creative:not(.ft-reader-subscription)[data-house-format=skyscraper][data-house-image-unavailable=true] .ft-house-body{color:var(--_heading,#0f172a)}
.ft-house-creative:not(.ft-reader-subscription)[data-house-format=leaderboard]{grid-template-columns:minmax(0,1fr) 28%}
.ft-house-creative:not(.ft-reader-subscription)[data-house-format=leaderboard] .ft-house-art{grid-column:2;grid-row:1;object-position:right center}
.ft-house-creative:not(.ft-reader-subscription)[data-house-format=leaderboard] .ft-house-copy{grid-column:1;grid-row:1;display:grid;grid-template-columns:minmax(0,1fr) auto;grid-template-rows:auto auto;align-content:center;gap:3px 12px;padding:8px 14px}
.ft-house-creative:not(.ft-reader-subscription)[data-house-format=leaderboard] .ft-house-title{grid-column:1;grid-row:1;font-size:17px;line-height:1.1}
.ft-house-creative:not(.ft-reader-subscription)[data-house-format=leaderboard] .ft-house-promise{grid-column:1;grid-row:2;padding:4px 5px;font-size:12px;line-height:1.1}
.ft-house-creative:not(.ft-reader-subscription)[data-house-format=leaderboard] .ft-house-cta{grid-column:2;grid-row:1 / span 2;min-height:36px;padding:6px 10px;font-size:12px}
.ft-house-creative:not(.ft-reader-subscription)[data-house-format=leaderboard] .ft-house-body{display:none}
.ft-house-creative:not(.ft-reader-subscription)[data-house-format=mobile_large]{grid-template-columns:18% minmax(0,1fr)}
.ft-house-creative:not(.ft-reader-subscription)[data-house-format=mobile_large] .ft-house-copy{display:grid;grid-template-columns:minmax(0,1fr) auto;grid-template-rows:auto auto;align-content:center;gap:4px 8px;padding:8px}
.ft-house-creative:not(.ft-reader-subscription)[data-house-format=mobile_large] .ft-house-title{grid-column:1;grid-row:1;font-size:14px;line-height:1.1}
.ft-house-creative:not(.ft-reader-subscription)[data-house-format=mobile_large] .ft-house-promise{grid-column:1;grid-row:2;padding:5px 6px;font-size:12px;line-height:1.1}
.ft-house-creative:not(.ft-reader-subscription)[data-house-format=mobile_large] .ft-house-body{display:none}
.ft-house-creative:not(.ft-reader-subscription)[data-house-format=mobile_large] .ft-house-cta{grid-column:2;grid-row:1 / span 2;width:76px;min-height:36px;padding:5px 8px;font-size:11px}
.ft-house-creative:not(.ft-reader-subscription)[data-house-format=mobile_banner]{grid-template-columns:16% minmax(0,1fr)}
.ft-house-creative:not(.ft-reader-subscription)[data-house-format=mobile_banner] .ft-house-copy{display:grid;grid-template-columns:minmax(0,1fr) auto;grid-template-rows:auto auto;align-content:center;gap:2px 8px;padding:3px 8px}
.ft-house-creative:not(.ft-reader-subscription)[data-house-format=mobile_banner] .ft-house-title{grid-column:1;grid-row:1;font-size:12px;line-height:1.05;white-space:nowrap}
.ft-house-creative:not(.ft-reader-subscription)[data-house-format=mobile_banner] .ft-house-promise{grid-column:1;grid-row:2;padding:4px 5px;font-size:11px;line-height:1.05;white-space:nowrap}
.ft-house-creative:not(.ft-reader-subscription)[data-house-format=mobile_banner] .ft-house-body{display:none}
.ft-house-creative:not(.ft-reader-subscription)[data-house-format=mobile_banner] .ft-house-cta{grid-column:2;grid-row:1 / span 2;min-height:30px;padding:4px 8px;font-size:11px;white-space:nowrap}
@container(max-width:220px){.ft-house-creative:not(.ft-reader-subscription)[data-house-format=mobile_banner],.ft-house-creative:not(.ft-reader-subscription)[data-house-format=mobile_large]{grid-template-columns:minmax(0,1fr)}.ft-house-creative:not(.ft-reader-subscription)[data-house-format=mobile_banner] .ft-house-art,.ft-house-creative:not(.ft-reader-subscription)[data-house-format=mobile_large] .ft-house-art{display:none}.ft-house-creative:not(.ft-reader-subscription)[data-house-format=mobile_banner] .ft-house-copy,.ft-house-creative:not(.ft-reader-subscription)[data-house-format=mobile_large] .ft-house-copy{grid-column:1;padding:4px 8px}.ft-house-creative:not(.ft-reader-subscription)[data-house-format=mobile_banner] .ft-house-title{font-size:10px}.ft-house-creative:not(.ft-reader-subscription)[data-house-format=mobile_banner] .ft-house-promise{font-size:10px}.ft-house-creative:not(.ft-reader-subscription)[data-house-format=mobile_banner] .ft-house-cta,.ft-house-creative:not(.ft-reader-subscription)[data-house-format=mobile_large] .ft-house-cta{display:none}.ft-house-creative:not(.ft-reader-subscription)[data-house-format=mobile_large] .ft-house-copy{grid-template-columns:minmax(0,1fr);grid-template-rows:auto auto}.ft-house-creative:not(.ft-reader-subscription)[data-house-format=mobile_large] .ft-house-title{font-size:12px}.ft-house-creative:not(.ft-reader-subscription)[data-house-format=mobile_large] .ft-house-promise{font-size:11px}}
@container(max-width:220px){.ft-house-creative:not(.ft-reader-subscription)[data-house-format=skyscraper] .ft-house-copy{padding:12px;gap:7px}.ft-house-creative:not(.ft-reader-subscription)[data-house-format=skyscraper] .ft-house-title{font-size:20px}.ft-house-creative:not(.ft-reader-subscription)[data-house-format=skyscraper] .ft-house-promise{font-size:14px;padding:5px 7px}.ft-house-creative:not(.ft-reader-subscription)[data-house-format=skyscraper] .ft-house-body{font-size:11px;line-height:1.3}.ft-house-creative:not(.ft-reader-subscription)[data-house-format=skyscraper] .ft-house-cta{min-height:36px;font-size:12px;padding-inline:8px}}
@container(min-height:1400px){.ft-house-creative:not(.ft-reader-subscription)[data-house-format=billboard]{grid-template-columns:1fr;grid-template-rows:55% minmax(0,1fr)}.ft-house-creative:not(.ft-reader-subscription)[data-house-format=billboard] .ft-house-art{grid-column:1;grid-row:1;object-position:center 22%}.ft-house-creative:not(.ft-reader-subscription)[data-house-format=billboard] .ft-house-copy{grid-column:1;grid-row:2;padding:32px;gap:12px}.ft-house-creative:not(.ft-reader-subscription)[data-house-format=billboard] .ft-house-title{font-size:44px}.ft-house-creative:not(.ft-reader-subscription)[data-house-format=billboard] .ft-house-promise{font-size:28px}.ft-house-creative:not(.ft-reader-subscription)[data-house-format=billboard] .ft-house-body{font-size:16px}.ft-house-creative:not(.ft-reader-subscription)[data-house-format=billboard] .ft-house-cta{font-size:16px;padding:12px 20px}}
@container(max-width:900px){.ft-house-creative:not(.ft-reader-subscription)[data-house-format=billboard] .ft-house-copy{padding:14px;gap:6px}.ft-house-creative:not(.ft-reader-subscription)[data-house-format=billboard] .ft-house-title{font-size:26px}.ft-house-creative:not(.ft-reader-subscription)[data-house-format=billboard] .ft-house-promise{font-size:18px}.ft-house-creative:not(.ft-reader-subscription)[data-house-format=billboard] .ft-house-body{font-size:12px}}
`;
