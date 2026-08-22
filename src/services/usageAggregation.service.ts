import { DailyUsage, type IDailyUsage } from "../models/report.model.js";
import { fetchCloudflareUsageForRange } from "../http/admin.js";
import { isValidDateString, kolkataDayRangeUtc, yesterdayKolkata } from "../core/date.js";
import { logger } from "../core/logger.js";
import { AppError } from "../core/errors.js";

/**
 * Aggregates one Asia/Kolkata calendar day of Cloudflare Calls usage into a
 * single DailyUsage row.
 *
 * Idempotency: the write is a single `findOneAndUpdate({ date }, ..., {
 * upsert: true })` against DailyUsage.date, which has a unique index (see
 * models/report.model.ts). Running this for the same date any number of
 * times - the midnight cron firing twice, a manual re-run, retries after a
 * transient failure - always converges on exactly one row for that date,
 * overwritten in place, never a duplicate.
 *
 * Failure handling: if the Cloudflare fetch fails and a *successful* row
 * already exists for this date, that row is left untouched (a transient
 * error later in the day shouldn't clobber good data) - the error is still
 * thrown so the caller (cron / route) can log or alert. If no successful
 * row exists yet, an "error" status row is upserted so gaps are visible in
 * the usage graph API instead of silently missing.
 */
export async function aggregateDailyUsage(dateStr: string = yesterdayKolkata()): Promise<IDailyUsage> {
    if (!isValidDateString(dateStr)) {
        throw new AppError("VALIDATION_ERROR", `Invalid date: ${String(dateStr)}`);
    }

    const { start, end } = kolkataDayRangeUtc(dateStr);

    let usage: Awaited<ReturnType<typeof fetchCloudflareUsageForRange>>;
    try {
        usage = await fetchCloudflareUsageForRange(start, end);
    } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error fetching Cloudflare usage";
        const existing = await DailyUsage.findOne({ date: dateStr }).lean();

        if (existing?.status === "ok") {
            logger.warn("Daily usage aggregation failed but a successful row already exists - leaving it untouched", {
                date: dateStr,
                error: message,
            });
            throw error;
        }

        await upsertDailyUsage(dateStr, start, end, {
            callsUsageEgressBytes: 0,
            totalEgressBytes: 0,
            status: "error",
            errorMessage: message.slice(0, 1000),
        });

        logger.error("Daily usage aggregation failed", { date: dateStr, error: message });
        throw error;
    }

    const doc = await upsertDailyUsage(dateStr, start, end, {
        ...usage,
        status: "ok",
        errorMessage: undefined,
    });

    logger.info("Daily usage aggregated", { date: dateStr, totalEgressBytes: usage.totalEgressBytes });
    return doc;
}

async function upsertDailyUsage(
    dateStr: string,
    rangeStart: Date,
    rangeEnd: Date,
    fields: Pick<IDailyUsage, "callsUsageEgressBytes" | "totalEgressBytes" | "status"> &
        Partial<Pick<IDailyUsage, "errorMessage">>
): Promise<IDailyUsage> {
    const { errorMessage, ...rest } = fields;

    // $set and $unset can never touch the same path in one update, so
    // errorMessage goes in exactly one of the two depending on whether this
    // run produced one.
    const update = {
        $set: {
            ...rest,
            sfuAnalyticsVersion: 2,
            rangeStart,
            rangeEnd,
            aggregatedAt: new Date(),
            ...(errorMessage !== undefined ? { errorMessage } : {}),
        },
        ...(errorMessage === undefined ? { $unset: { errorMessage: "" as const } } : {}),
        $setOnInsert: { date: dateStr },
    };

    try {
        const doc = await DailyUsage.findOneAndUpdate({ date: dateStr }, update, {
            upsert: true,
            new: true,
            runValidators: true,
            setDefaultsOnInsert: true,
        }).lean();
        if (!doc) throw new Error("Upsert returned no document");
        return doc;
    } catch (error: unknown) {
        // Rare race: two concurrent upserts both miss the initial find and both
        // attempt an insert - MongoDB rejects the second with E11000 on the
        // unique `date` index. The row now definitely exists, so retry as a
        // plain (non-upsert) update.
        if (isDuplicateKeyError(error)) {
            const doc = await DailyUsage.findOneAndUpdate({ date: dateStr }, update, {
                new: true,
                runValidators: true,
            }).lean();
            if (doc) return doc;
        }
        throw error;
    }
}

function isDuplicateKeyError(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error && (error as { code: unknown }).code === 11000;
}

export interface AggregateRangeResult {
    date: string;
    ok: boolean;
    error?: string;
}

/**
 * Backfills/re-aggregates a closed range of dates, sequentially (so a burst
 * of admin-triggered backfill requests doesn't hammer Cloudflare's API).
 * Used by the manual "POST /admin/usage/aggregate" route and available for
 * ad-hoc gap recovery (e.g. the cron didn't run for a few days).
 */
export async function aggregateDateRange(dates: string[]): Promise<AggregateRangeResult[]> {
    const results: AggregateRangeResult[] = [];
    for (const dateStr of dates) {
        try {
            await aggregateDailyUsage(dateStr);
            results.push({ date: dateStr, ok: true });
        } catch (error) {
            results.push({ date: dateStr, ok: false, error: error instanceof Error ? error.message : "Unknown error" });
        }
    }
    return results;
}
