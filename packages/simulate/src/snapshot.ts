import type { ParsedDecision } from "../../cds/src/validate.js";

export type MetricKey = "unit_price" | "unit_cost" | "volume";

export type MetricValue = {
  value?: number;
  // provenance of the value (baseline observation)
  from_observation_id?: string;
  // change ids that contribute to this metric after partial-override logic
  applied_change_ids: string[];
};

export type ItemSnapshot = {
  item_id: string;
  metrics: Record<MetricKey, MetricValue>;
};

export type SkippedChange = {
  change_id: string;
  reason:
    | "NO_EFFECTIVE_WINDOW"
    | "OUTSIDE_DECISION_HORIZON"
    | "INVALID_EFFECTIVE_TIME"
    | "MISSING_DECISION_HORIZON"
    | "UNSUPPORTED_CHANGE_TYPE"
    | "UNSUPPORTED_TARGET";
};

export type AppliedChange = {
  change_id: string;
  item_id: string;
  metric: MetricKey;
  active_fraction: number; // 0..1
  overlap: { start: string; end: string };
  horizon: { start: string; end: string };
};

export type OverriddenChange = {
  change_id: string;
  overridden_by: string;
  metric: MetricKey;
  item_id: string;
  override_fraction: number; // 0..1 (fraction of horizon overridden by overridden_by)
};

export type DecisionSnapshots = {
  baseline: ItemSnapshot[];
  simulated: ItemSnapshot[];
  skipped_changes: SkippedChange[];
  applied_changes: AppliedChange[];
  overridden_changes: OverriddenChange[];
};

export function buildDecisionSnapshots(d: ParsedDecision): DecisionSnapshots {
  const baseline = buildBaselineSnapshot(d);
  const { simulated, skipped_changes, applied_changes, overridden_changes } =
    applyChangeSetsWithTimeGatingV4(d, baseline);
  return { baseline, simulated, skipped_changes, applied_changes, overridden_changes };
}

/* ----------------------------- Baseline ----------------------------- */

function buildBaselineSnapshot(d: ParsedDecision): ItemSnapshot[] {
  const itemIds = [...new Set(d.baseline.items.map((i) => i.item_id))].sort((a, b) =>
    a.localeCompare(b)
  );

  const p = latestObsByItem(d, "UNIT_PRICE");
  const c = latestObsByItem(d, "UNIT_COST");
  const v = latestObsByItem(d, "VOLUME");

  return itemIds.map((item_id) => ({
    item_id,
    metrics: {
      unit_price: {
        value: p.get(item_id)?.value,
        from_observation_id: p.get(item_id)?.obs_id,
        applied_change_ids: [],
      },
      unit_cost: {
        value: c.get(item_id)?.value,
        from_observation_id: c.get(item_id)?.obs_id,
        applied_change_ids: [],
      },
      volume: {
        value: v.get(item_id)?.value,
        from_observation_id: v.get(item_id)?.obs_id,
        applied_change_ids: [],
      },
    },
  }));
}

function latestObsByItem(
  d: ParsedDecision,
  metric: "UNIT_PRICE" | "UNIT_COST" | "VOLUME"
): Map<string, { value: number; obs_id: string }> {
  const m = new Map<string, { t: number; value: number; obs_id: string }>();

  for (const o of d.baseline.observations) {
    if (o.metric !== metric) continue;
    const item_id = o.dims.item_id;
    if (!item_id) continue;

    const t = Date.parse(o.time);
    if (Number.isNaN(t)) continue;

    const prev = m.get(item_id);
    if (!prev || t >= prev.t) {
      m.set(item_id, { t, value: o.value, obs_id: o.obs_id });
    }
  }

  const out = new Map<string, { value: number; obs_id: string }>();
  for (const [k, vv] of m.entries()) out.set(k, { value: vv.value, obs_id: vv.obs_id });
  return out;
}

/* ---------------------------- Simulation ---------------------------- */

function applyChangeSetsWithTimeGatingV4(
  d: ParsedDecision,
  baseline: ItemSnapshot[]
): {
  simulated: ItemSnapshot[];
  skipped_changes: SkippedChange[];
  applied_changes: AppliedChange[];
  overridden_changes: OverriddenChange[];
} {
  const sim: ItemSnapshot[] = baseline.map((row) => ({
    item_id: row.item_id,
    metrics: {
      unit_price: {
        ...row.metrics.unit_price,
        applied_change_ids: [...row.metrics.unit_price.applied_change_ids],
      },
      unit_cost: {
        ...row.metrics.unit_cost,
        applied_change_ids: [...row.metrics.unit_cost.applied_change_ids],
      },
      volume: {
        ...row.metrics.volume,
        applied_change_ids: [...row.metrics.volume.applied_change_ids],
      },
    },
  }));

  const index = new Map(sim.map((r) => [r.item_id, r]));
  const skipped_changes: SkippedChange[] = [];
  const applied_changes: AppliedChange[] = [];
  const overridden_changes: OverriddenChange[] = [];

  const hzStartStr = d.horizon?.start ?? "";
  const hzEndStr = d.horizon?.end ?? "";
  const hzStart = Date.parse(hzStartStr);
  const hzEnd = Date.parse(hzEndStr);
  const hasHorizon = Number.isFinite(hzStart) && Number.isFinite(hzEnd) && hzStart <= hzEnd;

  for (const cs of d.change_set) {
    if (cs.target.scope !== "ITEM") {
      skipped_changes.push({ change_id: cs.change_id, reason: "UNSUPPORTED_TARGET" });
      continue;
    }

    const metricKey: MetricKey | null =
      cs.type === "PRICE_CHANGE"
        ? "unit_price"
        : cs.type === "COST_CHANGE"
        ? "unit_cost"
        : cs.type === "VOLUME_CHANGE"
        ? "volume"
        : null;

    if (!metricKey) {
      skipped_changes.push({ change_id: cs.change_id, reason: "UNSUPPORTED_CHANGE_TYPE" });
      continue;
    }

    const item_id = cs.target.item_id;
    if (!item_id) continue;

    const row = index.get(item_id);
    if (!row) continue;

    const metric = row.metrics[metricKey];
    const cur = metric.value;

    // Gate: if horizon missing, we apply fully (legacy) but record the problem.
    const gate = hasHorizon
      ? computeGateFraction(cs, hzStart, hzEnd)
      : {
          fraction: 1,
          overlapStart: hzStart,
          overlapEnd: hzEnd,
          reasonIfZero: null as SkippedChange["reason"] | null,
          missingHorizon: true,
        };

    if (!hasHorizon) {
      skipped_changes.push({ change_id: cs.change_id, reason: "MISSING_DECISION_HORIZON" });
    }

    if (gate.fraction <= 0) {
      skipped_changes.push({
        change_id: cs.change_id,
        reason: gate.reasonIfZero ?? "OUTSIDE_DECISION_HORIZON",
      });
      continue;
    }

    // record applied change (fraction-aware)
    applied_changes.push({
      change_id: cs.change_id,
      item_id,
      metric: metricKey,
      active_fraction: gate.fraction,
      overlap: {
        start: new Date(gate.overlapStart).toISOString(),
        end: new Date(gate.overlapEnd).toISOString(),
      },
      horizon: {
        start: new Date(hzStart).toISOString(),
        end: new Date(hzEnd).toISOString(),
      },
    });

    if (cur == null) {
      // can't apply numeric deltas without baseline value (v0 behavior)
      // but still keep traces above
      continue;
    }

    const f = gate.fraction;
    const delta = cs.delta;

    // ABSOLUTE: supports partial application by blending
    if (delta.kind === "ABSOLUTE") {
      // Mark all previously contributing changes as overridden by this ABSOLUTE for fraction f.
      for (const priorId of metric.applied_change_ids) {
        overridden_changes.push({
          change_id: priorId,
          overridden_by: cs.change_id,
          metric: metricKey,
          item_id,
          override_fraction: f,
        });
      }

      // For full ABSOLUTE, it fully replaces. For partial ABSOLUTE, both contribute.
      if (f >= 1) {
        metric.applied_change_ids = [cs.change_id];
        metric.value = delta.new_value;
      } else {
        // keep priors + add ABSOLUTE id (unique)
        metric.applied_change_ids = uniq([...metric.applied_change_ids, cs.change_id]);
        metric.value = cur * (1 - f) + delta.new_value * f;
      }
      continue;
    }

    // Non-ABSOLUTE: fraction-aware application
    metric.applied_change_ids.push(cs.change_id);

    let next: number = cur;

    if (delta.kind === "RELATIVE") {
      // blend between cur and (cur*multiplier)
      next = cur * (1 - f) + cur * delta.multiplier * f;
    } else if (delta.kind === "ADD") {
      // apply only fraction of amount
      next = cur + delta.amount * f;
    } else {
      // unsupported delta kinds (for now)
      continue;
    }

    metric.value = next;
  }

  return { simulated: sim, skipped_changes, applied_changes, overridden_changes };
}

function uniq(xs: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of xs) {
    if (seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}

function computeGateFraction(
  cs: { effective?: { start?: string; end?: string } },
  hzStart: number,
  hzEnd: number
): {
  fraction: number;
  overlapStart: number;
  overlapEnd: number;
  reasonIfZero: SkippedChange["reason"] | null;
  missingHorizon: false;
} {
  const eff = cs.effective;
  if (!eff || !eff.start) {
    return {
      fraction: 0,
      overlapStart: hzStart,
      overlapEnd: hzStart,
      reasonIfZero: "NO_EFFECTIVE_WINDOW",
      missingHorizon: false,
    };
  }

  const eStart = Date.parse(eff.start);
  if (!Number.isFinite(eStart)) {
    return {
      fraction: 0,
      overlapStart: hzStart,
      overlapEnd: hzStart,
      reasonIfZero: "INVALID_EFFECTIVE_TIME",
      missingHorizon: false,
    };
  }

  const eEndRaw = eff.end ? Date.parse(eff.end) : Number.POSITIVE_INFINITY;
  const eEnd = Number.isFinite(eEndRaw) ? eEndRaw : Number.POSITIVE_INFINITY;

  const overlapStart = Math.max(eStart, hzStart);
  const overlapEnd = Math.min(eEnd, hzEnd);

  if (overlapEnd < overlapStart) {
    return {
      fraction: 0,
      overlapStart,
      overlapEnd: overlapStart,
      reasonIfZero: "OUTSIDE_DECISION_HORIZON",
      missingHorizon: false,
    };
  }

  const hzDur = hzEnd - hzStart;
  if (hzDur <= 0) {
    // degenerate horizon -> treat as full if overlaps
    return {
      fraction: 1,
      overlapStart,
      overlapEnd,
      reasonIfZero: null,
      missingHorizon: false,
    };
  }

  const overlapDur = overlapEnd - overlapStart;
  const fraction = overlapDur / hzDur;

  return {
    fraction: Math.max(0, Math.min(1, fraction)),
    overlapStart,
    overlapEnd,
    reasonIfZero: null,
    missingHorizon: false,
  };
}

