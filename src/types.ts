export type PlanStatus =
  | "pending"
  | "ready"
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
  status: "ready" | "confirmed" | "failed" | "ambiguous";
  message: string;
  launchRequests: number;
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

export interface PlanStore {
  version: 1;
  plans: ReservationPlan[];
}

