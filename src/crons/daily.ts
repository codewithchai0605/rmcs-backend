import { CronJob } from "cron";
import { isValidDateString, yesterdayKolkata } from "../core/date.js";
import { logger } from "../core/logger.js";
import { aggregateDailyUsage } from "../services/usageAggregation.service.js";

export const dailyjob = new CronJob(
    "0 0 * * *",
    async () => {
        const dateStr = yesterdayKolkata();

        if (!isValidDateString(dateStr)) {
            logger.error("Invalid --date argument, expected YYYY-MM-DD", { dateStr });
            return;
        }

        try {
            const result = await aggregateDailyUsage(dateStr);
            logger.info("Aggregation script completed", { date: dateStr, status: result.status, totalEgressBytes: result.totalEgressBytes });
        } catch (error) {
            logger.error("Aggregation script failed", { date: dateStr, error: error instanceof Error ? error.message : String(error) });
        }
    },
    null,
    false,
    "Asia/Kolkata"
)