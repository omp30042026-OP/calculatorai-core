// Canonical snapshot contract for the whole monorepo.
// Compute + Explain should depend on this, not ad-hoc shapes.

export type SnapshotMetric = "UNIT_PRICE" | "UNIT_COST" | "VOLUME";

export type SnapshotRow = {
  item_id: string;
  metric: SnapshotMetric;
  value: number | null;
  obs_id?: string;
  quality?: {
    staleness_days?: number;
    completeness?: number;
    source_system?: string;
  };
};

export type AppliedChangeRow = {
  item_id: string;
  change_id: string;
};

export type OverriddenChangeRow = {
  item_id: string;
  change_id: string;
  overridden_by: string;
};

export type SkippedChangeRow = {
  item_id: string;
  change_id: string;
  reason_code: string;
  note?: string;
};

export type DecisionSnapshots = {
  // per-item, per-metric rows (baseline)
  baseline: SnapshotRow[];
  // per-item, per-metric rows (simulated)
  simulated: SnapshotRow[];

  // bookkeeping
  applied_changes: AppliedChangeRow[];
  overridden_changes: OverriddenChangeRow[];
  skipped_changes: SkippedChangeRow[];
};
