import { TIME_ZONE } from "./constants.js";

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const SLOT_RE = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/;

export function validateDate(value: string): string {
  const match = DATE_RE.exec(value);
  if (!match) {
    throw new Error(`日期必须使用 YYYY-MM-DD 格式：${value}`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`日期不存在：${value}`);
  }
  return value;
}

function toMinutes(hour: string, minute: string): number {
  const h = Number(hour);
  const m = Number(minute);
  if (h > 23 || m > 59) {
    return Number.NaN;
  }
  return h * 60 + m;
}

export function validateSlot(value: string): string {
  const match = SLOT_RE.exec(value);
  if (!match) {
    throw new Error(`时段必须使用 HH:mm-HH:mm 格式：${value}`);
  }
  const start = toMinutes(match[1]!, match[2]!);
  const end = toMinutes(match[3]!, match[4]!);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
    throw new Error(`时段不合法：${value}`);
  }
  return value;
}

export function normalizeSlots(primary: string, fallbacks: string[]): string[] {
  const values = [primary, ...fallbacks].map(validateSlot);
  return [...new Set(values)];
}

export function shanghaiDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function addCalendarDays(dateValue: string, days: number): string {
  validateDate(dateValue);
  const [year, month, day] = dateValue.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day! + days));
  return date.toISOString().slice(0, 10);
}

export function releaseDateFor(targetDate: string): string {
  return addCalendarDays(targetDate, -2);
}

