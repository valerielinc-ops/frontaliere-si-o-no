/**
 * robots-policy.mjs — lettura di robots.txt per un crawler che si dichiara.
 *
 * Due domande diverse, e servono entrambe (decisione D10 del programma
 * «sezioni cantonali»):
 *
 *  1. Il NOSTRO agente (e `*`) puo' leggere questo path? RFC 9309: gruppo piu'
 *     specifico per user-agent, poi regola Allow/Disallow piu' lunga; a parita'
 *     di lunghezza vince Allow. `Crawl-delay` del gruppo applicabile.
 *  2. Il sito vieta questo path a un agente AI di input (ClaudeBot, GPTBot …)
 *     o dichiara `Content-Signal: ai-input=no`? Se si', la fonte NON si usa
 *     nemmeno con un user agent onesto diverso: il divieto e' rivolto al tipo
 *     di uso, non alla stringa. Niente UA camuffato (D10).
 *
 * Esito del fetch di robots.txt (RFC 9309 §2.3.1): 2xx → si applica; 4xx →
 * nessuna restrizione; 5xx o rete → «unreachable», trattato come divieto
 * completo per questo giro.
 */

/** @returns {{ groups: { agents: string[], rules: { allow: boolean, path: string }[], crawlDelay: number|null }[], contentSignals: string[] }} */
export function parseRobotsTxt(text) {
  const groups = [];
  const contentSignals = [];
  let current = null;
  let lastWasAgent = false;
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [], crawlDelay: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (key === 'content-signal') {
      contentSignals.push(value);
      continue;
    }
    if (!current) continue;
    if (key === 'allow' || key === 'disallow') {
      // `Disallow:` vuoto = nessuna restrizione: non e' una regola.
      if (value === '' && key === 'disallow') continue;
      current.rules.push({ allow: key === 'allow', path: value });
    } else if (key === 'crawl-delay') {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) current.crawlDelay = n;
    }
  }
  return { groups, contentSignals };
}

function ruleMatches(rulePath, path) {
  // `*` = qualunque sequenza, `$` finale = fine del path.
  const anchored = rulePath.endsWith('$');
  const body = anchored ? rulePath.slice(0, -1) : rulePath;
  const re = new RegExp(`^${body.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}${anchored ? '$' : ''}`);
  return re.test(path);
}

/** Gruppi applicabili a un token agente: quelli che lo nominano, altrimenti `*`. */
function groupsFor(parsed, agentToken) {
  const token = agentToken.toLowerCase();
  const named = parsed.groups.filter((g) => g.agents.some((a) => a !== '*' && a === token));
  if (named.length) return named;
  return parsed.groups.filter((g) => g.agents.includes('*'));
}

/** Path + query come lo confronta robots.txt. */
const robotsPath = (url) => {
  const u = new URL(url);
  return `${u.pathname}${u.search}`;
};

/**
 * @returns {{ allowed: boolean, rule: string|null, crawlDelay: number|null }}
 */
export function isAllowed(parsed, agentToken, url) {
  const groups = groupsFor(parsed, agentToken);
  const path = robotsPath(url);
  let best = null;
  for (const g of groups) {
    for (const r of g.rules) {
      if (!ruleMatches(r.path, path)) continue;
      const len = r.path.replace(/[*$]/g, '').length;
      if (!best || len > best.len || (len === best.len && r.allow && !best.allow)) best = { ...r, len, agents: g.agents };
    }
  }
  const crawlDelay = groups.reduce((acc, g) => (g.crawlDelay != null ? Math.max(acc ?? 0, g.crawlDelay) : acc), null);
  if (!best || best.allow) return { allowed: true, rule: null, crawlDelay };
  return { allowed: false, rule: `User-agent: ${best.agents.join(', ')} -> Disallow: ${best.path}`, crawlDelay };
}

/**
 * La fonte e' vietata agli agenti AI di input? Solo i gruppi che NOMINANO
 * esplicitamente uno di quegli agenti contano: un `Disallow` per `*` e' gia'
 * coperto dalla domanda 1.
 * @returns {string|null} la regola esatta, o null
 */
export function aiInputBlock(parsed, aiAgents, url) {
  for (const s of parsed.contentSignals) {
    if (/ai-input\s*=\s*no/i.test(s)) return `Content-Signal: ${s}`;
  }
  const path = robotsPath(url);
  for (const agent of aiAgents) {
    const token = agent.toLowerCase();
    const named = parsed.groups.filter((g) => g.agents.includes(token));
    if (!named.length) continue;
    const verdict = isAllowed({ groups: named, contentSignals: [] }, token, url);
    if (!verdict.allowed) return verdict.rule ?? `User-agent: ${agent} -> Disallow (${path})`;
  }
  return null;
}

/**
 * Esito di una risposta robots.txt secondo RFC 9309.
 * @returns {{ state: 'parsed'|'absent'|'unreachable', parsed: ReturnType<typeof parseRobotsTxt> }}
 */
export function robotsFromResponse(status, text) {
  if (status >= 200 && status < 300) {
    // Un 200 che e' una pagina HTML (CMS che risponde a tutto) non e' un robots.txt.
    if (/^\s*<(?:!doctype|html)/i.test(String(text ?? ''))) return { state: 'absent', parsed: parseRobotsTxt('') };
    return { state: 'parsed', parsed: parseRobotsTxt(text) };
  }
  if (status >= 400 && status < 500) return { state: 'absent', parsed: parseRobotsTxt('') };
  return { state: 'unreachable', parsed: parseRobotsTxt('User-agent: *\nDisallow: /') };
}
