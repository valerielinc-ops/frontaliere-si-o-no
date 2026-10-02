/**
 * The tailored CV as a document: header, personal data and sections, in the
 * order of the Swiss CV for the type of application (study 2026-10-02,
 * report-cv-lettera §4; SDBB/CSFO templates, SECO, BIZ Bern). Built in code
 * from the profile (every fact) and the model's sanitized text (headline,
 * summary, competencies, bullets, skills); any renderer prints it as it is.
 *
 * Layout rules measured in the study and kept by every renderer: one real
 * column, the dates on a line under the role (never a date column), "Label:
 * value" pairs on one line, no icons.
 */

import { formatPeriod } from './lib/cvPeriod.js';

export const SECTION_TITLES = {
  de: {
    personal: 'Persönliche Angaben', summary: 'Kurzprofil', competencies: 'Kernkompetenzen', experience: 'Berufserfahrung', internships: 'Praktika',
    trial: 'Schnupperlehren', jobs: 'Nebenjobs', volunteer: 'Freiwilligenarbeit', school: 'Schulbildung', education: 'Ausbildung',
    recognitions: 'Anerkennung und Registrierung', certifications: 'Weiterbildung und Zertifikate', tests: 'Eignungstests', projects: 'Projekte',
    skills: 'Kenntnisse', languages: 'Sprachen', interests: 'Freizeit und Engagement', references: 'Referenzen',
  },
  fr: {
    personal: 'Données personnelles', summary: 'Profil', competencies: 'Compétences clés', experience: 'Expérience professionnelle', internships: 'Stages',
    trial: "Stages d'orientation", jobs: 'Petits jobs', volunteer: 'Bénévolat', school: 'Scolarité', education: 'Formation',
    recognitions: 'Reconnaissance et enregistrement', certifications: 'Formations continues et certificats', tests: "Tests d'aptitudes", projects: 'Projets',
    skills: 'Compétences', languages: 'Langues', interests: 'Loisirs et engagements', references: 'Références',
  },
  it: {
    personal: 'Dati personali', summary: 'Profilo', competencies: 'Competenze chiave', experience: 'Esperienza professionale', internships: 'Stage',
    trial: 'Stage di orientamento', jobs: 'Lavoretti', volunteer: 'Volontariato', school: 'Scuola', education: 'Formazione',
    recognitions: 'Riconoscimento e registrazione', certifications: 'Formazione continua e certificati', tests: 'Test attitudinali', projects: 'Progetti',
    skills: 'Competenze', languages: 'Lingue', interests: 'Tempo libero e impegni', references: 'Referenze',
  },
  en: {
    personal: 'Personal details', summary: 'Professional summary', competencies: 'Core competencies', experience: 'Work experience', internships: 'Internships',
    trial: 'Taster placements', jobs: 'Side jobs', volunteer: 'Volunteering', school: 'School', education: 'Education',
    recognitions: 'Recognition and registration', certifications: 'Further training and certificates', tests: 'Aptitude tests', projects: 'Projects',
    skills: 'Skills', languages: 'Languages', interests: 'Interests', references: 'References',
  },
};

export const PERSONAL_LABELS = {
  de: { born: 'Geburtsdatum', nationality: 'Nationalität', permit: 'Arbeitsbewilligung', availability: 'Verfügbarkeit', licence: 'Führerausweis' },
  fr: { born: 'Date de naissance', nationality: 'Nationalité', permit: 'Permis de travail', availability: 'Disponibilité', licence: 'Permis de conduire' },
  it: { born: 'Data di nascita', nationality: 'Nazionalità', permit: 'Permesso di lavoro', availability: 'Disponibilità', licence: 'Patente' },
  en: { born: 'Date of birth', nationality: 'Nationality', permit: 'Work permit', availability: 'Availability', licence: 'Driving licence' },
};

// Which section of the CV an experience goes to, by its kind and the type of application.
const EXPERIENCE_SECTION = {
  apprentice: { job: 'jobs', apprenticeship: 'experience', internship: 'trial', trial_apprenticeship: 'trial', side_job: 'jobs', volunteer: 'volunteer' },
  first_job: { job: 'experience', apprenticeship: 'experience', internship: 'internships', trial_apprenticeship: 'internships', side_job: 'jobs', volunteer: 'volunteer' },
  qualified: { job: 'experience', apprenticeship: 'experience', internship: 'internships', trial_apprenticeship: 'internships', side_job: 'jobs', volunteer: 'volunteer' },
};

// Section order of the Swiss CV for each type (SDBB apprentice templates; SECO / BIZ Bern for adults).
const ORDER = {
  apprentice: ['school', 'trial', 'experience', 'jobs', 'volunteer', 'tests', 'skills', 'languages', 'interests', 'references'],
  first_job: ['summary', 'education', 'internships', 'experience', 'jobs', 'volunteer', 'projects', 'competencies', 'skills', 'certifications', 'languages', 'interests', 'references'],
  qualified: ['summary', 'competencies', 'experience', 'internships', 'education', 'recognitions', 'certifications', 'projects', 'skills', 'languages', 'jobs', 'volunteer', 'interests', 'references'],
};

const joined = (...parts) => parts.map((part) => String(part || '').trim()).filter(Boolean).join(', ');

function addressLine(profile = {}) {
  const address = profile.address || {};
  const street = String(address.street || '').trim();
  const city = [address.postalCode, address.city].filter(Boolean).join(' ').trim();
  return street && city ? `${street}, ${city}` : String(profile.location || '').trim();
}

/**
 * @param {object} cv sanitizeTailoredCv's result
 * @param {{identity:{name:string,email:string,phone:string}, profile:object, language?:string, type?:string, sector?:string}} context
 * @returns {{language:string, name:string, headline:string, contact:string[], personal:Array<[string,string]>, sections:Array<{kind:string, title:string, items?:object[], pairs?:Array<[string,string]>, list?:string[], text?:string}>}}
 */
export function buildCvDocument(cv, { identity, profile = {}, language = 'it', type = 'qualified', sector = 'other' }) {
  const titles = SECTION_TITLES[language] || SECTION_TITLES.it;
  const labels = PERSONAL_LABELS[language] || PERSONAL_LABELS.it;
  const kindOf = EXPERIENCE_SECTION[type] || EXPERIENCE_SECTION.qualified;
  const period = (start, end) => formatPeriod(start, end, language);
  const sections = {};
  const push = (kind, entry) => { (sections[kind] ||= []).push(entry); };

  (cv.experience || []).forEach((role, index) => {
    const kind = kindOf[profile.experience?.[index]?.kind || 'job'] || 'experience';
    push(kind, { date: period(role.start, role.end), title: role.role, org: role.employer, place: role.location, bullets: role.bullets });
  });
  const education = (profile.education || []).filter((item) => item.degree || item.institution)
    .map((item) => ({ date: period(item.start, item.end), title: item.degree, org: item.institution, text: item.grade || '' }));

  const content = {
    summary: type !== 'apprentice' && cv.summary ? { text: cv.summary } : null,
    competencies: type !== 'apprentice' && cv.competencies?.length ? { text: cv.competencies.join(' · ') } : null,
    school: type === 'apprentice' && education.length ? { items: education } : null,
    education: type !== 'apprentice' && education.length ? { items: education } : null,
    recognitions: (profile.recognitions || []).length ? { list: profile.recognitions.map((item) => joined(item.title, item.issuer, item.date)) } : null,
    certifications: (profile.certifications || []).length ? { list: profile.certifications } : null,
    tests: (profile.aptitudeTests || []).length ? { pairs: profile.aptitudeTests.map((test) => [test.name, joined(test.date, test.results)]) } : null,
    projects: (profile.projects || []).length && (sector === 'it' || type !== 'apprentice')
      ? { items: profile.projects.map((project) => ({ title: project.name, org: project.url, text: project.description })) } : null,
    skills: cv.skills?.length ? { text: cv.skills.join(', ') } : null,
    languages: (profile.languages || []).some((item) => item.language)
      ? { pairs: profile.languages.filter((item) => item.language).map((item) => [item.language, item.level || '']) } : null,
    interests: (profile.interests || []).length ? { list: profile.interests } : null,
    references: (profile.references || []).length ? { list: profile.references.map((item) => joined(item.name, item.role, item.organisation, item.contact)) } : null,
  };
  for (const kind of ['experience', 'internships', 'trial', 'jobs', 'volunteer']) if (sections[kind]) content[kind] = { items: sections[kind] };

  const personal = [
    ['born', profile.dateOfBirth], ['nationality', profile.nationality], ['permit', profile.workPermit],
    ['availability', profile.availability], ['licence', profile.drivingLicence],
  ].filter(([, value]) => String(value || '').trim()).map(([key, value]) => [labels[key], String(value).trim()]);

  return {
    language,
    name: identity.name,
    headline: cv.headline || '',
    contact: [addressLine(profile), identity.phone, identity.email, profile.linkedin, sector === 'it' ? profile.website : ''].filter(Boolean),
    personal,
    sections: (ORDER[type] || ORDER.qualified).filter((kind) => content[kind]).map((kind) => ({ kind, title: titles[kind], ...content[kind] })),
  };
}

/** The document as blocks of the standard-font PDF writer (renderPdf). */
export function cvDocumentBlocks(document, { personalTitle } = {}) {
  const heading = (text) => ({ text: text.toUpperCase(), bold: true, size: 10.5, gapBefore: 10 });
  const blocks = [{ text: document.name, bold: true, size: 16 }];
  if (document.headline) blocks.push({ text: document.headline, bold: true, size: 11, gapBefore: 2 });
  if (document.contact.length) blocks.push({ text: document.contact.join(' · '), size: 9.5, gapBefore: 2 });
  const pairs = (list) => list.map(([label, value]) => ({ text: value ? `${label}: ${value}` : label }));
  if (document.personal.length) blocks.push(heading(personalTitle || (SECTION_TITLES[document.language] || SECTION_TITLES.it).personal), ...pairs(document.personal));
  for (const section of document.sections) {
    blocks.push(heading(section.title));
    if (section.text) blocks.push({ text: section.text });
    if (section.pairs) blocks.push(...pairs(section.pairs));
    if (section.list) blocks.push(...section.list.map((item) => ({ text: item, bullet: true })));
    (section.items || []).forEach((item, index) => {
      blocks.push({ text: [item.title, item.org].filter(Boolean).join(' — '), bold: true, gapBefore: index ? 6 : 2 });
      const meta = [item.date, item.place].filter(Boolean).join(' · ');
      if (meta) blocks.push({ text: meta, size: 9.5 });
      if (item.text) blocks.push({ text: item.text });
      for (const bullet of item.bullets || []) blocks.push({ text: bullet, bullet: true });
    });
  }
  return blocks;
}
