/**
 * Per-job FAQ builder for individual `JobPosting` pages.
 *
 * Unlike article FAQ (AI-generated once per article, see
 * scripts/batch-add-faq-to-articles.mjs), job postings are high-volume
 * (~19k active, refreshed by the crawler every 6h, ~30d lifespan) so an
 * AI-per-job pipeline would be cost- and rate-limit-prohibitive and risks
 * near-duplicate output across similar roles. Instead this builder is a
 * pure template populated with the job's own resolved schema fields
 * (salary, employment type, company, canton) — deterministic, zero AI
 * cost, and naturally unique because those fields differ per job.
 *
 * Consumes the already-resolved `JobPostingFacts` (see jobPostingSchema.ts)
 * rather than re-deriving salary/address/employmentType itself, so there is
 * a single source of truth for those values and no duplicated resolution
 * logic between the two modules.
 */

import type { EmploymentType, JobPostingFacts } from './jobPostingSchema';
import { hostFromUrl } from './hostFromUrl';

export type FaqLocale = 'it' | 'en' | 'de' | 'fr';

export interface JobFaqPair {
  readonly q: string;
  readonly a: string;
}

export interface BuildJobPostingFaqOptions {
  readonly locale: FaqLocale;
  /** Absolute job listing URL (the employer's original posting, falling back
   * to our own canonical URL) — its HOSTNAME is cited in the "how to apply"
   * answer, see {@link buildApplyFaq}. */
  readonly jobUrl: string;
  /** Localised canton display name (e.g. "Ticino", "Ginevra"). */
  readonly cantonDisplay: string;
  /** True when the job's canton is Ticino — selects the detailed G-permit copy. */
  readonly isTicino: boolean;
  readonly isRemote?: boolean;
}

// Distinct from `EMPLOYMENT_TYPE_LABEL` in scripts/lib/social-post-utils.mjs
// (that one is Italian-only, capitalised, 4 values, for short social-post
// captions — a different rendering context, not the same constant): this map
// is multi-locale, lowercase/in-sentence, and covers all 8 schema.org
// EmploymentType values for a discursive FAQ answer. Kept separate rather
// than merged per AGENTS.md #6 — the two outputs genuinely diverge (e.g. IT
// CONTRACTOR is "Contratto" there vs "mandato/freelance" here), so unifying
// would either break existing social captions or blunt this FAQ's wording.
const EMPLOYMENT_TYPE_FAQ_LABEL: Record<FaqLocale, Record<EmploymentType, string>> = {
  it: {
    FULL_TIME: 'tempo pieno',
    PART_TIME: 'part-time',
    CONTRACTOR: 'mandato/freelance',
    TEMPORARY: 'contratto a tempo determinato',
    INTERN: 'stage/tirocinio',
    VOLUNTEER: 'volontariato',
    PER_DIEM: 'a giornata',
    OTHER: 'contratto atipico',
  },
  en: {
    FULL_TIME: 'full-time',
    PART_TIME: 'part-time',
    CONTRACTOR: 'contractor/freelance',
    TEMPORARY: 'fixed-term contract',
    INTERN: 'internship',
    VOLUNTEER: 'volunteer',
    PER_DIEM: 'per-diem',
    OTHER: 'atypical contract',
  },
  de: {
    FULL_TIME: 'Vollzeit',
    PART_TIME: 'Teilzeit',
    CONTRACTOR: 'Mandat/Freelance',
    TEMPORARY: 'befristeter Vertrag',
    INTERN: 'Praktikum',
    VOLUNTEER: 'ehrenamtlich',
    PER_DIEM: 'Tagessatz',
    OTHER: 'atypischer Vertrag',
  },
  fr: {
    FULL_TIME: 'temps plein',
    PART_TIME: 'temps partiel',
    CONTRACTOR: 'mandat/freelance',
    TEMPORARY: 'contrat à durée déterminée',
    INTERN: 'stage',
    VOLUNTEER: 'bénévolat',
    PER_DIEM: 'à la journée',
    OTHER: 'contrat atypique',
  },
};

const LOCALE_INTL: Record<FaqLocale, string> = {
  it: 'it-CH',
  en: 'en-CH',
  de: 'de-CH',
  fr: 'fr-CH',
};

function formatSalaryRange(schema: JobPostingFacts, locale: FaqLocale): string {
  const { currency, minValue, maxValue } = schema.salary;
  const fmt = new Intl.NumberFormat(LOCALE_INTL[locale], { maximumFractionDigits: 0 });
  const min = fmt.format(minValue);
  return maxValue !== undefined && maxValue > minValue
    ? `${currency} ${min} - ${fmt.format(maxValue)}`
    : `${currency} ${min}`;
}

const PER_YEAR_LABEL: Record<FaqLocale, string> = {
  it: 'lordi annui',
  en: 'gross per year',
  de: 'brutto pro Jahr',
  fr: 'bruts par an',
};

// The answer says which kind of figure it is. A reported salary is the
// employer's statement; an estimate is labelled as ours and is never phrased
// as "<company> offers" (owner decision 2026-10-24: estimates stay visible,
// explicitly labelled, and stay out of the JobPosting markup).
function buildSalaryFaq(schema: JobPostingFacts, opts: BuildJobPostingFaqOptions): JobFaqPair {
  const { locale } = opts;
  const company = schema.hiringOrganization.name;
  const range = formatSalaryRange(schema, locale);
  const perYear = PER_YEAR_LABEL[locale];
  const city = schema.jobLocation.address.addressLocality;
  const estimate = schema.salary.isEstimate;
  if (locale === 'en') {
    return {
      q: `What salary does ${company} offer for this role?`,
      a: estimate
        ? `The original listing does not state a salary. Our estimate for this role and sector in ${city} is ${range} ${perYear} — an estimate, not a figure communicated by ${company}. The calculator on this site converts a gross salary into your actual net take-home once cross-border tax and social contributions are applied.`
        : `${company} lists ${range} ${perYear} for this position in ${city}. This is the salary published in the original listing — the calculator on this site converts it to your actual net take-home once cross-border tax and social contributions are applied.`,
    };
  }
  if (locale === 'de') {
    return {
      q: `Welches Gehalt bietet ${company} für diese Stelle?`,
      a: estimate
        ? `Das Original-Inserat nennt kein Gehalt. Unsere Schätzung für diese Rolle und Branche in ${city} liegt bei ${range} ${perYear} — eine Schätzung, kein von ${company} mitgeteilter Betrag. Der Rechner auf dieser Seite berechnet aus einem Bruttogehalt Ihr tatsächliches Netto nach Grenzgänger-Steuer und Sozialabgaben.`
        : `${company} gibt ${range} ${perYear} für diese Position in ${city} an. Dies ist das im Original-Inserat veröffentlichte Gehalt — der Rechner auf dieser Seite berechnet daraus Ihr tatsächliches Netto nach Grenzgänger-Steuer und Sozialabgaben.`,
    };
  }
  if (locale === 'fr') {
    return {
      q: `Quel salaire propose ${company} pour ce poste ?`,
      a: estimate
        ? `L'annonce d'origine n'indique pas de salaire. Notre estimation pour ce rôle et ce secteur à ${city} est de ${range} ${perYear} — une estimation, pas un montant communiqué par ${company}. Le calculateur de ce site convertit un salaire brut en net réel une fois l'impôt frontalier et les cotisations sociales appliqués.`
        : `${company} indique ${range} ${perYear} pour ce poste à ${city}. Il s'agit du salaire publié dans l'annonce d'origine — le calculateur de ce site le convertit en net réel une fois l'impôt frontalier et les cotisations sociales appliqués.`,
    };
  }
  return {
    q: `Che stipendio offre ${company} per questa posizione?`,
    a: estimate
      ? `L'annuncio originale non indica lo stipendio. La nostra stima per questo ruolo e settore a ${city} è ${range} ${perYear}: è una stima, non una cifra comunicata da ${company}. Il calcolatore di questo sito converte un lordo nel netto reale una volta applicate imposta da frontaliere e contributi sociali.`
      : `${company} indica ${range} ${perYear} per questo ruolo a ${city}. Questo è lo stipendio pubblicato nell'annuncio originale — il calcolatore di questo sito lo converte nel netto reale una volta applicate imposta da frontaliere e contributi sociali.`,
  };
}

function buildContractFaq(schema: JobPostingFacts, opts: BuildJobPostingFaqOptions): JobFaqPair {
  const { locale } = opts;
  const labels = EMPLOYMENT_TYPE_FAQ_LABEL[locale];
  const contractLabel = schema.employmentTypes.map((type) => labels[type]).join(locale === 'it' ? ' e ' : locale === 'de' ? ' und ' : locale === 'fr' ? ' et ' : ' and ');
  const stated = schema.employmentTypes.length > 0;
  const company = schema.hiringOrganization.name;
  if (locale === 'en') {
    return {
      q: `Is this a full-time role, and what type of contract does ${company} offer?`,
      a: stated
        ? `This listing is a ${contractLabel} position. The contract type shown here comes directly from the employer's original posting; always confirm exact hours, notice period and probation length with ${company} during the application process, since these details can vary by role even within the same contract category.`
        : `The original posting does not state the contract type or the working hours. Ask ${company} about hours, contract duration, notice period and probation during the application process.`,
    };
  }
  if (locale === 'de') {
    return {
      q: `Ist das eine Vollzeitstelle, und welchen Vertragstyp bietet ${company}?`,
      a: stated
        ? `Diese Stelle ist eine ${contractLabel}-Position. Der hier angezeigte Vertragstyp stammt direkt aus dem Original-Inserat des Arbeitgebers; klären Sie genaue Arbeitszeiten, Kündigungsfrist und Probezeit während des Bewerbungsprozesses mit ${company}, da diese Details auch innerhalb derselben Vertragskategorie variieren können.`
        : `Das Original-Inserat nennt weder den Vertragstyp noch das Pensum. Klären Sie Arbeitszeiten, Vertragsdauer, Kündigungsfrist und Probezeit während des Bewerbungsprozesses mit ${company}.`,
    };
  }
  if (locale === 'fr') {
    return {
      q: `Est-ce un poste à temps plein, et quel type de contrat propose ${company} ?`,
      a: stated
        ? `Cette offre est un poste en ${contractLabel}. Le type de contrat affiché ici provient directement de l'annonce originale de l'employeur ; confirmez toujours les horaires exacts, le préavis et la durée d'essai avec ${company} pendant le processus de candidature, ces détails pouvant varier même au sein de la même catégorie de contrat.`
        : `L'annonce originale n'indique ni le type de contrat ni le taux d'activité. Renseignez-vous auprès de ${company} sur les horaires, la durée du contrat, le préavis et la période d'essai pendant la candidature.`,
    };
  }
  return {
    q: `È un ruolo a tempo pieno, e che tipo di contratto offre ${company}?`,
    a: stated
      ? `Questo annuncio è una posizione a ${contractLabel}. Il tipo di contratto mostrato qui arriva direttamente dall'annuncio originale del datore di lavoro; conferma sempre orario esatto, preavviso e durata del periodo di prova con ${company} durante il colloquio, perché questi dettagli possono variare anche all'interno della stessa categoria contrattuale.`
      : `L'annuncio originale non indica il tipo di contratto né la percentuale di impiego. Chiedi a ${company} orario, durata del contratto, preavviso e periodo di prova durante il colloquio.`,
  };
}

function buildPermitFaq(opts: BuildJobPostingFaqOptions): JobFaqPair {
  const { locale, cantonDisplay, isTicino, isRemote } = opts;
  if (isTicino) {
    if (locale === 'en') {
      return {
        q: `Do I need the G permit to apply for this role in Ticino as an Italian cross-border worker?`,
        a: `Yes. For EU/EFTA citizens the G permit no longer depends on a border zone: you need residence in an EU/EFTA state, a Swiss contract and a return home at least once a week. The 20 km band matters for taxation, not for the permit. The Swiss employer files the G-permit application at the Ticino cantonal migration office after the contract is signed — first issuance takes 2-6 weeks. The permit lasts five years with an open-ended contract or one over a year, otherwise for the length of the contract.${isRemote ? ' Note: this listing allows remote work — teleworking above 25 % of your time can shift your social-security base to Italy, so confirm the agreed remote share with HR before signing.' : ''}`,
      };
    }
    if (locale === 'de') {
      return {
        q: `Brauche ich als italienischer Grenzgänger die G-Bewilligung für diese Tessiner Stelle?`,
        a: `Ja. Für EU/EFTA-Bürger hängt die G-Bewilligung nicht mehr von einer Grenzzone ab: Nötig sind ein Wohnsitz in einem EU/EFTA-Staat, ein Schweizer Vertrag und die Rückkehr mindestens einmal pro Woche. Die 20-km-Regel betrifft die Besteuerung, nicht die Bewilligung. Der Schweizer Arbeitgeber beantragt die G-Bewilligung nach Vertragsunterzeichnung beim Migrationsamt des Kantons Tessin — die Erstausstellung dauert 2-6 Wochen. Die Bewilligung gilt fünf Jahre bei unbefristetem oder über einjährigem Vertrag, sonst für die Vertragsdauer.${isRemote ? ' Hinweis: Diese Stelle erlaubt Homeoffice — Telearbeit über 25 % der Arbeitszeit kann die Sozialversicherungsbasis nach Italien verschieben; klären Sie den vereinbarten Anteil vorab mit HR.' : ''}`,
      };
    }
    if (locale === 'fr') {
      return {
        q: `Ai-je besoin du permis G pour postuler à ce poste au Tessin en tant que frontalier italien ?`,
        a: `Oui. Pour les citoyens UE/AELE, le permis G ne dépend plus d'une zone frontalière : il faut résider dans un État UE/AELE, avoir un contrat suisse et rentrer au moins une fois par semaine. La bande des 20 km concerne la fiscalité, pas le permis. L'employeur suisse dépose la demande de permis G à l'office cantonal des migrations du Tessin après signature du contrat — la première délivrance prend 2-6 semaines. Le permis vaut cinq ans avec un contrat à durée indéterminée ou de plus d'un an, sinon pour la durée du contrat.${isRemote ? ' Remarque : cette offre autorise le télétravail — au-delà de 25 % du temps, la base de sécurité sociale peut basculer vers l\'Italie ; vérifiez la part convenue avec les RH avant de signer.' : ''}`,
      };
    }
    return {
      q: `Serve il Permesso G per candidarmi a questa posizione in Ticino da frontaliere italiano?`,
      a: `Sì. Per i cittadini UE/AELS il permesso G non dipende più da una zona di frontiera: servono residenza in uno Stato UE/AELS, contratto svizzero e rientro almeno una volta a settimana. La fascia dei 20 km riguarda il fisco, non il permesso. Il datore di lavoro svizzero presenta la domanda di Permesso G all'Ufficio della migrazione del Cantone Ticino dopo la firma del contratto — la prima emissione richiede 2-6 settimane. Il permesso vale cinque anni con contratto a tempo indeterminato o superiore a un anno, altrimenti per la durata del contratto.${isRemote ? ' Nota: questo annuncio prevede lavoro da remoto — il telelavoro sopra il 25% del tempo può spostare la base previdenziale verso l\'Italia, verifica con HR la quota concordata prima di firmare.' : ''}`,
    };
  }

  // Non-Ticino canton: keep the answer general (G-permit exists CH-wide for
  // EU/EFTA residents, with no border zone) without inventing canton-specific numbers we
  // have not verified, and point the reader to the cantonal authority.
  if (locale === 'en') {
    return {
      q: `Do I need a cross-border work permit for a role in ${cantonDisplay}?`,
      a: `EU/EFTA citizens living in an EU/EFTA state can apply for a G permit and can work anywhere in Switzerland: border zones no longer apply to them, and they must return home at least once a week. The Swiss employer files the request with Canton ${cantonDisplay}'s migration office after the contract is signed. Processing times vary by canton, so confirm the specifics with ${cantonDisplay}'s cantonal migration office or with HR during the application.`,
    };
  }
  if (locale === 'de') {
    return {
      q: `Brauche ich eine Grenzgänger-Bewilligung für eine Stelle im Kanton ${cantonDisplay}?`,
      a: `EU/EFTA-Bürger mit Wohnsitz in einem EU/EFTA-Staat können eine G-Bewilligung beantragen und in der ganzen Schweiz arbeiten: Grenzzonen gelten für sie nicht mehr, und sie müssen mindestens einmal pro Woche heimkehren. Der Schweizer Arbeitgeber reicht den Antrag nach Vertragsunterzeichnung beim Migrationsamt des Kantons ${cantonDisplay} ein. Die Bearbeitungszeiten variieren je nach Kanton — klären Sie die Details mit dem Migrationsamt des Kantons ${cantonDisplay} oder mit HR während der Bewerbung.`,
    };
  }
  if (locale === 'fr') {
    return {
      q: `Ai-je besoin d'un permis de frontalier pour un poste dans le canton de ${cantonDisplay} ?`,
      a: `Les citoyens UE/AELE résidant dans un État UE/AELE peuvent demander un permis G et travailler dans toute la Suisse : les zones frontalières ne s'appliquent plus à eux, et ils doivent rentrer au moins une fois par semaine. L'employeur suisse dépose la demande auprès de l'office des migrations du canton de ${cantonDisplay} après signature du contrat. Les délais varient selon le canton — confirmez les détails auprès de l'office des migrations du canton de ${cantonDisplay} ou avec les RH pendant la candidature.`,
    };
  }
  return {
    q: `Serve un permesso da frontaliere per un ruolo nel canton ${cantonDisplay}?`,
    a: `I cittadini UE/AELS residenti in uno Stato UE/AELS possono richiedere il Permesso G e lavorare in tutta la Svizzera: le zone di frontiera per loro non valgono più e il rientro è almeno settimanale. Il datore di lavoro svizzero presenta la domanda all'ufficio della migrazione del canton ${cantonDisplay} dopo la firma del contratto. I tempi di lavorazione variano per canton — verifica i dettagli con l'ufficio della migrazione del canton ${cantonDisplay} o con HR durante il colloquio.`,
  };
}

function buildApplyFaq(schema: JobPostingFacts, opts: BuildJobPostingFaqOptions): JobFaqPair {
  const { locale, jobUrl } = opts;
  const company = schema.hiringOrganization.name;
  // Display the SOURCE HOSTNAME, not the raw jobUrl path: third-party ATS
  // systems encode arbitrary characters into their URL slugs (e.g.
  // Rheinmetall's career site turns "/" "(" ")" into literal "_", producing
  // paths like `ux_ui___xr_designer__m_w_d_`). Interpolating that raw path
  // into visible prose leaked 3+-underscore runs into <main>, tripping
  // audit:no-literal-markdown's 0-tolerance separator-run gate even though
  // nothing here is AI-translation markdown (validate-dist run 29794187475,
  // 119 offenders). The "Apply now" button (href, not text) still points at
  // the exact full URL — only the human-readable citation is shortened.
  const jobHost = hostFromUrl(jobUrl) || jobUrl.replace(/[_=~]{3,}/g, ' ').trim();
  if (locale === 'en') {
    return {
      q: `How do I apply for this position at ${company}?`,
      a: `Use the "Apply now" button on this page — it links directly to ${company}'s original listing at ${jobHost}, so your application goes straight to the employer's own applicant-tracking system. Frontaliere Ticino does not collect or forward applications itself.`,
    };
  }
  if (locale === 'de') {
    return {
      q: `Wie bewerbe ich mich für diese Stelle bei ${company}?`,
      a: `Nutzen Sie die Schaltfläche "Jetzt bewerben" auf dieser Seite — sie führt direkt zum Original-Inserat von ${company} unter ${jobHost}, sodass Ihre Bewerbung direkt im Bewerbermanagementsystem des Arbeitgebers landet. Frontaliere Ticino sammelt oder leitet keine Bewerbungen selbst weiter.`,
    };
  }
  if (locale === 'fr') {
    return {
      q: `Comment postuler à ce poste chez ${company} ?`,
      a: `Utilisez le bouton « Postuler maintenant » sur cette page — il renvoie directement à l'annonce originale de ${company} sur ${jobHost}, votre candidature arrive donc directement dans le système de suivi des candidatures de l'employeur. Frontaliere Ticino ne collecte ni ne transmet lui-même les candidatures.`,
    };
  }
  return {
    q: `Come mi candido a questa posizione presso ${company}?`,
    a: `Usa il pulsante "Candidati ora" in questa pagina — rimanda direttamente all'annuncio originale di ${company} su ${jobHost}, quindi la tua candidatura arriva direttamente nel sistema di gestione candidature del datore di lavoro. Frontaliere Ticino non raccoglie né inoltra candidature in proprio.`,
  };
}

/**
 * Build the 4 job-specific FAQ pairs for a single JobPosting page. Pure
 * function of (schema, opts) — same inputs always produce the same output,
 * so it is safe to call on every build without memoization.
 */
export function buildJobPostingFaqPairs(
  schema: JobPostingFacts,
  opts: BuildJobPostingFaqOptions,
): JobFaqPair[] {
  return [
    buildSalaryFaq(schema, opts),
    buildContractFaq(schema, opts),
    buildPermitFaq(opts),
    buildApplyFaq(schema, opts),
  ];
}
