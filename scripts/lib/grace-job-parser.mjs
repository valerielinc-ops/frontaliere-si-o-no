function compact(text = '') {
  return String(text || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function trimNoise(text = '') {
  return compact(text)
    .replace(/\bStart application\b[\s\S]*$/i, '')
    .replace(/\bMatching jobs by mail\b[\s\S]*$/i, '')
    .replace(/\bcompany profile\s+Jobs:\s*\d+[\s\S]*$/i, '')
    .trim();
}

export function selectGraceDescription({
  metaDesc = '',
  sectionTexts = [],
  containerText = '',
  mainText = '',
  bodyText = '',
} = {}) {
  const normalizedSections = (Array.isArray(sectionTexts) ? sectionTexts : [])
    .map((entry) => trimNoise(entry))
    .filter(Boolean);
  const joinedSections = trimNoise(normalizedSections.join('\n\n'));
  const normalizedContainer = trimNoise(containerText);
  const normalizedMain = trimNoise(mainText);
  const normalizedBody = trimNoise(bodyText);
  const normalizedMeta = trimNoise(metaDesc);

  if (joinedSections.length >= 280) return joinedSections;
  if (normalizedContainer.length >= 280) return normalizedContainer;
  if (normalizedMain.length >= 280) return normalizedMain;
  if (joinedSections.length >= 140) return joinedSections;
  if (normalizedContainer.length >= 140) return normalizedContainer;
  if (normalizedMain.length >= 140) return normalizedMain;
  if (normalizedBody.length >= 140) return normalizedBody;
  return normalizedMeta || joinedSections || normalizedContainer || normalizedMain || normalizedBody;
}
