import {
  chmod,
  cp,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chromium, type BrowserContext, type Cookie } from "playwright-core";
import {
  EDGE_EXECUTABLE,
  EDGE_PROFILE_NAME,
  EDGE_USER_DATA,
  FUDAN_SUFFIX,
  PROFILE_DIR,
  RESERVATION_URL,
  STATE_DIR,
} from "./constants.js";
import {
  launchDedicatedContext,
  skipDebuggerPauses,
  verifyEdgeInstalled,
} from "./browser.js";
import { openAuthenticatedReservationPage, currentPageState } from "./booking-browser.js";
import { closeCourtWindow, stopDedicatedEdge } from "./edge-apple-events.js";

const COPY_ENTRIES = [
  "Cookies",
  "Cookies-journal",
  "Cookies-wal",
  "Cookies-shm",
  "Network",
  "Preferences",
  "Secure Preferences",
  "Local Storage",
  "Session Storage",
  "Sessions",
  "Current Session",
  "Current Tabs",
  "Last Session",
  "Last Tabs",
  "IndexedDB",
  "WebStorage",
];

const execFileAsync = promisify(execFile);

function isFudanHost(value: string): boolean {
  const host = value.replace(/^\./, "").toLowerCase();
  return host === FUDAN_SUFFIX || host.endsWith(`.${FUDAN_SUFFIX}`);
}

async function copyIfPresent(source: string, destination: string): Promise<void> {
  try {
    await stat(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await cp(source, destination, { recursive: true, force: true });
}

async function copySourceProfile(tempRoot: string): Promise<string> {
  const temporaryData = join(tempRoot, "user-data");
  const sourceProfile = join(EDGE_USER_DATA, EDGE_PROFILE_NAME);
  const temporaryProfile = join(temporaryData, EDGE_PROFILE_NAME);
  await mkdir(temporaryProfile, { recursive: true, mode: 0o700 });
  await copyIfPresent(join(EDGE_USER_DATA, "Local State"), join(temporaryData, "Local State"));
  for (const entry of COPY_ENTRIES) {
    await copyIfPresent(join(sourceProfile, entry), join(temporaryProfile, entry));
  }
  return temporaryData;
}

async function preserveFudanSessionCookies(temporaryData: string): Promise<void> {
  const database = join(temporaryData, EDGE_PROFILE_NAME, "Cookies");
  const chromiumEpochSeconds = 11_644_473_600;
  const expiresUtc =
    (Math.floor(Date.now() / 1_000) + 24 * 60 * 60 + chromiumEpochSeconds) *
    1_000_000;
  const sql = [
    "BEGIN IMMEDIATE",
    `UPDATE cookies SET has_expires=1, is_persistent=1, expires_utc=${Math.trunc(expiresUtc)} WHERE host_key LIKE '%fudan.edu.cn' AND is_persistent=0`,
    "COMMIT",
  ].join(";");
  await execFileAsync("sqlite3", [database, sql]);
}

async function importLocalStorage(
  context: BrowserContext,
  origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>,
): Promise<void> {
  for (const item of origins) {
    const host = new URL(item.origin).hostname;
    if (!isFudanHost(host) || !item.localStorage.length) {
      continue;
    }
    const page = await context.newPage();
    await page.goto(item.origin, { waitUntil: "commit", timeout: 20_000 });
    await page.evaluate((values) => {
      localStorage.clear();
      for (const { name, value } of values) {
        localStorage.setItem(name, value);
      }
    }, item.localStorage);
    await page.close();
  }
}

async function verifyDedicatedLogin(): Promise<void> {
  try {
    await openAuthenticatedReservationPage();
    const state = await currentPageState();
    if (!state.url.includes("reservationInfo?id=1055") || !state.calendar) {
      throw new Error("独立浏览器未到达羽毛球预约表格");
    }
  } finally {
    await closeCourtWindow().catch(() => undefined);
    await stopDedicatedEdge().catch(() => undefined);
  }
}

export async function importEdgeSession(): Promise<{ cookieCount: number }> {
  await verifyEdgeInstalled();
  await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  await chmod(STATE_DIR, 0o700);
  const marker = join(PROFILE_DIR, ".courtscript-profile");
  try {
    await stat(marker);
    throw new Error("独立 profile 已存在；为避免覆盖，请先使用 auth check");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const tempRoot = await mkdtemp(join(tmpdir(), "courtscript-edge-"));
  let sourceContext: BrowserContext | undefined;
  let dedicatedContext: BrowserContext | undefined;
  try {
    const temporaryData = await copySourceProfile(tempRoot);
    await preserveFudanSessionCookies(temporaryData);
    sourceContext = await chromium.launchPersistentContext(temporaryData, {
      executablePath: EDGE_EXECUTABLE,
      headless: true,
      ignoreDefaultArgs: ["--enable-automation"],
      args: [
        `--profile-directory=${EDGE_PROFILE_NAME}`,
        "--restore-last-session",
        "--disable-sync",
        "--disable-blink-features=AutomationControlled",
        "--no-first-run",
        "--no-default-browser-check",
      ],
    });
    await sourceContext.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, "webdriver", {
        configurable: true,
        get: () => undefined,
      });
    });
    const fudanUrls = [
      "https://booking.fudan.edu.cn/",
      "https://ehall.fudan.edu.cn/",
      "https://id.fudan.edu.cn/",
    ];
    let cookies = (await sourceContext.cookies(fudanUrls)).filter((cookie) =>
      isFudanHost(cookie.domain),
    );
    if (!cookies.length) {
      const probe = sourceContext.pages()[0] ?? (await sourceContext.newPage());
      await skipDebuggerPauses(sourceContext, probe);
      await probe.goto(RESERVATION_URL, {
        waitUntil: "commit",
        timeout: 20_000,
      });
      cookies = (await sourceContext.cookies(fudanUrls)).filter((cookie) =>
        isFudanHost(cookie.domain),
      );
    }
    const storage = await sourceContext.storageState();
    const origins = storage.origins.filter((origin) =>
      isFudanHost(new URL(origin.origin).hostname),
    );
    await sourceContext.close();
    sourceContext = undefined;
    if (!cookies.length) {
      throw new Error("当前 Edge profile 中没有可迁移的复旦 Cookie");
    }

    await mkdir(PROFILE_DIR, { recursive: true, mode: 0o700 });
    await chmod(PROFILE_DIR, 0o700);
    dedicatedContext = await launchDedicatedContext({ headless: true });
    await dedicatedContext.clearCookies();
    await dedicatedContext.addCookies(cookies as Cookie[]);
    await importLocalStorage(dedicatedContext, origins);
    await writeFile(marker, "CourtScript dedicated Edge profile\n", { mode: 0o600 });
    await dedicatedContext.close();
    dedicatedContext = undefined;

    await verifyDedicatedLogin().catch((error) => {
      const hosts = origins
        .map((origin) => new URL(origin.origin).hostname)
        .join(",");
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${message}；已导入复旦 Cookie=${cookies.length}，LocalStorage 来源=${hosts || "无"}`,
      );
    });
    return { cookieCount: cookies.length };
  } catch (error) {
    await rm(PROFILE_DIR, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  } finally {
    await sourceContext?.close().catch(() => undefined);
    await dedicatedContext?.close().catch(() => undefined);
    await rm(tempRoot, { recursive: true, force: true });
  }
}

export async function checkDedicatedSession(): Promise<void> {
  await verifyDedicatedLogin();
}

export async function manualLogin(): Promise<void> {
  await mkdir(PROFILE_DIR, { recursive: true, mode: 0o700 });
  try {
    process.stdout.write(
      "正在普通独立 Edge 中从 eHall 完成登录并进入羽毛球预约页。\n",
    );
    await openAuthenticatedReservationPage();
    await writeFile(join(PROFILE_DIR, ".courtscript-profile"), "CourtScript dedicated Edge profile\n", {
      mode: 0o600,
    });
  } finally {
    await closeCourtWindow().catch(() => undefined);
    await stopDedicatedEdge().catch(() => undefined);
  }
}
