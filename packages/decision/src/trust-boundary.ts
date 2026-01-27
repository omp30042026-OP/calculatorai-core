// packages/decision/src/trust-boundary.ts
import type { PolicyViolation } from "./policy.js";


export type TrustZone = "INTERNAL" | "PARTNER" | "VENDOR" | "PUBLIC" | "TEAM" | "ORG" | "EXTERNAL";

export type EvidenceRef = {
  id?: string;
  kind?: string;        // "doc" | "log" | "invoice" | ...
  uri?: string;
  hash?: string;        // sha256/merkle root/etc
  trust_level?: number; // 0..100
};

export type EventAttestationRef = {
  payload_hash?: string;
  attested_by?: string;
  attested_at?: string; // ISO time
};

export type FederationProof = {
  origin_org_id: string;
  proof_hash: string;
  signature?: string;
  scheme?: string;
};

export type TrustBoundaryPolicy = {
  allowed_zones_by_event?: Partial<Record<string, TrustZone[]>>;
  evidence_required_by_event?: Partial<Record<string, { min_trust_level?: number }>>;
  attestation_required_by_event?: Partial<Record<string, true>>;
  federation_required_by_event?: Partial<Record<string, true>>;
  default_zone?: TrustZone;
};

export type TrustBoundaryInput = {
  event: any;
  decision: any;
  policy?: TrustBoundaryPolicy;

  // optional caller-provided context (store-engine passes this)
  trustContext?: {
    origin_zone?: string | null;
    origin_system?: string | null;
    channel?: string | null;
    tenant_id?: string | null;
  };
};

function toViolation(code: string, message: string, details?: any): PolicyViolation {
  return {
    code,
    severity: "BLOCK",
    message,
    details,
  };
}

function normalizePolicyZone(z: any): TrustZone {
  const s = String(z ?? "").toUpperCase();

  // legacy -> canonical
  if (s === "ORG" || s === "TEAM") return "INTERNAL";
  if (s === "EXTERNAL") return "PUBLIC";

  // canonical
  if (s === "INTERNAL" || s === "PARTNER" || s === "VENDOR" || s === "PUBLIC") {
    return s as TrustZone;
  }

  // unknown -> safest
  return "PUBLIC";
}


function pickZone(input: TrustBoundaryInput): TrustZone {
  const { event, policy, trustContext } = input;

  // Prefer the canonical V2 location: event.trust.origin.zone
  const z1 = event?.trust?.origin?.zone;

  // Back-compat fallbacks
  const z2 =
    event?.meta?.trust_zone ??
    event?.meta?.origin?.trust_zone ??
    event?.actor_zone ??
    null;

  // Store-engine trustContext fallback
  const z3 = trustContext?.origin_zone ?? null;

  const z = String(z1 ?? z2 ?? z3 ?? policy?.default_zone ?? "INTERNAL").toUpperCase();

    // legacy -> canonical
    if (z === "TEAM" || z === "ORG") return "INTERNAL";
    if (z === "EXTERNAL") return "PUBLIC";

    // canonical
    if (z === "INTERNAL" || z === "PARTNER" || z === "VENDOR" || z === "PUBLIC") return z as any;

    // unknown -> safest default
    return "PUBLIC";
}

function extractPolicy(decision: any, policyOverride?: TrustBoundaryPolicy): TrustBoundaryPolicy | null {
  if (policyOverride) return policyOverride;

  // Pull policy from decision.artifacts.extra.trust.policy if present (matches your legacy pattern)
  const a = decision?.artifacts ?? {};
  const extra = a?.extra ?? {};
  const trust = extra?.trust ?? null;
  const p = trust?.policy ?? null;

  return p && typeof p === "object" ? (p as TrustBoundaryPolicy) : null;
}

/**
 * ✅ Option A:
 * Return PolicyViolation[] (empty => ok)
 */
export function enforceTrustBoundary(input: TrustBoundaryInput): PolicyViolation[] {
  const { event, decision } = input;

  const policy = extractPolicy(decision, input.policy);
  if (!policy) return []; // no policy => allow

  // allow disabling via policy.enabled if you include it in your stored policy
  if ((policy as any).enabled === false) return [];

  const violations: PolicyViolation[] = [];

  const type: string = String(event?.type ?? "");
  const zone = pickZone(input);

  // Optional exempt list (if you store it)
  const exempt: string[] = Array.isArray((policy as any).exempt_event_types)
    ? (policy as any).exempt_event_types.map(String)
    : [];
  if (exempt.includes(type)) return [];

  // 1) origin trust
    const allowedRaw = policy.allowed_zones_by_event?.[type];
    const allowed = Array.isArray(allowedRaw) ? allowedRaw.map(normalizePolicyZone) : null;

    if (allowed && allowed.length > 0 && !allowed.includes(zone)) {
        violations.push(
        toViolation(
            "TB_ORIGIN_ZONE_NOT_ALLOWED",
            `Event ${type} not allowed from zone ${zone}`,
            { type, zone, allowed }
        )
        );
    }


    const deniedRaw = Array.isArray((policy as any).denied_origin_zones)
        ? (policy as any).denied_origin_zones
        : [];
    const denied = deniedRaw.map(normalizePolicyZone);

    if (denied.includes(zone)) {
    violations.push(
      toViolation(
        "TB_ORIGIN_ZONE_DENIED",
        `Event ${type} denied from zone ${zone}`,
        { type, zone, denied }
      )
    );
  }

  // 2) evidence trust
  const evReq = policy.evidence_required_by_event?.[type];
  if (evReq) {
    const evidence: EvidenceRef[] = Array.isArray(event?.meta?.evidence)
      ? event.meta.evidence
      : event?.meta?.evidence
        ? [event.meta.evidence]
        : [];

    if (evidence.length === 0) {
      violations.push(
        toViolation("TB_EVIDENCE_REQUIRED", `Event ${type} requires evidence`, { type })
      );
    } else if (typeof evReq.min_trust_level === "number") {
      const best = Math.max(
        ...evidence.map((e) => (typeof e?.trust_level === "number" ? e.trust_level : 0))
      );
      if (best < evReq.min_trust_level) {
        violations.push(
          toViolation(
            "TB_EVIDENCE_TRUST_TOO_LOW",
            `Event ${type} requires evidence trust >= ${evReq.min_trust_level}`,
            { best, required: evReq.min_trust_level }
          )
        );
      }
    }
  }

  // 3) attestation trust
  if (policy.attestation_required_by_event?.[type]) {
    const att: EventAttestationRef | null =
      event?.meta?.attestation && typeof event.meta.attestation === "object"
        ? event.meta.attestation
        : null;

    if (!att?.payload_hash || !att?.attested_by) {
      violations.push(
        toViolation(
          "TB_ATTESTATION_REQUIRED",
          `Event ${type} requires external attestation`,
          { type }
        )
      );
    }
  }

  // 18) autonomous agent constraint
  // NOTE: your events.ts actor_type is "human" | "service" | "system".
  // If you later add "agent", this will automatically enforce it.
  if (event?.actor_type === "agent" && (type === "APPROVE" || type === "REJECT")) {
    violations.push(
      toViolation(
        "TB_AGENT_CANNOT_FINALIZE",
        `Agent cannot ${type} (must be human-gated)`,
        { actor_id: event?.actor_id, actor_type: event?.actor_type }
      )
    );
  }

  // 19) federation constraint
  if (policy.federation_required_by_event?.[type]) {
    const fed: FederationProof | null =
      event?.meta?.federation && typeof event.meta.federation === "object"
        ? event.meta.federation
        : null;

    const decisionOrg = decision?.meta?.org_id ?? decision?.org_id ?? null;
    const originOrg = fed?.origin_org_id ?? null;

    const isCrossOrg = originOrg && decisionOrg && originOrg !== decisionOrg;

    if (isCrossOrg && !fed?.proof_hash) {
      violations.push(
        toViolation(
          "TB_FEDERATION_PROOF_REQUIRED",
          `Cross-org event ${type} requires federation proof`,
          { origin_org_id: originOrg, decision_org_id: decisionOrg }
        )
      );
    }
  }

  return violations;
}









