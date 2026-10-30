/** The same permission profile is exercised before auth and used by the broker. */
export function brokerPermissionConfig() {
  return `default_permissions = "codex-luna-max"

[permissions.codex-luna-max]
description = "Read-only Codex primary in an empty temporary workspace"
extends = ":read-only"

[permissions.codex-luna-max.network]
enabled = false

[permissions.codex-luna-max.filesystem]
":root" = "deny"
":minimal" = "read"
":tmpdir" = "deny"

[permissions.codex-luna-max.filesystem.":workspace_roots"]
"." = "read"
`;
}
