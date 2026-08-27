import { CronJob } from "cron";
import { logger } from "../utils/logger";
import { previousMonthKolkata } from "../utils/date";
import { aggregateMonthlySnapshot, deleteDailyUsageBefore } from "../services/monthly.aggregation.service";

export const monthlyjob = new CronJob(
    "0 6 1 * *",
    async () => {
        const monthStr = previousMonthKolkata();

        try {
            const snapshot = await aggregateMonthlySnapshot(monthStr);
            logger.info("Monthly snapshot job completed", {
                month: monthStr,
                status: snapshot.status,
                totalEgressBytes: snapshot.totalEgressBytes,
                daysAggregated: snapshot.daysAggregated,
                daysExpected: snapshot.daysExpected,
            });

            // Only prune DailyUsage once the month's snapshot is both
            // written AND complete - a "partial" snapshot (missing or
            // errored days) means the underlying DailyUsage rows may still
            // be worth backfilling/correcting, so this deliberately leaves
            // them in place rather than deleting the only copy of data
            // that might still be recoverable. It'll be re-attempted next
            // month's run if a manual backfill fixes it up before then.
            if (snapshot.status !== "ok") {
                logger.warn("Skipping DailyUsage prune - monthly snapshot was partial", { month: monthStr });
                return;
            }

            const deletedCount = await deleteDailyUsageBefore(monthStr);
            logger.info("Pruned old DailyUsage rows", { keptFromMonth: monthStr, deletedCount });
        } catch (error) {
            logger.error("Monthly snapshot job failed", {
                month: monthStr,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    },
    null,
    false,
    "Asia/Kolkata"
);