/**
 * herdr-omp-lens — public barrel.
 *
 * Later tasks own the real modules:
 *   - src/protocol  (task 2: wire protocol types & codecs)
 *   - src/herdr     (task 3: herdr pane/session client)
 *   - src/extension (task 4+: OMP extension entry, bound via
 *     package.json `omp.extensions` → ./src/extension/index.ts)
 *
 * Task 1 ships only the scaffold; this file intentionally exports
 * nothing so downstream tasks add their re-exports here.
 */

export {};
