import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

// `courtscript` is normally installed through `npm link`, so callers may run
// it from any working directory. Both src/ (tsx) and dist/ (compiled CLI) live
// one level below the repository root.
export const PROJECT_ROOT = resolve(MODULE_DIR, "..");
export const STATE_DIR = join(PROJECT_ROOT, ".state");
export const PLANS_FILE = join(STATE_DIR, "plans.json");
export const PROFILE_DIR = join(STATE_DIR, "edge-profile");
export const LOG_DIR = join(STATE_DIR, "logs");
export const SCREENSHOT_DIR = join(STATE_DIR, "screenshots");

export const EDGE_EXECUTABLE =
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
export const EDGE_USER_DATA = join(
  homedir(),
  "Library/Application Support/Microsoft Edge",
);
export const EDGE_PROFILE_NAME = "Default";

export const RESOURCE_ID = 1055;
export const RESERVATION_URL =
  `https://booking.fudan.edu.cn/reservation/fe/site/reservationInfo?id=${RESOURCE_ID}`;
export const FUDAN_SUFFIX = "fudan.edu.cn";
export const TIME_ZONE = "Asia/Shanghai";
export const LAUNCH_PATH = "/reservation/site/resource/launch";

