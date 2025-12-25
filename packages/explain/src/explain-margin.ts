import type { ParsedDecision } from "../../cds/src/validate.js";
import type { DecisionSnapshots } from "../../simulate/src/snapshot.js";
import type { MarginImpactRow } from "../../compute/src/margins.js";

export type ExplanationLine = {
  kind: "INPUT" | "CHANGE" | "COMPUTE" | "RESULT" | "NOTE";
  text: string;
};

export type MarginExplanation = {
  item_id: string;
  lines: ExplanationLine[];
};

export function explainMarginImpact(
  d: ParsedDecision,
  s: DecisionSnapshots,
  rows: MarginImpactRow[]
): MarginExplanation[] {
  const baseByItem = new Map(s.baseline.map((x) => [x.item_id, x]));
  const simByItem = new Map(s.simulated.map((x) => [x.item_id, x]));
  const changeById = new Map(d.change_set.map((c) => [c.change_id, c]));
  const obsById = new Map(d.baseline.observations.map((o) => [o.obs_id, o]));

  return rows.map((r) => {
    const lines: ExplanationLine[] = [];
    const b = baseByItem.get(r.item_id);
    const sim = simByItem.get(r.item_id);

    // ---- Inputs
    lines.push({
      kind: "INPUT",
      text: `Baseline UNIT_PRICE = ${fmt(r.baseline_unit_price)} (obs ${r.trace.used_observations.unit_price ?? "?"})`,
    });
    lines.push({
      kind: "INPUT",
      text: `Baseline UNIT_COST = ${fmt(r.baseline_unit_cost)} (obs ${r.trace.used_observations.unit_cost ?? "?"})`,
    });
    lines.push({
      kind: "INPUT",
      text: `Baseline VOLUME = ${fmt(r.baseline_volume)} (obs ${r.trace.used_observations.volume ?? "?"})`,
    });

    // ---- Quality warnings (deterministic thresholds)
    addQualityLines(lines, obsById, "UNIT_PRICE", r.trace.used_observations.unit_price);
    addQualityLines(lines, obsById, "UNIT_COST", r.trace.used_observations.unit_cost);
    addQualityLines(lines, obsById, "VOLUME", r.trace.used_observations.volume);

    // ---- Changes (deterministic order by change_id)
    const applied = [...r.trace.applied_change_ids].sort((a, b) => a.localeCompare(b));
    for (const cid of applied) {
      const cs = changeById.get(cid);
      if (!cs) {
        lines.push({ kind: "CHANGE", text: `Applied change ${cid} (details missing in decision.change_set)` });
        continue;
      }
      const target = cs.target.scope === "ITEM" ? `ITEM:${cs.target.item_id}` : cs.target.scope;
      lines.push({
        kind: "CHANGE",
        text: `Applied ${cs.type} ${cs.change_id} on ${target}: ${deltaText(cs.delta)}`,
      });
    }

    // ---- Snapshot values used for compute (truth source)
    const sp = sim?.metrics.unit_price.value ?? b?.metrics.unit_price.value;
    const sc = sim?.metrics.unit_cost.value ?? b?.metrics.unit_cost.value;
    const sv = sim?.metrics.volume.value ?? b?.metrics.volume.value;

    lines.push({
      kind: "COMPUTE",
      text: `Simulated snapshot values: price=${fmt(sp)}, cost=${fmt(sc)}, volume=${fmt(sv)}`,
    });

    // ---- Computation formula
    lines.push({
      kind: "COMPUTE",
      text: `Baseline total margin = (price - cost) * volume = (${fmt(r.baseline_unit_price)} - ${fmt(r.baseline_unit_cost)}) * ${fmt(r.baseline_volume)} = ${fmt(r.baseline_total_margin)}`,
    });
    lines.push({
      kind: "COMPUTE",
      text: `Simulated total margin = (price - cost) * volume = (${fmt(r.simulated_unit_price)} - ${fmt(sc)}) * ${fmt(sv)} = ${fmt(r.simulated_total_margin)}`,
    });
    lines.push({
      kind: "RESULT",
      text: `Delta total margin = ${fmt(r.delta_total_margin)}`,
    });

    // ---- Notes from compute
    for (const n of r.notes) lines.push({ kind: "NOTE", text: n });

    return { item_id: r.item_id, lines };
  });
}

function addQualityLines(
  lines: ExplanationLine[],
  obsById: Map<string, any>,
  metricLabel: "UNIT_PRICE" | "UNIT_COST" | "VOLUME",
  obsId: string | undefined
) {
  if (!obsId) return;
  const o = obsById.get(obsId);
  if (!o || !o.quality) return;

  const staleness = o.quality.staleness_days;
  const completeness = o.quality.completeness;

  // Staleness thresholds (deterministic)
  if (typeof staleness === "number") {
    if (staleness > 30) {
      lines.push({ kind: "NOTE", text: `WARN: ${metricLabel} obs ${obsId} is stale (${staleness} days old)` });
    } else if (staleness > 7) {
      lines.push({ kind: "NOTE", text: `NOTE: ${metricLabel} obs ${obsId} is ${staleness} days old` });
    }
  }

  // Completeness thresholds (deterministic)
  if (typeof completeness === "number") {
    if (completeness < 0.8) {
      lines.push({ kind: "NOTE", text: `WARN: ${metricLabel} obs ${obsId} completeness is low (${completeness})` });
    } else if (completeness < 1) {
      lines.push({ kind: "NOTE", text: `NOTE: ${metricLabel} obs ${obsId} completeness is ${completeness}` });
    }
  }
}

function fmt(n: number | undefined): string {
  return n == null ? "null" : Number.isFinite(n) ? String(n) : "NaN";
}

function deltaText(delta: any): string {
  if (!delta || typeof delta !== "object") return "unknown";
  if (delta.kind === "RELATIVE") return `RELATIVE x${delta.multiplier}`;
  if (delta.kind === "ABSOLUTE") return `ABSOLUTE => ${delta.new_value}`;
  if (delta.kind === "ADD") return `ADD ${delta.amount >= 0 ? "+" : ""}${delta.amount}`;
  if (delta.kind === "SET_CATEGORY") return `SET_CATEGORY => ${delta.value}`;
  return `kind=${String(delta.kind)}`;
}

