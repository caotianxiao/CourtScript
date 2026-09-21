import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LOG_DIR, SCREENSHOT_DIR } from "./constants.js";
import type { ReservationResult } from "./types.js";

function safeTimestamp(): string {
  return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

export async function artifactPaths(planId: string): Promise<{
  logPath: string;
  screenshotPath: string;
}> {
  await mkdir(LOG_DIR, { recursive: true, mode: 0o700 });
  await mkdir(SCREENSHOT_DIR, { recursive: true, mode: 0o700 });
  await chmod(LOG_DIR, 0o700);
  await chmod(SCREENSHOT_DIR, 0o700);
  const stamp = safeTimestamp();
  return {
    logPath: join(LOG_DIR, `${stamp}-${planId}.json`),
    screenshotPath: join(SCREENSHOT_DIR, `${stamp}-${planId}.png`),
  };
}

export async function writeResultLog(
  logPath: string,
  result: ReservationResult,
): Promise<void> {
  const safeResult = {
    ...result,
    message: result.message.slice(0, 500),
  };
  await writeFile(logPath, `${JSON.stringify(safeResult, null, 2)}\n`, {
    mode: 0o600,
  });
}

