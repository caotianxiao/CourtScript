import { LAUNCH_PATH, RESOURCE_ID } from "./constants.js";
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

const PAGE_TIMEOUT = 30_000;

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

interface WeekNavigationSnapshot {
  start: string;
  end: string;
  visibleDates: string[];
}

export type WeekNavigationDecision = "visible" | "wait" | "前一周" | "后一周";

export function decideWeekNavigation(
  targetDate: string,
  snapshot: WeekNavigationSnapshot,
): WeekNavigationDecision {
  // The rendered date columns are the authoritative state.  In particular,
  // they can be ready before the date-range inputs finish hydrating after a
  // reload, so a visible target must never trigger week navigation.
  if (snapshot.visibleDates.includes(targetDate)) {
    return "visible";
  }
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  if (
    !datePattern.test(snapshot.start)
    || !datePattern.test(snapshot.end)
    || snapshot.start > snapshot.end
  ) {
    return "wait";
  }
  // If the inputs say that the target belongs to this week but its column is
  // not rendered yet, keep waiting instead of clicking a navigation control.
  if (targetDate >= snapshot.start && targetDate <= snapshot.end) {
    return "wait";
  }
  return targetDate < snapshot.start ? "前一周" : "后一周";
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

async function selectSlot(
  targetDate: string,
  slots: string[],
): Promise<SlotSelection> {
  const result = await waitForCourtJavaScript<SlotSelection & {
    state: "loading" | "selected" | "unavailable" | "error";
    error?: string;
    timeCount?: number;
    cellCount?: number;
  }>(`(() => {
    const targetDate = ${JSON.stringify(targetDate)};
    const slots = ${JSON.stringify(slots)};
    const times = Array.from(
      document.querySelectorAll('.left_time dd.resource_item_info'),
    ).map((item) => item.innerText.trim());
    if (times.length !== 14
        || times.some((time) => !/^\\d{2}:\\d{2}-\\d{2}:\\d{2}$/.test(time))) {
      return JSON.stringify({state: 'loading', timeCount: times.length});
    }
    const columns = Array.from(document.querySelectorAll('.reservation_data'));
    const matches = columns.filter((column) =>
      Array.from(column.querySelectorAll('.week_header span'))
        .some((span) => span.innerText.trim() === targetDate),
    );
    if (matches.length === 0) {
      return JSON.stringify({state: 'loading', timeCount: times.length});
    }
    if (matches.length > 1) {
      return JSON.stringify({
        state: 'error',
        error: '无法唯一定位日期列：' + targetDate,
      });
    }
    const cells = Array.from(matches[0].querySelectorAll('dd.resource_item_info'));
    if (cells.length !== 14 || cells.some((cell) => cell.innerText.trim().length === 0)) {
      return JSON.stringify({
        state: 'loading',
        timeCount: times.length,
        cellCount: cells.length,
      });
    }
    for (const slot of slots) {
      const index = times.indexOf(slot);
      const cell = index >= 0 ? cells[index] : undefined;
      if (!cell) continue;
      const text = cell.innerText.trim();
      if (!text.includes('可预约') || !cell.classList.contains('can_active')) continue;
      cell.scrollIntoView({block: 'center'});
      cell.click();
      return JSON.stringify({state: 'selected', slot, availability: text});
    }
    return JSON.stringify({
      state: 'unavailable',
      error: '首选和备选时段均不可预约：' + slots.join(', '),
    });
  })()`,
  (value) => value.state !== "loading",
  PAGE_TIMEOUT,
  "等待完整预约表格",
  );
  if (result.error) {
    throw new Error(result.error);
  }
  if (result.state !== "selected" || !result.slot || !result.availability) {
    throw new Error("预约表格返回了无法识别的选择状态");
  }
  await waitForCourtJavaScript<{ summary: boolean; phone: boolean }>(
    `(() => {
      const expected = ${JSON.stringify(`${targetDate} ${result.slot}`)};
      const summary = Array.from(document.querySelectorAll('*'))
        .some((item) => typeof item.innerText === 'string'
          && item.innerText.trim().replace(/\\s+/g, ' ') === expected);
      const phone = document.querySelector('input[placeholder="请输入手机号"]');
      return JSON.stringify({summary, phone: Boolean(phone && phone.value.trim())});
    })()`,
    (value) => value.summary && value.phone,
    PAGE_TIMEOUT,
    "核验预约日期、时段和预填手机号",
  );
  return { slot: result.slot, availability: result.availability };
}

async function installLaunchMonitor(): Promise<void> {
  await executeCourtJavaScript(`(() => {
    if (!window.__courtScriptLaunchMonitor) {
      const launchPath = ${JSON.stringify(LAUNCH_PATH)};
      const performanceCount = () => performance.getEntriesByType('resource')
        .filter((entry) => {
          try {
            return new URL(entry.name, location.href).pathname === launchPath;
          } catch {
            return false;
          }
        }).length;
      window.__courtScriptLaunchMonitor = {
        count: 0,
        performanceBaseline: performanceCount(),
      };
      const originalFetch = window.fetch;
      if (originalFetch) {
        window.fetch = function(input, init) {
          const url = typeof input === 'string' ? input : input && input.url;
          if (url && new URL(url, location.href).pathname === launchPath) {
            window.__courtScriptLaunchMonitor.count += 1;
          }
          return originalFetch.call(this, input, init);
        };
      }
      const originalOpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        this.__courtScriptUrl = String(url);
        return originalOpen.call(this, method, url, ...rest);
      };
      const originalSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.send = function(body) {
        if (this.__courtScriptUrl
            && new URL(this.__courtScriptUrl, location.href).pathname === launchPath) {
          window.__courtScriptLaunchMonitor.count += 1;
        }
        return originalSend.call(this, body);
      };
    }
    return JSON.stringify({installed: true});
  })()`);
}

async function countLaunchRequests(): Promise<number> {
  const output = await executeCourtJavaScript(`(() => {
    const monitor = window.__courtScriptLaunchMonitor;
    const launchPath = ${JSON.stringify(LAUNCH_PATH)};
    const performanceCount = performance.getEntriesByType('resource')
      .filter((entry) => {
        try {
          return new URL(entry.name, location.href).pathname === launchPath;
        } catch {
          return false;
        }
      }).length - (monitor?.performanceBaseline ?? 0);
    return JSON.stringify({
      count: Math.max(monitor?.count ?? 0, performanceCount, 0),
    });
  })()`);
  const result = JSON.parse(output) as { count?: number };
  return Number(result.count) || 0;
}

async function captchaVisible(): Promise<boolean> {
  const output = await executeCourtJavaScript(`JSON.stringify({
    challenge: /滑块|验证码|captcha/i.test(document.body?.innerText || '')
  })`);
  return Boolean((JSON.parse(output) as { challenge?: boolean }).challenge);
}

async function submitReservation(): Promise<void> {
  const output = await executeCourtJavaScript(`(() => {
    const button = Array.from(document.querySelectorAll('button'))
      .find((item) => item.innerText.trim() === '确认预约');
    if (!button) return JSON.stringify({clicked: false});
    button.click();
    return JSON.stringify({clicked: true});
  })()`);
  if (!(JSON.parse(output) as { clicked?: boolean }).clicked) {
    throw new Error("页面缺少“确认预约”按钮");
  }
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
      const slot = ${JSON.stringify(slot)};
      const found = Array.from(document.querySelectorAll('tr')).some((row) => {
        const text = row.innerText.replace(/\\s+/g, ' ').trim();
        return text.includes(targetDate)
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
    await moveToTargetWeek(plan.targetDate);
    if (options.notBefore) {
      console.log(
        `[${new Date().toISOString()}] RUN_PHASE：页面预热完成，等待 ${options.notBefore.toISOString()}`,
      );
      await waitUntilRelease(options.notBefore, maxLatenessMs);
      console.log(`[${new Date().toISOString()}] RUN_PHASE：开放时刻已到，刷新预约资源`);
      await reloadReservationTable();
      await moveToTargetWeek(plan.targetDate);
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
    await submitReservation();
    if (options.deferVerification) {
      // Give the page's click handler enough time to dispatch its request, but
      // do not block the next priority on screenshots or My Reservation.
      await new Promise((resolve) => setTimeout(resolve, 500));
      launchRequests = await countLaunchRequests();
      if (launchRequests > 1) {
        throw new Error(`预约提交请求次数异常：${launchRequests}`);
      }
      const result: ReservationResult = {
        mode,
        planId: plan.id,
        targetDate: plan.targetDate,
        selectedSlot,
        status: "submitted",
        message: `已提交，延后核验：${plan.targetDate} ${selectedSlot}`,
        launchRequests,
      };
      await writeResultLog(artifacts.logPath, result);
      await updatePlan(
        plan.id,
        "submitted",
        { at: new Date().toISOString(), mode, slot: selectedSlot, result: "submitted" },
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
