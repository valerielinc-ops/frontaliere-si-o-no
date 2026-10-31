/** The same permission profile is exercised before auth and used by the broker. */
export function brokerPermissionConfig({ platform = process.platform } = {}) {
  // Codex 0.153.4 :minimal adds Darwin Process platform scratch allows. Real
  // glob denies are necessary; :root/:tmpdir carve-outs do not override them.
  const darwinScratch = platform === 'darwin'
    ? '\n"/tmp/**" = "deny"\n"/private/tmp/**" = "deny"\n"/var/tmp/**" = "deny"\n"/private/var/tmp/**" = "deny"\n' : '';
  return `default_permissions = "codex-luna-max"

[permissions.codex-luna-max]
description = "Read-only Codex primary in an empty temporary workspace"
extends = ":read-only"

[permissions.codex-luna-max.network]
enabled = false

[permissions.codex-luna-max.filesystem]
":root" = "deny"
":minimal" = "read"
":tmpdir" = "deny"${darwinScratch}

[permissions.codex-luna-max.filesystem.":workspace_roots"]
"." = "read"
`;
}
