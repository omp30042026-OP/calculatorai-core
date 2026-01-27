import type { DecisionStore } from "../../src/store.js";

// NOTE: This is a stub to satisfy TypeScript.
// Either implement a real in-memory DecisionStore here,
// or rewrite rbac.finalize.test.ts to use SqliteDecisionStore.
export function createMemoryStore(): DecisionStore {
  throw new Error("createMemoryStore not implemented");
}
