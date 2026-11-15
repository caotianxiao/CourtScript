export type PlanStatus =
  | "pending"
  | "ready"
  | "submitted"
  | "confirmed"
  | "failed"
  | "ambiguous"
  | "expired";

export type RunMode = "dry-run" | "submit";

export interface PlanAttempt {
  at: string;
  mode: RunMode;
  slot?: string;
  result: string;
  message?: string;
}

export interface ReservationResult {
  mode: RunMode;
  planId: string;
  targetDate: string;
  selectedSlot?: string;
  status: "ready" | "submitted" | "confirmed" | "failed" | "ambiguous";
  message: string;
  launchRequests: number;
  submission?: {
    observed: boolean;
    completed: boolean;
    outcome: "success" | "failure" | "unknown" | "timeout";
    elapsedMs: number;
    httpStatus?: number;
    applicationCode?: string;
    responseMessage?: string;
  };
  screenshot?: string;
}

export interface ReservationPlan {
  id: string;
  resourceId: number;
  targetDate: string;
  slots: string[];
  status: PlanStatus;
  createdAt: string;
  updatedAt: string;
  attempts: PlanAttempt[];
  result?: ReservationResult;
}

export type PriorityPairStatus =
  | "pending"
  | "running"
  | "ready"
  | "confirmed"
  | "partial"
  | "failed"
  | "ambiguous";

export interface PriorityPairAttempt {
  at: string;
  mode: RunMode;
  result: PriorityPairStatus;
  message: string;
}

export interface PriorityPairResult {
  mode: RunMode;
  pairId: string;
  status: Exclude<PriorityPairStatus, "pending" | "running">;
  message: string;
  high: ReservationResult;
  low: ReservationResult;
}

export interface PriorityPair {
  id: string;
  targetDate: string;
  highDate: string;
  lowDate: string;
  highSlot: string;
  lowSlot: string;
  highPlanId: string;
  lowPlanId: string;
  status: PriorityPairStatus;
  createdAt: string;
  updatedAt: string;
  attempts: PriorityPairAttempt[];
  result?: PriorityPairResult;
}

export interface PlanStore {
  version: 1;
  plans: ReservationPlan[];
  priorityPairs: PriorityPair[];
}
