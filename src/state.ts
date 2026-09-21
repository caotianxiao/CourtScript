import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { PLANS_FILE, RESOURCE_ID, STATE_DIR } from "./constants.js";
import type {
  PlanAttempt,
  PlanStatus,
  PlanStore,
  ReservationPlan,
  ReservationResult,
} from "./types.js";
import { normalizeSlots, validateDate } from "./validation.js";

const EMPTY_STORE: PlanStore = { version: 1, plans: [] };

export async function ensureStateDirectories(): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
}

export async function loadStore(): Promise<PlanStore> {
  await ensureStateDirectories();
  try {
    const parsed = JSON.parse(await readFile(PLANS_FILE, "utf8")) as PlanStore;
    if (parsed.version !== 1 || !Array.isArray(parsed.plans)) {
      throw new Error("计划文件格式不受支持");
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return structuredClone(EMPTY_STORE);
    }
    throw error;
  }
}

export async function saveStore(store: PlanStore): Promise<void> {
  await ensureStateDirectories();
  const temporary = join(dirname(PLANS_FILE), `.plans-${process.pid}.tmp`);
  await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, PLANS_FILE);
}

export async function addPlan(
  targetDate: string,
  primary: string,
  fallbacks: string[],
): Promise<ReservationPlan> {
  validateDate(targetDate);
  const slots = normalizeSlots(primary, fallbacks);
  const store = await loadStore();
  const now = new Date().toISOString();
  const plan: ReservationPlan = {
    id: randomUUID().slice(0, 8),
    resourceId: RESOURCE_ID,
    targetDate,
    slots,
    status: "pending",
    createdAt: now,
    updatedAt: now,
    attempts: [],
  };
  store.plans.push(plan);
  await saveStore(store);
  return plan;
}

export async function findPlan(planId: string): Promise<ReservationPlan> {
  const store = await loadStore();
  const plan = store.plans.find((item) => item.id === planId);
  if (!plan) {
    throw new Error(`找不到计划：${planId}`);
  }
  return plan;
}

export async function updatePlan(
  planId: string,
  status: PlanStatus,
  attempt: PlanAttempt,
  result?: ReservationResult,
): Promise<ReservationPlan> {
  const store = await loadStore();
  const plan = store.plans.find((item) => item.id === planId);
  if (!plan) {
    throw new Error(`找不到计划：${planId}`);
  }
  plan.status = status;
  plan.updatedAt = new Date().toISOString();
  plan.attempts.push(attempt);
  if (result) {
    plan.result = result;
  }
  await saveStore(store);
  return plan;
}

