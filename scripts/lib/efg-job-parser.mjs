function decodeHtml(text = '') {
  return String(text || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\u00a0/g, ' ');
}

function compact(text = '') {
  return decodeHtml(String(text || '')).replace(/\s+/g, ' ').trim();
}

function unique(items = [], max = 24) {
  const out = [];
  const seen = new Set();
  for (const item of items) {
    const clean = compact(String(item || '').replace(/^[-•*]\s*/, ''));
    if (!clean || clean.length < 3) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
    if (out.length >= max) break;
  }
  return out;
}

function toMarkdownParagraphs(html = '') {
  return decodeHtml(
    String(html || '')
      .replace(/<li[^>]*>/gi, '\n- ')
      .replace(/<\/li>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<p[^>]*>/gi, '')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeHeading(heading = '') {
  return compact(heading).replace(/:$/, '');
}

function classifySectionId(heading = '') {
  const h = normalizeHeading(heading).toLowerCase();
  if (/main responsibilities|responsibilities|your role|job description/.test(h)) return 'responsibilities';
  if (/skills and experience|qualifications|your profile|requirements/.test(h)) return 'requirements';
  if (/our values|what we offer|benefits/.test(h)) return 'benefits';
  if (/application|apply|contact/.test(h)) return 'process';
  if (/company|purpose|mission/.test(h)) return 'company';
  if (/general info|details|information/.test(h)) return 'details';
  return 'details';
}

function extractSectionBlocks(html = '') {
  const normalized = String(html || '')
    .replace(/\r/g, '\n')
    .replace(
      /<p([^>]*)>\s*(Application|Apply(?: now)?|Contact)\s*<\/p>/gi,
      '<p$1><strong>$2</strong></p>',
    );
  const headingRe = /<p[^>]*>\s*<strong[^>]*>([\s\S]*?)<\/strong>\s*<\/p>/gi;
  const matches = [...normalized.matchAll(headingRe)];
  if (matches.length === 0) return [];

  const sections = [];
  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i];
    const heading = normalizeHeading(match[1]);
    const start = match.index + match[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : normalized.length;
    const body = normalized.slice(start, end).trim();
    sections.push({ heading, body });
  }
  return sections;
}

function extractBullets(html = '') {
  return unique(
    [...String(html || '').matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map((match) => match[1]),
    24,
  );
}

function extractParagraphs(html = '') {
  return unique(
    [...String(html || '').matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
      .map((match) => compact(match[1]))
      .filter(Boolean),
    24,
  );
}

export function parseEfgOracleDescription(rawHtml = '') {
  const sections = extractSectionBlocks(rawHtml);
  if (sections.length === 0) {
    const compactText = compact(rawHtml);
    return {
      description: compactText,
      requirements: [],
      canonical: {
        summary: compactText ? [compactText] : [],
        responsibilities: [],
        requirements: [],
        benefits: [],
        process: [],
        highlights: [],
        keywords: [],
        sections: [],
        readingMinutes: Math.max(1, Math.round(Math.max(1, compactText.split(/\s+/).length) / 180)),
      },
    };
  }

  const summary = [];
  const responsibilities = [];
  const requirements = [];
  const benefits = [];
  const process = [];
  const extraSections = [];
  const markdownParts = [];

  for (const section of sections) {
    const sectionId = classifySectionId(section.heading);
    const bullets = extractBullets(section.body);
    const paragraphs = extractParagraphs(section.body).filter((p) => !bullets.includes(p));

    markdownParts.push(`## ${section.heading}`);
    const bodyMarkdown = toMarkdownParagraphs(section.body);
    if (bodyMarkdown) markdownParts.push(bodyMarkdown);

    if (sectionId === 'responsibilities') {
      if (/job description/i.test(section.heading)) summary.push(...paragraphs.slice(0, 3));
      responsibilities.push(...bullets);
      if (!/job description/i.test(section.heading)) {
        summary.push(...paragraphs.slice(0, 1));
      }
      continue;
    }
    if (sectionId === 'requirements') {
      requirements.push(...bullets);
      continue;
    }
    if (sectionId === 'benefits') {
      benefits.push(...bullets);
      continue;
    }
    if (sectionId === 'process') {
      process.push(...bullets, ...paragraphs);
      continue;
    }
    extraSections.push({
      id: sectionId,
      heading: section.heading,
      paragraphs,
      bullets,
    });
  }

  const uniqSummary = unique(summary, 4);
  const uniqResponsibilities = unique(responsibilities, 16);
  const uniqRequirements = unique(requirements, 16);
  const uniqBenefits = unique(benefits, 12);
  const uniqProcess = unique(process, 10);
  const description = markdownParts.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  const highlights = unique([
    ...uniqResponsibilities.slice(0, 3),
    ...uniqRequirements.slice(0, 3),
    ...uniqBenefits.slice(0, 2),
  ], 8);

  return {
    description,
    requirements: uniqRequirements,
    canonical: {
      summary: uniqSummary,
      responsibilities: uniqResponsibilities,
      requirements: uniqRequirements,
      benefits: uniqBenefits,
      process: uniqProcess,
      highlights,
      keywords: unique([
        ...uniqRequirements.slice(0, 5).map((item) => item.split(/[:;,]/)[0]),
        ...uniqResponsibilities.slice(0, 4).map((item) => item.split(/[:;,]/)[0]),
      ], 10),
      sections: extraSections,
      readingMinutes: Math.max(1, Math.round(Math.max(1, description.split(/\s+/).length) / 180)),
    },
  };
}
