/**
 * Deterministic CV Fit Scoring ($0, sub-1ms, zero LLM tokens)
 * Modello a 4 dimensioni con la Regola Aurea del Denominatore:
 * i requisiti non verificabili vengono rimossi dal numeratore e dal denominatore,
 * garantendo che un candidato non venga mai penalizzato per lacune del dizionario.
 */

export interface CvMatchInput {
  cvText: string;
  cvSkills: string[];
  jobTitle: string;
  jobSkills: string[];
  jobSeniority?: 'junior' | 'mid' | 'senior' | 'lead';
  requirements: Array<{ text?: string; requiredSkills?: string[] }>;
}

export interface CvMatchCategoryScore {
  earned: number;
  weight: number;
  available: boolean;
}

export interface CvMatchResult {
  overall: number;               // 0 - 100
  categories: {
    requirements: CvMatchCategoryScore;
    keyword: CvMatchCategoryScore;
    title: CvMatchCategoryScore;
    seniority: CvMatchCategoryScore;
  };
  matchedSkills: string[];
  missingSkills: string[];
}

export function computeCvMatch(input: CvMatchInput): CvMatchResult {
  const normCvText = (input.cvText || '').toLowerCase();
  const cvSkillSet = new Set((input.cvSkills || []).map(s => s.toLowerCase()));

  // 1. Requirements Coverage (Peso 40)
  let reqEarned = 0;
  let reqPossible = 0;
  const rawReqs = Array.isArray(input.requirements) ? input.requirements : [];

  for (const req of rawReqs) {
    const skills = Array.isArray(req.requiredSkills) ? req.requiredSkills : [];
    if (skills.length === 0) {
      // Regola Aurea del Denominatore: requisito non verificabile, escluso dal conteggio
      continue;
    }
    reqPossible += 1;
    const isCovered = skills.some(s => cvSkillSet.has(s.toLowerCase()) || normCvText.includes(s.toLowerCase()));
    if (isCovered) {
      reqEarned += 1;
    }
  }
  const reqAvailable = reqPossible > 0;
  const reqScore = reqAvailable ? (reqEarned / reqPossible) * 40 : 0;

  // 2. Keyword Match (Peso 30)
  const matchedSkills: string[] = [];
  const missingSkills: string[] = [];
  const jobSkills = Array.isArray(input.jobSkills) ? input.jobSkills : [];

  for (const skill of jobSkills) {
    const s = skill.toLowerCase();
    if (cvSkillSet.has(s) || normCvText.includes(s)) {
      matchedSkills.push(skill);
    } else {
      missingSkills.push(skill);
    }
  }
  const keyAvailable = jobSkills.length > 0;
  const keyScore = keyAvailable ? (matchedSkills.length / jobSkills.length) * 30 : 0;

  // 3. Title Match (Peso 20)
  const titleWords = (input.jobTitle || '')
    .toLowerCase()
    .split(/\s+/)
    .filter(w => w.length > 3);
  let titleMatches = 0;
  for (const word of titleWords) {
    if (normCvText.includes(word)) {
      titleMatches++;
    }
  }
  const titleAvailable = titleWords.length > 0;
  const titleScore = titleAvailable
    ? Math.min(1, titleMatches / Math.max(1, titleWords.length * 0.6)) * 20
    : 0;

  // 4. Seniority Fit (Peso 10)
  let senScore = 10;
  let senAvailable = true;
  if (input.jobSeniority) {
    const sen = input.jobSeniority.toLowerCase();
    const hasSeniorMarker = /\b(?:senior|lead|head|principal|expert)\b/i.test(normCvText);
    const hasJuniorMarker = /\b(?:junior|trainee|apprentice|stage|tirocinio)\b/i.test(normCvText);

    if (sen === 'senior' && !hasSeniorMarker && hasJuniorMarker) {
      senScore = 3;
    } else if (sen === 'junior' && hasSeniorMarker) {
      senScore = 7;
    }
  } else {
    senAvailable = false;
  }

  // Aggregazione ponderata con esclusione delle categorie non disponibili
  let totalEarned = 0;
  let totalWeight = 0;

  if (reqAvailable) { totalEarned += reqScore; totalWeight += 40; }
  if (keyAvailable) { totalEarned += keyScore; totalWeight += 30; }
  if (titleAvailable) { totalEarned += titleScore; totalWeight += 20; }
  if (senAvailable) { totalEarned += senScore; totalWeight += 10; }

  const overall = totalWeight > 0 ? Math.round((totalEarned / totalWeight) * 100) : 0;

  return {
    overall,
    categories: {
      requirements: { earned: Math.round(reqScore), weight: 40, available: reqAvailable },
      keyword: { earned: Math.round(keyScore), weight: 30, available: keyAvailable },
      title: { earned: Math.round(titleScore), weight: 20, available: titleAvailable },
      seniority: { earned: Math.round(senScore), weight: 10, available: senAvailable },
    },
    matchedSkills,
    missingSkills,
  };
}
