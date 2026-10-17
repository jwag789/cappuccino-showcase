/**
 * The progress and result shapes a sync reports.
 *
 * Trimmed for this repository: the full module also carries the per-provider
 * target schemas and the sync scheduler's types, which live with the
 * connectors in the private codebase.
 */

export type SyncProgress =
  | { phase: "fetching"; detail: string }
  | { phase: "storing"; detail: string }
  | { phase: "extracting"; done: number; total: number }
  | { phase: "detecting"; detail: string }
  | { phase: "done"; result: SyncResult };

export type OnSyncProgress = (event: SyncProgress) => void;

export type SyncResult = {
  /** Units of the provider's own shape: channels, repos, projects, files. */
  sources: number;
  /** Artifacts written this run. */
  items: number;
  conflictsDetected: number;
  errors: string[];
  notes: string[];
};
