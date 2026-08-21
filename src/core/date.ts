/**
 * Date helpers for the usage-aggregation feature. All "business dates" for
 * usage tracking are calendar days in Asia/Kolkata (IST, UTC+5:30, no DST),
 * regardless of where this process is actually running - so a fixed offset
 * is all we need and we don't need a timezone database / extra dependency.
 */

export const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DATE_STRING_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Type alias for YYYY-MM-DD format to make signatures self-documenting */
export type DateString = string;

export function isValidDateString(value: unknown): value is DateString {
    if (typeof value !== "string" || !DATE_STRING_RE.test(value)) return false;

    // Using `as [number, number, number]` satisfies strict index access rules
    const [year, month, day] = value.split("-").map(Number) as [number, number, number];
    const date = new Date(Date.UTC(year, month - 1, day));

    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** Formats a UTC instant as its Asia/Kolkata calendar date, "YYYY-MM-DD". */
export function toKolkataDateString(instant: Date): DateString {
    const shifted = new Date(instant.getTime() + IST_OFFSET_MS);
    const year = shifted.getUTCFullYear();
    const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
    const day = String(shifted.getUTCDate()).padStart(2, "0");

    return `${year}-${month}-${day}`;
}

/** Today's calendar date in Asia/Kolkata. */
export function todayKolkata(): DateString {
    return toKolkataDateString(new Date());
}

/** Yesterday's calendar date in Asia/Kolkata - the day a midnight cron is capturing. */
export function yesterdayKolkata(): DateString {
    return addDaysToDateString(todayKolkata(), -1);
}

/**
 * The [start, end) UTC instant range that covers one Asia/Kolkata calendar
 * day, e.g. "2026-08-19" -> 2026-08-18T18:30:00.000Z .. 2026-08-19T18:30:00.000Z.
 * Used to scope the Cloudflare GraphQL query to exactly one IST day.
 */
export function kolkataDayRangeUtc(dateStr: DateString): { start: Date; end: Date } {
    if (!isValidDateString(dateStr)) {
        throw new RangeError(`Invalid date string: ${dateStr}`);
    }

    const [year, month, day] = dateStr.split("-").map(Number) as [number, number, number];
    // Midnight IST = the previous day's 18:30 UTC.
    const start = new Date(Date.UTC(year, month - 1, day) - IST_OFFSET_MS);
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

    return { start, end };
}

export function addDaysToDateString(dateStr: DateString, days: number): DateString {
    if (!isValidDateString(dateStr)) {
        throw new RangeError(`Invalid date string: ${dateStr}`);
    }

    const [year, month, day] = dateStr.split("-").map(Number) as [number, number, number];
    const base = new Date(Date.UTC(year, month - 1, day));

    base.setUTCDate(base.getUTCDate() + days);

    return `${base.getUTCFullYear()}-${String(base.getUTCMonth() + 1).padStart(2, "0")}-${String(base.getUTCDate()).padStart(2, "0")}`;
}

/** Inclusive count of days between two "YYYY-MM-DD" strings (to >= from). */
export function diffDaysInclusive(fromStr: DateString, toStr: DateString): number {
    if (!isValidDateString(fromStr) || !isValidDateString(toStr)) {
        throw new RangeError("Invalid date range provided");
    }

    const [fy, fm, fd] = fromStr.split("-").map(Number) as [number, number, number];
    const [ty, tm, td] = toStr.split("-").map(Number) as [number, number, number];

    const fromUtc = Date.UTC(fy, fm - 1, fd);
    const toUtc = Date.UTC(ty, tm - 1, td);

    return Math.round((toUtc - fromUtc) / 86_400_000) + 1;
}

/** Every "YYYY-MM-DD" from `fromStr` to `toStr`, inclusive, in ascending order. */
export function enumerateDateStrings(fromStr: DateString, toStr: DateString): DateString[] {
    if (!isValidDateString(fromStr) || !isValidDateString(toStr)) {
        throw new RangeError("Invalid date range");
    }

    const count = diffDaysInclusive(fromStr, toStr);
    if (count <= 0) return [];

    const dates: DateString[] = [];
    let cursor = fromStr;

    for (let i = 0; i < count; i++) {
        dates.push(cursor);
        cursor = addDaysToDateString(cursor, 1);
    }

    return dates;
}

/** First day of the current Kolkata month, e.g. "2026-08-01". */
export function startOfThisMonthKolkata(): DateString {
    const today = todayKolkata();
    const [year, month] = today.split("-") as [string, string, string];
    return `${year}-${month}-01`;
}