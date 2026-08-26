import { CronJob } from "cron";
import { isValidDateString, yesterdayKolkata } from "../utils/date";
import { logger } from "../utils/logger";
import { aggregateDailyUsage } from "../services/usage.aggregation.service";

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