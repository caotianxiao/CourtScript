import { spawn, type ChildProcess } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { chmod, cp, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import {
  EDGE_EXECUTABLE,
  LAUNCH_PATH,
  PROFILE_DIR,
  RESERVATION_URL,
  STATE_DIR,
} from "./constants.js";
import { loadStoredCredentials, type StoredCredentials } from "./credentials.js";
import { EHALL_URL, SPECIAL_URL } from "./selenium-browser.js";
import { validateDate, validateSlot } from "./validation.js";
import {
  decideWeekNavigation,
  type WeekNavigationSnapshot,
} from "./week-navigation.js";

const EXPERIMENT_ROOT = join(STATE_DIR, "parallel-feasibility");
const PAGE_TIMEOUT = 75_000;
const GRID_TIMEOUT = 30_000;

interface GridState {
  ready: boolean;
  availableSlots: string[];
  timeCount: number;
  cellCount: number;
}

interface EdgeInstance {
  label: "A" | "B";
  profileDir: string;
  port: number;
  process: ChildProcess;
  cdp: RawCdpClient;
  page: RawCdpPage;
  loginMs: number;
  fudanCookieCount: number;
  webdriverExposed: boolean;
}

interface CdpResponse {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

class RawCdpClient {
  private nextId = 1;
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private readonly listeners = new Map<string, Array<(params: unknown) => void>>();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as CdpResponse;
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) {
          pending.reject(new Error(`CDP ${message.error.code}：${message.error.message}`));
        } else {
          pending.resolve(message.result);
        }
        return;
      }
      if (message.method) {
        for (const listener of this.listeners.get(message.method) ?? []) {
          listener(message.params);
        }
      }
    });
    socket.addEventListener("close", () => {
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Edge CDP 连接已关闭"));
        this.pending.delete(id);
      }
    });
  }

  static async connect(url: string): Promise<RawCdpClient> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("连接 Edge CDP 超时")), 10_000);
      socket.addEventListener("open", () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error("连接 Edge CDP 失败"));
      }, { once: true });
    });
    return new RawCdpClient(socket);
  }

  send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 8_000,
  ): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 超时`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method: string, listener: (params: unknown) => void): void {
    const listeners = this.listeners.get(method) ?? [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
  }

  close(): void {
    this.socket.close();
  }
}

class RawCdpPage {
  constructor(readonly cdp: RawCdpClient) {}

  async evaluate<Result, Argument = undefined>(
    pageFunction: string | ((argument: Argument) => Result),
    argument?: Argument,
  ): Promise<Awaited<Result>> {
    const expression = typeof pageFunction === "string"
      ? pageFunction
      : `(${pageFunction.toString()})(${JSON.stringify(argument)})`;
    const response = await this.cdp.send<{
      result?: { value?: Awaited<Result>; description?: string };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (response.exceptionDetails) {
      throw new Error(
        response.exceptionDetails.exception?.description
          ?? response.exceptionDetails.text
          ?? "页面脚本执行失败",
      );
    }
    return response.result?.value as Awaited<Result>;
  }

  async navigate(url: string): Promise<void> {
    await this.cdp.send("Page.navigate", { url });
  }

  async reload(): Promise<void> {
    await this.cdp.send("Page.reload", { ignoreCache: true });
  }
}

interface BrowserProbe {
  label: "A" | "B";
  profileDir: string;
  rootPid: number;
  debuggingPort: number;
  loginMs: number;
  fudanCookieCount: number;
  webdriverExposed: boolean;
  selectedSlot: string;
  availability: string;
  availableAfterRefresh: boolean;
  selected: boolean;
  submitted: boolean;
  error?: string;
  refreshMs: number;
  selectionMs: number;
  launchRequests: number;
  launchResponseStatuses: number[];
  launchResponseBodies: string[];
}

export interface ParallelFeasibilityResult {
  status: "feasible" | "confirmed" | "partial" | "failed" | "ambiguous";
  mode: "dry-run" | "submit";
  controlMethod: "ordinary-edge-raw-cdp";
  targetDate: string;
  requestedSlots: [string, string];
  testedSlots: [string, string];
  distinctRootProcesses: boolean;
  distinctProfiles: boolean;
  refreshStartSkewMs: number;
  requestedSubmitDelayMs?: number;
  submitStartSkewMs?: number;
  simultaneousSelectionsHeld: boolean;
  availableAfterRefresh: [boolean, boolean];
  selectedLanes: [boolean, boolean];
  submittedLanes: [boolean, boolean];
  recordsFound?: [boolean, boolean];
  browsers: [BrowserProbe, BrowserProbe];
}

export interface ParallelLanePlan {
  index: 0 | 1;
  label: "A" | "B";
  available: boolean;
  submitDelayMs: number;
}

export function buildParallelLanePlan(
  availableAfterRefresh: [boolean, boolean],
  submitDelayMs: number,
): [ParallelLanePlan, ParallelLanePlan] {
  return [
    { index: 0, label: "A", available: availableAfterRefresh[0], submitDelayMs: 0 },
    { index: 1, label: "B", available: availableAfterRefresh[1], submitDelayMs },
  ];
}

export function runIndependentLanePipelines<A, B>(
  laneA: () => Promise<A>,
  laneB: () => Promise<B>,
): Promise<[PromiseSettledResult<A>, PromiseSettledResult<B>]> {
  return Promise.allSettled([laneA(), laneB()]);
}

export function parallelSubmitStatus(
  submittedLanes: [boolean, boolean],
  recordsFound?: [boolean, boolean],
): ParallelFeasibilityResult["status"] {
  const submittedCount = submittedLanes.filter(Boolean).length;
  if (submittedCount === 0) return "failed";
  if (!recordsFound) return "ambiguous";
  const confirmedCount = submittedLanes.filter((submitted, index) =>
    submitted && Boolean(recordsFound[index])
  ).length;
  if (confirmedCount !== submittedCount) return "ambiguous";
  return submittedCount === 2 ? "confirmed" : "partial";
}

async function freeLocalPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("无法分配本地 CDP 端口");
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return port;
}

async function waitForCdp(port: number): Promise<string> {
  const deadline = Date.now() + 20_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const targets = await response.json() as Array<{
          type?: string;
          webSocketDebuggerUrl?: string;
        }>;
        const target = targets.find((item) =>
          item.type === "page" && item.webSocketDebuggerUrl,
        );
        if (target?.webSocketDebuggerUrl) return target.webSocketDebuggerUrl;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Edge CDP ${port} 未就绪：${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

async function launchOrdinaryEdge(
  label: "A" | "B",
  profileDir: string,
  port: number,
): Promise<EdgeInstance> {
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  await chmod(profileDir, 0o700);
  console.log(`[${new Date().toISOString()}] PARALLEL_PHASE：启动普通 Edge ${label}`);
  const child = spawn(EDGE_EXECUTABLE, [
    `--user-data-dir=${profileDir}`,
    "--profile-directory=Default",
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    "--disable-sync",
    "--disable-component-update",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--no-first-run",
    "--no-default-browser-check",
    "--hide-crash-restore-bubble",
    "--disable-session-crashed-bubble",
    "--disable-features=msEdgeSidebarV2",
    "--window-size=1280,900",
    "about:blank",
  ], { stdio: "ignore" });
  try {
    const webSocketUrl = await waitForCdp(port);
    const cdp = await RawCdpClient.connect(webSocketUrl);
    const page = new RawCdpPage(cdp);
    return {
      label,
      profileDir,
      port,
      process: child,
      cdp,
      page,
      loginMs: 0,
      fudanCookieCount: 0,
      webdriverExposed: false,
    };
  } catch (error) {
    child.kill("SIGTERM");
    throw error;
  }
}

interface PageState {
  url: string;
  text: string;
  bodyLength: number;
  usernameInput: boolean;
  passwordInput: boolean;
  calendar: boolean;
  ehallService: boolean;
  ehallLogin: boolean;
}

async function readPageState(page: RawCdpPage): Promise<PageState | undefined> {
  return page.evaluate(() => ({
    url: location.href,
    text: document.body?.innerText.slice(0, 500) ?? "",
    bodyLength: document.body?.innerText.length ?? 0,
    usernameInput: Boolean(document.querySelector(
      '#login-username, input[name="username"], input[placeholder*="用户名"]',
    )),
    passwordInput: Boolean(document.querySelector('input[type="password"]')),
    calendar: Boolean(document.querySelector(".week_calendar")),
    ehallService: document.body?.innerText.includes("体育场馆个人预约") ?? false,
    ehallLogin: Array.from(document.querySelectorAll(".right.login_btn")).some((item) => {
      const rect = item.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0
        && getComputedStyle(item).visibility !== "hidden";
    }),
  })).catch(() => undefined);
}

async function assign(page: RawCdpPage, url: string): Promise<void> {
  await page.navigate(url).catch(() => undefined);
}

async function openReservation(
  instance: EdgeInstance,
  credentials: StoredCredentials,
  timeoutMs = PAGE_TIMEOUT,
): Promise<void> {
  const started = Date.now();
  await assign(instance.page, EHALL_URL);
  const deadline = Date.now() + timeoutMs;
  let loginSubmitted = false;
  let lastLoginClick = 0;
  let specialStarted = false;
  let resourceStarted = false;
  let lastState: PageState | undefined;

  while (Date.now() < deadline) {
    lastState = await readPageState(instance.page);
    if (!lastState) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      continue;
    }
    if (/滑块|验证码|captcha/i.test(lastState.text)) {
      throw new Error(`Edge ${instance.label} 出现验证码或滑块`);
    }
    if (lastState.url.includes("id.fudan.edu.cn")) {
      if (!loginSubmitted && lastState.usernameInput && lastState.passwordInput) {
        const result = await instance.page.evaluate(({ usernameValue, passwordValue }) => {
          const username = document.querySelector<HTMLInputElement>(
            '#login-username, input[name="username"], input[placeholder*="用户名"]',
          );
          const password = document.querySelector<HTMLInputElement>(
            '#login-password, input[name="password"], input[type="password"]',
          );
          const button = Array.from(document.querySelectorAll("button"))
            .find((item) => item.textContent?.trim() === "登录");
          if (!username || !password || !button) return false;
          const setValue = (element: HTMLInputElement, value: string) => {
            const setter = Object.getOwnPropertyDescriptor(
              HTMLInputElement.prototype,
              "value",
            )?.set;
            setter?.call(element, value);
            element.dispatchEvent(new Event("input", { bubbles: true }));
            element.dispatchEvent(new Event("change", { bubbles: true }));
          };
          setValue(username, usernameValue);
          setValue(password, passwordValue);
          window.setTimeout(() => (button as HTMLElement).click(), 100);
          return true;
        }, {
          usernameValue: credentials.username,
          passwordValue: credentials.password,
        }).catch(() => false);
        loginSubmitted = result;
      }
    } else if (lastState.url.includes("ehall.fudan.edu.cn")) {
      if (lastState.ehallLogin) {
        if (Date.now() - lastLoginClick > 2_000) {
          await instance.page.evaluate(() => {
            const button = Array.from(document.querySelectorAll<HTMLElement>(
              ".right.login_btn",
            )).find((item) => {
              const rect = item.getBoundingClientRect();
              return rect.width > 0 && rect.height > 0
                && getComputedStyle(item).visibility !== "hidden";
            });
            if (!button) return false;
            window.open = ((url?: string | URL) => {
              if (url) location.assign(String(url));
              return window;
            }) as typeof window.open;
            document.querySelectorAll<HTMLAnchorElement>('a[target="_blank"]')
              .forEach((item) => item.target = "_self");
            button.click();
            return true;
          }).catch(() => false);
          lastLoginClick = Date.now();
        }
      } else if (lastState.ehallService && !specialStarted) {
        await assign(instance.page, SPECIAL_URL);
        specialStarted = true;
      }
    } else if (lastState.url.includes("reservationInfo?id=1055")) {
      if (lastState.calendar) {
        instance.loginMs = Date.now() - started;
        const cookieResult = await instance.cdp.send<{
          cookies?: Array<{ domain?: string }>;
        }>("Storage.getCookies").catch(() => ({ cookies: [] }));
        instance.fudanCookieCount = (cookieResult.cookies ?? []).filter((cookie) =>
          (cookie.domain ?? "").replace(/^\./, "").endsWith("fudan.edu.cn"),
        ).length;
        instance.webdriverExposed = Boolean(await instance.page.evaluate(
          () => navigator.webdriver === true,
        ));
        console.log(
          `[${new Date().toISOString()}] PARALLEL_PHASE：Edge ${instance.label} 已登录并进入预约表`,
        );
        return;
      }
    } else if (
      lastState.url.includes("booking.fudan.edu.cn")
      && lastState.bodyLength > 0
      && !resourceStarted
    ) {
      await assign(instance.page, RESERVATION_URL);
      resourceStarted = true;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    `Edge ${instance.label} 进入预约表超时：${JSON.stringify(lastState ?? {}).slice(0, 400)}`,
  );
}

async function openReservationWithRetries(
  instance: EdgeInstance,
  credentials: StoredCredentials,
  attempts: number,
  timeoutMs: number,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await openReservation(instance, credentials, timeoutMs);
      return;
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) break;
      console.log(
        `[${new Date().toISOString()}] PARALLEL_PHASE：Edge ${instance.label} 登录失败，重新从 eHall 尝试（${attempt + 1}/${attempts}）`,
      );
      await assign(instance.page, EHALL_URL);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastError;
}

async function waitUntilRelease(at: Date, maxLatenessMs: number): Promise<void> {
  if (Date.now() > at.getTime() + maxLatenessMs) {
    throw new Error(`已错过双提交执行窗口：${at.toISOString()}`);
  }
  while (Date.now() < at.getTime()) {
    const remaining = at.getTime() - Date.now();
    await new Promise((resolve) => setTimeout(resolve, Math.min(remaining, 500)));
  }
  if (Date.now() > at.getTime() + maxLatenessMs) {
    throw new Error(`登录或唤醒延误，已超过双提交执行窗口：${at.toISOString()}`);
  }
}

function gridStateScript(targetDate: string): string {
  return `(() => {
    const targetDate = ${JSON.stringify(targetDate)};
    const times = Array.from(
      document.querySelectorAll('.left_time dd.resource_item_info'),
    ).map((item) => item.innerText.trim());
    const column = Array.from(document.querySelectorAll('.reservation_data'))
      .find((item) => Array.from(item.querySelectorAll('.week_header span'))
        .some((span) => span.innerText.trim() === targetDate));
    const cells = column
      ? Array.from(column.querySelectorAll('dd.resource_item_info'))
      : [];
    const availableSlots = times.filter((slot, index) => {
      const cell = cells[index];
      const text = cell ? cell.innerText.trim() : '';
      return Boolean(cell)
        && text.includes('可预约')
        && cell.classList.contains('can_active');
    });
    return {
      ready: times.length === 14
        && cells.length === 14
        && cells.every((cell) => cell.innerText.trim().length > 0),
      availableSlots,
      timeCount: times.length,
      cellCount: cells.length,
    };
  })()`;
}

async function readWeekNavigationSnapshot(
  page: RawCdpPage,
): Promise<WeekNavigationSnapshot> {
  return page.evaluate(() => {
    const start = document.querySelector<HTMLInputElement>(
      'input[placeholder="开始日期"]',
    );
    const end = document.querySelector<HTMLInputElement>(
      'input[placeholder="结束日期"]',
    );
    const visibleDates = Array.from(
      document.querySelectorAll<HTMLElement>(
        ".reservation_data .week_header span",
      ),
    ).map((item) => item.innerText.trim())
      .filter((text) => /^\d{4}-\d{2}-\d{2}$/.test(text));
    return {
      start: start?.value.trim() ?? "",
      end: end?.value.trim() ?? "",
      visibleDates,
    };
  });
}

async function reloadAndWaitForNewDocument(page: RawCdpPage): Promise<void> {
  const marker = `${Date.now()}-${Math.random()}`;
  await page.evaluate((value) => {
    const markedWindow = window as Window & { __courtScriptReloadMarker?: string };
    markedWindow.__courtScriptReloadMarker = value;
    return true;
  }, marker);
  await page.reload();
  const deadline = Date.now() + GRID_TIMEOUT;
  while (Date.now() < deadline) {
    const replaced = await page.evaluate((value) => {
      const markedWindow = window as Window & { __courtScriptReloadMarker?: string };
      return markedWindow.__courtScriptReloadMarker !== value
        && document.readyState !== "loading";
    }, marker).catch(() => false);
    if (replaced) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("刷新后等待新文档替换超时");
}

async function waitForActionableWeekSnapshot(
  page: RawCdpPage,
  targetDate: string,
): Promise<WeekNavigationSnapshot> {
  const deadline = Date.now() + GRID_TIMEOUT;
  let lastSnapshot: WeekNavigationSnapshot | undefined;
  while (Date.now() < deadline) {
    lastSnapshot = await readWeekNavigationSnapshot(page).catch(() => undefined);
    if (
      lastSnapshot
      && decideWeekNavigation(targetDate, lastSnapshot) !== "wait"
    ) {
      return lastSnapshot;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `等待目标日期列 ${targetDate} 超时：${JSON.stringify(lastSnapshot ?? {})}`,
  );
}

async function waitForWeekChange(
  page: RawCdpPage,
  previous: WeekNavigationSnapshot,
  label: "前一周" | "后一周",
): Promise<void> {
  const deadline = Date.now() + GRID_TIMEOUT;
  while (Date.now() < deadline) {
    const current = await readWeekNavigationSnapshot(page).catch(() => undefined);
    if (
      current
      && (
        current.start !== previous.start
        || current.end !== previous.end
        || current.visibleDates.join(",") !== previous.visibleDates.join(",")
      )
    ) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`切换${label}超时`);
}

async function moveRawPageToTargetWeek(
  page: RawCdpPage,
  targetDate: string,
  edgeLabel: "A" | "B",
): Promise<void> {
  for (let step = 0; step < 110; step += 1) {
    const snapshot = await waitForActionableWeekSnapshot(page, targetDate);
    const decision = decideWeekNavigation(targetDate, snapshot);
    if (decision === "visible") return;
    if (decision === "wait") continue;
    const clicked = await page.evaluate((label) => {
      const candidates = Array.from(
        document.querySelectorAll<HTMLElement>("button,a,span,div"),
      ).filter((item) => item.innerText?.trim() === label)
        .sort((left, right) => left.children.length - right.children.length);
      const control = candidates[0];
      if (!control) return false;
      control.click();
      return true;
    }, decision);
    if (!clicked) throw new Error(`页面缺少“${decision}”控件`);
    console.log(
      `[${new Date().toISOString()}] PARALLEL_PHASE：Edge ${edgeLabel} 点击${decision}，查找 ${targetDate}`,
    );
    await waitForWeekChange(page, snapshot, decision);
  }
  throw new Error(`无法导航到目标日期：${targetDate}`);
}

async function waitForGrid(page: RawCdpPage, targetDate: string): Promise<GridState> {
  const deadline = Date.now() + GRID_TIMEOUT;
  let lastState: GridState | undefined;
  let readyStreak = 0;
  while (Date.now() < deadline) {
    lastState = await page.evaluate<GridState>(gridStateScript(targetDate))
      .catch(() => undefined);
    if (lastState?.ready) {
      readyStreak += 1;
      if (readyStreak >= 5) return lastState;
    } else {
      readyStreak = 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `等待 ${targetDate} 预约表格超时：${JSON.stringify(lastState ?? {})}`,
  );
}

async function selectWithoutSubmitting(
  page: RawCdpPage,
  targetDate: string,
  slot: string,
): Promise<{ availability: string; selectionMs: number }> {
  const started = Date.now();
  let availability = "";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const state = await page.evaluate(({ targetDate, slot }) => {
      const expected = `${targetDate} ${slot}`;
      const summary = Array.from(document.querySelectorAll<HTMLElement>("*"))
        .some((item) => item.innerText?.trim().replace(/\s+/g, " ") === expected);
      const phone = document.querySelector<HTMLInputElement>(
        'input[placeholder="请输入手机号"]',
      );
      if (summary && phone?.value.trim()) return { status: "confirmed" as const };
      const times = Array.from(document.querySelectorAll<HTMLElement>(
        ".left_time dd.resource_item_info",
      )).map((item) => item.innerText.trim());
      const column = Array.from(document.querySelectorAll<HTMLElement>(
        ".reservation_data",
      )).find((item) => Array.from(item.querySelectorAll<HTMLElement>(
        ".week_header span",
      )).some((span) => span.innerText.trim() === targetDate));
      const index = times.indexOf(slot);
      const cell = column && index >= 0
        ? column.querySelectorAll<HTMLElement>("dd.resource_item_info")[index]
        : undefined;
      if (!cell) return { status: "transient" as const };
      const text = cell.innerText.trim();
      if (summary || cell.classList.contains("active")) {
        return { status: "pending" as const, availability: text };
      }
      if (!text.includes("可预约") || !cell.classList.contains("can_active")) {
        return { status: "unavailable" as const, availability: text };
      }
      cell.scrollIntoView({ block: "center" });
      cell.click();
      return { status: "clicked" as const, availability: text };
    }, { targetDate, slot });
    availability = state.availability ?? availability;
    if (state.status === "transient") {
      await new Promise((resolve) => setTimeout(resolve, 100));
      continue;
    }
    if (state.status === "confirmed") {
      return { availability: availability || "可预约", selectionMs: Date.now() - started };
    }
    if (state.status === "unavailable") {
      throw new Error(`${targetDate} ${slot} 不可预约：${availability || "无可用格子"}`);
    }
    const deadline = Date.now() + 700;
    while (Date.now() < deadline) {
      const confirmed = await page.evaluate(({ targetDate, slot }) => {
        const expected = `${targetDate} ${slot}`;
        const summary = Array.from(document.querySelectorAll<HTMLElement>("*"))
          .some((item) => item.innerText?.trim().replace(/\s+/g, " ") === expected);
        const phone = document.querySelector<HTMLInputElement>(
          'input[placeholder="请输入手机号"]',
        );
        return Boolean(summary && phone?.value.trim());
      }, { targetDate, slot }).catch(() => false);
      if (confirmed) {
        return { availability: availability || "可预约", selectionMs: Date.now() - started };
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`${targetDate} ${slot} 经 20 次尝试仍未选中`);
}

async function submitExactSelection(
  page: RawCdpPage,
  targetDate: string,
  slot: string,
): Promise<number> {
  const result = await page.evaluate(({ targetDate, slot }) => {
    const expected = `${targetDate} ${slot}`;
    const summary = Array.from(document.querySelectorAll<HTMLElement>("*"))
      .some((item) => item.innerText?.trim().replace(/\s+/g, " ") === expected);
    const phone = document.querySelector<HTMLInputElement>(
      'input[placeholder="请输入手机号"]',
    );
    const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
      .find((item) => item.innerText.trim() === "确认预约");
    if (!summary || !phone?.value.trim()) {
      return { clicked: false, reason: "selection-missing" };
    }
    if (!button) return { clicked: false, reason: "button-missing" };
    const clickedAt = Date.now();
    button.click();
    return { clicked: true, clickedAt };
  }, { targetDate, slot });
  if (!result.clicked || !result.clickedAt) {
    throw new Error(
      `${targetDate} ${slot} 提交前核验失败：${result.reason ?? "unknown"}`,
    );
  }
  return result.clickedAt;
}

async function verifyAppointmentSlots(
  page: RawCdpPage,
  targetDate: string,
  slots: [string, string],
): Promise<[boolean, boolean]> {
  const clickDeadline = Date.now() + 8_000;
  let clicked = false;
  while (Date.now() < clickDeadline && !clicked) {
    clicked = await page.evaluate(() => {
      const nav = Array.from(document.querySelectorAll<HTMLElement>("*"))
        .filter((item) => item.innerText?.trim() === "我的预约")
        .sort((left, right) => left.children.length - right.children.length)[0];
      if (!nav) return false;
      nav.click();
      return true;
    }).catch(() => false);
    if (!clicked) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!clicked) return [false, false];

  const deadline = Date.now() + 12_000;
  let found: [boolean, boolean] = [false, false];
  while (Date.now() < deadline) {
    found = await page.evaluate(({ targetDate, slots }) => {
      const shortDate = targetDate.slice(5);
      const rows = Array.from(document.querySelectorAll<HTMLElement>("tr"))
        .map((row) => row.innerText.replace(/\s+/g, " ").trim())
        .filter((text) =>
          (text.includes(targetDate) || text.includes(shortDate))
          && !text.includes("已取消"),
        );
      return slots.map((slot) => rows.some((text) =>
        text.includes(slot)
        && (text.includes("已预约") || text.includes("取消预约")),
      )) as [boolean, boolean];
    }, { targetDate, slots }).catch(() => [false, false] as [boolean, boolean]);
    if (found.every(Boolean)) return found;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return found;
}

function chooseTestSlots(
  requested: [string, string],
  stateA: GridState,
  stateB: GridState,
): [string, string] {
  if (
    requested[0] !== requested[1]
    && stateA.availableSlots.includes(requested[0])
    && stateB.availableSlots.includes(requested[1])
  ) return requested;
  for (const slotA of stateA.availableSlots) {
    const slotB = stateB.availableSlots.find((value) => value !== slotA);
    if (slotB) return [slotA, slotB];
  }
  throw new Error("当前没有两个可用的不同时段供并发 dry-run 验证");
}

async function stopInstance(instance: EdgeInstance | undefined): Promise<void> {
  if (!instance) return;
  instance.cdp.close();
  instance.process.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    if (instance.process.exitCode !== null) return resolve();
    const timer = setTimeout(resolve, 5_000);
    instance.process.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function removeExperimentProfiles(): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(EXPERIMENT_ROOT, { recursive: true, force: true, maxRetries: 3 });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError;
}

export async function runParallelFeasibility(options: {
  targetDate: string;
  slots: [string, string];
  submit?: boolean;
  submitDelayMs?: number;
  seedProfile?: boolean;
  notBefore?: Date;
  maxLatenessMs?: number;
  loginAttempts?: number;
  loginTimeoutMs?: number;
}): Promise<ParallelFeasibilityResult> {
  const targetDate = validateDate(options.targetDate);
  const requestedSlots: [string, string] = [
    validateSlot(options.slots[0]),
    validateSlot(options.slots[1]),
  ];
  if (requestedSlots[0] === requestedSlots[1]) {
    throw new Error("并发验证必须使用两个不同时段");
  }
  const submitDelayMs = options.submitDelayMs ?? 0;
  if (!Number.isInteger(submitDelayMs) || submitDelayMs < 0 || submitDelayMs > 10_000) {
    throw new Error("提交错峰必须是 0–10000 毫秒的整数");
  }
  if (!options.submit && submitDelayMs !== 0) {
    throw new Error("只有真实提交模式允许设置提交错峰");
  }
  if (options.notBefore && !options.submit) {
    throw new Error("准点等待只允许用于真实提交模式");
  }
  const maxLatenessMs = options.maxLatenessMs ?? 120_000;
  const loginAttempts = options.loginAttempts ?? 1;
  const loginTimeoutMs = options.loginTimeoutMs ?? PAGE_TIMEOUT;
  if (!Number.isInteger(loginAttempts) || loginAttempts < 1 || loginAttempts > 5) {
    throw new Error("登录尝试次数必须是 1–5 的整数");
  }
  if (!Number.isFinite(loginTimeoutMs) || loginTimeoutMs < 5_000) {
    throw new Error("单次登录超时不能少于 5 秒");
  }
  const credentials = await loadStoredCredentials();
  if (!credentials) throw new Error("并发验证需要已保存的统一身份认证凭据");

  await removeExperimentProfiles();
  await mkdir(EXPERIMENT_ROOT, { recursive: true, mode: 0o700 });
  await chmod(EXPERIMENT_ROOT, 0o700);
  const profileA = join(EXPERIMENT_ROOT, "profile-a");
  const profileB = join(EXPERIMENT_ROOT, "profile-b");
  if (options.seedProfile) {
    console.log(`[${new Date().toISOString()}] PARALLEL_PHASE：复制已验证的专用登录 profile`);
    await Promise.all([profileA, profileB].map(async (profileDir) => {
      await cp(PROFILE_DIR, profileDir, {
        recursive: true,
        mode: fsConstants.COPYFILE_FICLONE,
      });
      await Promise.all([
        "SingletonCookie",
        "SingletonLock",
        "SingletonSocket",
      ].map((name) => rm(join(profileDir, name), { force: true })));
      await chmod(profileDir, 0o700);
    }));
  }
  const portA = await freeLocalPort();
  let portB = await freeLocalPort();
  while (portB === portA) portB = await freeLocalPort();
  let browserA: EdgeInstance | undefined;
  let browserB: EdgeInstance | undefined;
  try {
    [browserA, browserB] = await Promise.all([
      launchOrdinaryEdge("A", profileA, portA),
      launchOrdinaryEdge("B", profileB, portB),
    ]);
    await Promise.all([
      openReservationWithRetries(browserA, credentials, loginAttempts, loginTimeoutMs),
      openReservationWithRetries(browserB, credentials, loginAttempts, loginTimeoutMs),
    ]);
    console.log(`[${new Date().toISOString()}] PARALLEL_PHASE：两个 Edge 登录均完成`);

    let testedSlots = requestedSlots;
    if (!options.submit) {
      const [initialA, initialB] = await Promise.all([
        (async () => {
          await moveRawPageToTargetWeek(browserA.page, targetDate, "A");
          return waitForGrid(browserA.page, targetDate);
        })(),
        (async () => {
          await moveRawPageToTargetWeek(browserB.page, targetDate, "B");
          return waitForGrid(browserB.page, targetDate);
        })(),
      ]);
      testedSlots = chooseTestSlots(requestedSlots, initialA, initialB);
    }
    console.log(
      `[${new Date().toISOString()}] PARALLEL_PHASE：并发验证时段 ${testedSlots.join(" + ")}`,
    );

    const requestCounts = [0, 0];
    const responseStatuses: [number[], number[]] = [[], []];
    const responseBodies: [string[], string[]] = [[], []];
    const launchRequestIds: [Set<string>, Set<string>] = [new Set(), new Set()];
    await Promise.all([browserA, browserB].map(async (instance, index) => {
      instance.cdp.on("Network.requestWillBeSent", (params) => {
        const url = (params as { request?: { url?: string } }).request?.url;
        if (!url) return;
        try {
          if (new URL(url).pathname === LAUNCH_PATH) {
            requestCounts[index] = (requestCounts[index] ?? 0) + 1;
          }
        } catch {
          // Ignore malformed non-HTTP request URLs.
        }
      });
      instance.cdp.on("Network.responseReceived", (params) => {
        const event = params as {
          requestId?: string;
          response?: { url?: string; status?: number };
        };
        const response = event.response;
        if (!response?.url) return;
        try {
          if (new URL(response.url).pathname === LAUNCH_PATH) {
            responseStatuses[index]?.push(Number(response.status) || 0);
            if (event.requestId) launchRequestIds[index]?.add(event.requestId);
          }
        } catch {
          // Ignore malformed non-HTTP response URLs.
        }
      });
      instance.cdp.on("Network.loadingFinished", (params) => {
        const requestId = (params as { requestId?: string }).requestId;
        if (!requestId || !launchRequestIds[index]?.has(requestId)) return;
        launchRequestIds[index]?.delete(requestId);
        void instance.cdp.send<{ body?: string; base64Encoded?: boolean }>(
          "Network.getResponseBody",
          { requestId },
        ).then((response) => {
          const body = response.base64Encoded && response.body
            ? Buffer.from(response.body, "base64").toString("utf8")
            : (response.body ?? "");
          responseBodies[index]?.push(body.slice(0, 2_000));
        }).catch(() => undefined);
      });
      await instance.cdp.send("Network.enable");
    }));
    const releaseAt = options.notBefore?.getTime() ?? Date.now() + 1_500;
    if (options.notBefore) {
      console.log(
        `[${new Date().toISOString()}] PARALLEL_PHASE：双路预登录完成，等待 ${options.notBefore.toISOString()}`,
      );
      await waitUntilRelease(options.notBefore, maxLatenessMs);
      console.log(`[${new Date().toISOString()}] PARALLEL_PHASE：开放时刻已到`);
    }
    const instances: [EdgeInstance, EdgeInstance] = [browserA, browserB];
    const refreshStarts: [number, number] = [0, 0];
    const refreshDurations: [number, number] = [0, 0];
    const availableAfterRefresh: [boolean, boolean] = [false, false];
    type SelectionResult = Awaited<ReturnType<typeof selectWithoutSubmitting>>;
    const selections: [SelectionResult | undefined, SelectionResult | undefined] = [
      undefined,
      undefined,
    ];
    const laneErrors: [string | undefined, string | undefined] = [undefined, undefined];
    const selectedLanes: [boolean, boolean] = [false, false];
    const submittedLanes: [boolean, boolean] = [false, false];
    const submitStarts: [number | undefined, number | undefined] = [undefined, undefined];
    const lanePlan = buildParallelLanePlan([true, true], submitDelayMs);
    const runLane = async (index: 0 | 1): Promise<void> => {
      const instance = instances[index];
      const slot = testedSlots[index];
      const plan = lanePlan[index];
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, releaseAt - Date.now())));
      refreshStarts[index] = Date.now();
      let refreshedState: GridState;
      try {
        await reloadAndWaitForNewDocument(instance.page);
        await moveRawPageToTargetWeek(instance.page, targetDate, plan.label);
        refreshedState = await waitForGrid(instance.page, targetDate);
      } finally {
        refreshDurations[index] = Date.now() - refreshStarts[index];
      }
      availableAfterRefresh[index] = refreshedState.availableSlots.includes(slot);
      console.log(
        `[${new Date().toISOString()}] PARALLEL_PHASE：Edge ${plan.label} 刷新完成（${refreshDurations[index]}ms），目标可预约=${availableAfterRefresh[index]}`,
      );
      if (!availableAfterRefresh[index]) return;

      selections[index] = await selectWithoutSubmitting(instance.page, targetDate, slot);
      const held = await instance.page.evaluate(
        ({ targetDate, slot }) => document.body.innerText
          .replace(/\s+/g, " ").includes(`${targetDate} ${slot}`),
        { targetDate, slot },
      ).catch(() => false);
      if (!held) throw new Error("选择未能保持");
      selectedLanes[index] = true;
      console.log(
        `[${new Date().toISOString()}] PARALLEL_PHASE：Edge ${plan.label} 已独立选中 ${slot}`,
      );
      if (!options.submit) return;
      if ((requestCounts[index] ?? 0) !== 0) {
        throw new Error("选择阶段已经观察到提交请求，为避免重复提交已跳过");
      }
      if (plan.submitDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, plan.submitDelayMs));
      }
      submitStarts[index] = await submitExactSelection(instance.page, targetDate, slot);
      submittedLanes[index] = true;
      console.log(
        `[${new Date().toISOString()}] PARALLEL_PHASE：Edge ${plan.label} 已独立单次提交 ${slot}`,
      );
    };
    const laneAttempts = await runIndependentLanePipelines(
      () => runLane(0),
      () => runLane(1),
    );
    for (const index of [0, 1] as const) {
      const attempt = laneAttempts[index];
      if (attempt.status === "rejected") {
        laneErrors[index] = attempt.reason instanceof Error
          ? attempt.reason.message
          : String(attempt.reason);
      }
    }
    console.log(
      `[${new Date().toISOString()}] PARALLEL_PHASE：双路独立流程结束，可预约=${JSON.stringify(availableAfterRefresh)}，已选中=${JSON.stringify(selectedLanes)}，已提交=${JSON.stringify(submittedLanes)}，错误=${JSON.stringify(laneErrors)}`,
    );
    const simultaneousSelectionsHeld = selectedLanes.some(Boolean)
      && selectedLanes.every((selected, index) =>
        !availableAfterRefresh[index] || selected
      );
    if (!options.submit && (
      !simultaneousSelectionsHeld
      || requestCounts.some((count) => count !== 0)
    )) {
      throw new Error("并发选择未同时保持，或 dry-run 观测到提交请求");
    }
    let submitStartSkewMs: number | undefined;
    let recordsFound: [boolean, boolean] | undefined;
    if (options.submit) {
      if (submitStarts[0] !== undefined && submitStarts[1] !== undefined) {
        submitStartSkewMs = Math.abs(submitStarts[0] - submitStarts[1]);
      }
      if (submittedLanes.some(Boolean)) {
        await new Promise((resolve) => setTimeout(resolve, 2_500));
        for (const index of [0, 1] as const) {
          if ((requestCounts[index] ?? 0) > 1) {
            laneErrors[index] = `预约提交请求次数异常：${requestCounts[index]}`;
            submittedLanes[index] = false;
          }
        }
        const verificationPage = submittedLanes[0] ? browserA.page : browserB.page;
        const found = await verifyAppointmentSlots(
          verificationPage,
          targetDate,
          testedSlots,
        );
        recordsFound = [
          submittedLanes[0] && found[0],
          submittedLanes[1] && found[1],
        ];
        console.log(
          `[${new Date().toISOString()}] PARALLEL_PHASE：我的预约核验 ${JSON.stringify(recordsFound)}`,
        );
      }
    }

    const probes: [BrowserProbe, BrowserProbe] = [browserA, browserB].map(
      (instance, index) => ({
        label: instance.label,
        profileDir: instance.profileDir,
        rootPid: instance.process.pid ?? 0,
        debuggingPort: instance.port,
        loginMs: instance.loginMs,
        fudanCookieCount: instance.fudanCookieCount,
        webdriverExposed: instance.webdriverExposed,
        selectedSlot: testedSlots[index] ?? "",
        availability: selections[index]?.availability
          ?? (availableAfterRefresh[index] ? "刷新后可预约" : "刷新后不可预约"),
        availableAfterRefresh: availableAfterRefresh[index] ?? false,
        selected: selectedLanes[index] ?? false,
        submitted: submittedLanes[index] ?? false,
        error: laneErrors[index],
        refreshMs: refreshDurations[index] ?? 0,
        selectionMs: selections[index]?.selectionMs ?? 0,
        launchRequests: requestCounts[index] ?? 0,
        launchResponseStatuses: responseStatuses[index] ?? [],
        launchResponseBodies: responseBodies[index] ?? [],
      }),
    ) as [BrowserProbe, BrowserProbe];
    return {
      status: options.submit
        ? parallelSubmitStatus(submittedLanes, recordsFound)
        : "feasible",
      mode: options.submit ? "submit" : "dry-run",
      controlMethod: "ordinary-edge-raw-cdp",
      targetDate,
      requestedSlots,
      testedSlots,
      distinctRootProcesses: probes[0].rootPid > 0
        && probes[1].rootPid > 0
        && probes[0].rootPid !== probes[1].rootPid,
      distinctProfiles: profileA !== profileB,
      refreshStartSkewMs: Math.abs((refreshStarts[0] ?? 0) - (refreshStarts[1] ?? 0)),
      requestedSubmitDelayMs: options.submit ? submitDelayMs : undefined,
      submitStartSkewMs,
      simultaneousSelectionsHeld,
      availableAfterRefresh,
      selectedLanes,
      submittedLanes,
      recordsFound,
      browsers: probes,
    };
  } finally {
    await Promise.allSettled([stopInstance(browserA), stopInstance(browserB)]);
    await removeExperimentProfiles().catch((error) => {
      console.error(
        `PARALLEL_CLEANUP_WARNING：${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }
}
