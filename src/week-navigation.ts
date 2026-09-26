export interface WeekNavigationSnapshot {
  start: string;
  end: string;
  visibleDates: string[];
}

export type WeekNavigationDecision = "visible" | "wait" | "前一周" | "后一周";

export type ReleaseLoadStrategy = "reload" | "navigate-at-release";

export function decideWeekNavigation(
  targetDate: string,
  snapshot: WeekNavigationSnapshot,
): WeekNavigationDecision {
  // Rendered columns are authoritative and can precede hydrated range inputs.
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
  // The range can update before its columns finish rendering.
  if (targetDate >= snapshot.start && targetDate <= snapshot.end) {
    return "wait";
  }
  return targetDate < snapshot.start ? "前一周" : "后一周";
}

export function decideReleaseLoadStrategy(
  decision: WeekNavigationDecision,
): ReleaseLoadStrategy {
  // A full reload resets the booking app to the current week. If the target is
  // in a later week, waiting there and clicking "后一周" at release avoids
  // loading the current week first and the target week second.
  return decision === "后一周" ? "navigate-at-release" : "reload";
}
