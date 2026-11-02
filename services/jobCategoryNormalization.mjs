// Shared by the browser board and the Node email matcher. Keep one definition
// of the categories a subscriber selects on the board.
const CATEGORY_ALIASES = {
  tech: 'tech', it: 'tech', software: 'tech',
  engineering: 'engineering', 'quality assurance': 'engineering',
  quality: 'engineering', operations: 'engineering', production: 'engineering',
  regulatory: 'health', 'medical affairs': 'health', health: 'health', healthcare: 'health',
  finance: 'finance', admin: 'admin', administration: 'admin', hr: 'admin',
  'human resources': 'admin', 'general services': 'admin',
  sales: 'sales', marketing: 'sales', hospitality: 'hospitality', other: 'other',
};

function normalizeText(value) {
  return String(value || '').trim().toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

export function normalizeJobCategory(raw, hintText = '') {
  const rawNorm = normalizeText(raw);
  const hintNorm = normalizeText(hintText);
  if (rawNorm && Object.hasOwn(CATEGORY_ALIASES, rawNorm)) {
    if (rawNorm === 'general services' && /(manutent|mainten|elettro|mechanic|tecnic|facility)/.test(hintNorm)) {
      return 'engineering';
    }
    return CATEGORY_ALIASES[rawNorm];
  }
  const combined = `${rawNorm} ${hintNorm}`.trim();
  if (!combined) return 'other';
  if (/(web developer|software|sistemista|devops|cloud|robotics|c\+\+)/.test(combined)) return 'tech';
  if (/(manutent|mainten|elettro|mechanic|ingegner|engineer|fresator|tornitor|quality|operations|production|r d|research|sviluppo)/.test(combined)) return 'engineering';
  if (/(medical|clinical|healthcare|health care|medic|orthopedic|orthopaedic|regulatory|medical affairs)/.test(combined)) return 'health';
  if (/(finance|account|audit|treasury|contabil|controll)/.test(combined)) return 'finance';
  if (/(sales|marketing|commercial|product manager|business development|communication)/.test(combined)) return 'sales';
  if (/(hr|human resources|recruit|talent|admin|amministr|servizi general|event|travel)/.test(combined)) return 'admin';
  if (/(hotel|hospitality|ristor|bar|chef|camerier)/.test(combined)) return 'hospitality';
  return 'other';
}
