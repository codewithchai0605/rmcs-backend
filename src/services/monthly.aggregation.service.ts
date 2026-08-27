import { DailyUsage } from "../models/report.model";
import { MonthlySnapshot, type IMonthlySnapshot, type MonthlySnapshotStatus } from "../models/monthly-snapshot.model";
import { addDaysToDateString, diffDaysInclusive, kolkataDayRangeUtc, kolkataMonthDateBounds, previousMonthKolkata } from "../utils/date";
import { logger } from "../utils/logger";
import { AppError } from "../utils/errors";

const MONTH_RE = /^\d{4}-\d{2}$/;

/**
 * Rolls up every DailyUsage row for one Kolkata calendar month into a
 * single MonthlySnapshot row.
 *
 * Idempotency: same findOneAndUpdate-by-unique-key upsert pattern as
 * DailyUsage in usage.aggregation.service.ts - safe to re-run for the same
 * month any number of times (e.g. a manual backfill after fixing a gap in
 * DailyUsage), always converging on one row for that month.
 *
 * Unlike DailyUsage's aggregation, this never talks to Cloudflare's API -
 * it only sums rows already sitting in our own DailyUsage collection - so
 * there's no external-API flakiness to cushion here and no "error" status
 * placeholder path like DailyUsage has. If this throws (e.g. a genuine DB
 * connectivity problem), the caller (the monthly cron below) just logs it;
 * nothing is written, and the next run (whether that's next month's cron
 * or a manual backfill) tries again from scratch.
 */
export async function aggregateMonthlySnapshot(monthStr: string = previousMonthKolkata()): Promise<IMonthlySnapshot> {
    if (!MONTH_RE.test(monthStr)) {
        throw new AppError("VALIDATION_ERROR", `Invalid month: ${String(monthStr)}`);
    }

    const { startDate, endDate } = kolkataMonthDateBounds(monthStr);
    const rangeStart = kolkataDayRangeUtc(startDate).start;
    const rangeEnd = kolkataDayRangeUtc(endDate).start;

    // endDate is the *next* month's first day (exclusive), so the day
    // before it is this month's last day - diffDaysInclusive between the
    // two gives exactly this month's length (28-31), regardless of which
    // month it is.
    const daysExpected = diffDaysInclusive(startDate, addDaysToDateString(endDate, -1));

    // DailyUsage.date sorts lexicographically the same as chronologically
    // (zero-padded "YYYY-MM-DD"), so a plain string range query is exact -
    // no need to convert to UTC instants for this part.
    const days = await DailyUsage.find({ date: { $gte: startDate, $lt: endDate } })
        .sort({ date: 1 })
        .lean();

    let callsUsageEgressBytes = 0;
    let turnUsageEgressBytes = 0;
    let turnUsageIngressBytes = 0;
    let daysOk = 0;

    for (const day of days) {
        callsUsageEgressBytes += day.callsUsageEgressBytes;
        turnUsageEgressBytes += day.turnUsageEgressBytes;
        turnUsageIngressBytes += day.turnUsageIngressBytes;
        if (day.status === "ok") daysOk += 1;
    }

    // "ok" only when every calendar day in the month is both present and
    // itself clean - otherwise the sums above are an undercount, not a
    // true monthly total, so the row is marked "partial" instead of
    // silently looking complete.
    const status: MonthlySnapshotStatus = days.length === daysExpected && daysOk === daysExpected ? "ok" : "partial";

    const doc = await MonthlySnapshot.findOneAndUpdate(
        { month: monthStr },
        {
            $set: {
                callsUsageEgressBytes,
                turnUsageEgressBytes,
                turnUsageIngressBytes,
                totalEgressBytes: callsUsageEgressBytes + turnUsageEgressBytes,
                daysExpected,
                daysAggregated: days.length,
                daysOk,
                status,
                rangeStart,
                rangeEnd,
                aggregatedAt: new Date(),
            },
            $setOnInsert: { month: monthStr },
        },
        { upsert: true, returnDocument: "after", runValidators: true, setDefaultsOnInsert: true }
    ).lean();

    if (!doc) {
        throw new Error("MonthlySnapshot upsert returned no document");
    }

    if (status === "partial") {
        logger.warn("Monthly usage snapshot is partial - some days were missing or incomplete", {
            month: monthStr,
            daysExpected,
            daysAggregated: days.length,
            daysOk,
        });
    }

    return doc;
}

/**
 * Deletes every DailyUsage row strictly before the given month - i.e. the
 * daily-granularity detail for any month that's now covered by a
 * MonthlySnapshot and is no longer "the previous month" either.
 *
 * Example: called with monthStr "2026-08" (on 1 Sept, right after that
 * month's snapshot is written) deletes every DailyUsage row dated before
 * 2026-08-01 - July and everything older - while leaving August's rows
 * (and September's, as they accumulate) in place. So DailyUsage always
 * retains roughly the last two months of raw daily detail: the month that
 * was just snapshotted, plus the in-progress current month.
 *
 * Deliberately a separate function from aggregateMonthlySnapshot rather
 * than folded into it, so the cron can choose not to call this at all if
 * the snapshot came out "partial" - see crons/monthly.ts.
 */
export async function deleteDailyUsageBefore(monthStr: string): Promise<number> {
    if (!MONTH_RE.test(monthStr)) {
        throw new AppError("VALIDATION_ERROR", `Invalid month: ${String(monthStr)}`);
    }

    const { startDate } = kolkataMonthDateBounds(monthStr);
    const result = await DailyUsage.deleteMany({ date: { $lt: startDate } });
    return result.deletedCount ?? 0;
}