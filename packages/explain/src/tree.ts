export type ExplainTree = {
  item_id: string;

  inputs: Array<{
    metric: "UNIT_PRICE" | "UNIT_COST" | "VOLUME";
    value: number | null;
    obs_id: string | null;
    quality?:
      | {
          staleness_days?: number;
          completeness?: number;
          source_system?: string;
        }
      | undefined;
  }>;

  changes: Array<{
    change_id: string;
    type: string;
    target: string;
    delta: any;
    status?: "APPLIED" | "SKIPPED" | "OVERRIDDEN";
    note?: string;

    // v7: structured time-gating info (computed from horizon + effective)
    meta?: {
      time_gating?: {
        active_fraction?: number; // optional so partial builds are safe
        overlap?: { start: string; end: string };
        horizon?: { start: string; end: string };
      };
    };
  }>;

  computations: Array<{
    name: string;
    formula: string;
    substituted: string;
    value: number | null;
  }>;

  result: {
    baseline_total_margin: number | null;
    simulated_total_margin: number | null;
    delta_total_margin: number | null;
  };

  notes: string[];
};

