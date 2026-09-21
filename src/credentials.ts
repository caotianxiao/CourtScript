import { execFile } from "node:child_process";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { ensureStateDirectories } from "./state.js";
import { STATE_DIR } from "./constants.js";

const execFileAsync = promisify(execFile);
const CONFIG_FILE = join(STATE_DIR, "credentials.json");
const KEYCHAIN_SERVICE = "CourtScript Fudan eHall";

export interface StoredCredentials {
  username: string;
  password: string;
}

interface CredentialConfig {
  version: 1;
  username: string;
}

function appleScriptString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

async function existingUsername(): Promise<string> {
  try {
    const config = JSON.parse(await readFile(CONFIG_FILE, "utf8")) as CredentialConfig;
    return typeof config.username === "string" ? config.username : "";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

export async function saveCredentialsFromDialog(): Promise<string> {
  const priorUsername = appleScriptString(await existingUsername());
  const script = `
    set accountDialog to display dialog "请输入复旦统一身份认证账号" default answer "${priorUsername}" buttons {"取消", "继续"} default button "继续" cancel button "取消" with title "CourtScript"
    set passwordDialog to display dialog "请输入统一身份认证密码（将保存到 macOS 钥匙串）" default answer "" buttons {"取消", "保存"} default button "保存" cancel button "取消" with title "CourtScript" with hidden answer
    return (text returned of accountDialog) & linefeed & (text returned of passwordDialog)
  `;
  const { stdout } = await execFileAsync("osascript", ["-e", script], {
    maxBuffer: 1024 * 1024,
  });
  const separator = stdout.indexOf("\n");
  if (separator < 0) {
    throw new Error("没有收到完整的账号和密码");
  }
  const username = stdout.slice(0, separator).trim();
  const password = stdout.slice(separator + 1).replace(/\r?\n$/, "");
  if (!username || !password) {
    throw new Error("账号和密码不能为空");
  }

  await ensureStateDirectories();
  await execFileAsync("security", [
    "add-generic-password",
    "-U",
    "-a",
    username,
    "-s",
    KEYCHAIN_SERVICE,
    "-w",
    password,
  ]);
  const config: CredentialConfig = { version: 1, username };
  await writeFile(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(CONFIG_FILE, 0o600);
  return username;
}

export async function loadStoredCredentials(): Promise<StoredCredentials | undefined> {
  let config: CredentialConfig;
  try {
    config = JSON.parse(await readFile(CONFIG_FILE, "utf8")) as CredentialConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  if (config.version !== 1 || !config.username) {
    throw new Error("凭据配置文件格式不受支持");
  }
  try {
    const { stdout } = await execFileAsync("security", [
      "find-generic-password",
      "-w",
      "-a",
      config.username,
      "-s",
      KEYCHAIN_SERVICE,
    ]);
    return {
      username: config.username,
      password: stdout.replace(/\r?\n$/, ""),
    };
  } catch {
    throw new Error("macOS 钥匙串中找不到 CourtScript 密码，请重新运行 auth save-credentials");
  }
}

export async function clearStoredCredentials(): Promise<void> {
  const username = await existingUsername();
  if (username) {
    await execFileAsync("security", [
      "delete-generic-password",
      "-a",
      username,
      "-s",
      KEYCHAIN_SERVICE,
    ]).catch(() => undefined);
  }
  await rm(CONFIG_FILE, { force: true });
}
