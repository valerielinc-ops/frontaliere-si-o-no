export const HOUSE_AD_VARIANTS = ['control', 'time_saved', 'profile_match', 'in_control', 'swiss_work', 'next_chapter'] as const;
export type HouseAdVariant = (typeof HOUSE_AD_VARIANTS)[number];
export type HouseAdFormat = 'mobile_banner' | 'mobile_large' | 'rectangle' | 'leaderboard' | 'billboard' | 'skyscraper';
export type HouseAdLocale = 'it' | 'en' | 'de' | 'fr';

/** The same compositions render in React and in the independently booted static shell. */
export function createHouseAdCreative(options: {
  variant: HouseAdVariant;
  format: HouseAdFormat;
  locale: HouseAdLocale;
  placement: string;
  destinationPath?: string;
  portraitArtwork?: boolean;
  assetBase?: string;
  onClick?: () => void;
}): HTMLAnchorElement {
  const { variant, format, locale, placement } = options;
  const words = {
    it: { cta: 'Scopri come funziona', shortCta: 'Scopri', body: 'Troviamo le offerte adatte al tuo mestiere e prepariamo le candidature per te.',
      titles: { control: 'Lavoro in Svizzera? Lo cerchiamo noi per te.', time_saved: 'Vuoi lavorare in Svizzera? Alla ricerca pensiamo noi.', profile_match: 'Il tuo mestiere. Il lavoro in Svizzera. Lo cerchiamo noi.', in_control: 'Lavoro in Svizzera: non sai da dove iniziare? Ti aiutiamo noi.', swiss_work: 'Vuoi lavorare in Svizzera? Partiamo dal tuo mestiere.', next_chapter: 'Cercare lavoro in Svizzera richiede tempo. Ti aiutiamo noi.' },
      short: { control: 'Svizzera? Il lavoro lo cerchiamo noi.', time_saved: 'Lavoro in Svizzera? Ci pensiamo noi.', profile_match: 'Svizzera: cerchiamo per il tuo mestiere.', in_control: 'Svizzera: da dove iniziare? Ti aiutiamo.', swiss_work: 'Il tuo mestiere, in Svizzera. Cerchiamo noi.', next_chapter: 'Lavoro in Svizzera? Ti togliamo la ricerca.' } },
    en: { cta: 'See how it works', shortCta: 'Explore', body: 'We find job offers that fit your profession and prepare the applications for you.',
      titles: { control: 'A job in Switzerland? We do the searching for you.', time_saved: 'Want to work in Switzerland? Leave the search to us.', profile_match: 'Your profession. A job in Switzerland. We do the searching.', in_control: 'Want to work in Switzerland, but unsure where to start? We help.', swiss_work: 'Want to work in Switzerland? We start with your profession.', next_chapter: 'Searching for a job in Switzerland takes time. We help.' },
      short: { control: 'Switzerland? We search for you.', time_saved: 'Swiss job search? Leave it to us.', profile_match: 'Swiss jobs for your profession.', in_control: 'Work in Switzerland? We help you start.', swiss_work: 'Your profession, in Switzerland.', next_chapter: 'We take the Swiss job search off your hands.' } },
    de: { cta: 'So funktioniert es', shortCta: 'Entdecken', body: 'Wir suchen passende Stellen für Ihren Beruf und bereiten Ihre Bewerbungen vor.',
      titles: { control: 'Arbeit in der Schweiz? Wir suchen für Sie.', time_saved: 'In der Schweiz arbeiten? Die Suche übernehmen wir.', profile_match: 'Ihr Beruf. Arbeit in der Schweiz. Wir übernehmen die Suche.', in_control: 'Arbeit in der Schweiz: Wo anfangen? Wir helfen Ihnen.', swiss_work: 'In der Schweiz arbeiten? Ihr Beruf ist unser Ausgangspunkt.', next_chapter: 'Die Stellensuche in der Schweiz kostet Zeit. Wir helfen Ihnen.' },
      short: { control: 'Schweiz? Wir suchen für Sie.', time_saved: 'Schweizer Stellensuche? Übernehmen wir.', profile_match: 'Schweizer Stellen für Ihren Beruf.', in_control: 'Arbeit in der Schweiz? Wir helfen.', swiss_work: 'Ihr Beruf, in der Schweiz.', next_chapter: 'Wir nehmen Ihnen die Stellensuche ab.' } },
    fr: { cta: 'Voir comment ça marche', shortCta: 'Découvrir', body: 'Nous cherchons les offres adaptées à votre métier et préparons vos candidatures.',
      titles: { control: 'Un emploi en Suisse ? Nous cherchons pour vous.', time_saved: 'Vous voulez travailler en Suisse ? Nous nous chargeons de la recherche.', profile_match: 'Votre métier. Un emploi en Suisse. Nous cherchons pour vous.', in_control: 'Travailler en Suisse : par où commencer ? Nous vous aidons.', swiss_work: 'Travailler en Suisse ? Nous partons de votre métier.', next_chapter: 'Chercher un emploi en Suisse prend du temps. Nous vous aidons.' },
      short: { control: 'La Suisse ? Nous cherchons pour vous.', time_saved: 'Emploi en Suisse ? On s’en charge.', profile_match: 'Des offres suisses pour votre métier.', in_control: 'Travailler en Suisse ? Nous vous aidons.', swiss_work: 'Votre métier, en Suisse.', next_chapter: 'Nous cherchons votre emploi en Suisse.' } },
  }[locale];
  const narrow = options.portraitArtwork || format === 'rectangle' || format === 'mobile_banner' || format === 'mobile_large' || format === 'skyscraper';
  const artwork = {
    control: narrow ? 'construction-portrait-v1' : 'construction-wide-v1',
    time_saved: narrow ? 'logistics-portrait-v1' : 'logistics-wide-v1',
    profile_match: narrow ? 'production-portrait-v1' : 'production-wide-v1',
    in_control: narrow ? 'maintenance-portrait-v1' : 'maintenance-wide-v1',
    swiss_work: narrow ? 'electrician-portrait-v1' : 'electrician-wide-v1',
    next_chapter: narrow ? 'hospitality-portrait-v1' : 'hospitality-wide-v1',
  }[variant];
  const sizes: Record<string, [number, number]> = {
    'construction-portrait-v1': [600, 1200], 'construction-wide-v1': [1456, 486],
    'maintenance-portrait-v1': [600, 1200], 'maintenance-wide-v1': [1456, 486],
    'logistics-portrait-v1': [600, 1200], 'logistics-wide-v1': [1456, 486],
    'production-portrait-v1': [600, 1200], 'production-wide-v1': [1456, 486],
    'electrician-portrait-v1': [600, 1200], 'electrician-wide-v1': [1456, 486],
    'hospitality-portrait-v1': [600, 1200], 'hospitality-wide-v1': [1456, 486],
  };
  const compact = format === 'mobile_banner' || format === 'mobile_large' || format === 'leaderboard';
  const anchor = document.createElement('a');
  anchor.className = 'ft-house-creative';
  anchor.dataset.houseFormat = format;
  anchor.dataset.houseCreative = `${variant}_v1`;
  anchor.dataset.houseArtwork = narrow ? 'portrait' : 'wide';
  const query = new URLSearchParams({ utm_source: 'house_ads', utm_medium: 'display', utm_campaign: 'job_search_automation', utm_content: `${variant}_v1`, utm_term: `${format}.${placement}` });
  const destination = options.destinationPath || ({ it: '/automatizza-ricerca-lavoro-svizzera/', en: '/en/automate-job-search-switzerland/', de: '/de/arbeitssuche-schweiz-automatisieren/', fr: '/fr/automatiser-recherche-emploi-suisse/' })[locale];
  anchor.href = `${destination}?${query}`;
  anchor.setAttribute('aria-label', `${words.titles[variant]} ${words.cta}`);
  const image = document.createElement('img');
  image.className = 'ft-house-art'; image.alt = ''; image.decoding = 'async'; image.loading = 'lazy';
  image.width = sizes[artwork][0]; image.height = sizes[artwork][1];
  image.src = `${options.assetBase || '/images/job-search-campaign/'}${artwork}.webp`;
  const text = document.createElement('span'); text.className = 'ft-house-copy';
  const title = document.createElement('span'); title.className = 'ft-house-title'; title.textContent = compact ? words.short[variant] : words.titles[variant];
  const promise = document.createElement('span'); promise.className = 'ft-house-promise';
  if (!compact) {
    const campaign = {
      it: { question: 'Lavoro in Svizzera?', promises: { control: 'Lo cerchiamo noi per te.', time_saved: 'Alla ricerca pensiamo noi.', profile_match: 'Le offerte per il tuo mestiere.', in_control: 'Ti aiutiamo noi, dall’inizio.', swiss_work: 'Cerchiamo le offerte per te.', next_chapter: 'Meno ricerche. Ti aiutiamo noi.' } },
      en: { question: 'A job in Switzerland?', promises: { control: 'We do the searching for you.', time_saved: 'Leave the search to us.', profile_match: 'Offers for your profession.', in_control: 'We help you get started.', swiss_work: 'We find the offers for you.', next_chapter: 'Less searching. We help you.' } },
      de: { question: 'Arbeit in der Schweiz?', promises: { control: 'Wir suchen für Sie.', time_saved: 'Die Suche übernehmen wir.', profile_match: 'Stellen für Ihren Beruf.', in_control: 'Wir helfen Ihnen beim Start.', swiss_work: 'Wir suchen die Stellen für Sie.', next_chapter: 'Weniger suchen. Wir helfen.' } },
      fr: { question: 'Un emploi en Suisse ?', promises: { control: 'Nous cherchons pour vous.', time_saved: 'On s’occupe de la recherche.', profile_match: 'Des offres pour votre métier.', in_control: 'Nous vous aidons à démarrer.', swiss_work: 'Nous cherchons les offres.', next_chapter: 'Moins chercher. On vous aide.' } },
    }[locale];
    title.textContent = campaign.question; promise.textContent = campaign.promises[variant];
  }
  const body = document.createElement('span'); body.className = 'ft-house-body'; body.textContent = words.body;
  const cta = document.createElement('span'); cta.className = 'ft-house-cta'; cta.textContent = format === 'mobile_banner' ? words.shortCta : words.cta;
  text.append(title); if (!compact) text.append(promise); text.append(body, cta);
  anchor.append(image, text);
  if (options.onClick) anchor.addEventListener('click', options.onClick);
  return anchor;
}

export const HOUSE_AD_CREATIVE_CSS = `
.ft-house-creative{box-sizing:border-box;container-type:inline-size;display:grid;grid-template-columns:42% minmax(0,1fr);width:100%;height:100%;min-width:0;overflow:hidden;border:1px solid var(--_edge,ButtonBorder);border-radius:6px;background:var(--_surface,Canvas);text-align:left;isolation:isolate}
/* Isolate link typography without raising the specificity of format geometry. */
a.ft-house-creative[data-house-format][data-house-creative]{color:var(--_heading,CanvasText);text-decoration:none;font:400 14px/1.4 Inter,system-ui,sans-serif}
.ft-house-creative *{box-sizing:border-box}
.ft-house-art{grid-column:1;grid-row:1;display:block;width:100%;height:100%;min-width:0;min-height:0;object-fit:cover;object-position:center 28%}
.ft-house-copy{grid-column:2;grid-row:1;display:flex;flex-direction:column;justify-content:center;align-items:flex-start;gap:8px;min-width:0;min-height:0;padding:18px}
.ft-house-title{font:700 30px/1.04 "Space Grotesk",Inter,system-ui,sans-serif;letter-spacing:-.025em;text-transform:uppercase;text-wrap:balance}
.ft-house-promise{max-width:100%;padding:3px 6px;background:var(--_danger,FireBrick);color:var(--_surface,Canvas);font-size:20px;line-height:1.12;font-weight:700;text-transform:uppercase;text-wrap:balance}
.ft-house-body{color:var(--_body,CanvasText);font-size:13px;line-height:1.4}
.ft-house-cta{display:inline-flex;min-height:44px;align-items:center;justify-content:center;gap:8px;padding:9px 14px;border-radius:6px;background:var(--_heading,CanvasText);color:var(--_surface,Canvas);font-size:13px;font-weight:700;line-height:1.25}
.ft-house-creative:hover .ft-house-cta{background:var(--_danger,FireBrick)}.ft-house-creative:focus-visible{outline:3px solid var(--_accent,Highlight);outline-offset:2px}
.ft-house-creative[data-house-format=rectangle]{grid-template-columns:38% minmax(0,1fr)}
.ft-house-creative[data-house-format=rectangle] .ft-house-copy{padding:10px;gap:7px}
.ft-house-creative[data-house-format=rectangle] .ft-house-title{font-size:21px}
.ft-house-creative[data-house-format=rectangle] .ft-house-promise{font-size:16px;padding:3px 4px}
.ft-house-creative[data-house-format=rectangle] .ft-house-body{display:none}
.ft-house-creative[data-house-format=rectangle] .ft-house-cta{padding-inline:8px;font-size:12px}
.ft-house-creative[data-house-format=billboard]{grid-template-columns:minmax(0,1fr) 43%}
.ft-house-creative[data-house-format=billboard] .ft-house-art{grid-column:2;grid-row:1;object-position:right center}
.ft-house-creative[data-house-format=billboard] .ft-house-copy{grid-column:1;grid-row:1;padding:20px;gap:9px}
.ft-house-creative[data-house-format=billboard] .ft-house-title{font-size:38px}
.ft-house-creative[data-house-format=billboard] .ft-house-promise{font-size:24px}
.ft-house-creative[data-house-format=skyscraper]{grid-template-columns:1fr;grid-template-rows:48% minmax(0,1fr)}
.ft-house-creative[data-house-format=skyscraper] .ft-house-art{grid-column:1;grid-row:1;object-position:center 22%}
.ft-house-creative[data-house-format=skyscraper] .ft-house-copy{grid-column:1;grid-row:2;padding:16px;gap:8px}
.ft-house-creative[data-house-format=skyscraper] .ft-house-title{font-size:26px}
.ft-house-creative[data-house-format=skyscraper] .ft-house-cta{align-self:stretch}
.ft-house-creative[data-house-format=leaderboard]{grid-template-columns:minmax(0,1fr) 30%}
.ft-house-creative[data-house-format=leaderboard] .ft-house-art{grid-column:2;grid-row:1;object-position:right center}
.ft-house-creative[data-house-format=leaderboard] .ft-house-copy{grid-column:1;grid-row:1;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 16px;padding:10px 16px}
.ft-house-creative[data-house-format=leaderboard] .ft-house-title{grid-column:1;font-size:18px}
.ft-house-creative[data-house-format=leaderboard] .ft-house-cta{grid-column:2;grid-row:1}
.ft-house-creative[data-house-format=leaderboard] .ft-house-body{display:none}
.ft-house-creative[data-house-format=mobile_large],.ft-house-creative[data-house-format=mobile_banner]{grid-template-columns:22% minmax(0,1fr)}
.ft-house-creative[data-house-format=mobile_large] .ft-house-copy{display:grid;grid-template-columns:minmax(0,1fr) 82px;padding:8px;gap:4px 8px}
.ft-house-creative[data-house-format=mobile_large] .ft-house-title{grid-column:1;grid-row:1;font-size:14px}
.ft-house-creative[data-house-format=mobile_large] .ft-house-body{display:none}
.ft-house-creative[data-house-format=mobile_large] .ft-house-cta{grid-column:2;grid-row:1;min-height:44px;padding:5px 8px;font-size:11px}
.ft-house-creative[data-house-format=mobile_banner]{grid-template-columns:16% minmax(0,1fr)}
.ft-house-creative[data-house-format=mobile_banner] .ft-house-copy{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 8px;padding:2px 6px}
.ft-house-creative[data-house-format=mobile_banner] .ft-house-title{font-size:11px;grid-column:1;line-height:1.05}
.ft-house-creative[data-house-format=mobile_banner] .ft-house-body{display:none}
.ft-house-creative[data-house-format=mobile_banner] .ft-house-cta{grid-column:2;grid-row:1;padding:5px 8px;font-size:11px}
@container(max-width:200px){.ft-house-creative[data-house-format=skyscraper] .ft-house-copy{padding:12px;gap:7px}.ft-house-creative[data-house-format=skyscraper] .ft-house-title{font-size:20px}.ft-house-creative[data-house-format=skyscraper] .ft-house-promise{font-size:16px;padding:3px 4px}.ft-house-creative[data-house-format=skyscraper] .ft-house-body{font-size:12px;line-height:1.35}.ft-house-creative[data-house-format=skyscraper] .ft-house-cta{font-size:12px;padding-inline:8px}}
@container(min-height:1400px){.ft-house-creative[data-house-format=billboard]{grid-template-columns:1fr;grid-template-rows:60% minmax(0,1fr)}.ft-house-creative[data-house-format=billboard] .ft-house-art{grid-column:1;grid-row:1;object-position:center 22%}.ft-house-creative[data-house-format=billboard] .ft-house-copy{grid-column:1;grid-row:2;padding:36px;gap:16px}.ft-house-creative[data-house-format=billboard] .ft-house-title{font-size:48px}.ft-house-creative[data-house-format=billboard] .ft-house-promise{font-size:32px}.ft-house-creative[data-house-format=billboard] .ft-house-body{font-size:18px}.ft-house-creative[data-house-format=billboard] .ft-house-cta{font-size:18px;padding:14px 22px}}
@container(max-width:900px){.ft-house-creative[data-house-format=billboard] .ft-house-copy{padding:14px;gap:6px}.ft-house-creative[data-house-format=billboard] .ft-house-title{font-size:28px}.ft-house-creative[data-house-format=billboard] .ft-house-promise{font-size:20px}}
`;
