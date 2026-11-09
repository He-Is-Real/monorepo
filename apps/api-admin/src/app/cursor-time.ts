// SurrealDB's own datetime text: UTC, up to nanoseconds.
const DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/;

/**
 * A cursor's time: a real UTC date and time from 1970 to 9999, at SurrealDB's precision. The
 * database casts it, so anything it would refuse ("0", 31 February, 24:00) must be a `400` here,
 * never a `500` there (Codex #210; the same check as api-public-read's browse).
 */
export function isCursorTime(text: string): boolean {
  const m = DATETIME.exec(text);
  if (!m) return false;
  const [year, month, day, hour, minute, second] = m.slice(1).map(Number);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return (
    year >= 1970 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59
  );
}
