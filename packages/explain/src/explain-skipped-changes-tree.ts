import type { ParsedDecision } from "../../cds/src/validate.js";
import type { DecisionSnapshots } from "../../simulate/src/snapshot.js";
import type { ExplainTree } from "./tree.js";

type ChangeRow = ExplainTree["changes"][number];
type ChangePatch = Partial<Omit<ChangeRow, "change_id" | "type" | "target" | "delta">>;

export function attachSkippedChangesToTrees(
  d: ParsedDecision,
  snaps: DecisionSnapshots,
  trees: ExplainTree[]
): ExplainTree[] {
  const byItem = new Map(trees.map((t) => [t.item_id, t]));
  const changeById = new Map(d.change_set.map((c) => [c.change_id, c]));

  function addNote(item_id: string | null, note: string) {
    if (item_id) {
      const t = byItem.get(item_id);
      if (t) {
        t.notes.push(note);
        return;
      }
    }
    if (trees.length > 0) trees[0]!.notes.push(note);
  }

  function upsertChange(item_id: string, change_id: string, patch: ChangePatch) {
    const t = byItem.get(item_id);
    if (!t) return;

    const idx = t.changes.findIndex((c) => c.change_id === change_id);
    if (idx >= 0) {
      const prev = t.changes[idx]!;
      t.changes[idx] = {
        ...prev,
        ...patch,
        change_id: prev.change_id,
        type: prev.type,
        target: prev.target,
        delta: prev.delta,
      };
    } else {
      const cs = changeById.get(change_id);
      const type = cs?.type ?? "UNKNOWN_TYPE";
      const target =
        cs?.target?.scope === "ITEM" && cs.target.item_id
          ? `ITEM:${cs.target.item_id}`
          : cs?.target?.scope ?? "UNKNOWN_TARGET";

      t.changes.push({
        change_id,
        type,
        target,
        delta: cs?.delta ?? { kind: "UNKNOWN" },
        ...patch,
      });
    }

    t.changes.sort((a, b) => a.change_id.localeCompare(b.change_id));
  }

  /* ---------- time-gating skips ---------- */

  const skipped = [...(snaps.skipped_changes ?? [])].sort((a, b) =>
    a.change_id.localeCompare(b.change_id)
  );

  for (const sc of skipped) {
    const cs = changeById.get(sc.change_id);

    const item_id =
      cs?.target?.scope === "ITEM" && cs.target.item_id ? cs.target.item_id : null;

    const effStart = cs?.effective?.start ?? "unknown";
    const effEnd = cs?.effective?.end ?? "open";

    const type = cs?.type ?? "UNKNOWN_TYPE";
    const target =
      cs?.target?.scope === "ITEM" && cs.target.item_id
        ? `ITEM:${cs.target.item_id}`
        : cs?.target?.scope ?? "UNKNOWN_TARGET";

    addNote(
      item_id,
      `SKIPPED(time-gating): ${sc.change_id} (${type} ${target}) effective=[${effStart}..${effEnd}] reason=${sc.reason}`
    );

    if (item_id) {
      upsertChange(item_id, sc.change_id, {
        status: "SKIPPED",
        note: `Skipped: ${sc.reason}`,
      });
    }
  }

  /* ---------- overridden changes ---------- */

  const overridden = [...(snaps.overridden_changes ?? [])].sort((a, b) =>
    a.change_id.localeCompare(b.change_id)
  );

  for (const oc of overridden) {
    upsertChange(oc.item_id, oc.change_id, {
      status: "OVERRIDDEN",
      note: `Overridden by ABSOLUTE change ${oc.overridden_by}`,
    });
  }

  /* ---------- v7: attach meta.time_gating for all changes ---------- */

  attachTimeGatingMeta(d, trees);

  return trees;
}

/* ---------------------------- v7 helpers ---------------------------- */

function attachTimeGatingMeta(d: ParsedDecision, trees: ExplainTree[]) {
  const hzStart = Date.parse(d.horizon?.start ?? "");
  const hzEnd = Date.parse(d.horizon?.end ?? "");
  const hasHorizon = Number.isFinite(hzStart) && Number.isFinite(hzEnd) && hzStart < hzEnd;
  if (!hasHorizon) return;

  const hzStartIso = new Date(hzStart).toISOString();
  const hzEndIso = new Date(hzEnd).toISOString();
  const hzDur = hzEnd - hzStart;

  const changeById = new Map(d.change_set.map((c) => [c.change_id, c]));

  for (const t of trees) {
    for (const ch of t.changes) {
      const cs = changeById.get(ch.change_id);
      if (!cs?.effective?.start) continue;

      const eStart = Date.parse(cs.effective.start);
      if (!Number.isFinite(eStart)) continue;

      const eEndRaw =
        cs.effective.end != null ? Date.parse(cs.effective.end) : Number.POSITIVE_INFINITY;
      const eEnd = Number.isFinite(eEndRaw) ? eEndRaw : Number.POSITIVE_INFINITY;

      // overlap with horizon
      const oStart = Math.max(hzStart, eStart);
      const oEnd = Math.min(hzEnd, eEnd);

      if (!(oEnd > oStart)) {
        // no overlap => active_fraction = 0
        ch.meta = {
          ...(ch.meta ?? {}),
          time_gating: {
            active_fraction: 0,
            overlap: { start: hzStartIso, end: hzStartIso },
            horizon: { start: hzStartIso, end: hzEndIso },
          },
        };
        continue;
      }

      const af = (oEnd - oStart) / hzDur;

      ch.meta = {
        ...(ch.meta ?? {}),
        time_gating: {
          active_fraction: af,
          overlap: { start: new Date(oStart).toISOString(), end: new Date(oEnd).toISOString() },
          horizon: { start: hzStartIso, end: hzEndIso },
        },
      };
    }
  }
}
