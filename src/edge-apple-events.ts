import { spawn } from "node:child_process";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { EDGE_EXECUTABLE, PROFILE_DIR } from "./constants.js";
import { join } from "node:path";

const execFileAsync = promisify(execFile);
const EDGE_APP = "Microsoft Edge";
const COURT_HOSTS = [
  "booking.fudan.edu.cn",
  "id.fudan.edu.cn",
  "ehall.fudan.edu.cn",
];

function appleString(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\r", "\\r")
    .replaceAll("\n", "\\n");
}

async function runAppleScript(source: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("osascript", ["-"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let settled = false;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error("Apple Events 调用超时（8 秒）"));
    }, 8_000);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString("utf8").replace(/\r?\n$/, ""));
        return;
      }
      reject(new Error(
        Buffer.concat(stderr).toString("utf8").trim()
          || `osascript 退出码 ${code ?? "unknown"}`,
      ));
    });
    child.stdin.end(source);
  });
}

function targetTabScript(action: string): string {
  const hostTests = COURT_HOSTS
    .map((host) => `theUrl contains "${appleString(host)}"`)
    .join(" or ");
  return `
tell application "${EDGE_APP}"
  set targetTab to missing value
  set targetWindow to missing value
  set targetTabIndex to 0
  if (count of windows) > 0 then
    set currentWindow to front window
    set currentTab to active tab of currentWindow
    set theUrl to URL of currentTab
    if ${hostTests} then
      set targetTab to currentTab
      set targetWindow to currentWindow
      set targetTabIndex to active tab index of currentWindow
    end if
  end if
  repeat with currentWindow in windows
    if targetTab is not missing value then exit repeat
    set currentTabIndex to 0
    repeat with currentTab in tabs of currentWindow
      set currentTabIndex to currentTabIndex + 1
      set theUrl to URL of currentTab
      if ${hostTests} then
        set targetTab to currentTab
        set targetWindow to currentWindow
        set targetTabIndex to currentTabIndex
        exit repeat
      end if
    end repeat
    if targetTab is not missing value then exit repeat
  end repeat
  if targetTab is missing value then error "找不到 CourtScript 的复旦标签页"
  ${action}
end tell
`;
}

export async function ensureAppleEventsPreference(): Promise<void> {
  const preferencesPath = join(PROFILE_DIR, "Default", "Preferences");
  const preferences = JSON.parse(await readFile(preferencesPath, "utf8")) as {
    browser?: Record<string, unknown>;
    profile?: Record<string, unknown>;
    session?: Record<string, unknown>;
  };
  preferences.browser ??= {};
  preferences.browser.allow_javascript_apple_events = true;
  // Edge restores every old tab after a forced/crashed exit.  That makes
  // Apple Events attach to a stale Fudan tab after wake instead of the fresh
  // eHall entry point.  This profile is dedicated to CourtScript, so always
  // start it as a clean, single-purpose browser session.
  preferences.profile ??= {};
  preferences.profile.exit_type = "Normal";
  preferences.profile.exited_cleanly = true;
  preferences.session ??= {};
  preferences.session.restore_on_startup = 5;
  preferences.session.startup_urls = [];
  await writeFile(preferencesPath, JSON.stringify(preferences), { mode: 0o600 });
  await chmod(preferencesPath, 0o600);
}

export async function launchNormalEdge(url: string): Promise<void> {
  await ensureAppleEventsPreference();
  await execFileAsync("open", [
    "-na",
    EDGE_APP,
    "--args",
    `--user-data-dir=${PROFILE_DIR}`,
    "--profile-directory=Default",
    "--disable-sync",
    "--no-first-run",
    "--no-default-browser-check",
    "--hide-crash-restore-bubble",
    "--disable-session-crashed-bubble",
    "--disable-features=msEdgeSidebarV2",
    "--new-window",
    "--window-size=1440,1000",
    url,
  ]);
}

async function dedicatedEdgePids(): Promise<number[]> {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,command="]);
  return stdout
    .split("\n")
    .filter((line) =>
      line.includes(EDGE_EXECUTABLE)
      && line.includes(`--user-data-dir=${PROFILE_DIR}`)
      && !line.includes("/Helpers/"),
    )
    .map((line) => Number.parseInt(line.trim().split(/\s+/, 1)[0] ?? "", 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

export async function stopDedicatedEdge(): Promise<void> {
  const pids = await dedicatedEdgePids();
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        throw error;
      }
    }
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && (await dedicatedEdgePids()).length > 0) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const remaining = await dedicatedEdgePids();
  if (remaining.length > 0) {
    throw new Error(`CourtScript 独立 Edge 未能正常退出：${remaining.join(",")}`);
  }
}

export async function executeCourtJavaScript(javaScript: string): Promise<string> {
  const action = `return execute targetTab javascript "${appleString(javaScript)}"`;
  return runAppleScript(targetTabScript(action));
}

export async function focusCourtTab(): Promise<void> {
  await runAppleScript(targetTabScript(`
    set active tab index of targetWindow to targetTabIndex
    set index of targetWindow to 1
    activate
  `));
}

export async function closeCourtWindow(): Promise<void> {
  await runAppleScript(targetTabScript("close targetWindow"));
}

export async function captureCourtWindow(path: string): Promise<void> {
  const bounds = await runAppleScript(targetTabScript(`
    set active tab index of targetWindow to targetTabIndex
    set index of targetWindow to 1
    activate
    return bounds of targetWindow
  `));
  const values = bounds.split(",").map((value) => Number.parseInt(value.trim(), 10));
  const [left, top, right, bottom] = values;
  if (
    values.length !== 4
    || [left, top, right, bottom].some((value) => !Number.isFinite(value))
    || left === undefined
    || top === undefined
    || right === undefined
    || bottom === undefined
  ) {
    throw new Error(`无法读取 Edge 窗口边界：${bounds}`);
  }
  await execFileAsync("screencapture", [
    "-x",
    "-R",
    `${left},${top},${right - left},${bottom - top}`,
    path,
  ]);
  await chmod(path, 0o600);
}

export async function waitForCourtJavaScript<T>(
  javaScript: string,
  accept: (value: T) => boolean,
  timeoutMs: number,
  description: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastValue: T | undefined;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const output = await executeCourtJavaScript(javaScript);
      lastValue = JSON.parse(output) as T;
      if (accept(lastValue)) {
        return lastValue;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  const detail = lastValue === undefined
    ? (lastError instanceof Error ? lastError.message : String(lastError ?? "无页面结果"))
    : JSON.stringify(lastValue).slice(0, 500);
  throw new Error(`${description}超时：${detail}`);
}
