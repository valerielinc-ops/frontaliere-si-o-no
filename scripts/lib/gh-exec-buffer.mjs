// Synchronous GitHub CLI reads include paginated API responses and issue
// bodies. Keep one shared bound comfortably above the former 1 MiB default.
export const GH_EXEC_MAX_BUFFER = 64 * 1024 * 1024;
