import { loadStoredCredentials } from "./credentials.js";
import { RESERVATION_URL } from "./constants.js";
import {
  executeCourtJavaScript,
  launchNormalEdge,
  waitForCourtJavaScript,
} from "./edge-apple-events.js";
import { EHALL_URL, SPECIAL_URL } from "./selenium-browser.js";

interface PageState {
  url: string;
  title: string;
  bodyLength: number;
  text: string;
  usernameInput: boolean;
  passwordInput: boolean;
  calendar: boolean;
  ehallService: boolean;
  ehallLogin: boolean;
}

const PAGE_STATE_SCRIPT = `(() => JSON.stringify({
  url: location.href,
  title: document.title,
  bodyLength: document.body ? document.body.innerText.length : 0,
  text: document.body ? document.body.innerText.slice(0, 500) : '',
  usernameInput: Boolean(document.querySelector(
    '#login-username, input[name="username"], input[placeholder*="用户名"]'
  )),
  passwordInput: Boolean(document.querySelector('input[type="password"]')),
  calendar: Boolean(document.querySelector('.week_calendar')),
  ehallService: Boolean(document.body?.innerText.includes('体育场馆个人预约')),
  ehallLogin: Array.from(document.querySelectorAll('.right.login_btn')).some((item) => {
    const rect = item.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && getComputedStyle(item).visibility !== 'hidden';
  })
}))()`;

function pageHasChallenge(state: PageState): boolean {
  return /滑块|验证码|captcha/i.test(state.text);
}

async function submitIdentityLogin(): Promise<void> {
  const credentials = await loadStoredCredentials();
  if (!credentials) {
    throw new Error("统一身份认证需要登录，请先运行 auth save-credentials");
  }
  const script = `(() => {
    const text = document.body ? document.body.innerText : '';
    if (/滑块|验证码|captcha/i.test(text)) {
      return JSON.stringify({status: 'challenge'});
    }
    const username = document.querySelector(
      '#login-username, input[name="username"], input[placeholder*="用户名"]'
    );
    const password = document.querySelector(
      '#login-password, input[name="password"], input[type="password"]'
    );
    const button = Array.from(document.querySelectorAll('button'))
      .find((item) => item.innerText.trim() === '登录');
    if (!username || !password || !button) {
      return JSON.stringify({status: 'not-ready'});
    }
    const setValue = (element, value) => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      ).set;
      setter.call(element, value);
      element.dispatchEvent(new Event('input', {bubbles: true}));
      element.dispatchEvent(new Event('change', {bubbles: true}));
    };
    setValue(username, ${JSON.stringify(credentials.username)});
    setValue(password, ${JSON.stringify(credentials.password)});
    window.setTimeout(() => button.click(), 100);
    return JSON.stringify({status: 'scheduled'});
  })()`;
  const output = await executeCourtJavaScript(script);
  const result = JSON.parse(output) as { status?: string };
  if (result.status === "challenge") {
    throw new Error("统一身份认证出现验证码或滑块，脚本不会尝试绕过");
  }
  if (result.status !== "scheduled") {
    throw new Error("统一身份认证表单尚未准备好");
  }
}

async function navigate(url: string): Promise<void> {
  await executeCourtJavaScript(
    `location.assign(${JSON.stringify(url)}); JSON.stringify({navigating: true})`,
  );
}

async function clickEhallLogin(): Promise<void> {
  const output = await executeCourtJavaScript(`(() => {
    const button = Array.from(document.querySelectorAll('.right.login_btn'))
      .find((item) => {
        const rect = item.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0
          && getComputedStyle(item).visibility !== 'hidden';
      });
    if (!button) return JSON.stringify({clicked: false});
    window.open = (url) => {
      location.assign(url);
      return window;
    };
    document.querySelectorAll('a[target="_blank"]').forEach((item) => {
      item.setAttribute('target', '_self');
    });
    button.click();
    return JSON.stringify({clicked: true});
  })()`);
  if (!(JSON.parse(output) as { clicked?: boolean }).clicked) {
    throw new Error("eHall 登录按钮不可用");
  }
}

export async function openAuthenticatedReservationPage(): Promise<void> {
  console.log(`[${new Date().toISOString()}] AUTH_PHASE：启动普通 Edge 并打开 eHall`);
  await launchNormalEdge(EHALL_URL);
  let loginSubmitted = false;
  let ehallLoginClickAt = 0;
  let specialNavigationStarted = false;
  let resourceNavigationStarted = false;
  const deadline = Date.now() + 75_000;
  let lastState: PageState | undefined;

  while (Date.now() < deadline) {
    lastState = await waitForCourtJavaScript<PageState>(
      PAGE_STATE_SCRIPT,
      (state) => Boolean(state.url),
      8_000,
      "连接普通 Edge",
      { minimumAttempts: 3 },
    );
    if (pageHasChallenge(lastState)) {
      throw new Error("页面出现验证码或滑块，脚本不会尝试绕过");
    }
    if (lastState.url.includes("id.fudan.edu.cn")) {
      if (!loginSubmitted && lastState.usernameInput && lastState.passwordInput) {
        console.log(`[${new Date().toISOString()}] AUTH_PHASE：提交统一身份认证表单`);
        await submitIdentityLogin();
        loginSubmitted = true;
      }
    } else if (lastState.url.includes("ehall.fudan.edu.cn")) {
      if (lastState.ehallLogin) {
        if (Date.now() - ehallLoginClickAt >= 3_000) {
          console.log(`[${new Date().toISOString()}] AUTH_PHASE：点击 eHall 登录`);
          await clickEhallLogin();
          ehallLoginClickAt = Date.now();
        }
      } else if (lastState.ehallService && !specialNavigationStarted) {
        console.log(`[${new Date().toISOString()}] AUTH_PHASE：eHall 已登录，进入场馆预约专题`);
        await navigate(SPECIAL_URL);
        specialNavigationStarted = true;
      }
    } else if (lastState.url.includes("reservationInfo?id=1055")) {
      if (lastState.calendar) {
        console.log(`[${new Date().toISOString()}] AUTH_PHASE：资源 1055 预约表已就绪`);
        return;
      }
    } else if (
      lastState.url.includes("booking.fudan.edu.cn")
      && lastState.bodyLength > 0
      && !resourceNavigationStarted
    ) {
      console.log(`[${new Date().toISOString()}] AUTH_PHASE：进入羽毛球资源 1055`);
      await navigate(RESERVATION_URL);
      resourceNavigationStarted = true;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  throw new Error(
    `羽毛球预约表格加载超时：${JSON.stringify(lastState ?? {}).slice(0, 500)}`,
  );
}

export async function currentPageState(): Promise<PageState> {
  return JSON.parse(await executeCourtJavaScript(PAGE_STATE_SCRIPT)) as PageState;
}
