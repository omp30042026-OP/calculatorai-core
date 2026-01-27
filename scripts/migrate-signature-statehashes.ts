import Database from "better-sqlite3";

function main() {
  const dbPath = process.argv.includes("--db")
    ? process.argv[process.argv.indexOf("--db") + 1]
    : "replay-demo.db";

  const decisionId = process.argv.includes("--decision")
    ? process.argv[process.argv.indexOf("--decision") + 1]
    : "dec_exec_001";

  const db = new Database(dbPath);

  console.log("db =", dbPath);
  console.log("decision =", decisionId);

  const exists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='risk_liability_signatures'`)
    .get();

  if (!exists) {
    console.error("missing table risk_liability_signatures");
    process.exit(1);
  }

  const upd = db.prepare(`
    UPDATE risk_liability_signatures
    SET
      state_before_hash = (SELECT state_before_hash FROM liability_receipts l
                           WHERE l.decision_id=risk_liability_signatures.decision_id
                             AND l.event_seq=risk_liability_signatures.event_seq),
      state_after_hash  = (SELECT state_after_hash  FROM liability_receipts l
                           WHERE l.decision_id=risk_liability_signatures.decision_id
                             AND l.event_seq=risk_liability_signatures.event_seq),
      obligations_hash  = (SELECT obligations_hash FROM liability_receipts l
                           WHERE l.decision_id=risk_liability_signatures.decision_id
                             AND l.event_seq=risk_liability_signatures.event_seq),
      receipt_hash      = (SELECT receipt_hash      FROM liability_receipts l
                           WHERE l.decision_id=risk_liability_signatures.decision_id
                             AND l.event_seq=risk_liability_signatures.event_seq)
    WHERE decision_id=?;
  `);

  const tx = db.transaction(() => {
    const info = upd.run(decisionId);
    return info.changes;
  });

  const changed = tx();
  console.log("✅ updated rows =", changed);

  const rows = db
    .prepare(
      `
      SELECT
        r.event_seq,
        substr(r.state_after_hash,1,12) AS sig_after,
        substr(l.state_after_hash,1,12) AS receipt_after
      FROM risk_liability_signatures r
      JOIN liability_receipts l
        ON l.decision_id=r.decision_id AND l.event_seq=r.event_seq
      WHERE r.decision_id=?
      ORDER BY r.event_seq;
      `
    )
    .all(decisionId);

  for (const r of rows as any[]) {
    console.log(`seq ${r.event_seq} sig_after=${r.sig_after} receipt_after=${r.receipt_after}`);
  }
}

main();

