/**
 * Requirement labels that identify a degree or graduation document without
 * relying on the model's separate kind classification. Ambiguous file text
 * still stays unknown in the browser classifier.
 */
const DEGREE_CERTIFICATE_LABELS = Object.freeze([
  'degree certificate', 'degree certificates', 'certificate of degree', 'certificates of degree',
  'degree diploma', 'degree diplomas', 'graduation certificate', 'graduation certificates',
  'academic degree', 'university degree', 'bachelor degree', 'bachelor degrees',
  'bachelors degree', 'bachelors degrees', 'bachelor s degree', 'bachelor s degrees',
  'master degree', 'master degrees', 'masters degree', 'masters degrees', 'master s degree', 'master s degrees',
  'laurea', 'lauree', 'laurea triennale', 'laurea magistrale', 'titolo universitario', 'titoli universitari',
  'diploma di laurea', 'diplomi di laurea', 'diploma universitario', 'diplomi universitari',
  'certificato di laurea', 'certificati di laurea', 'attestato di laurea', 'attestati di laurea',
  'attestazione di laurea', 'attestazioni di laurea', 'certificazione di laurea', 'certificazioni di laurea',
  'diplome universitaire', 'diplomes universitaires', 'diplome de licence', 'diplomes de licence',
  'diplome de master', 'diplomes de master',
  'attestation de diplome', 'attestations de diplome', 'certificat de diplome', 'certificats de diplome',
  'certificat de reussite', 'certificats de reussite',
  'hochschulabschluss', 'hochschulabschlusse', 'hochschulabschlusszeugnis', 'hochschulabschlusszeugnisse',
  'bachelorabschluss', 'masterabschluss', 'bachelorzeugnis', 'bachelorzeugnisse',
  'masterzeugnis', 'masterzeugnisse', 'abschlusszeugnis', 'abschlusszeugnisse',
  'diplomurkunde', 'diplomurkunden',
]);

function normalizeLabel(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function isDegreeCertificateRequirement(label) {
  const normalized = normalizeLabel(label);
  if (normalized === 'degree' || normalized === 'degrees') return true;
  const padded = ` ${normalized} `;
  return DEGREE_CERTIFICATE_LABELS.some(phrase => padded.includes(` ${phrase} `));
}

/** Labels for a candidate portrait, as opposed to a CV or another record. */
export function isPhotoRequirement(label, kind = null) {
  const normalized = normalizeLabel(label);
  if (normalized && /\b(?:photo|photograph|photographie|foto|fotografia) (?:id|identification|identity|identity card)\b|\b(?:id|identity|identification) (?:photo|photograph|photographie|foto|fotografia)\b/.test(normalized)) return false;
  if (kind === 'photo') return true;
  if (!normalized) return false;
  const padded = ` ${normalized} `;
  return [
    'foto', 'fotos', 'fotografia', 'fotografie', 'fototessera', 'fototessere',
    'fotografia tessera', 'fotografie tessera', 'foto tessera', 'foto tessere',
    'photo', 'photos', 'photograph', 'photographs', 'photographie', 'photographies',
    'portrait', 'portraits', 'headshot', 'headshots',
    'bewerbungsfoto', 'bewerbungsfotos', 'bewerbungsbild', 'bewerbungsbilder',
    'passfoto', 'passfotos', 'pasfoto', 'pasfotos', 'profilbild', 'profilbilder', 'profilfoto', 'profilfotos',
    'profielfoto', 'profielfotos', 'portretfoto', 'portretfotos', 'lichtbild', 'lichtbilder',
    'profile photo', 'profile photos', 'profile picture', 'profile pictures', 'passport photo', 'passport photos',
    'application photo', 'application photos',
    'photo identite', 'photo d identite', 'photographie identite', 'photographie d identite',
    'photos identite', 'photos d identite', 'photographies identite', 'photographies d identite',
    'photo de profil', 'photos de profil', 'photo profil', 'photos profil', 'photo de candidature',
    'foto de perfil', 'fotos de perfil', 'fotografia de perfil', 'foto carnet', 'foto de carnet',
  ].some(phrase => padded.includes(` ${phrase} `));
}
