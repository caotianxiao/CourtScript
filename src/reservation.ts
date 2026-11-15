import { RESOURCE_ID } from "./constants.js";
import { artifactPaths, writeResultLog } from "./logging.js";
import {
  captureCourtWindow,
  closeCourtWindow,
  executeCourtJavaScript,
  focusCourtTab,
  stopDedicatedEdge,
  waitForCourtJavaScript,
} from "./edge-apple-events.js";
import { openAuthenticatedReservationPage } from "./booking-browser.js";
import { updatePlan } from "./state.js";
import type {
  ReservationPlan,
  ReservationResult,
  RunMode,
} from "./types.js";
import { addCalendarDays, shanghaiDate } from "./validation.js";
import {
  decideReleaseLoadStrategy,
  decideWeekNavigation,
  type WeekNavigationSnapshot,
} from "./week-navigation.js";

export { decideWeekNavigation } from "./week-navigation.js";

const PAGE_TIMEOUT = 30_000;
const SUBMISSION_OBSERVATION_TIMEOUT_MS = 15_000;
const SUBMISSION_IN_FLIGHT_TIMEOUT_MS = 60_000;

export interface ReservationRunOptions {
  notBefore?: Date;
  maxLatenessMs?: number;
  deferVerification?: boolean;
}

async function waitUntilRelease(
  notBefore: Date,
  maxLatenessMs: number,
): Promise<void> {
  const latestStart = notBefore.getTime() + maxLatenessMs;
  if (Date.now() > latestStart) {
    throw new Error(`已错过预约执行窗口：${notBefore.toISOString()}`);
  }
  while (Date.now() < notBefore.getTime()) {
    const remaining = notBefore.getTime() - Date.now();
    await new Promise((resolve) => setTimeout(resolve, Math.min(remaining, 30_000)));
  }
  if (Date.now() > latestStart) {
    throw new Error(`唤醒或登录延误，已超过预约执行窗口：${notBefore.toISOString()}`);
  }
}

export async function reloadReservationTable(): Promise<void> {
  await executeCourtJavaScript("location.reload(); JSON.stringify({reloading: true})");
  await waitForCourtJavaScript<{
    ready: boolean;
    url: string;
    timeCount: number;
    columnCount: number;
    completeColumnCount: number;
  }>(
    `(() => {
      const times = Array.from(
        document.querySelectorAll('.left_time dd.resource_item_info'),
      ).map((item) => item.innerText.trim());
      const columns = Array.from(document.querySelectorAll('.reservation_data'));
      const completeColumnCount = columns.filter((column) => {
        const cells = Array.from(column.querySelectorAll('dd.resource_item_info'));
        return cells.length === 14 && cells.every((cell) => cell.innerText.trim().length > 0);
      }).length;
      return JSON.stringify({
        ready: Boolean(document.querySelector('.week_calendar'))
          && times.length === 14
          && times.every((time) => /^\\d{2}:\\d{2}-\\d{2}:\\d{2}$/.test(time))
          && columns.length > 0
          && completeColumnCount === columns.length,
        url: location.href,
        timeCount: times.length,
        columnCount: columns.length,
        completeColumnCount,
      });
    })()`,
    (value) => value.ready && value.url.includes("reservationInfo?id=1055"),
    PAGE_TIMEOUT,
    "预约资源刷新",
  );
}

const WEEK_NAVIGATION_STATE_SCRIPT = `(() => {
  const start = document.querySelector('input[placeholder="开始日期"]');
  const end = document.querySelector('input[placeholder="结束日期"]');
  const visibleDates = Array.from(
    document.querySelectorAll('.reservation_data .week_header span'),
  ).map((item) => item.innerText.trim())
    .filter((text) => /^\\d{4}-\\d{2}-\\d{2}$/.test(text));
  return JSON.stringify({
    start: start ? start.value.trim() : '',
    end: end ? end.value.trim() : '',
    visibleDates,
  });
})()`;

async function currentWeekNavigationDecision(
  targetDate: string,
): Promise<ReturnType<typeof decideWeekNavigation>> {
  const snapshot = await waitForCourtJavaScript<WeekNavigationSnapshot>(
    WEEK_NAVIGATION_STATE_SCRIPT,
    (value) => decideWeekNavigation(targetDate, value) !== "wait",
    PAGE_TIMEOUT,
    `等待目标日期范围 ${targetDate}`,
  );
  return decideWeekNavigation(targetDate, snapshot);
}

async function moveToTargetWeek(targetDate: string): Promise<void> {
  for (let step = 0; step < 110; step += 1) {
    const snapshot = await waitForCourtJavaScript<WeekNavigationSnapshot>(
      WEEK_NAVIGATION_STATE_SCRIPT,
      (value) => decideWeekNavigation(targetDate, value) !== "wait",
      PAGE_TIMEOUT,
      `等待目标日期列 ${targetDate}`,
    );
    const decision = decideWeekNavigation(targetDate, snapshot);
    if (decision === "visible") {
      return;
    }
    const label = decision;
    const result = JSON.parse(await executeCourtJavaScript(`(() => {
      const label = ${JSON.stringify(label)};
      const candidates = Array.from(document.querySelectorAll('button,a,span,div'))
        .filter((item) => item.innerText && item.innerText.trim() === label);
      candidates.sort((a, b) => a.children.length - b.children.length);
      const control = candidates[0];
      if (!control) return JSON.stringify({clicked: false});
      control.click();
      return JSON.stringify({clicked: true});
    })()`)) as { clicked?: boolean };
    if (!result.clicked) {
      throw new Error(`页面缺少“${label}”控件`);
    }
    const previousDates = snapshot.visibleDates.join(",");
    await waitForCourtJavaScript<WeekNavigationSnapshot>(
      WEEK_NAVIGATION_STATE_SCRIPT,
      (value) => value.start !== snapshot.start
        || value.end !== snapshot.end
        || value.visibleDates.join(",") !== previousDates,
      PAGE_TIMEOUT,
      `切换${label}`,
    );
  }
  throw new Error(`无法导航到目标日期：${targetDate}`);
}

interface SlotSelection {
  slot: string;
  availability: string;
}

interface SlotUiState {
  state: "loading" | "candidate" | "unavailable" | "error";
  slot?: string;
  availability?: string;
  summary: boolean;
  phone: boolean;
  active: boolean;
  error?: string;
  timeCount?: number;
  cellCount?: number;
}

export type SelectionAction = "confirmed" | "wait" | "click";

export function isSelectedSlotCell(text: string, className: string): boolean {
  const classes = new Set(className.split(/\s+/).filter(Boolean));
  return text.includes("可预约")
    && classes.has("active")
    && classes.has("can_active")
    && !classes.has("no_active");
}

export function decideSelectionAction(
  state: Pick<SlotUiState, "summary" | "phone" | "active">,
): SelectionAction {
  if (state.summary && state.phone) {
    return "confirmed";
  }
  // An active cell or an existing summary means the first click did take
  // effect. Never click it again because the site's handler toggles it off.
  if (state.active || state.summary) {
    return "wait";
  }
  return "click";
}

function slotUiStateScript(targetDate: string, slots: string[]): string {
  return `(() => {
    const targetDate = ${JSON.stringify(targetDate)};
    const slots = ${JSON.stringify(slots)};
    const isSelectedSlotCell = ${isSelectedSlotCell.toString()};
    const empty = (extra) => ({
      summary: false,
      phone: false,
      active: false,
      ...extra,
    });
    const times = Array.from(
      document.querySelectorAll('.left_time dd.resource_item_info'),
    ).map((item) => item.innerText.trim());
    if (times.length !== 14
        || times.some((time) => !/^\\d{2}:\\d{2}-\\d{2}:\\d{2}$/.test(time))) {
      return JSON.stringify(empty({state: 'loading', timeCount: times.length}));
    }
    const columns = Array.from(document.querySelectorAll('.reservation_data'));
    const matches = columns.filter((column) =>
      Array.from(column.querySelectorAll('.week_header span'))
        .some((span) => span.innerText.trim() === targetDate),
    );
    if (matches.length === 0) {
      return JSON.stringify(empty({state: 'loading', timeCount: times.length}));
    }
    if (matches.length > 1) {
      return JSON.stringify(empty({
        state: 'error',
        error: '无法唯一定位日期列：' + targetDate,
      }));
    }
    const cells = Array.from(matches[0].querySelectorAll('dd.resource_item_info'));
    if (cells.length !== 14 || cells.some((cell) => cell.innerText.trim().length === 0)) {
      return JSON.stringify(empty({
        state: 'loading',
        timeCount: times.length,
        cellCount: cells.length,
      }));
    }
    const phoneInput = document.querySelector('input[placeholder="请输入手机号"]');
    const phone = Boolean(phoneInput && phoneInput.value.trim());
    const hasSummary = (slot) => {
      const expected = targetDate + ' ' + slot;
      return Array.from(document.querySelectorAll('*'))
        .some((item) => typeof item.innerText === 'string'
          && item.innerText.trim().replace(/\\s+/g, ' ') === expected);
    };
    const details = (slot) => {
      const index = times.indexOf(slot);
      const cell = index >= 0 ? cells[index] : undefined;
      const text = cell ? cell.innerText.trim() : '';
      return {
        cell,
        text,
        summary: hasSummary(slot),
        active: Boolean(cell && isSelectedSlotCell(text, cell.className)),
      };
    };
    // Preserve an existing selection even if a later table update changed the
    // cell's availability class.
    for (const slot of slots) {
      const detail = details(slot);
      if (detail.summary || detail.active) {
        return JSON.stringify({
          state: 'candidate',
          slot,
          availability: detail.text,
          summary: detail.summary,
          phone,
          active: detail.active,
        });
      }
    }
    for (const slot of slots) {
      const detail = details(slot);
      if (!detail.cell) continue;
      if (!detail.text.includes('可预约')
          || !detail.cell.classList.contains('can_active')) continue;
      return JSON.stringify({
        state: 'candidate',
        slot,
        availability: detail.text,
        summary: false,
        phone,
        active: false,
      });
    }
    return JSON.stringify(empty({
      state: 'unavailable',
      error: '首选和备选时段均不可预约：' + slots.join(', '),
    }));
  })()`;
}

async function readSlotUiState(
  targetDate: string,
  slots: string[],
  timeoutMs = PAGE_TIMEOUT,
): Promise<SlotUiState> {
  return waitForCourtJavaScript<SlotUiState>(
    slotUiStateScript(targetDate, slots),
    (value) => value.state !== "loading",
    timeoutMs,
    "等待完整预约表格",
  );
}

async function clickLatestSlotCell(
  targetDate: string,
  slot: string,
): Promise<"clicked" | "pending" | "confirmed" | "unavailable"> {
  const output = await executeCourtJavaScript(`(() => {
    const targetDate = ${JSON.stringify(targetDate)};
    const slot = ${JSON.stringify(slot)};
    const isSelectedSlotCell = ${isSelectedSlotCell.toString()};
    const expected = targetDate + ' ' + slot;
    const summary = Array.from(document.querySelectorAll('*'))
      .some((item) => typeof item.innerText === 'string'
        && item.innerText.trim().replace(/\\s+/g, ' ') === expected);
    const phoneInput = document.querySelector('input[placeholder="请输入手机号"]');
    const phone = Boolean(phoneInput && phoneInput.value.trim());
    if (summary && phone) return JSON.stringify({state: 'confirmed'});
    const times = Array.from(
      document.querySelectorAll('.left_time dd.resource_item_info'),
    ).map((item) => item.innerText.trim());
    const column = Array.from(document.querySelectorAll('.reservation_data'))
      .find((item) => Array.from(item.querySelectorAll('.week_header span'))
        .some((span) => span.innerText.trim() === targetDate));
    const index = times.indexOf(slot);
    const cell = column && index >= 0
      ? column.querySelectorAll('dd.resource_item_info')[index]
      : undefined;
    if (!cell) return JSON.stringify({state: 'unavailable'});
    const text = cell.innerText.trim();
    if (summary || isSelectedSlotCell(text, cell.className)) {
      return JSON.stringify({state: 'pending'});
    }
    if (!text.includes('可预约') || !cell.classList.contains('can_active')) {
      return JSON.stringify({state: 'unavailable'});
    }
    cell.scrollIntoView({block: 'center'});
    cell.click();
    return JSON.stringify({state: 'clicked'});
  })()`);
  const result = JSON.parse(output) as {
    state?: "clicked" | "pending" | "confirmed" | "unavailable";
  };
  return result.state ?? "unavailable";
}

async function waitForSelectionConfirmation(
  targetDate: string,
  slot: string,
  timeoutMs: number,
): Promise<SlotUiState | undefined> {
  const deadline = Date.now() + timeoutMs;
  let lastState: SlotUiState | undefined;
  while (Date.now() < deadline) {
    try {
      lastState = await readSlotUiState(targetDate, [slot], 300);
      if (decideSelectionAction(lastState) === "confirmed") {
        return lastState;
      }
    } catch {
      // A table replacement can make the DOM briefly incomplete. The next
      // retry will locate the newest cell node.
    }
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  return undefined;
}

export async function selectSlot(
  targetDate: string,
  slots: string[],
): Promise<SlotSelection> {
  const maxAttempts = 4;
  const confirmationTimeoutMs = 600;
  let lastState: SlotUiState | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const state = await readSlotUiState(targetDate, slots);
    lastState = state;
    if (state.error) {
      throw new Error(state.error);
    }
    if (state.state === "unavailable") {
      throw new Error(state.error ?? `目标时段不可预约：${slots.join(", ")}`);
    }
    if (!state.slot) {
      throw new Error("预约表格返回了无法识别的选择状态");
    }
    if (decideSelectionAction(state) === "confirmed") {
      return { slot: state.slot, availability: state.availability ?? "可预约" };
    }
    if (decideSelectionAction(state) === "click") {
      const clickResult = await clickLatestSlotCell(targetDate, state.slot);
      if (clickResult === "confirmed") {
        return { slot: state.slot, availability: state.availability ?? "可预约" };
      }
    }
    const confirmed = await waitForSelectionConfirmation(
      targetDate,
      state.slot,
      confirmationTimeoutMs,
    );
    if (confirmed) {
      return {
        slot: state.slot,
        availability: confirmed.availability || state.availability || "可预约",
      };
    }
    if (attempt < maxAttempts) {
      console.log(
        `[${new Date().toISOString()}] RUN_PHASE：时段选择未确认，重新定位并重试（${attempt + 1}/${maxAttempts}）`,
      );
    }
  }
  throw new Error(
    `时段选择经 ${maxAttempts} 次尝试仍未被页面确认：${JSON.stringify({
      slot: lastState?.slot,
      summary: lastState?.summary,
      phone: lastState?.phone,
      active: lastState?.active,
    })}`,
  );
}

export function launchMonitorJavaScript(): string {
  return `(() => {
    if (!window.__courtScriptLaunchMonitor
        || window.__courtScriptLaunchMonitor.version !== 2) {
      const launchSuffix = '/site/resource/launch';
      const isLaunchUrl = (value) => {
        try {
          return new URL(String(value), location.href).pathname
            .replace(/\\/+$/, '')
            .endsWith(launchSuffix);
        } catch {
          return false;
        }
      };
      const performanceCount = () => performance.getEntriesByType('resource')
        .filter((entry) => isLaunchUrl(entry.name)).length;
      window.__courtScriptLaunchMonitor = {
        version: 2,
        events: [],
        performanceBaseline: performanceCount(),
      };
      const monitor = window.__courtScriptLaunchMonitor;
      const begin = (transport, url, method) => {
        const event = {
          transport,
          url: String(url || ''),
          method: String(method || 'GET').toUpperCase(),
          startedAt: Date.now(),
        };
        monitor.events.push(event);
        return event;
      };
      const finish = (event, status, body, error) => {
        if (!event || event.completedAt) return;
        event.completedAt = Date.now();
        event.status = Number(status) || 0;
        event.body = typeof body === 'string' ? body.slice(0, 4000) : '';
        event.error = error ? String(error).slice(0, 500) : '';
      };
      const originalFetch = window.fetch;
      if (originalFetch) {
        window.fetch = function(input, init) {
          const url = typeof input === 'string' ? input : input && input.url;
          if (!url || !isLaunchUrl(url)) {
            return originalFetch.call(this, input, init);
          }
          const event = begin('fetch', url, init && init.method);
          return originalFetch.call(this, input, init).then((response) => {
            const copy = response.clone();
            copy.text()
              .then((body) => finish(event, response.status, body, ''))
              .catch((error) => finish(event, response.status, '', error));
            return response;
          }).catch((error) => {
            finish(event, 0, '', error);
            throw error;
          });
        };
      }
      const originalOpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        this.__courtScriptUrl = String(url);
        this.__courtScriptMethod = String(method);
        return originalOpen.call(this, method, url, ...rest);
      };
      const originalSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.send = function(body) {
        if (!this.__courtScriptUrl || !isLaunchUrl(this.__courtScriptUrl)) {
          return originalSend.call(this, body);
        }
        const event = begin(
          'xhr',
          this.__courtScriptUrl,
          this.__courtScriptMethod,
        );
        this.addEventListener('loadend', () => {
          let responseBody = '';
          try {
            if (typeof this.responseText === 'string') {
              responseBody = this.responseText;
            }
          } catch {}
          if (!responseBody && this.response != null) {
            try {
              responseBody = typeof this.response === 'string'
                ? this.response
                : JSON.stringify(this.response);
            } catch {}
          }
          finish(event, this.status, responseBody, this.status ? '' : 'loadend-status-0');
        }, {once: true});
        return originalSend.call(this, body);
      };
    }
    return JSON.stringify({installed: true});
  })()`;
}

async function installLaunchMonitor(): Promise<void> {
  await executeCourtJavaScript(launchMonitorJavaScript());
}

async function countLaunchRequests(): Promise<number> {
  const output = await executeCourtJavaScript(`(() => {
    const monitor = window.__courtScriptLaunchMonitor;
    const launchSuffix = '/site/resource/launch';
    const performanceCount = performance.getEntriesByType('resource')
      .filter((entry) => {
        try {
          return new URL(entry.name, location.href).pathname
            .replace(/\\/+$/, '')
            .endsWith(launchSuffix);
        } catch {
          return false;
        }
      }).length - (monitor?.performanceBaseline ?? 0);
    return JSON.stringify({
      count: Math.max(monitor?.events?.length ?? 0, performanceCount, 0),
    });
  })()`);
  const result = JSON.parse(output) as { count?: number };
  return Number(result.count) || 0;
}

interface LaunchMonitorEvent {
  transport?: string;
  url?: string;
  method?: string;
  startedAt?: number;
  completedAt?: number;
  status?: number;
  body?: string;
  error?: string;
}

interface LaunchMonitorSnapshot {
  eventCount: number;
  performanceCount: number;
  latest?: LaunchMonitorEvent;
  pageText: string;
}

export interface SubmissionInterpretation {
  outcome: "success" | "failure" | "unknown";
  applicationCode?: string;
  responseMessage?: string;
}

function responseFields(body: string): {
  applicationCode?: string;
  responseMessage?: string;
  success?: boolean;
} {
  if (!body.trim()) return {};
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const values = [parsed, parsed.data, parsed.result]
      .filter((value): value is Record<string, unknown> =>
        Boolean(value) && typeof value === "object" && !Array.isArray(value)
      );
    const pick = (keys: string[]): unknown => {
      for (const value of values) {
        for (const key of keys) {
          if (value[key] !== undefined && value[key] !== null) return value[key];
        }
      }
      return undefined;
    };
    const code = pick(["code", "statusCode", "errno"]);
    const message = pick(["message", "msg", "error", "errorMessage"]);
    const success = pick(["success", "ok"]);
    return {
      applicationCode: code === undefined ? undefined : String(code).slice(0, 80),
      responseMessage: typeof message === "string"
        ? message.replace(/\s+/g, " ").trim().slice(0, 300)
        : undefined,
      success: typeof success === "boolean" ? success : undefined,
    };
  } catch {
    return {
      responseMessage: body.replace(/\s+/g, " ").trim().slice(0, 300) || undefined,
    };
  }
}

export function interpretSubmissionResponse(
  httpStatus: number | undefined,
  body: string,
  error = "",
): SubmissionInterpretation {
  const fields = responseFields(body);
  const message = fields.responseMessage ?? "";
  const failureText = /预约失败|已约满|已被预约|已被占用|没有余量|余量不足|资源不足|不可预约|无法预约|预约冲突|重复预约|超过.*上限|未开放|已过期|失败|error/i;
  const successText = /预约成功|提交成功|操作成功|成功预约|success/i;
  if (error || httpStatus === 0 || (httpStatus !== undefined && httpStatus >= 400)) {
    return { outcome: "failure", ...fields };
  }
  if (fields.success === false || failureText.test(message)) {
    return { outcome: "failure", ...fields };
  }
  if (fields.success === true || successText.test(message)) {
    return { outcome: "success", ...fields };
  }
  return { outcome: "unknown", ...fields };
}

async function readLaunchMonitorSnapshot(): Promise<LaunchMonitorSnapshot> {
  const output = await executeCourtJavaScript(`(() => {
    const monitor = window.__courtScriptLaunchMonitor;
    const launchSuffix = '/site/resource/launch';
    const performanceCount = performance.getEntriesByType('resource')
      .filter((entry) => {
        try {
          return new URL(entry.name, location.href).pathname
            .replace(/\\/+$/, '')
            .endsWith(launchSuffix);
        } catch {
          return false;
        }
      }).length - (monitor?.performanceBaseline ?? 0);
    const events = monitor?.events ?? [];
    return JSON.stringify({
      eventCount: events.length,
      performanceCount: Math.max(performanceCount, 0),
      latest: events.length ? events[events.length - 1] : undefined,
      pageText: (document.body?.innerText || '').slice(-1200),
    });
  })()`);
  return JSON.parse(output) as LaunchMonitorSnapshot;
}

async function waitForSubmissionReceipt(clickedAt: number): Promise<NonNullable<
  ReservationResult["submission"]
>> {
  let deadline = clickedAt + SUBMISSION_OBSERVATION_TIMEOUT_MS;
  let lastSnapshot: LaunchMonitorSnapshot | undefined;
  while (Date.now() < deadline) {
    lastSnapshot = await readLaunchMonitorSnapshot();
    const latest = lastSnapshot.latest;
    if (latest?.startedAt && !latest.completedAt) {
      deadline = Math.max(
        deadline,
        latest.startedAt + SUBMISSION_IN_FLIGHT_TIMEOUT_MS,
      );
    }
    if (latest?.completedAt) {
      const interpretation = interpretSubmissionResponse(
        latest.status,
        latest.body ?? "",
        latest.error ?? "",
      );
      return {
        observed: true,
        completed: true,
        outcome: interpretation.outcome,
        elapsedMs: Math.max(0, latest.completedAt - clickedAt),
        httpStatus: latest.status,
        applicationCode: interpretation.applicationCode,
        responseMessage: interpretation.responseMessage,
      };
    }
    if ((lastSnapshot.performanceCount ?? 0) > 0) {
      const pageInterpretation = interpretSubmissionResponse(
        undefined,
        lastSnapshot.pageText,
      );
      return {
        observed: true,
        completed: true,
        outcome: pageInterpretation.outcome,
        elapsedMs: Math.max(0, Date.now() - clickedAt),
        responseMessage: pageInterpretation.responseMessage,
      };
    }
    const pageInterpretation = interpretSubmissionResponse(
      undefined,
      lastSnapshot.pageText,
    );
    // A toast is only a fallback when no request hook fired. If a real fetch
    // or XHR is still pending, never close its browser based on page text.
    if (
      (lastSnapshot.eventCount ?? 0) === 0
      && pageInterpretation.outcome !== "unknown"
    ) {
      return {
        observed: (lastSnapshot.eventCount ?? 0) > 0,
        completed: true,
        outcome: pageInterpretation.outcome,
        elapsedMs: Math.max(0, Date.now() - clickedAt),
        responseMessage: pageInterpretation.responseMessage,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return {
    observed: Boolean(
      (lastSnapshot?.eventCount ?? 0) > 0
      || (lastSnapshot?.performanceCount ?? 0) > 0
    ),
    completed: false,
    outcome: "timeout",
    elapsedMs: Math.max(0, Date.now() - clickedAt),
  };
}

async function captchaVisible(): Promise<boolean> {
  const output = await executeCourtJavaScript(`JSON.stringify({
    challenge: /滑块|验证码|captcha/i.test(document.body?.innerText || '')
  })`);
  return Boolean((JSON.parse(output) as { challenge?: boolean }).challenge);
}

async function submitReservation(targetDate: string, slot: string): Promise<number> {
  const output = await executeCourtJavaScript(`(() => {
    const expected = ${JSON.stringify(`${targetDate} ${slot}`)};
    const summary = Array.from(document.querySelectorAll('*'))
      .some((item) => typeof item.innerText === 'string'
        && item.innerText.trim().replace(/\\s+/g, ' ') === expected);
    const phoneInput = document.querySelector('input[placeholder="请输入手机号"]');
    if (!summary || !phoneInput || !phoneInput.value.trim()) {
      return JSON.stringify({clicked: false, reason: 'selection-missing'});
    }
    const button = Array.from(document.querySelectorAll('button'))
      .find((item) => item.innerText.trim() === '确认预约');
    if (!button) return JSON.stringify({clicked: false, reason: 'button-missing'});
    button.click();
    return JSON.stringify({clicked: true});
  })()`);
  const result = JSON.parse(output) as { clicked?: boolean; reason?: string };
  if (!result.clicked && result.reason === "selection-missing") {
    throw new Error("提交前预约日期、时段或手机号状态已失效");
  }
  if (!result.clicked) {
    throw new Error("页面缺少“确认预约”按钮");
  }
  return Date.now();
}

async function verifyAppointment(targetDate: string, slot: string): Promise<boolean> {
  const output = await executeCourtJavaScript(`(() => {
    const nav = Array.from(document.querySelectorAll('*'))
      .filter((item) => typeof item.innerText === 'string'
        && item.innerText.trim() === '我的预约')
      .sort((a, b) => a.children.length - b.children.length)[0];
    if (!nav) return JSON.stringify({clicked: false});
    nav.click();
    return JSON.stringify({clicked: true});
  })()`);
  if (!(JSON.parse(output) as { clicked?: boolean }).clicked) {
    return false;
  }
  return waitForCourtJavaScript<{ found: boolean }>(
    `(() => {
      const targetDate = ${JSON.stringify(targetDate)};
      const shortDate = targetDate.slice(5);
      const slot = ${JSON.stringify(slot)};
      const found = Array.from(document.querySelectorAll('tr')).some((row) => {
        const text = row.innerText.replace(/\\s+/g, ' ').trim();
        return (text.includes(targetDate) || text.includes(shortDate))
          && text.includes(slot)
          && !text.includes('已取消')
          && (text.includes('已预约') || text.includes('取消预约'));
      });
      return JSON.stringify({found});
    })()`,
    (value) => value.found,
    12_000,
    "检查我的预约",
  ).then(() => true).catch(() => false);
}

export async function runReservation(
  plan: ReservationPlan,
  mode: RunMode,
  options: ReservationRunOptions = {},
): Promise<ReservationResult> {
  if (plan.resourceId !== RESOURCE_ID) {
    throw new Error(`不支持的资源 ID：${plan.resourceId}`);
  }
  const today = shanghaiDate();
  if (plan.targetDate <= today) {
    throw new Error(`目标日期必须晚于今天：${plan.targetDate}`);
  }
  if (plan.targetDate > addCalendarDays(today, 370)) {
    throw new Error("目标日期超过脚本允许的范围（370 天）");
  }
  if (options.notBefore && mode !== "submit") {
    throw new Error("--not-before 只允许用于 --submit");
  }
  const maxLatenessMs = options.maxLatenessMs ?? 120_000;
  if (options.notBefore && Date.now() > options.notBefore.getTime() + maxLatenessMs) {
    throw new Error(`已错过预约执行窗口：${options.notBefore.toISOString()}`);
  }

  const artifacts = await artifactPaths(plan.id);
  let normalEdgeStarted = false;
  let launchRequests = 0;
  let selectedSlot: string | undefined;
  let screenshot: string | undefined;
  try {
    normalEdgeStarted = true;
    await openAuthenticatedReservationPage();
    const initialWeekDecision = await currentWeekNavigationDecision(plan.targetDate);
    const releaseLoadStrategy = options.notBefore
      ? decideReleaseLoadStrategy(initialWeekDecision)
      : "reload";
    if (!options.notBefore || releaseLoadStrategy === "reload") {
      await moveToTargetWeek(plan.targetDate);
    }
    if (options.notBefore) {
      console.log(
        releaseLoadStrategy === "navigate-at-release"
          ? `[${new Date().toISOString()}] RUN_PHASE：页面预热完成，目标在下一周，整点切换目标周；等待 ${options.notBefore.toISOString()}`
          : `[${new Date().toISOString()}] RUN_PHASE：页面预热完成，整点刷新当前周；等待 ${options.notBefore.toISOString()}`,
      );
      await waitUntilRelease(options.notBefore, maxLatenessMs);
      if (releaseLoadStrategy === "navigate-at-release") {
        console.log(
          `[${new Date().toISOString()}] RUN_PHASE：开放时刻已到，切换到目标周并加载预约资源`,
        );
        await moveToTargetWeek(plan.targetDate);
      } else {
        console.log(`[${new Date().toISOString()}] RUN_PHASE：开放时刻已到，刷新预约资源`);
        await reloadReservationTable();
        await moveToTargetWeek(plan.targetDate);
      }
    }
    await installLaunchMonitor();
    console.log(`[${new Date().toISOString()}] RUN_PHASE：按优先级选择目标时段`);
    const selection = await selectSlot(plan.targetDate, plan.slots);
    selectedSlot = selection.slot;
    if (mode === "dry-run") {
      await focusCourtTab();
      await captureCourtWindow(artifacts.screenshotPath);
      screenshot = artifacts.screenshotPath;
    }

    if (mode === "dry-run") {
      launchRequests = await countLaunchRequests();
      if (launchRequests !== 0) {
        throw new Error("dry-run 检测到预约提交请求，已停止");
      }
      const result: ReservationResult = {
        mode,
        planId: plan.id,
        targetDate: plan.targetDate,
        selectedSlot,
        status: "ready",
        message: `READY_TO_SUBMIT：${plan.targetDate} ${selectedSlot}（${selection.availability}）`,
        launchRequests,
        screenshot,
      };
      await executeCourtJavaScript("location.reload(); JSON.stringify({cleared: true})");
      await writeResultLog(artifacts.logPath, result);
      await updatePlan(
        plan.id,
        "ready",
        { at: new Date().toISOString(), mode, slot: selectedSlot, result: "ready" },
        result,
      );
      return result;
    }

    if (await captchaVisible()) {
      throw new Error("页面出现验证码或滑块，脚本不会尝试绕过");
    }
    console.log(`[${new Date().toISOString()}] RUN_PHASE：二次核验通过，单次点击确认预约`);
    const submittedAt = await submitReservation(plan.targetDate, selectedSlot);
    if (options.deferVerification) {
      // Keep this exact browser alive until the booking request has completed.
      // A fixed short delay can terminate a slow in-flight POST when finally
      // closes the dedicated Edge before the low-priority run starts.
      const submission = await waitForSubmissionReceipt(submittedAt);
      launchRequests = Math.max(
        submission.observed ? 1 : 0,
        await countLaunchRequests(),
      );
      console.log(
        `[${new Date().toISOString()}] RUN_PHASE：提交响应判定 `
        + `observed=${submission.observed} completed=${submission.completed} `
        + `outcome=${submission.outcome} http=${submission.httpStatus ?? "unknown"} `
        + `elapsedMs=${submission.elapsedMs}`,
      );
      if (launchRequests > 1) {
        throw new Error(`预约提交请求次数异常：${launchRequests}`);
      }
      if (submission.outcome === "failure") {
        throw new Error(
          `预约接口明确返回失败`
          + `${submission.httpStatus ? `（HTTP ${submission.httpStatus}）` : ""}`
          + `${submission.responseMessage ? `：${submission.responseMessage}` : ""}`,
        );
      }
      const status = submission.completed ? "submitted" : "ambiguous";
      const result: ReservationResult = {
        mode,
        planId: plan.id,
        targetDate: plan.targetDate,
        selectedSlot,
        status,
        message: submission.completed
          ? `预约请求已完成，延后核验：${plan.targetDate} ${selectedSlot}`
          : `确认预约已点击，但 ${submission.elapsedMs}ms 内未取得完整响应，禁止自动重试`,
        launchRequests,
        submission,
      };
      await writeResultLog(artifacts.logPath, result);
      await updatePlan(
        plan.id,
        status,
        { at: new Date().toISOString(), mode, slot: selectedSlot, result: status },
        result,
      );
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    launchRequests = await countLaunchRequests();
    if (launchRequests > 1) {
      throw new Error(`预约提交请求次数异常：${launchRequests}`);
    }

    const recordFound = await verifyAppointment(plan.targetDate, selectedSlot);
    const status = recordFound ? "confirmed" : "ambiguous";
    const result: ReservationResult = {
      mode,
      planId: plan.id,
      targetDate: plan.targetDate,
      selectedSlot,
      status,
      message: recordFound
        ? `预约成功：${plan.targetDate} ${selectedSlot}`
        : "提交已发出，但未在我的预约中确认，禁止自动重试",
      launchRequests,
      screenshot,
    };
    await writeResultLog(artifacts.logPath, result);
    await updatePlan(
      plan.id,
      status,
      { at: new Date().toISOString(), mode, slot: selectedSlot, result: status },
      result,
    );
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const result: ReservationResult = {
      mode,
      planId: plan.id,
      targetDate: plan.targetDate,
      selectedSlot,
      status: "failed",
      message,
      launchRequests,
    };
    await writeResultLog(artifacts.logPath, result).catch(() => undefined);
    await updatePlan(
      plan.id,
      "failed",
      {
        at: new Date().toISOString(),
        mode,
        slot: selectedSlot,
        result: "failed",
        message: message.slice(0, 300),
      },
      result,
    ).catch(() => undefined);
    throw error;
  } finally {
    if (normalEdgeStarted) {
      await closeCourtWindow().catch(() => undefined);
      await stopDedicatedEdge().catch(() => undefined);
    }
  }
}

export async function verifyReservationRecord(
  targetDate: string,
  slot: string,
): Promise<boolean> {
  let normalEdgeStarted = false;
  try {
    normalEdgeStarted = true;
    await openAuthenticatedReservationPage();
    return await verifyAppointment(targetDate, slot);
  } finally {
    if (normalEdgeStarted) {
      await closeCourtWindow().catch(() => undefined);
      await stopDedicatedEdge().catch(() => undefined);
    }
  }
}
