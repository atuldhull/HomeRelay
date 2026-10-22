// Timezone-aware helpers (no dependencies). All stored instants are UTC ISO strings.

export const DEFAULT_TZ = "Asia/Kolkata";

/** Intl.DateTimeFormat construction is slow (tens of microseconds each); reuse one per (kind, zone). */
const fmtCache = new Map<string, Intl.DateTimeFormat>();
function formatter(kind: string, tz: string, make: () => Intl.DateTimeFormat): Intl.DateTimeFormat {
  const key = kind + "|" + tz;
  let f = fmtCache.get(key);
  if (!f) { f = make(); fmtCache.set(key, f); }
  return f;
}

function tzOffsetMs(utcMs: number, tz: string): number {
  const parts = formatter("offset", tz, () => new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  })).formatToParts(new Date(utcMs));
  const g = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second")) - utcMs;
}

/** Local wall-clock time in `tz` -> UTC ISO string. */
export function zonedToUtcIso(y: number, mo: number, d: number, h: number, mi: number, tz = DEFAULT_TZ): string {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const first = guess - tzOffsetMs(guess, tz);
  const second = guess - tzOffsetMs(first, tz);
  return new Date(second).toISOString();
}

/** Same local wall-clock time, shifted by whole local days or months (month ends clamp, e.g. Jan 31 + 1 month = Feb 28). */
export function shiftLocal(iso: string, by: { days?: number; months?: number }, tz = DEFAULT_TZ): string {
  const ms = new Date(iso).getTime();
  const local = new Date(ms + tzOffsetMs(ms, tz));
  let y = local.getUTCFullYear(); let mo = local.getUTCMonth() + (by.months ?? 0); const h = local.getUTCHours(); const mi = local.getUTCMinutes();
  y += Math.floor(mo / 12); mo = ((mo % 12) + 12) % 12;
  const dim = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
  const base = Date.UTC(y, mo, Math.min(local.getUTCDate(), dim)) + (by.days ?? 0) * 86_400_000;
  const d = new Date(base);
  return zonedToUtcIso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), h, mi, tz);
}

export function localYmd(iso: string, tz = DEFAULT_TZ): { y: number; mo: number; d: number } {
  const p = formatter("ymd", tz, () => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })).formatToParts(new Date(iso));
  const g = (t: string) => Number(p.find((x) => x.type === t)!.value);
  return { y: g("year"), mo: g("month"), d: g("day") };
}

/** Next occurrence (strictly after `now`) of a local clock time. */
export function nextLocalTimeIso(now: Date, h: number, mi: number, tz = DEFAULT_TZ): string {
  const { y, mo, d } = localYmd(now.toISOString(), tz);
  let iso = zonedToUtcIso(y, mo, d, h, mi, tz);
  if (new Date(iso).getTime() <= now.getTime()) {
    const next = new Date(new Date(iso).getTime() + 26 * 3600_000); // safely into next local day
    const n = localYmd(next.toISOString(), tz);
    iso = zonedToUtcIso(n.y, n.mo, n.d, h, mi, tz);
  }
  return iso;
}

/**
 * Parse a clock time like "6 PM", "7pm", "6:30 pm", "18:00" out of free text.
 * Returns hour/minute or null. Does not guess when no time is present.
 */
export function parseClockTime(text: string): { h: number; mi: number } | null {
  const ampm = /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)/i.exec(text);
  if (ampm) {
    let h = Number(ampm[1]);
    const mi = ampm[2] ? Number(ampm[2]) : 0;
    const pm = ampm[3].toLowerCase().startsWith("p");
    if (h < 1 || h > 12 || mi > 59) return null;
    if (pm && h !== 12) h += 12;
    if (!pm && h === 12) h = 0;
    return { h, mi };
  }
  const h24 = /\b([01]?\d|2[0-3]):([0-5]\d)\b/.exec(text);
  if (h24) return { h: Number(h24[1]), mi: Number(h24[2]) };
  return null;
}

export function formatLocal(iso: string | null | undefined, tz = DEFAULT_TZ): string {
  if (!iso) return "—";
  return formatter("local", tz, () => new Intl.DateTimeFormat("en-IN", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true, day: "numeric", month: "short" })).format(new Date(iso));
}
export function formatClock(iso: string | null | undefined, tz = DEFAULT_TZ): string {
  if (!iso) return "—";
  return formatter("clock", tz, () => new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true })).format(new Date(iso));
}

/** Local calendar date `offsetDays` from now in `tz`. */
export function localDatePlus(now: Date, offsetDays: number, tz = DEFAULT_TZ): { y: number; mo: number; d: number } {
  const base = localYmd(now.toISOString(), tz);
  const noonUtc = new Date(zonedToUtcIso(base.y, base.mo, base.d, 12, 0, tz));
  return localYmd(new Date(noonUtc.getTime() + offsetDays * 86_400_000).toISOString(), tz);
}

/** True when both instants fall on the same calendar day in `tz`. */
export function sameLocalDay(a: string | Date, b: string | Date, tz = DEFAULT_TZ): boolean {
  const x = localYmd(new Date(a).toISOString(), tz); const y = localYmd(new Date(b).toISOString(), tz);
  return x.y === y.y && x.mo === y.mo && x.d === y.d;
}

/**
 * Parse a range like "between 2 PM and 4 PM", "2 and 4 PM", "2-4pm" or "14:00 to 16:00".
 * The meridiem of one end is shared with the other when only one is given. Returns null when not a valid ordered range.
 */
export function parseTimeRange(text: string): { start: { h: number; mi: number }; end: { h: number; mi: number } } | null {
  const m = /(\d{1,2}(?::\d{2})?)\s*(a\.?m\.?|p\.?m\.?)?\s*(?:-|to|and|until|till)\s*(\d{1,2}(?::\d{2})?)\s*(a\.?m\.?|p\.?m\.?)?/i.exec(text);
  if (!m) return null;
  const mer1 = m[2] ?? m[4]; const mer2 = m[4] ?? m[2];
  const a = parseClockTime(m[1] + (mer1 ? " " + mer1 : "")); const b = parseClockTime(m[3] + (mer2 ? " " + mer2 : ""));
  if (!a || !b) return null;
  if (a.h * 60 + a.mi >= b.h * 60 + b.mi) return null;
  return { start: a, end: b };
}
