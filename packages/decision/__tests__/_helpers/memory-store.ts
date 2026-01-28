// packages/decision/__tests__/_helpers/memory-store.ts
import type { DecisionStore } from "../../src/store.js";
import { SqliteDecisionStore } from "../../src/sqlite-store.js";

// Use SQLite in-memory DB as our "memory store" for tests.
export function createMemoryStore(): DecisionStore {
  return new SqliteDecisionStore(":memory:");
}

