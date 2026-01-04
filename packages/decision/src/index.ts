// packages/decision/src/index.ts

// ---- core types + schemas ----
export type { Decision, DecisionState } from "./decision.js";
export {
  DecisionSchema,
  DecisionStateSchema,
  DecisionHistoryEntrySchema,
  DecisionArtifactsSchema,
  DecisionAccountabilitySchema,
  DecisionRiskSchema,
} from "./decision.js";

// ---- events ----
export type { DecisionEvent } from "./events.js";
export {
  DecisionEventSchema,
  ValidateEventSchema,
  SimulateEventSchema,
  ExplainEventSchema,
  ApproveEventSchema,
  RejectEventSchema,
  AttachArtifactsEventSchema,
} from "./events.js";

// ---- state machine ----
export type { DecisionEventType } from "./state-machine.js";
export { transitionDecisionState } from "./state-machine.js";

// ---- engine / store / extras ----
export * from "./engine.js";
export * from "./policy.js";
export * from "./store.js";
export * from "./store-engine.js";
export * from "./snapshots.js";

export * from "./sqlite-store.js";
export * from "./sqlite-snapshot-store.js";

export * from "./store-history.js";
export * from "./store-diff.js";
export * from "./store-audit.js";
export * from "./store-timeline.js";
export * from "./store-lineage.js";
export * from "./store-fork-graph.js";

export { verifyDecisionHashChain } from "./store-verify.js";
export type { VerifyHashChainOptions, VerifyHashChainResult } from "./store-verify.js";

export { verifyDecisionFromSnapshot } from "./store-verify.js";
export type { VerifyFromSnapshotResult } from "./store-verify.js";

export { verifyForkLineage } from "./store-verify-lineage.js";
export type { VerifyForkLineageResult, VerifyForkLineageOptions } from "./store-verify-lineage.js";

export { verifyDecisionRootFromSnapshot } from "./store-verify-root.js";
export type { VerifyRootFromSnapshotResult } from "./store-verify-root.js";

// packages/decision/src/index.ts
export { buildMerkleProofFromLeaves, verifyMerkleProof } from "./merkle-proof.js";
export type { VerifyMerkleProofResult } from "./merkle-proof.js";

export { verifyEventIncludedFromLatestSnapshot } from "./store-verify-inclusion.js";
export type { VerifyInclusionResult } from "./store-verify-inclusion.js";

export type { DecisionAnchorStore, DecisionAnchorRecord, AnchorPolicy } from "./anchors.js";
export { verifyGlobalAnchorChain } from "./store-verify-anchors.js";

