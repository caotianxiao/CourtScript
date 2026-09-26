export interface WeekNavigationSnapshot {
  start: string;
  end: string;
  visibleDates: string[];
}

export type WeekNavigationDecision = "visible" | "wait" | "前一周" | "后一周";

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
