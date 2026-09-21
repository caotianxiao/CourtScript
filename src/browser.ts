import { access, chmod, mkdir } from "node:fs/promises";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { EDGE_EXECUTABLE, PROFILE_DIR } from "./constants.js";

export async function verifyEdgeInstalled(): Promise<void> {
  await access(EDGE_EXECUTABLE);
}

export async function launchDedicatedContext(options?: {
  headless?: boolean;
}): Promise<BrowserContext> {
  await verifyEdgeInstalled();
  await mkdir(PROFILE_DIR, { recursive: true, mode: 0o700 });
  await chmod(PROFILE_DIR, 0o700);
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    executablePath: EDGE_EXECUTABLE,
    headless: options?.headless ?? true,
    viewport: { width: 1440, height: 1000 },
    ignoreDefaultArgs: ["--enable-automation"],
    args: [
      "--disable-sync",
      "--disable-blink-features=AutomationControlled",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=msEdgeSidebarV2",
    ],
  });
  await context.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "webdriver", {
      configurable: true,
      get: () => undefined,
    });
  });
  return context;
}

export async function skipDebuggerPauses(
  context: BrowserContext,
  page: Page,
): Promise<void> {
  const session = await context.newCDPSession(page);
  await session.send("Debugger.enable");
  await session.send("Debugger.setSkipAllPauses", { skip: true });
}
