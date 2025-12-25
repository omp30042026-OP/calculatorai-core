import { z } from "zod";

/* ------------------------------------------------------------------ */
/*                              Primitives                            */
/* ------------------------------------------------------------------ */

const ISO8601 = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), "Invalid ISO-8601 timestamp");

const CurrencyCode = z.string().min(3).max(3);

const FiniteNumber = z
  .number()
  .refine(Number.isFinite, "Must be a finite number");

/* ------------------------------------------------------------------ */
/*                               Policy                               */
/* ------------------------------------------------------------------ */

const PolicyContextSchema = z.object({
  read_only: z.literal(true),
  allow_pii: z.boolean().optional(),
  require_human_review: z.literal(true),
  audit_level: z.enum(["FULL", "STANDARD"]).optional(),
});

/* ------------------------------------------------------------------ */
/*                              Dimensions                            */
/* ------------------------------------------------------------------ */

const DimensionSetSchema = z.object({
  entity_id: z.string().optional(),
  item_id: z.string().optional(),
  relationship_id: z.string().optional(),
  location_id: z.string().optional(),
  business_unit_id: z.string().optional(),

  // Zod v4 record requires (keyType, valueType)
  extra: z.record(z.string(), z.string()).optional(),
});

/* ------------------------------------------------------------------ */
/*                              Observation                           */
/* ------------------------------------------------------------------ */

const ObservationSchema = z.object({
  obs_id: z.string(),
  metric: z.enum([
    "UNIT_PRICE",
    "UNIT_COST",
    "VOLUME",
    "REVENUE",
    "DISCOUNT_RATE",
    "LEAD_TIME_DAYS",
    "DEFECT_RATE",
    "STOCKOUT_RATE",
    "CAPACITY",
  ]),
  value: FiniteNumber,
  unit: z.string().optional(),
  time: ISO8601,
  dims: DimensionSetSchema,
  quality: z.object({
    completeness: z.number().min(0).max(1).optional(),
    staleness_days: z.number().min(0).optional(),
    source_system: z.string().optional(),
    notes: z.string().optional(),
  }),
  source: z
    .object({
      source_id: z.string().optional(),
      source_system: z.string().optional(),
      source_record_id: z.string().optional(),
    })
    .optional(),
});

/* ------------------------------------------------------------------ */
/*                              Baseline                              */
/* ------------------------------------------------------------------ */

const BaselineStateSchema = z.object({
  entities: z.array(
    z.object({
      entity_id: z.string(),
      entity_type: z.enum([
        "VENDOR",
        "CUSTOMER",
        "LOCATION",
        "BUSINESS_UNIT",
        "OTHER",
      ]),
      name: z.string().optional(),
      attributes: z
        .record(
          z.string(),
          z.union([z.string(), z.number(), z.boolean()])
        )
        .optional(),
    })
  ),

  items: z.array(
    z.object({
      item_id: z.string(),
      item_type: z.enum(["SKU", "SERVICE", "RESOURCE", "OTHER"]),
      name: z.string().optional(),
      uom: z.string().optional(),
      attributes: z
        .record(
          z.string(),
          z.union([z.string(), z.number(), z.boolean()])
        )
        .optional(),
    })
  ),

  relationships: z.array(
    z.object({
      relationship_id: z.string(),
      entity_id: z.string(),
      item_id: z.string(),
      relationship_type: z.enum([
        "SUPPLIES",
        "SELLS",
        "USES",
        "OWNS",
        "OTHER",
      ]),
      terms: z
        .object({
          payment_terms_days: z.number().min(0).optional(),
          lead_time_days: z.number().min(0).optional(),
          notes: z.string().optional(),
        })
        .optional(),
    })
  ),

  observations: z.array(ObservationSchema),
});

/* ------------------------------------------------------------------ */
/*                               Changes                              */
/* ------------------------------------------------------------------ */

const DeltaSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ABSOLUTE"), new_value: FiniteNumber }),
  z.object({ kind: z.literal("RELATIVE"), multiplier: z.number().positive() }),
  z.object({ kind: z.literal("ADD"), amount: FiniteNumber }),
  z.object({ kind: z.literal("SET_CATEGORY"), value: z.string() }),
]);

const TargetRefSchema = z.object({
  scope: z.enum(["ENTITY", "ITEM", "RELATIONSHIP", "OBSERVATION_DIM"]),
  entity_id: z.string().optional(),
  item_id: z.string().optional(),
  relationship_id: z.string().optional(),
  dims: DimensionSetSchema.optional(),
});

const ChangeSetSchema = z.object({
  change_id: z.string(),
  type: z.enum([
    "PRICE_CHANGE",
    "COST_CHANGE",
    "VOLUME_CHANGE",
    "MIX_SHIFT",
    "TERM_CHANGE",
    "AVAILABILITY_CHANGE",
  ]),
  target: TargetRefSchema,
  effective: z.object({
    start: ISO8601,
    end: ISO8601.optional(),
  }),
  delta: DeltaSchema,
  constraints: z
    .array(
      z.object({
        constraint_id: z.string(),
        expr: z.string(),
        severity: z.enum(["HARD", "SOFT"]),
        notes: z.string().optional(),
      })
    )
    .optional(),
  notes: z.string().optional(),
});

/* ------------------------------------------------------------------ */
/*                              Decision                              */
/* ------------------------------------------------------------------ */

export const DecisionSchema = z.object({
  decision_id: z.string(),
  title: z.string(),
  decision_time: ISO8601,

  horizon: z.object({
    start: ISO8601,
    end: ISO8601,
  }),

  currency: CurrencyCode,

  baseline: BaselineStateSchema,
  change_set: z.array(ChangeSetSchema),

  assumptions: z.array(
    z.object({
      assumption_id: z.string(),
      statement: z.string(),
      applies_to: TargetRefSchema,
      value: z.union([z.string(), z.number(), z.boolean()]).optional(),
      justification: z.string().optional(),
    })
  ),

  policy: PolicyContextSchema,
  provenance: z.object({
    created_by: z.enum(["HUMAN", "ADAPTER"]),
    adapter_id: z.string().optional(),
    source_systems: z.array(z.string()).optional(),
    created_at: ISO8601,
  }),
});

export type ParsedDecision = z.infer<typeof DecisionSchema>;

export function parseDecision(input: unknown): ParsedDecision {
  return DecisionSchema.parse(input);
}

