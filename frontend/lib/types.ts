export type ServiceName = "strategy" | "search" | "copy" | "image";

export type UnitStatus =
  | "pending"
  | "requesting"
  | "paying"
  | "validated"
  | "reused"
  | "failed";

export type TaskType = "twitter_post" | "email_campaign" | "banner" | "full_kit";

export type MicroUnitDefinition = {
  service: ServiceName;
  unit: string;
  price: number;
  dnaKey?: string | null;
  label: string;
  investmentOnly?: boolean;
};

export type LedgerItem = {
  unitId: string;
  service: ServiceName;
  unit: string;
  label: string;
  status: UnitStatus;
  price: number;
  amountUsdc?: number;
  txHash?: string;
  arcUrl?: string | null;
  network?: string | null;
  dnaKey?: string | null;
  note?: string | null;
  reusedFromDna?: boolean;
};

export type ActivityItem = {
  id: string;
  tone: "neutral" | "success" | "warning" | "danger";
  title: string;
  description: string;
};

export type TaskPlanView = {
  brandName: string;
  dnaExists: boolean;
  dnaFile?: string | null;
  microPlan: MicroUnitDefinition[];
  skippedUnits: string[];
  estimatedCost: number;
  investmentCost: number;
  savings: number;
  totalUnits: number;
  payableUnits: number;
  reusedUnits: number;
  dnaBlocksTotal: number;
};

export type TransactionItem = {
  order?: number;
  service: ServiceName;
  unit: string;
  label: string;
  txHash: string;
  amountUsdc: number;
  arcUrl?: string | null;
  network?: string | null;
};

export type TaskRecord = {
  id: string;
  prompt: string;
  task_type: string;
  brand_name?: string | null;
  status: string;
  budget_usdc?: number | null;
  estimated_cost_usdc?: number | null;
  investment_cost_usdc?: number | null;
  total_spent_usdc?: number | null;
  savings_usdc?: number | null;
  dna_exists?: boolean | null;
  dna_file_created?: string | null;
  plan_steps?: string[] | null;
  plan_skipped?: string[] | null;
  result?: {
    text?: string | null;
    imageUrl?: string | null;
    brandName?: string | null;
    taskType?: string | null;
    metrics?: {
      paidMicroPayments?: number;
      reusedUnits?: number;
      totalBlueprintUnits?: number;
      dnaBlocksBuilt?: number;
      dnaBlocksTotal?: number;
    } | null;
  } | null;
  error_log?: string | null;
  created_at?: string | null;
  completed_at?: string | null;
};

export type TaskStepRecord = {
  id: string;
  task_id: string;
  service_name: ServiceName;
  unit_name: string;
  status: string;
  cost_usdc?: number | null;
  tx_hash?: string | null;
  arc_url?: string | null;
  payment_network?: string | null;
  payment_note?: string | null;
  reused_from_dna?: boolean | null;
  dna_section_key?: string | null;
  output_json?: Record<string, unknown> | null;
  error_log?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
};

export type TaskSnapshotResponse = {
  task: TaskRecord;
  steps: TaskStepRecord[];
};

export type HistoryResponse = {
  tasks: TaskRecord[];
  dnaAssets: string[];
  summary?: {
    completedTasks: number;
    spent: number;
    saved: number;
    paidUnits: number;
    reusedUnits: number;
  };
};

export type VariantTier = "lite" | "balanced" | "deep";

export type VariantCard = {
  tier: VariantTier;
  label: string;
  subtitle: string;
  description: string;
  timeEstimateSeconds: number;
  units: number;
  dnaBlocks: number;
  dnaBlocksTotal: number;
  estimatedCostUsdc: number;
  savingsUsdc: number;
  services: { strategy: number; search: number; copy: number; image: number };
  // Dynamic agent count (4-15) picked by Hermes + complexity heuristic for
  // this specific task. Not fixed per tier.
  agents: number;
  agentsPerService?: { strategy?: number; search?: number; copy?: number; image?: number };
  headline: string;
  narrative: string;
  dnaFocus: string[];
  riskNote: string;
  plan: {
    microPlan: Array<{ service: string; unit: string; label: string; price: number; dnaKey?: string | null }>;
    payableUnits: number;
    dnaBlocksIncluded: number;
  };
};

export type VariantPlanResponse = {
  brandName: string;
  dnaExists: boolean;
  dnaFile: string | null;
  recommendedTier: VariantTier;
  rationale: string;
  variants: VariantCard[];
  source: string;
  model: string | null;
};

export type CumulativeMetrics = {
  totalMicroPayments: number;
  totalReusedUnits: number;
  totalSpentUsdc: number;
  totalSavedUsdc: number;
  completedTasks: number;
  hackathonTarget: number;
  hackathonTargetReached: boolean;
};
