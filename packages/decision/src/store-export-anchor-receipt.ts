// packages/decision/src/store-export-anchor-receipt.ts
import type { DecisionAnchorStore } from "./anchors.js";
import { makeReceiptV2, type DecisionAnchorReceiptV2 } from "./anchor-receipt-v2.js";

export async function exportAnchorReceiptV2(
  store: DecisionAnchorStore,
  anchor_seq: number
): Promise<DecisionAnchorReceiptV2 | null> {
  const anchors = await store.listAnchors();
  const a = anchors.find((x) => x.seq === anchor_seq);
  if (!a) return null;

  const head = store.getLastAnchor ? await store.getLastAnchor() : anchors[anchors.length - 1] ?? null;
  return makeReceiptV2(a, head ?? undefined);
}

