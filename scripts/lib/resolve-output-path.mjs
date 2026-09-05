/**
 * resolve-output-path.mjs
 *
 * Risolve il percorso di scrittura di uno script che ha un default TRACCIATO
 * nel repo e un override d'ambiente pensato come via d'uscita per i test.
 *
 * Perche' esiste (issue #7291, item 2 — reviewer adversarial check su #7281):
 * un override cosi' e' una via di scrittura FUORI dal repo che non lascia
 * traccia. Se una variabile del genere finisce nell'environment di un cron —
 * `scripts/load-rc-env.mjs` inietta chiavi da Remote Config prima degli step
 * successivi, e un `export` residuo nella shell di uno sviluppatore fa lo
 * stesso — il job continua verde, `git add <file tracciato>` non trova
 * modifiche, e il dato consumato dal build resta fermo: drift silenzioso.
 *
 * Due proprieta', entrambe necessarie:
 *   1. il percorso risolto viene SEMPRE loggato, override o no — cosi' una
 *      redirezione e' leggibile nel log del job invece che invisibile;
 *   2. in CI l'override e' onorato solo con un opt-in esplicito
 *      (`<ENV_VAR>_ALLOW_CI=1`). Senza, si scrive il percorso canonico e si
 *      logga un warning. Il default e' fail-safe: il file tracciato del cron
 *      si aggiorna comunque, e chi ha davvero bisogno del redirect in CI —
 *      la suite — lo dichiara.
 *
 * Nota: NON si applica agli override che sono un contratto di produzione
 * legittimo (es. `SLUG_REGISTRY_PATH_OVERRIDE`, letto anche da
 * `scripts/lib/dedicated-crawler-common.mjs` come path del registry, non come
 * scappatoia di test): li' ignorare l'override in CI cambierebbe il
 * comportamento voluto.
 */
import path from 'node:path';

/** Percorso leggibile: relativo a `root` se ci sta dentro, altrimenti assoluto. */
export function describePath(root, target) {
  const rel = path.relative(root, target);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : target;
}

/** Nome della variabile di opt-in associata a un override. */
export function allowInCiVar(envVar) {
  return `${envVar}_ALLOW_CI`;
}

/**
 * @param {object} o
 * @param {string} o.label            prefisso di log dello script chiamante
 * @param {string} o.envVar           nome della variabile di override
 * @param {string} o.canonicalPath    default (assoluto o relativo a `root`)
 * @param {string} o.root             root del repo
 * @param {NodeJS.ProcessEnv} [o.env]
 * @param {(msg: string) => void} [o.log]
 * @param {(msg: string) => void} [o.warn]
 * @returns {string} percorso assoluto su cui scrivere
 */
export function resolveOutputPath({
  label,
  envVar,
  canonicalPath,
  root,
  env = process.env,
  log = console.log,
  warn = console.warn,
}) {
  const canonical = path.resolve(root, canonicalPath);
  const override = String(env[envVar] ?? '').trim();

  if (!override) {
    log(`[${label}] percorso: ${describePath(root, canonical)}`);
    return canonical;
  }

  const allowVar = allowInCiVar(envVar);
  if (env.CI && env[allowVar] !== '1') {
    warn(
      `[${label}] ${envVar}=${override} IGNORATO in CI (manca ${allowVar}=1): `
      + `scrivo il percorso canonico ${describePath(root, canonical)}`,
    );
    return canonical;
  }

  const resolved = path.resolve(root, override);
  log(
    `[${label}] percorso REDIRETTO da ${envVar}: ${describePath(root, resolved)} `
    + `— il percorso canonico ${describePath(root, canonical)} non viene toccato`,
  );
  return resolved;
}
