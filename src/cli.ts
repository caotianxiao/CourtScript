#!/usr/bin/env node
import { Command } from "commander";
import { importEdgeSession, checkDedicatedSession, manualLogin } from "./auth.js";
import {
  clearStoredCredentials,
  saveCredentialsFromDialog,
} from "./credentials.js";
import {
  addPlan,
  addPriorityPair,
  findPlan,
  findPriorityPair,
  loadStore,
} from "./state.js";
import { runReservation } from "./reservation.js";
import { runPriorityPair } from "./priority.js";
import {
  installOneShotSchedule,
  installPrioritySchedule,
} from "./scheduler.js";
import type { RunMode } from "./types.js";
import { releaseDateFor, shanghaiDate } from "./validation.js";
import { runParallelFeasibility } from "./parallel-feasibility.js";

function parseTimestamp(value: string, optionName: string): Date {
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new Error(`${optionName} 必须包含明确时区，例如 2026-09-21T07:00:00+08:00`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`无法解析 ${optionName}：${value}`);
  }
  return parsed;
}

const program = new Command();
program
  .name("courtscript")
  .description("复旦大学体育场馆预约脚本")
  .showSuggestionAfterError()
  .showHelpAfterError();

const auth = program.command("auth").description("管理独立 Edge 登录态");
auth
  .command("import-edge")
  .description("从已关闭的当前 Edge profile 迁移复旦登录态")
  .action(async () => {
    const result = await importEdgeSession();
    console.log(`AUTH_READY：已迁移 ${result.cookieCount} 个复旦 Cookie`);
  });
auth
  .command("check")
  .description("验证独立浏览器登录态")
  .action(async () => {
    await checkDedicatedSession();
    console.log("AUTH_OK：独立浏览器登录态有效");
  });
auth
  .command("login")
  .description("在普通独立 Edge 中自动完成 eHall 和统一认证登录")
  .action(async () => {
    await manualLogin();
    console.log("AUTH_READY：独立 Edge 登录已保存");
  });
auth
  .command("save-credentials")
  .description("通过系统对话框保存账号，并将密码写入 macOS 钥匙串")
  .action(async () => {
    await saveCredentialsFromDialog();
    console.log("CREDENTIALS_SAVED：账号已保存，密码已写入 macOS 钥匙串");
  });
auth
  .command("clear-credentials")
  .description("删除 CourtScript 保存的账号和钥匙串密码")
  .action(async () => {
    await clearStoredCredentials();
    console.log("CREDENTIALS_CLEARED：已删除保存的凭据");
  });

const plan = program.command("plan").description("管理预约计划");
plan
  .command("add")
  .requiredOption("--date <YYYY-MM-DD>", "预约日期")
  .requiredOption("--slot <HH:mm-HH:mm>", "首选时段")
  .option("--fallback <HH:mm-HH:mm>", "备选时段；可重复", (value, previous: string[]) => [
    ...previous,
    value,
  ], [])
  .action(async (options: { date: string; slot: string; fallback: string[] }) => {
    const created = await addPlan(options.date, options.slot, options.fallback);
    console.log(JSON.stringify(created, null, 2));
  });
plan
  .command("add-priority")
  .description("创建先高后低、分别提交的两个串行时段")
  .option("--date <YYYY-MM-DD>", "两个时段使用同一预约日期")
  .option("--high-date <YYYY-MM-DD>", "高优先级预约日期")
  .option("--low-date <YYYY-MM-DD>", "低优先级预约日期")
  .requiredOption("--high-slot <HH:mm-HH:mm>", "高优先级时段")
  .requiredOption("--low-slot <HH:mm-HH:mm>", "低优先级时段")
  .action(async (options: {
    date: string;
    highDate?: string;
    lowDate?: string;
    highSlot: string;
    lowSlot: string;
  }) => {
    const highDate = options.highDate ?? options.date;
    const lowDate = options.lowDate ?? options.date;
    if (!highDate || !lowDate) {
      throw new Error("必须指定 --date，或同时指定 --high-date 和 --low-date");
    }
    const created = await addPriorityPair(
      highDate,
      options.highSlot,
      lowDate,
      options.lowSlot,
    );
    console.log(JSON.stringify(created, null, 2));
  });
plan
  .command("list")
  .description("列出预约计划")
  .action(async () => {
    const store = await loadStore();
    if (!store.plans.length && !store.priorityPairs.length) {
      console.log("暂无预约计划");
      return;
    }
    const childPlanIds = new Set(
      store.priorityPairs.flatMap((item) => [item.highPlanId, item.lowPlanId]),
    );
    const independentPlans = store.plans.filter((item) => !childPlanIds.has(item.id));
    if (independentPlans.length) {
      console.log("普通计划");
      console.table(
        independentPlans.map((item) => ({
          id: item.id,
          date: item.targetDate,
          slots: item.slots.join(" > "),
          status: item.status,
        })),
      );
    }
    if (store.priorityPairs.length) {
      console.log("优先级串行计划");
      console.table(
        store.priorityPairs.map((item) => ({
          id: item.id,
          high: `${item.highDate} ${item.highSlot}`,
          low: `${item.lowDate} ${item.lowSlot}`,
          status: item.status,
        })),
      );
    }
  });

program
  .command("parallel-feasibility")
  .description("用两个隔离 Edge profile 并发验证两个时段，不提交预约")
  .requiredOption("--date <YYYY-MM-DD>", "验证日期")
  .requiredOption("--slot-a <HH:mm-HH:mm>", "Edge A 的时段")
  .requiredOption("--slot-b <HH:mm-HH:mm>", "Edge B 的时段")
  .action(async (options: { date: string; slotA: string; slotB: string }) => {
    const result = await runParallelFeasibility({
      targetDate: options.date,
      slots: [options.slotA, options.slotB],
    });
    console.log("PARALLEL_FEASIBLE：两个独立 Edge 已同时选中不同时段，未提交");
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("schedule-once")
  .description("安装一次性 launchd 任务，提前登录并在指定时刻提交")
  .requiredOption("--plan <id>", "计划 ID")
  .requiredOption("--at <ISO-8601>", "提交时刻，必须包含时区")
  .option("--prepare-minutes <minutes>", "提前登录并保持唤醒的分钟数", "5")
  .action(async (options: { plan: string; at: string; prepareMinutes: string }) => {
    const selectedPlan = await findPlan(options.plan);
    if (selectedPlan.status === "confirmed") {
      throw new Error("该计划已经预约成功，不会创建重复调度");
    }
    const at = parseTimestamp(options.at, "--at");
    const prepareMinutes = Number(options.prepareMinutes);
    if (!Number.isInteger(prepareMinutes)) {
      throw new Error("--prepare-minutes 必须是整数");
    }
    const releaseDate = releaseDateFor(selectedPlan.targetDate);
    if (shanghaiDate(at) !== releaseDate) {
      throw new Error(
        `目标日期 ${selectedPlan.targetDate} 应在 ${releaseDate} 抢订，调度日期不匹配`,
      );
    }
    const scheduled = await installOneShotSchedule(
      selectedPlan.id,
      at,
      prepareMinutes,
    );
    console.log("SCHEDULED：一次性任务已安装");
    console.log(JSON.stringify(scheduled, null, 2));
  });

program
  .command("schedule-priority")
  .description("安装高优先级准点、低优先级随后立即执行的一次性任务")
  .requiredOption("--pair <id>", "优先级计划 ID")
  .requiredOption("--at <ISO-8601>", "高优先级提交时刻，必须包含时区")
  .option("--prepare-minutes <minutes>", "提前登录并保持唤醒的分钟数", "3")
  .action(async (options: { pair: string; at: string; prepareMinutes: string }) => {
    const selectedPair = await findPriorityPair(options.pair);
    if (selectedPair.status === "confirmed") {
      throw new Error("该优先级计划的两个时段都已预约成功，不会创建重复调度");
    }
    const at = parseTimestamp(options.at, "--at");
    const prepareMinutes = Number(options.prepareMinutes);
    if (!Number.isInteger(prepareMinutes)) {
      throw new Error("--prepare-minutes 必须是整数");
    }
    const releaseDate = releaseDateFor(selectedPair.highDate);
    if (shanghaiDate(at) !== releaseDate) {
      throw new Error(
        `高优先级日期 ${selectedPair.highDate} 应在 ${releaseDate} 抢订，调度日期不匹配`,
      );
    }
    const scheduled = await installPrioritySchedule(
      selectedPair.id,
      at,
      prepareMinutes,
    );
    console.log("SCHEDULED：优先级串行任务已安装");
    console.log(JSON.stringify(scheduled, null, 2));
  });

program
  .command("run")
  .requiredOption("--plan <id>", "计划 ID")
  .option("--dry-run", "停在确认预约前")
  .option("--submit", "真实提交预约")
  .option("--not-before <ISO-8601>", "完成预登录后等待到指定时刻再刷新和提交")
  .option("--max-lateness-seconds <seconds>", "超过指定秒数仍未开始则放弃", "120")
  .action(async (options: {
    plan: string;
    dryRun?: boolean;
    submit?: boolean;
    notBefore?: string;
    maxLatenessSeconds: string;
  }) => {
    if (Boolean(options.dryRun) === Boolean(options.submit)) {
      throw new Error("必须且只能指定 --dry-run 或 --submit");
    }
    const mode: RunMode = options.dryRun ? "dry-run" : "submit";
    let notBefore: Date | undefined;
    if (options.notBefore) {
      notBefore = parseTimestamp(options.notBefore, "--not-before");
    }
    const maxLatenessSeconds = Number(options.maxLatenessSeconds);
    if (!Number.isFinite(maxLatenessSeconds) || maxLatenessSeconds <= 0) {
      throw new Error("--max-lateness-seconds 必须是正数");
    }
    const selectedPlan = await findPlan(options.plan);
    if (mode === "submit" && selectedPlan.status === "confirmed") {
      throw new Error("该计划已经预约成功，不会重复提交");
    }
    const result = await runReservation(selectedPlan, mode, {
      notBefore,
      maxLatenessMs: maxLatenessSeconds * 1_000,
    });
    console.log(result.message);
    console.log(JSON.stringify(result, null, 2));
    if (result.status === "failed" || result.status === "ambiguous") {
      process.exitCode = 2;
    }
  });

program
  .command("run-priority")
  .description("串行执行高、低优先级两个预约计划")
  .requiredOption("--pair <id>", "优先级计划 ID")
  .option("--dry-run", "依次停在两个时段的确认预约前")
  .option("--submit", "依次真实提交两个时段")
  .option("--not-before <ISO-8601>", "高优先级预登录后等待到指定时刻")
  .option("--max-lateness-seconds <seconds>", "高优先级超过指定秒数仍未开始则放弃", "120")
  .action(async (options: {
    pair: string;
    dryRun?: boolean;
    submit?: boolean;
    notBefore?: string;
    maxLatenessSeconds: string;
  }) => {
    if (Boolean(options.dryRun) === Boolean(options.submit)) {
      throw new Error("必须且只能指定 --dry-run 或 --submit");
    }
    const mode: RunMode = options.dryRun ? "dry-run" : "submit";
    if (mode === "dry-run" && options.notBefore) {
      throw new Error("--not-before 只允许用于 --submit");
    }
    const notBefore = options.notBefore
      ? parseTimestamp(options.notBefore, "--not-before")
      : undefined;
    const maxLatenessSeconds = Number(options.maxLatenessSeconds);
    if (!Number.isFinite(maxLatenessSeconds) || maxLatenessSeconds <= 0) {
      throw new Error("--max-lateness-seconds 必须是正数");
    }
    const selectedPair = await findPriorityPair(options.pair);
    if (mode === "submit" && selectedPair.status === "confirmed") {
      throw new Error("该优先级计划的两个时段都已预约成功，不会重复提交");
    }
    const result = await runPriorityPair(selectedPair, mode, {
      notBefore,
      maxLatenessMs: maxLatenessSeconds * 1_000,
    });
    console.log(result.message);
    console.log(JSON.stringify(result, null, 2));
    if (["failed", "partial", "ambiguous"].includes(result.status)) {
      process.exitCode = 2;
    }
  });

program.parseAsync().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`ERROR：${message}`);
  process.exitCode = 1;
});
