import { execFile } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { PROJECT_ROOT, STATE_DIR } from "./constants.js";

const execFileAsync = promisify(execFile);

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function localParts(date: Date): {
  month: number;
  day: number;
  hour: number;
  minute: number;
} {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(
    parts.find((part) => part.type === type)?.value,
  );
  return {
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
  };
}

export interface OneShotSchedule {
  label: string;
  at: string;
  prepareAt: string;
  plistPath: string;
  logPath: string;
}

export interface HardwareWakeSchedule {
  wakeAt: string;
  reused: boolean;
}

interface ShanghaiDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function shanghaiDateTimeParts(date: Date): ShanghaiDateTimeParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(
    parts.find((part) => part.type === type)?.value,
  );
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
  };
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

export function hardwareWakeAt(at: Date, minutesBefore: number): Date {
  if (!Number.isInteger(minutesBefore) || minutesBefore < 1 || minutesBefore > 30) {
    throw new Error("--wake-minutes-before 必须是 1–30 的整数");
  }
  return new Date(at.getTime() - minutesBefore * 60_000);
}

export function pmsetDate(wakeAt: Date, fourDigitYear = false): string {
  const parts = shanghaiDateTimeParts(wakeAt);
  const year = fourDigitYear ? String(parts.year) : twoDigits(parts.year % 100);
  return [
    `${twoDigits(parts.month)}/${twoDigits(parts.day)}/${year}`,
    `${twoDigits(parts.hour)}:${twoDigits(parts.minute)}:${twoDigits(parts.second)}`,
  ].join(" ");
}

function appleScriptString(value: string): string {
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\r", "\\r")
    .replaceAll("\n", "\\n")}"`;
}

export async function installHardwareWake(wakeAt: Date): Promise<HardwareWakeSchedule> {
  if (wakeAt.getTime() <= Date.now()) {
    throw new Error("硬件唤醒时间已经过去，未创建调度任务");
  }
  const commandDate = pmsetDate(wakeAt);
  const displayedDate = pmsetDate(wakeAt, true);
  const { stdout: existing } = await execFileAsync("/usr/bin/pmset", ["-g", "sched"]);
  const expected = `wakeorpoweron at ${displayedDate}`;
  if (existing.includes(expected)) {
    return { wakeAt: wakeAt.toISOString(), reused: true };
  }

  const shellCommand = `/usr/bin/pmset schedule wakeorpoweron "${commandDate}"`;
  await execFileAsync("/usr/bin/osascript", [
    "-e",
    `do shell script ${appleScriptString(shellCommand)} with administrator privileges`,
  ]);
  const { stdout: installed } = await execFileAsync("/usr/bin/pmset", ["-g", "sched"]);
  if (!installed.includes(expected)) {
    throw new Error(`未能从 pmset 回读硬件唤醒事件：${displayedDate}`);
  }
  return { wakeAt: wakeAt.toISOString(), reused: false };
}

async function installSchedule(
  labelSuffix: string,
  cliArguments: string[],
  at: Date,
  prepareMinutes: number,
): Promise<OneShotSchedule> {
  if (!Number.isInteger(prepareMinutes) || prepareMinutes < 1 || prepareMinutes > 30) {
    throw new Error("--prepare-minutes 必须是 1–30 的整数");
  }
  const prepareAt = new Date(at.getTime() - prepareMinutes * 60_000);
  if (prepareAt.getTime() <= Date.now()) {
    throw new Error("预登录时间已经过去，未创建调度任务");
  }

  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new Error("当前系统不支持用户级 launchd 调度");
  }
  const label = `cn.edu.fudan.courtscript.${labelSuffix}`;
  const schedulerDir = join(STATE_DIR, "scheduler");
  const launchAgentsDir = join(process.env.HOME ?? "", "Library", "LaunchAgents");
  if (!process.env.HOME) {
    throw new Error("无法确定用户主目录");
  }
  await mkdir(schedulerDir, { recursive: true, mode: 0o700 });
  await mkdir(launchAgentsDir, { recursive: true, mode: 0o700 });

  const runnerPath = join(schedulerDir, `${label}.mjs`);
  const logPath = join(schedulerDir, `${label}.log`);
  const plistPath = join(launchAgentsDir, `${label}.plist`);
  const atIso = at.toISOString();
  const serviceTarget = `gui/${uid}/${label}`;
  const runner = `
import { spawn } from "node:child_process";
import { unlink } from "node:fs/promises";

const commandArguments = ${JSON.stringify([
  process.execPath,
  join(PROJECT_ROOT, "bin", "courtscript.js"),
])}.concat(${JSON.stringify(cliArguments)});
const child = spawn("/usr/bin/caffeinate", [
  "-dimsu",
  ...commandArguments
], {
  cwd: ${JSON.stringify(PROJECT_ROOT)},
  env: {...process.env, TZ: "Asia/Shanghai"},
  stdio: "inherit"
});

const exitCode = await new Promise((resolve) => {
  child.once("error", () => resolve(1));
  child.once("close", (code) => resolve(code ?? 1));
});
await Promise.all([
  unlink(${JSON.stringify(plistPath)}).catch(() => undefined),
  unlink(${JSON.stringify(runnerPath)}).catch(() => undefined)
]);
const cleanup = spawn("/bin/launchctl", [
  "bootout", ${JSON.stringify(serviceTarget)}
], {detached: true, stdio: "ignore"});
cleanup.unref();
process.exitCode = exitCode;
`;
  await writeFile(runnerPath, runner.trimStart(), { mode: 0o700 });
  await chmod(runnerPath, 0o700);

  const calendar = localParts(prepareAt);
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(process.execPath)}</string>
    <string>${xml(runnerPath)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(PROJECT_ROOT)}</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Month</key><integer>${calendar.month}</integer>
    <key>Day</key><integer>${calendar.day}</integer>
    <key>Hour</key><integer>${calendar.hour}</integer>
    <key>Minute</key><integer>${calendar.minute}</integer>
  </dict>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>${xml(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(logPath)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>TZ</key>
    <string>Asia/Shanghai</string>
  </dict>
</dict>
</plist>
`;
  await writeFile(plistPath, plist, { mode: 0o600 });
  await chmod(plistPath, 0o600);

  await execFileAsync("launchctl", ["bootout", serviceTarget]).catch(() => undefined);
  await execFileAsync("launchctl", ["bootstrap", `gui/${uid}`, plistPath]);
  await execFileAsync("launchctl", ["enable", serviceTarget]);

  return {
    label,
    at: atIso,
    prepareAt: prepareAt.toISOString(),
    plistPath,
    logPath,
  };
}

export async function installOneShotSchedule(
  planId: string,
  at: Date,
  prepareMinutes: number,
): Promise<OneShotSchedule> {
  return installSchedule(
    planId,
    [
      "run",
      "--plan", planId,
      "--submit",
      "--not-before", at.toISOString(),
      "--max-lateness-seconds", "120",
    ],
    at,
    prepareMinutes,
  );
}

export async function installPrioritySchedule(
  pairId: string,
  at: Date,
  prepareMinutes: number,
): Promise<OneShotSchedule> {
  return installSchedule(
    `priority.${pairId}`,
    [
      "run-priority",
      "--pair", pairId,
      "--submit",
      "--not-before", at.toISOString(),
      "--max-lateness-seconds", "120",
    ],
    at,
    prepareMinutes,
  );
}

export async function installParallelSchedule(
  targetDate: string,
  slotA: string,
  slotB: string,
  at: Date,
  prepareMinutes: number,
  submitDelayMs: number,
): Promise<OneShotSchedule> {
  const suffix = [targetDate, slotA, slotB]
    .join(".")
    .replaceAll(":", "")
    .replaceAll("-", "");
  return installSchedule(
    `parallel.${suffix}`,
    [
      "run-parallel",
      "--date", targetDate,
      "--slot-a", slotA,
      "--slot-b", slotB,
      "--submit",
      "--submit-delay-ms", String(submitDelayMs),
      "--seed-profile",
      "--not-before", at.toISOString(),
      "--max-lateness-seconds", "120",
      "--login-attempts", "3",
      "--login-timeout-seconds", "25",
    ],
    at,
    prepareMinutes,
  );
}
