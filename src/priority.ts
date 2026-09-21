import { runReservation } from "./reservation.js";
import {
  findPlan,
  updatePriorityPair,
} from "./state.js";
import type {
  PriorityPair,
  PriorityPairResult,
  ReservationPlan,
  ReservationResult,
  RunMode,
} from "./types.js";

export interface PriorityRunOptions {
  notBefore?: Date;
  maxLatenessMs?: number;
}

function failedResult(
  plan: ReservationPlan,
  mode: RunMode,
  message: string,
): ReservationResult {
  return {
    mode,
    planId: plan.id,
    targetDate: plan.targetDate,
    status: "failed",
    message,
    launchRequests: 0,
  };
}

async function runChild(
  planId: string,
  mode: RunMode,
  options: PriorityRunOptions,
): Promise<ReservationResult> {
  const plan = await findPlan(planId);
  const previous = plan.result;

  if (mode === "submit" && previous?.status === "confirmed") {
    console.log(
      `[${new Date().toISOString()}] PRIORITY_PHASE：子计划 ${plan.id} 已成功，跳过重复提交`,
    );
    return previous;
  }
  if (
    mode === "submit"
    && (previous?.status === "ambiguous" || (previous?.launchRequests ?? 0) > 0)
  ) {
    return {
      ...(previous ?? failedResult(plan, mode, "此前提交结果不明确")),
      mode,
      status: "ambiguous",
      message: "此前已发送预约请求但结果不明确，禁止自动重试",
    };
  }
  if (mode === "dry-run" && previous?.mode === "dry-run" && previous.status === "ready") {
    return previous;
  }

  try {
    return await runReservation(plan, mode, options);
  } catch (error) {
    const updated = await findPlan(plan.id);
    if (updated.result) {
      return updated.result;
    }
    return failedResult(
      plan,
      mode,
      error instanceof Error ? error.message : String(error),
    );
  }
}

function isSuccessful(result: ReservationResult, mode: RunMode): boolean {
  return result.status === "confirmed" || (mode === "dry-run" && result.status === "ready");
}

export function priorityResultStatus(
  high: ReservationResult,
  low: ReservationResult,
  mode: RunMode,
): PriorityPairResult["status"] {
  const highSucceeded = isSuccessful(high, mode);
  const lowSucceeded = isSuccessful(low, mode);
  if (highSucceeded && lowSucceeded) {
    return mode === "dry-run" ? "ready" : "confirmed";
  }
  if (high.status === "ambiguous" || low.status === "ambiguous") {
    return "ambiguous";
  }
  if (highSucceeded || lowSucceeded) {
    return "partial";
  }
  return "failed";
}

export async function runPriorityPair(
  pair: PriorityPair,
  mode: RunMode,
  options: PriorityRunOptions = {},
): Promise<PriorityPairResult> {
  await updatePriorityPair(pair.id, "running");
  console.log(
    `[${new Date().toISOString()}] PRIORITY_PHASE：开始高优先级 ${pair.highSlot}`,
  );
  const high = await runChild(pair.highPlanId, mode, options);

  console.log(
    `[${new Date().toISOString()}] PRIORITY_PHASE：高优先级结束（${high.status}），立即从 eHall 开始低优先级 ${pair.lowSlot}`,
  );
  const low = await runChild(pair.lowPlanId, mode, {});
  const status = priorityResultStatus(high, low, mode);
  const message = [
    `优先级计划 ${pair.id}：${status}`,
    `高 ${pair.highSlot}=${high.status}`,
    `低 ${pair.lowSlot}=${low.status}`,
  ].join("；");
  const result: PriorityPairResult = {
    mode,
    pairId: pair.id,
    status,
    message,
    high,
    low,
  };
  await updatePriorityPair(
    pair.id,
    status,
    {
      at: new Date().toISOString(),
      mode,
      result: status,
      message,
    },
    result,
  );
  return result;
}
