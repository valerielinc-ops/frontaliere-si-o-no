// Shared dist walker of the D.5 page audits (meta-description, title, schema,
// internal-link). Each script used to carry the same literal `walkHtml`, which
// built an array of every absolute path before reading a page: ~950 B per
// `path.join` cons-string, ~5.9 GB for the 6.3M files of the reassembled
// corpus — where report:meta-description died `Reached heap limit` at 4 GB
// (replay 40068012243). This yields one path at a time; the stack holds one
// frame per OPEN directory with the NAMES of its subdirectories still to visit.
import { existsSync, readdirSync } from 'node:fs';

export function* walkHtml(dir) {
  if (!existsSync(dir)) return;
  const stack = [{ path: dir, subdirs: null }];
  while (stack.length) {
    const top = stack[stack.length - 1];
    if (top.subdirs === null) {
      let entries;
      try { entries = readdirSync(top.path, { withFileTypes: true }); } catch { entries = []; }
      top.subdirs = [];
      for (const e of entries) {
        if (e.isDirectory()) {
          if (e.name === 'assets' || e.name === 'node_modules') continue;
          top.subdirs.push(e.name);
        } else if (e.isFile() && e.name.endsWith('.html')) {
          yield `${top.path}/${e.name}`;
        }
      }
      top.subdirs.reverse();
    }
    const next = top.subdirs.pop();
    if (next === undefined) stack.pop();
    else stack.push({ path: `${top.path}/${next}`, subdirs: null });
  }
}
