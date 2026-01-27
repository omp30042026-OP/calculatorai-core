// examples/graph.ts
import fs from "node:fs";
import { SqliteDecisionStore } from "../packages/decision/src/sqlite-store.js";
import { buildDecisionDagPayload, oneClickAnswers } from "../packages/decision/src/decision-dag.js";

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  if (i === -1) return null;
  return process.argv[i + 1] ?? null;
}

function has(name: string): boolean {
  return process.argv.includes(name);
}

function dedupeEdges<T extends { edge_hash?: string; from_decision_id: string; to_decision_id: string; relation: string; via_event_seq: number }>(
  edges: T[]
): T[] {
  const m = new Map<string, T>();
  for (const e of edges) {
    const key =
      (typeof e.edge_hash === "string" && e.edge_hash.length)
        ? e.edge_hash
        : `${e.from_decision_id}::${e.to_decision_id}::${e.relation}::${e.via_event_seq}`;
    if (!m.has(key)) m.set(key, e);
  }
  return [...m.values()];
}

function sortEdges<T extends { from_decision_id: string; to_decision_id: string; relation: string; via_event_seq: number }>(edges: T[]): T[] {
  return edges.sort((a, b) => {
    if (a.from_decision_id !== b.from_decision_id) return a.from_decision_id.localeCompare(b.from_decision_id);
    if (a.to_decision_id !== b.to_decision_id) return a.to_decision_id.localeCompare(b.to_decision_id);
    if (a.relation !== b.relation) return a.relation.localeCompare(b.relation);
    return (a.via_event_seq ?? 0) - (b.via_event_seq ?? 0);
  });
}



async function main() {
  const db = arg("--db") ?? "replay-demo.db";
  const decision = arg("--decision");
  const mode = (arg("--mode") ?? "both").toLowerCase();
  const exportPath = arg("--export");
  const oneclick = arg("--oneclick");

  if (!decision) {
    console.error("Missing --decision <id>");
    process.exit(1);
  }

  const store = new SqliteDecisionStore(db);

  if (oneclick) {
    const res = await oneClickAnswers({ store, decision_id: decision, max_depth: 25 });
    if (!res.ok) {
      console.error(res.error);
      process.exit(1);
    }
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  const dir =
    mode === "upstream" ? "UPSTREAM" :
    mode === "downstream" ? "DOWNSTREAM" :
    "BOTH";

  const res = await buildDecisionDagPayload({
    store,
    decision_id: decision,
    direction: dir as any,
    max_depth: 25,
  });

  if (!res.ok) {
    console.error(res.error);
    process.exit(1);
  }

    // ✅ Canonicalize payload (prevents duplicate edges in BOTH export, stabilizes dag_hash)
  if (Array.isArray((res.payload as any).edges)) {
    (res.payload as any).edges = sortEdges(dedupeEdges((res.payload as any).edges));
  }
  if (Array.isArray((res.payload as any).nodes)) {
    // optional but recommended: stable ordering + dedupe by decision_id
    const m = new Map<string, any>();
    for (const n of (res.payload as any).nodes) {
      if (n && typeof n.decision_id === "string") m.set(n.decision_id, n);
    }
    (res.payload as any).nodes = [...m.values()].sort((a, b) => a.decision_id.localeCompare(b.decision_id));
  }

  if (exportPath) {
    fs.writeFileSync(exportPath, JSON.stringify(res.payload, null, 2), "utf8");
    console.log(`Wrote ${exportPath}`);
    return;
  }

  console.log(JSON.stringify(res.payload, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

