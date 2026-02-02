// packages/decision/src/provenance/query.ts
import type { EdgeType } from "./dag.js";

export type Direction = "UP" | "DOWN" | "BOTH";

type DecisionId = string;

/**
 * Graph Query Language (GQL-lite) for DAG snapshots.
 * Pure data-in -> data-out, zero UI assumptions.
 */
export type DagQuery =
  | {
      kind: "NEIGHBORS";
      focus?: DecisionId;
      node_id: DecisionId;
      direction?: Direction; // default BOTH
      edge_types?: EdgeType[]; // default all
      limit?: number; // default 250
    }
  | {
      kind: "LINEAGE";
      focus?: DecisionId;
      node_id: DecisionId;
      direction?: Exclude<Direction, "BOTH">; // default UP
      depth?: number; // default 5
      edge_types?: EdgeType[]; // default all
      limit?: number; // default 2000
    }
  | {
      kind: "PATH";
      focus?: DecisionId;
      from: DecisionId;
      to: DecisionId;
      // If there are multiple paths, return the shortest in edges (BFS).
      edge_types?: EdgeType[]; // default all
      limit?: number; // default 2000
    }
  | {
      kind: "SUBGRAPH";
      focus?: DecisionId;
      node_ids: DecisionId[];
      // expand neighborhood around these nodes
      depth?: number; // default 2
      edge_types?: EdgeType[]; // default all
      limit?: number; // default 5000
    };

export type DagQueryResult = {
  focus: DecisionId;
  nodes: DecisionId[];
  edges: string[]; // edge_id list
  stats: {
    returned_nodes: number;
    returned_edges: number;
    scanned_edges: number;
  };
  explanation?: string;
};