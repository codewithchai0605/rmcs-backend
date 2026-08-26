import { DailyUsage } from "../models/report.model";
import { AppError } from "../utils/errors";
import {
    addDaysToDateString,
    diffDaysInclusive,
    enumerateDateStrings,
    isValidDateString,
    kolkataDayRangeUtc,
    startOfThisMonthKolkata,
    todayKolkata,
} from "../utils/date";
import { fetchCloudflareUsageForRange } from "../http/admin";

/** Hard ceiling on any single range query - protects Mongo from an unbounded custom from/to scan. */
export const MAX_RANGE_DAYS = 366;

export type UsageRangeKeyword = "7d" | "30d" | "this_month";

export interface DailyUsagePoint {
    date: string;
    callsUsageEgressBytes: number;
    totalEgressBytes: number;
    totalEgressGB: number;
    status: "ok" | "partial" | "error" | "missing";
}

export interface UsageRangeResponse {
    from: string;
    to: string;
    days: DailyUsagePoint[];
    totals: {
        totalEgressBytes: number;
        totalEgressGB: number;
        callsUsageEgressBytes: number;
    };
    comparison: {
        previousFrom: string;
        previousTo: string;
        previousTotalEgressBytes: number;
        changeBytes: number;
        /** Percent change vs the previous equal-length period, or null if the previous period had zero usage. */
        changePercent: number | null;
    };
}

/**
 * Resolves the query params from GET /admin/usage into a concrete [from, to]
 * Asia/Kolkata date range. Exactly one of `range` or (`from` + `to`) is
 * expected; every input is validated before it ever reaches a Mongoose
 * query (defense against malformed/NoSQL-injection-shaped query params).
 */
export function resolveRange(query: { range?: unknown; from?: unknown; to?: unknown }): { from: string; to: string } {
    const today = todayKolkata();

    if (query.from !== undefined || query.to !== undefined) {
        const from = query.from;
        const to = query.to;
        if (!isValidDateString(from) || !isValidDateString(to)) {
            throw new AppError("VALIDATION_ERROR", "from/to must both be valid dates formatted YYYY-MM-DD");
        }
        if (from > to) {
            throw new AppError("VALIDATION_ERROR", "from must not be after to");
        }
        if (to > today) {
            throw new AppError("VALIDATION_ERROR", "to cannot be in the future");
        }
        if (diffDaysInclusive(from, to) > MAX_RANGE_DAYS) {
            throw new AppError("VALIDATION_ERROR", `Range cannot exceed ${MAX_RANGE_DAYS} days`);
        }
        return { from, to };
    }

    const range = typeof query.range === "string" ? query.range : "7d";
    switch (range) {
        case "7d":
            return { from: addDaysToDateString(today, -6), to: today };
        case "30d":
            return { from: addDaysToDateString(today, -29), to: today };
        case "this_month":
            return { from: startOfThisMonthKolkata(), to: today };
        default:
            throw new AppError("VALIDATION_ERROR", `Unknown range "${range}" - use 7d, 30d, this_month, or from/to`);
    }
}

/** The equal-length period immediately preceding [from, to], for period-over-period comparison. */
function previousPeriod(from: string, to: string): { from: string; to: string } {
    const lengthDays = diffDaysInclusive(from, to);
    const previousTo = addDaysToDateString(from, -1);
    const previousFrom = addDaysToDateString(previousTo, -(lengthDays - 1));
    return { from: previousFrom, to: previousTo };
}

/** Fetches DailyUsage rows for [from, to] and returns them zero-filled for any date with no row. */
async function loadZeroFilledSeries(from: string, to: string): Promise<DailyUsagePoint[]> {
    const rows = await DailyUsage.find({ date: { $gte: from, $lte: to } })
        .select({ date: 1, callsUsageEgressBytes: 1, totalEgressBytes: 1, status: 1, _id: 0 })
        .sort({ date: 1 })
        .lean();

    const byDate = new Map(rows.map((row) => [row.date, row]));

    return enumerateDateStrings(from, to).map((date) => {
        const row = byDate.get(date);
        if (!row) {
            return {
                date,
                callsUsageEgressBytes: 0,
                totalEgressBytes: 0,
                totalEgressGB: 0,
                status: "missing",
            };
        }
        return {
            date,
            callsUsageEgressBytes: row.callsUsageEgressBytes,
            totalEgressBytes: row.totalEgressBytes,
            totalEgressGB: row.totalEgressBytes / 1_000_000_000,
            status: row.status,
        };
    });
}

function sumBytes(days: DailyUsagePoint[]): { totalEgressBytes: number; callsUsageEgressBytes: number } {
    return days.reduce(
        (acc, day) => ({
            totalEgressBytes: acc.totalEgressBytes + day.totalEgressBytes,
            callsUsageEgressBytes: acc.callsUsageEgressBytes + day.callsUsageEgressBytes,
        }),
        { totalEgressBytes: 0, callsUsageEgressBytes: 0 }
    );
}

/** Full payload for GET /admin/usage - the graph series, totals, and a period-over-period comparison. */
export async function getUsageRange(from: string, to: string): Promise<UsageRangeResponse> {
    await refreshLegacyUsageRows(from, to);
    const days = await loadZeroFilledSeries(from, to);
    const totals = sumBytes(days);

    const previous = previousPeriod(from, to);
    const previousDays = await loadZeroFilledSeries(previous.from, previous.to);
    const previousTotals = sumBytes(previousDays);

    const changeBytes = totals.totalEgressBytes - previousTotals.totalEgressBytes;
    const changePercent = previousTotals.totalEgressBytes > 0 ? (changeBytes / previousTotals.totalEgressBytes) * 100 : null;

    return {
        from,
        to,
        days,
        totals: { ...totals, totalEgressGB: totals.totalEgressBytes / 1_000_000_000 },
        comparison: {
            previousFrom: previous.from,
            previousTo: previous.to,
            previousTotalEgressBytes: previousTotals.totalEgressBytes,
            changeBytes,
            changePercent,
        },
    };
}

/** Cloudflare Realtime's free tier, referenced for the "percent of free tier used" figure in the summary. */
const FREE_TIER_GB_PER_MONTH = 1000;

export interface UsageSummary {
    today: DailyUsagePoint;
    last7Days: { totalEgressBytes: number; totalEgressGB: number };
    last30Days: { totalEgressBytes: number; totalEgressGB: number };
    thisMonth: { totalEgressBytes: number; totalEgressGB: number; percentOfFreeTier: number };
    lastAggregation: { date: string; status: string; aggregatedAt: Date } | null;
}

/** Payload for GET /admin/usage/summary - a compact "at a glance" dashboard header. */
export async function getUsageSummary(): Promise<UsageSummary> {
    const today = todayKolkata();

    const [todayPoint, last7, last30, thisMonth, lastRow] = await Promise.all([
        loadZeroFilledSeries(today, today).then((rows) => rows[0]),
        loadZeroFilledSeries(addDaysToDateString(today, -6), today).then(sumBytes),
        loadZeroFilledSeries(addDaysToDateString(today, -29), today).then(sumBytes),
        loadZeroFilledSeries(startOfThisMonthKolkata(), today).then(sumBytes),
        DailyUsage.findOne({}).sort({ date: -1 }).select({ date: 1, status: 1, aggregatedAt: 1, _id: 0 }).lean(),
    ]);

    return {
        today: todayPoint!,
        last7Days: { totalEgressBytes: last7.totalEgressBytes, totalEgressGB: last7.totalEgressBytes / 1_000_000_000 },
        last30Days: { totalEgressBytes: last30.totalEgressBytes, totalEgressGB: last30.totalEgressBytes / 1_000_000_000 },
        thisMonth: {
            totalEgressBytes: thisMonth.totalEgressBytes,
            totalEgressGB: thisMonth.totalEgressBytes / 1_000_000_000,
            percentOfFreeTier: (thisMonth.totalEgressBytes / 1_000_000_000 / FREE_TIER_GB_PER_MONTH) * 100,
        },
        lastAggregation: lastRow ? { date: lastRow.date, status: lastRow.status, aggregatedAt: lastRow.aggregatedAt } : null,
    };
}

/**
 * Old rows included TURN data (or were written before SFU analytics was
 * available), which made the historical graph misleading. Refresh them on
 * first view with SFU-only data, then retain the cached result in Mongo.
 */
async function refreshLegacyUsageRows(from: string, to: string): Promise<void> {
    const rows = await DailyUsage.find({ date: { $gte: from, $lte: to } })
        .select({ date: 1, sfuAnalyticsVersion: 1, status: 1, _id: 0 })
        .lean();
    const current = new Set(rows.filter((row) => row.sfuAnalyticsVersion === 2 && row.status === "ok").map((row) => row.date));
    const staleDates = enumerateDateStrings(from, to).filter((date) => !current.has(date));

    // Keep the first-view sync friendly to Cloudflare while still repairing a
    // 30-day graph in one dashboard visit.
    for (const date of staleDates) {
        const { start, end } = kolkataDayRangeUtc(date);
        try {
            const usage = await fetchCloudflareUsageForRange(start, end);
            await DailyUsage.findOneAndUpdate(
                { date },
                {
                    $set: {
                        ...usage,
                        sfuAnalyticsVersion: 2,
                        status: "ok",
                        rangeStart: start,
                        rangeEnd: end,
                        aggregatedAt: new Date(),
                    },
                    $setOnInsert: { date },
                },
                { upsert: true, returnDocument: "after", runValidators: true, setDefaultsOnInsert: true }
            );
        } catch {
            // Keep gaps explicitly marked rather than presenting stale TURN
            // data as SFU usage. The next dashboard visit retries the day.
            await DailyUsage.findOneAndUpdate(
                { date },
                {
                    $set: {
                        callsUsageEgressBytes: 0,
                        totalEgressBytes: 0,
                        sfuAnalyticsVersion: 2,
                        status: "error",
                        rangeStart: start,
                        rangeEnd: end,
                        aggregatedAt: new Date(),
                    },
                    $setOnInsert: { date },
                },
                { upsert: true, returnDocument: "after", runValidators: true, setDefaultsOnInsert: true }
            );
        }
    }
}