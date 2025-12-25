import type { ParsedDecision } from "./validate.js";

export type InvariantViolationCode =
  | "DUPLICATE_ID"
  | "MISSING_REFERENCE"
  | "INVALID_TIME_RANGE";

export type InvariantViolation = {
  code: InvariantViolationCode;
  message: string;
  path: string; // JSON pointer-like path for debugging
};

export function checkInvariants(d: ParsedDecision): InvariantViolation[] {
  const v: InvariantViolation[] = [];

  // ---- Unique IDs
  v.push(
    ...checkUnique(d.baseline.entities.map((x) => x.entity_id), "/baseline/entities", "entity_id"),
    ...checkUnique(d.baseline.items.map((x) => x.item_id), "/baseline/items", "item_id"),
    ...checkUnique(d.baseline.relationships.map((x) => x.relationship_id), "/baseline/relationships", "relationship_id"),
    ...checkUnique(d.baseline.observations.map((x) => x.obs_id), "/baseline/observations", "obs_id"),
    ...checkUnique(d.change_set.map((x) => x.change_id), "/change_set", "change_id"),
    ...checkUnique(d.assumptions.map((x) => x.assumption_id), "/assumptions", "assumption_id")
  );

  // ---- Build reference sets
  const entityIds = new Set(d.baseline.entities.map((e) => e.entity_id));
  const itemIds = new Set(d.baseline.items.map((i) => i.item_id));
  const relationshipIds = new Set(d.baseline.relationships.map((r) => r.relationship_id));

  // ---- Relationships must resolve
  d.baseline.relationships.forEach((r, i) => {
    if (!entityIds.has(r.entity_id)) {
      v.push({
        code: "MISSING_REFERENCE",
        message: `Relationship references missing entity_id '${r.entity_id}'`,
        path: `/baseline/relationships/${i}/entity_id`,
      });
    }
    if (!itemIds.has(r.item_id)) {
      v.push({
        code: "MISSING_REFERENCE",
        message: `Relationship references missing item_id '${r.item_id}'`,
        path: `/baseline/relationships/${i}/item_id`,
      });
    }
  });

  // ---- Observation dims must resolve if present
  d.baseline.observations.forEach((o, i) => {
    if (o.dims.entity_id && !entityIds.has(o.dims.entity_id)) {
      v.push({
        code: "MISSING_REFERENCE",
        message: `Observation dims references missing entity_id '${o.dims.entity_id}'`,
        path: `/baseline/observations/${i}/dims/entity_id`,
      });
    }
    if (o.dims.item_id && !itemIds.has(o.dims.item_id)) {
      v.push({
        code: "MISSING_REFERENCE",
        message: `Observation dims references missing item_id '${o.dims.item_id}'`,
        path: `/baseline/observations/${i}/dims/item_id`,
      });
    }
    if (o.dims.relationship_id && !relationshipIds.has(o.dims.relationship_id)) {
      v.push({
        code: "MISSING_REFERENCE",
        message: `Observation dims references missing relationship_id '${o.dims.relationship_id}'`,
        path: `/baseline/observations/${i}/dims/relationship_id`,
      });
    }
  });

  // ---- ChangeSet target must resolve
  d.change_set.forEach((c, i) => {
    const t = c.target;

    if (t.scope === "ENTITY") {
      if (!t.entity_id || !entityIds.has(t.entity_id)) {
        v.push({
          code: "MISSING_REFERENCE",
          message: `ChangeSet target ENTITY missing/invalid entity_id`,
          path: `/change_set/${i}/target/entity_id`,
        });
      }
    }

    if (t.scope === "ITEM") {
      if (!t.item_id || !itemIds.has(t.item_id)) {
        v.push({
          code: "MISSING_REFERENCE",
          message: `ChangeSet target ITEM missing/invalid item_id`,
          path: `/change_set/${i}/target/item_id`,
        });
      }
    }

    if (t.scope === "RELATIONSHIP") {
      if (!t.relationship_id || !relationshipIds.has(t.relationship_id)) {
        v.push({
          code: "MISSING_REFERENCE",
          message: `ChangeSet target RELATIONSHIP missing/invalid relationship_id`,
          path: `/change_set/${i}/target/relationship_id`,
        });
      }
    }

    if (t.scope === "OBSERVATION_DIM") {
      // Must specify dims and at least one stable key inside dims
      if (!t.dims || Object.keys(t.dims).length === 0) {
        v.push({
          code: "MISSING_REFERENCE",
          message: `ChangeSet target OBSERVATION_DIM requires dims`,
          path: `/change_set/${i}/target/dims`,
        });
      }
    }
  });

  // ---- Time sanity
  const hStart = Date.parse(d.horizon.start);
  const hEnd = Date.parse(d.horizon.end);
  if (!Number.isNaN(hStart) && !Number.isNaN(hEnd) && hStart >= hEnd) {
    v.push({
      code: "INVALID_TIME_RANGE",
      message: "Decision horizon.start must be strictly earlier than horizon.end",
      path: "/horizon",
    });
  }

  return v;
}

function checkUnique(ids: string[], path: string, keyName: string): InvariantViolation[] {
  const seen = new Set<string>();
  const v: InvariantViolation[] = [];
  ids.forEach((id, idx) => {
    if (seen.has(id)) {
      v.push({
        code: "DUPLICATE_ID",
        message: `Duplicate ${keyName} '${id}'`,
        path: `${path}/${idx}/${keyName}`,
      });
    } else {
      seen.add(id);
    }
  });
  return v;
}

