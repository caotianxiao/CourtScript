#!/usr/bin/env node
import { Command } from "commander";
import { importEdgeSession, checkDedicatedSession, manualLogin } from "./auth.js";
import {
  clearStoredCredentials,
  saveCredentialsFromDialog,
} from "./credentials.js";
import { addPlan, findPlan, loadStore } from "./state.js";
import { runReservation } from "./reservation.js";
import { installOneShotSchedule } from "./scheduler.js";
import type { RunMode } from "./types.js";
import { releaseDateFor, shanghaiDate } from "./validation.js";

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
  .command("list")
  .description("列出预约计划")
  .action(async () => {
    const store = await loadStore();
    if (!store.plans.length) {
      console.log("暂无预约计划");
      return;
    }
    console.table(
      store.plans.map((item) => ({
        id: item.id,
        date: item.targetDate,
        slots: item.slots.join(" > "),
        status: item.status,
      })),
    );
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

program.parseAsync().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`ERROR：${message}`);
  process.exitCode = 1;
});
