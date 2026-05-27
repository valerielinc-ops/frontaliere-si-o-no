#!/usr/bin/env bash
# Auto-resolve merge conflicts in append-only files used by the article
# generator (BlogArticles.tsx, router.ts, routerBlogData.ts, seoService.ts,
# sitemaps, blog-meta-*.ts, article-source-urls.json, blog-articles-data.ts).
#
# When the article generator and a concurrent main writer both append at the
# same insertion point, git marks the spot as a conflict; both additions are
# valid and must be kept. This helper:
#   1. Strips conflict markers, keeping content from BOTH sides.
#   2. Repairs JSON files that lose commas during marker removal.
#   3. Dedupes single-declaration conflicts in routerBlogData.ts and router.ts
#      (`export const ALL_BLOG_ARTICLE_IDS = [...]`, `type _BlogId<N> = …`).
#   4. Validates blog-articles-data.ts for duplicate / merged article entries.
#
# Usage (sourced — preferred so the function is in scope of the caller):
#   source scripts/lib/resolve-append-conflicts.sh
#   resolve_append_conflicts && git add -A
#
# Usage (standalone):
#   bash scripts/lib/resolve-append-conflicts.sh
# Exit code 0 = all conflicts resolved; 1 = at least one file could not be
# auto-resolved (caller should defer / abort).

resolve_append_conflicts() {
  local CONFLICTED
  CONFLICTED=$(git diff --name-only --diff-filter=U 2>/dev/null || true)
  if [ -z "$CONFLICTED" ]; then
    return 0  # No conflicts
  fi

  echo "🔧 Auto-resolving conflicts in append-only files..."
  local ALL_RESOLVED=true

  while IFS= read -r file; do
    [ -z "$file" ] && continue

    if ! grep -q '<<<<<<<' "$file" 2>/dev/null; then
      echo "  ⚠️  $file: no conflict markers found, skipping"
      ALL_RESOLVED=false
      continue
    fi

    # Remove conflict markers, keeping BOTH sides.
    # Works for append-only files where both sides added new entries.
    sed -i 's/^<<<<<<< .*$//' "$file"
    sed -i '/^=======$/d' "$file"
    sed -i 's/^>>>>>>> .*$//' "$file"

    # Remove blank lines left by marker removal (max 2 consecutive)
    sed -i '/^$/N;/^\n$/d' "$file"

    # Verify no conflict markers remain
    if grep -q '<<<<<<<\|>>>>>>>' "$file" 2>/dev/null; then
      echo "  ❌ $file: conflict markers still present after resolution"
      ALL_RESOLVED=false
      continue
    fi

    # Basic syntax check for JSON files
    if [[ "$file" == *.json ]]; then
      if ! node -e "JSON.parse(require('fs').readFileSync('$file','utf8'))" 2>/dev/null; then
        echo "  ⚠️  $file: JSON syntax error after resolution — attempting fix..."
        # After removing conflict markers, common issues include:
        # - Missing comma between entries ("value"\n  "key")
        # - Duplicate commas (,\n,)
        # - Trailing comma before closing bracket
        # - Missing comma between nested objects (}\n  {)
        # - Duplicate keys (both sides added at same insertion point)
        node -e "
          const fs = require('fs');
          let s = fs.readFileSync('$file','utf8');
          // Fix double commas
          s = s.replace(/,(\s*),/g, ',\$1');
          // Fix trailing comma before closing bracket/brace
          s = s.replace(/,(\s*[}\]])/g, '\$1');
          // Fix missing comma between entries: \"value\"\\n  \"key\"
          s = s.replace(/(\"[^\"]*\"|true|false|null|\d+(?:\.\d+)?|\}|\])(\s*\n\s*)(\")/g, '\$1,\$2\$3');
          // Fix missing comma between } or ] and next { or [
          s = s.replace(/(\}|\])(\s*\n\s*)(\{|\[)/g, '\$1,\$2\$3');
          try {
            const obj = JSON.parse(s);
            fs.writeFileSync('$file', JSON.stringify(obj, null, 2) + '\n');
            console.log('  ✅ $file: JSON fixed and formatted');
          } catch(e) {
            console.log('  ❌ $file: JSON still invalid — ' + e.message);
            process.exit(1);
          }
        " 2>/dev/null
        if [ $? -ne 0 ]; then
          ALL_RESOLVED=false
          continue
        fi
      fi
    fi

    # Dedupe single-declaration conflicts in routerBlogData.ts and router.ts.
    # `export const ALL_BLOG_ARTICLE_IDS = [...]` and
    # `type _BlogId5 = '…' | …` are SINGLE declarations: when both sides modify
    # the same closing token, "keep both" produces two declarations with the
    # same name → esbuild fails with `Multiple exports with the same name`.
    # We merge the two sides into one declaration that contains the union of
    # every ID/literal mentioned.
    if [[ "$file" == *"routerBlogData.ts" ]] || [[ "$file" == *"router.ts" ]]; then
      if ! node -e "
        const fs = require('fs');
        const file = '$file';
        let src = fs.readFileSync(file, 'utf8');
        // Merge duplicate \`export const ALL_BLOG_ARTICLE_IDS = [...]\`
        const listRx = /export const ALL_BLOG_ARTICLE_IDS:[^=]+=\s*\[([^\]]+)\];/g;
        const listMatches = [...src.matchAll(listRx)];
        if (listMatches.length > 1) {
          const ids = new Set();
          for (const m of listMatches) {
            for (const id of m[1].matchAll(/'([^']+)'/g)) ids.add(id[1]);
          }
          const merged = [...ids].map((s) => \`'\${s}'\`).join(', ');
          const replacement = \`export const ALL_BLOG_ARTICLE_IDS: BlogArticleId[] = [\${merged}];\`;
          const first = listMatches[0];
          src = src.slice(0, first.index) + replacement + src.slice(first.index + first[0].length);
          src = src.replace(listRx, '');
          console.log('  🔁 Merged ' + listMatches.length + ' ALL_BLOG_ARTICLE_IDS declarations into one (' + ids.size + ' ids)');
        }
        // Merge duplicate \`type _BlogId<N> = '…' | …;\` declarations
        const typeRx = /type _BlogId(\d+) = (([^;])+);/g;
        const typeGroups = new Map();
        for (const m of src.matchAll(typeRx)) {
          const n = m[1];
          const literals = [...m[2].matchAll(/'([^']+)'/g)].map((x) => x[1]);
          if (!typeGroups.has(n)) typeGroups.set(n, []);
          typeGroups.get(n).push({ match: m[0], literals });
        }
        for (const [n, occurrences] of typeGroups) {
          if (occurrences.length <= 1) continue;
          const all = new Set();
          for (const occ of occurrences) for (const lit of occ.literals) all.add(lit);
          const mergedDecl = \`type _BlogId\${n} = \${[...all].map((s) => \`'\${s}'\`).join(' | ')};\`;
          src = src.replace(occurrences[0].match, mergedDecl);
          for (let i = 1; i < occurrences.length; i++) {
            src = src.replace(occurrences[i].match, '');
          }
          console.log('  🔁 Merged ' + occurrences.length + ' _BlogId' + n + ' declarations into one (' + all.size + ' literals)');
        }
        fs.writeFileSync(file, src);
      "; then
        echo "  ❌ $file: dedupe failed"
        ALL_RESOLVED=false
        continue
      fi
    fi

    # Syntax check for blog-articles-data.ts — detect merged entries
    # (FRO-328 moved ARTICLES array from BlogArticles.tsx to this file).
    if [[ "$file" == *"blog-articles-data.ts" ]]; then
      if ! node -e "
        const fs = require('fs');
        const src = fs.readFileSync('$file', 'utf8');
        const ids = [...src.matchAll(/^\s+id:\s*'([^']+)'/gm)].map(m => m[1]);
        const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
        if (dupes.length) {
          console.error('  ❌ $file: duplicate article IDs after conflict resolution: ' + dupes.join(', '));
          process.exit(1);
        }
        // Verify each id is inside its own object literal (not merged)
        const entryStarts = (src.match(/\{\s*\n\s+id:\s*'/g) || []).length;
        if (entryStarts !== ids.length) {
          console.error('  ❌ $file: ' + ids.length + ' ids but ' + entryStarts + ' entry blocks — merged entries detected');
          process.exit(1);
        }
        console.log('  ✅ $file: ' + ids.length + ' article entries validated (no duplicates)');
      " 2>&1; then
        echo "  ❌ $file: blog-articles-data.ts validation failed after conflict resolution"
        ALL_RESOLVED=false
        continue
      fi
    fi

    git add "$file"
    echo "  ✅ $file: resolved (both sides kept)"
  done <<< "$CONFLICTED"

  if [ "$ALL_RESOLVED" = true ]; then
    echo "✅ All conflicts auto-resolved"
    return 0
  else
    echo "❌ Some conflicts could not be auto-resolved"
    return 1
  fi
}

# When invoked directly (not sourced), run the function and propagate exit code.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  resolve_append_conflicts
fi
