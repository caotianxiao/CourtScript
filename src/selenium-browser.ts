import { mkdir, chmod } from "node:fs/promises";
import {
  Builder,
  By,
  Browser,
  until,
  type WebDriver,
  type WebElement,
} from "selenium-webdriver";
import { Driver as EdgeDriver, Options } from "selenium-webdriver/edge.js";
import {
  EDGE_EXECUTABLE,
  PROFILE_DIR,
  RESERVATION_URL,
} from "./constants.js";
import {
  loadStoredCredentials,
  type StoredCredentials,
} from "./credentials.js";
import { stopDedicatedEdge } from "./edge-apple-events.js";

export const EHALL_URL = "https://ehall.fudan.edu.cn/";
const SERVICE_NAME = "体育场馆个人预约";
const VENUE_NAME = "江湾综合体育馆-羽毛球";
export const SPECIAL_URL =
  "https://booking.fudan.edu.cn/reservation/fe/site/special/special?id=48";

export async function launchSeleniumEdge(): Promise<WebDriver> {
  await stopDedicatedEdge();
  await mkdir(PROFILE_DIR, { recursive: true, mode: 0o700 });
  await chmod(PROFILE_DIR, 0o700);

  const options = new Options();
  options.setEdgeChromiumBinaryPath(EDGE_EXECUTABLE);
  options.addArguments(
    `--user-data-dir=${PROFILE_DIR}`,
    "--profile-directory=Default",
    "--disable-sync",
    "--disable-blink-features=AutomationControlled",
    "--hide-crash-restore-bubble",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=msEdgeSidebarV2",
    "--window-size=1440,1000",
  );
  options.excludeSwitches("enable-automation");

  return new Builder()
    .forBrowser(Browser.EDGE)
    .setEdgeOptions(options)
    .build();
}

async function bodyText(driver: WebDriver): Promise<string> {
  return driver.findElement(By.css("body")).getText().catch(() => "");
}

async function firstVisibleElement(
  driver: WebDriver,
  locator: By,
): Promise<WebElement | undefined> {
  const elements = await driver.findElements(locator);
  for (const element of elements) {
    if (await element.isDisplayed().catch(() => false)) {
      return element;
    }
  }
  return undefined;
}

async function ehallLoggedIn(driver: WebDriver): Promise<boolean> {
  const text = await bodyText(driver);
  if (!text.includes(SERVICE_NAME)) {
    return false;
  }
  const loginButton = await firstVisibleElement(
    driver,
    By.xpath("//*[normalize-space()='登录']"),
  );
  return !loginButton;
}

async function persistCurrentFudanCookies(driver: WebDriver): Promise<void> {
  const cookies = await driver.manage().getCookies();
  const expiry = Math.floor(Date.now() / 1_000) + 30 * 24 * 60 * 60;
  for (const cookie of cookies) {
    const domain = (cookie.domain ?? "").replace(/^\./, "").toLowerCase();
    if (!domain.endsWith("fudan.edu.cn") || cookie.expiry) {
      continue;
    }
    await driver.manage().addCookie({ ...cookie, expiry });
  }
}

async function skipBookingDebuggerPauses(driver: WebDriver): Promise<void> {
  const edgeDriver = driver as EdgeDriver;
  await edgeDriver.sendDevToolsCommand("Debugger.enable", {});
  await edgeDriver.sendDevToolsCommand("Debugger.setSkipAllPauses", { skip: true });
}

async function submitIdentityLogin(
  driver: WebDriver,
  credentials: StoredCredentials,
): Promise<boolean> {
  const url = await driver.getCurrentUrl().catch(() => "");
  if (!url.includes("id.fudan.edu.cn")) {
    return false;
  }
  const pageText = await bodyText(driver);
  if (/滑块|验证码|captcha/i.test(pageText)) {
    throw new Error("统一身份认证出现验证码或滑块，脚本不会尝试绕过");
  }
  const username = await firstVisibleElement(
    driver,
    By.css('input[placeholder*="用户名"]'),
  );
  const password = await firstVisibleElement(
    driver,
    By.css('input[type="password"]'),
  );
  const submit = await firstVisibleElement(
    driver,
    By.xpath("//button[normalize-space()='登录']"),
  );
  if (!username || !password || !submit) {
    return false;
  }
  await username.clear();
  await username.sendKeys(credentials.username);
  await password.clear();
  await password.sendKeys(credentials.password);
  await driver.wait(until.elementIsEnabled(submit), 5_000);
  await submit.click();
  return true;
}

async function switchToBookingWindow(
  driver: WebDriver,
  handlesBefore: string[],
): Promise<boolean> {
  const deadline = Date.now() + 20_000;
  let newestHandle: string | undefined;
  while (Date.now() < deadline) {
    const handles = await driver.getAllWindowHandles();
    newestHandle = handles.find((handle) => !handlesBefore.includes(handle))
      ?? handles.at(-1);
    for (const handle of [...handles].reverse()) {
      try {
        await driver.switchTo().window(handle);
        const url = await driver.getCurrentUrl();
        if (url.includes("booking.fudan.edu.cn")) {
          return true;
        }
      } catch {
        // A newly opened tab can be briefly unavailable while Edge attaches it.
      }
    }
    await driver.sleep(400);
  }

  if (newestHandle) {
    await driver.switchTo().window(newestHandle).catch(() => undefined);
  }
  return false;
}

async function switchToResourceWindow(driver: WebDriver): Promise<boolean> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const handles = await driver.getAllWindowHandles();
    for (const handle of [...handles].reverse()) {
      try {
        await driver.switchTo().window(handle);
        const url = await driver.getCurrentUrl();
        if (url.includes("reservationInfo?id=1055")) {
          return true;
        }
      } catch {
        // Continue until the new venue tab is attached to WebDriver.
      }
    }
    await driver.sleep(400);
  }
  return false;
}

async function switchToReservationTable(
  driver: WebDriver,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const handles = await driver.getAllWindowHandles();
    for (const handle of [...handles].reverse()) {
      try {
        await driver.switchTo().window(handle);
        const tables = await driver.findElements(By.css(".week_calendar"));
        if (tables.length > 0) {
          return true;
        }
      } catch {
        // Tabs involved in the SSO redirect can close while we enumerate them.
      }
    }
    await driver.sleep(400);
  }
  return false;
}

async function navigateLiveWindow(driver: WebDriver, url: string): Promise<void> {
  const handles = await driver.getAllWindowHandles();
  let lastError: unknown;
  for (const handle of [...handles].reverse()) {
    try {
      await driver.switchTo().window(handle);
      await driver.get(url);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("没有可用的 Edge 标签页");
}

async function describeControlledSurfaces(driver: WebDriver): Promise<string> {
  const descriptions: string[] = [];
  const handles = await driver.getAllWindowHandles();
  for (const handle of handles) {
    try {
      await driver.switchTo().window(handle);
      const [url, title, source, frames] = await Promise.all([
        driver.getCurrentUrl(),
        driver.getTitle(),
        driver.getPageSource(),
        driver.findElements(By.css("iframe")),
      ]);
      descriptions.push(JSON.stringify({
        url,
        title,
        sourceLength: source.length,
        hasWeekCalendar: source.includes("week_calendar"),
        hasReservationData: source.includes("reservation_data"),
        iframeCount: frames.length,
      }));
    } catch (error) {
      descriptions.push(JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }
  return descriptions.join("; ");
}

async function clickService(driver: WebDriver): Promise<boolean> {
  const service = await driver.wait(async () => firstVisibleElement(
    driver,
    By.xpath(`//*[normalize-space()='${SERVICE_NAME}']`),
  ), 20_000, `未找到“${SERVICE_NAME}”`);
  if (!service) {
    throw new Error(`未找到“${SERVICE_NAME}”`);
  }
  await driver.executeScript(
    "arguments[0].scrollIntoView({block: 'center'});",
    service,
  );
  await driver.executeScript(`
    window.open = (url) => {
      window.location.assign(url);
      return window;
    };
    document.querySelectorAll('a[target="_blank"]').forEach((item) => {
      item.setAttribute('target', '_self');
    });
    arguments[0].click();
  `, service);
  return driver.wait(async () => {
    const url = await driver.getCurrentUrl().catch(() => "");
    return url.includes("booking.fudan.edu.cn");
  }, 20_000).catch(() => false);
}

async function clickVenue(driver: WebDriver): Promise<boolean> {
  const venue = await driver
    .findElement(By.xpath(`//*[normalize-space()='${VENUE_NAME}']`))
    .catch(() => undefined);
  if (!venue) {
    return false;
  }
  const bookButton = await venue
    .findElement(By.xpath("./following::*[normalize-space()='去预约'][1]"))
    .catch(() => undefined);
  if (!bookButton) {
    return false;
  }
  await driver.executeScript(
    "arguments[0].scrollIntoView({block: 'center'});",
    bookButton,
  );
  await driver.executeScript(`
    window.open = (url) => {
      window.location.assign(url);
      return window;
    };
    document.querySelectorAll('a[target="_blank"]').forEach((item) => {
      item.setAttribute('target', '_self');
    });
    arguments[0].click();
  `, bookButton);
  return true;
}

export async function authenticateEhall(
  driver: WebDriver,
  options?: { loginTimeoutMs?: number },
): Promise<void> {
  await driver.get(EHALL_URL);
  const loginTimeout = options?.loginTimeoutMs ?? 30_000;
  await driver.wait(
    async () => (await bodyText(driver)).includes(SERVICE_NAME),
    30_000,
    "eHall 首页加载超时",
  );
  let loginButton: WebElement | undefined;
  await driver.wait(async () => {
    if (await ehallLoggedIn(driver)) {
      return true;
    }
    loginButton = await firstVisibleElement(
      driver,
      By.css(".right.login_btn"),
    );
    return Boolean(loginButton);
  }, 20_000, "无法判断 eHall 登录状态");
  if (loginButton) {
    await loginButton.click().catch(async (error) => {
      await driver.sleep(500);
      const url = await driver.getCurrentUrl().catch(() => "");
      if (!url.includes("id.fudan.edu.cn")) {
        throw error;
      }
    });
  }
  const credentials = await loadStoredCredentials();
  let credentialsSubmitted = false;
  await driver.wait(
    async () => {
      if (await ehallLoggedIn(driver)) {
        return true;
      }
      if (!credentialsSubmitted && credentials) {
        credentialsSubmitted = await submitIdentityLogin(driver, credentials);
      }
      return false;
    },
    loginTimeout,
    credentials
      ? "统一身份认证未能自动完成，请检查账号、密码或二次验证"
      : "eHall 尚未登录；请在独立 Edge 窗口完成统一认证，或先运行 auth save-credentials",
  );
  await persistCurrentFudanCookies(driver);
}

export async function navigateFromEhall(
  driver: WebDriver,
  options?: { loginTimeoutMs?: number },
): Promise<void> {
  await authenticateEhall(driver, options);
  const loginTimeout = options?.loginTimeoutMs ?? 30_000;

  // The eHall card and the venue button force new tabs. The booking site pauses
  // while such tabs are controlled by WebDriver, so visit the exact destinations
  // observed from those two UI actions in the same authenticated tab.
  await skipBookingDebuggerPauses(driver);
  await driver.get(SPECIAL_URL);
  const bookingBodyReady = await driver.wait(async () => {
    const text = await bodyText(driver);
    return text.includes("体育场馆网上预约") || text.includes(VENUE_NAME);
  }, loginTimeout, "预约专题页加载超时").catch(() => false);
  if (!bookingBodyReady) {
    const surfaces = await describeControlledSurfaces(driver);
    throw new Error(`预约专题页加载超时；受控页面：${surfaces}`);
  }
  await persistCurrentFudanCookies(driver);

  await driver.get(RESERVATION_URL);
  const tableReady = await switchToReservationTable(driver, 30_000);
  if (!tableReady) {
    const surfaces = await describeControlledSurfaces(driver);
    throw new Error(`羽毛球预约表格加载超时；受控页面：${surfaces}`);
  }
  await persistCurrentFudanCookies(driver);
  if (!(await driver.getCurrentUrl()).includes(`reservationInfo?id=1055`)) {
    throw new Error("页面未停留在目标资源 1055");
  }
}

export async function exactTextElement(
  driver: WebDriver,
  text: string,
): Promise<WebElement> {
  return driver.findElement(By.xpath(`//*[normalize-space()='${text}']`));
}
