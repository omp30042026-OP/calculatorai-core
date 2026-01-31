// examples/your-store-factory.ts
import { SqliteDecisionStore } from "../packages/decision/src/index.js";

export type SqliteStoreBundle = {
  filename: string;
  store: SqliteDecisionStore;
};

export function createSqliteStoreBundle(
  opts?: { filename?: string }
): SqliteStoreBundle {
  const filename =
    opts?.filename ?? `/tmp/calculatorai-core-${process.pid}-${Date.now()}.sqlite`;

  const store = new SqliteDecisionStore(filename);
  return { filename, store };
}

