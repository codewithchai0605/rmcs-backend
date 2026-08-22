import { CronJob } from "cron";

const URL = process.env.RENDER_EXTERNAL_URL;

export const pingjob = new CronJob(
  "*/10 * * * *",
  async () => {
    if (!URL) return;

    try {
      const res = await fetch(URL);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      console.log("Pinged server successfully.");
    } catch (error) {
      console.error("Failed to ping the server:", error);
    }
  },
  null,
  false,
  "Asia/Kolkata",
);