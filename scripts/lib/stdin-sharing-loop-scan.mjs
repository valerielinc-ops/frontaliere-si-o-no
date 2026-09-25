/**
 * Scanner for the #7392–#7505 class of bug: a `while … read` loop fed by a
 * plain-file redirect (or a here-string) makes that list the loop's stdin, and
 * every external command in the body inherits it. Whatever one of them reads
 * is a line the next `read` never sees, so the loop stops early and reports a
 * normal-looking success. A dedicated fd (`read -r -u 9` … `done 9< …`) makes
 * the consumption impossible by construction.
 *
 * The regexes live here, not in a test file, because there is more than one
 * tree to watch — `.github/**` and `scripts/**` — and two hand-copied scanners
 * would drift exactly the way the eight copies of the artifact resolve did.
 * #7716 already spent two review rounds on regexes that measured less than
 * they claimed (`CONSUMERS` without `m`, a lookahead annulled by backtracking,
 * a token list missing `npm`/`bash`/`sh`, a command position blind to an
 * assignment prefix); a single shared implementation is what keeps a later
 * repair of one of them from leaving the other half-blind.
 */

/**
 * A command can be preceded by env assignments (and by `env`) — the shape that
 * hid the ninth site, `(NODE_OPTIONS="…" npm run "$script")`.
 */
const ASSIGN_PREFIX = String.raw`(?:env[ \t]+)?(?:[A-Za-z_]\w*=(?:"[^"\n]*"|'[^'\n]*'|[^ \t\n]*)[ \t]+)*`;

/**
 * Commands that CAN consume stdin. `npm run X` spawns node with OUR stdin and
 * `bash`/`sh` inherit it by definition, so they sit next to `gh`/`node`.
 * Commands that take their input from arguments — `cat "$log"`, `cp`, `mkdir`,
 * `find`, `jq … "$file"` — are safe by construction and stay out.
 */
export const CONSUMER_TOKENS = [
  'gh',
  'unzip',
  'node',
  'npx',
  'npm',
  'bash',
  'sh',
  'ssh',
  'curl',
  'xargs',
  'git',
];

/**
 * `m` is load-bearing: without it `^` only matches the start of the whole body
 * and a consumer on a line of its own — the commonest shape of all — never
 * matches.
 */
export function consumersRe() {
  return new RegExp(
    String.raw`(^|[;&|(]|\bthen\b|\bdo\b|\belse\b)[ \t]*${ASSIGN_PREFIX}(${CONSUMER_TOKENS.join('|')})\b`,
    'm',
  );
}

/**
 * `while …` line, body, and a `done` at the SAME indentation whose redirect is
 * a plain file or a here-string, not a process substitution (`< <(…)`, left
 * alone: same defect, same fix, but none of the current ones has a consumer in
 * the body). The lookahead sits right after the redirect operator and swallows
 * the spacing ITSELF — `<[ \t]*(?!\()` lets the engine backtrack `[ \t]*` to
 * zero and pass on the space — and it refuses the `<` of the substitution, not
 * the `(`, because after the operator of `done < <(…)` comes `<`.
 */
export function loopRe() {
  return /^([ \t]*)while\b[^\n]*\bread\b[^\n]*\n([\s\S]*?)^\1done[ \t]+(\d*)<(?![ \t]*<?\()[^\n]*$/gm;
}

/**
 * Whole-line comments removed. The comments in these files QUOTE the very
 * anti-pattern being looked for, to explain what it replaced; matching on them
 * would make every check self-fulfilling.
 */
export function stripShellComments(source) {
  return source.replace(/^[ \t]*#.*$/gm, '');
}

/** Every file-fed `while … read` loop in one source, with its verdict. */
export function scanLoops(source) {
  const src = stripShellComments(source);
  const consumers = consumersRe();
  const loops = [];
  for (const m of src.matchAll(loopRe())) {
    const [, , body, fd] = m;
    const head = m[0].slice(0, m[0].indexOf('\n')).trim();
    loops.push({
      head,
      fd,
      hasConsumer: consumers.test(body),
      // A loop is isolated only when the `done` redirect names an fd AND the
      // `read` actually reads from it: `done 9< f` with a bare `read` still
      // reads fd 0.
      isolated: Boolean(fd) && new RegExp(`read\\b[^\\n]*-u[ \\t]+${fd}\\b`).test(head),
    });
  }
  return loops;
}

/**
 * Scan a list of files. Returns every loop seen (so a caller can assert the
 * scan is not vacuously empty — a silently-zero scanner is how three of the
 * sites in #7716 stayed invisible) and the offenders among them.
 */
export function scanFiles(files, readSource) {
  const loops = [];
  const offenders = [];
  for (const file of files) {
    for (const loop of scanLoops(readSource(file))) {
      loops.push({ file, ...loop });
      if (loop.hasConsumer && !loop.isolated) {
        offenders.push(`${file}: ${loop.head} … done ${loop.fd}<`);
      }
    }
  }
  return { loops, offenders };
}
