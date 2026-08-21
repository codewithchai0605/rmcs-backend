import mongoose from "mongoose";
import { connectDb } from "../config/db";
import { logger } from "../core/logger";
import { isValidDateString, yesterdayKolkata } from "../core/date";
import { aggregateDailyUsage } from "../services/usageAggregation.service";

/**
 * Entrypoint for the external midnight cron (requirement: "do not add a
 * cron scheduler ... external cron will trigger it"). This script IS that
 * trigger target - a system crontab, a hosting platform's scheduled job,
 * or a Kubernetes CronJob runs it once around midnight IST:
 *
 *   node dist/scripts/aggregateDailyUsage
 *   node dist/scripts/aggregateDailyUsage --date=2026-08-19   # backfill
 *
 * Deliberately a plain script rather than an HTTP endpoint: it needs no
 * new authentication surface (it already has direct database access via
 * MONGOOSE_URI, same as the server process), and it works even if the
 * main server process is temporarily down. For triggering aggregation
 * from an admin dashboard instead, see POST /admin/usage/aggregate.
 *
 * Exits 0 on success, 1 on failure, so the cron's own monitoring/alerting
 * (e.g. a systemd OnFailure unit, a CI schedule's failure notification)
 * can detect a missed day.
 */

function parseDateArg(argv: string[]): string | undefined {
    for (const arg of argv) {
        if (arg.startsWith("--date=")) return arg.slice("--date=".length);
    }
    return undefined;
}

async function main(): Promise<void> {
    const requestedDate = parseDateArg(process.argv.slice(2));
    const dateStr = requestedDate ?? yesterdayKolkata();

    if (!isValidDateString(dateStr)) {
        logger.error("Invalid --date argument, expected YYYY-MM-DD", { requestedDate });
        process.exitCode = 1;
        return;
    }

    await connectDb();
    try {
        const result = await aggregateDailyUsage(dateStr);
        logger.info("Aggregation script completed", { date: dateStr, status: result.status, totalEgressBytes: result.totalEgressBytes });
        process.exitCode = 0;
    } catch (error) {
        logger.error("Aggregation script failed", { date: dateStr, error: error instanceof Error ? error.message : String(error) });
        process.exitCode = 1;
    } finally {
        await mongoose.disconnect();
    }
}

main().catch((error) => {
    logger.error("Aggregation script crashed", { error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
});