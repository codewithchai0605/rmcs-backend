import mongoose, { Schema, model, type Model } from "mongoose";

/**
 * One row per Asia/Kolkata calendar month ("YYYY-MM"), rolling up that
 * month's DailyUsage rows (see models/report.model.ts) into a single
 * total. Written once a month by the monthly-snapshot cron (see
 * crons/monthly.ts / services/monthly.aggregation.service.ts), which runs
 * on the 1st at 06:00 IST and snapshots the month that just ended - so
 * this only ever has rows for a *complete* month, never the current one.
 *
 * This exists because DailyUsage is pruned down to roughly the last two
 * months of raw daily rows right after each monthly snapshot is written
 * (see deleteDailyUsageBefore in monthly.aggregation.service.ts) -
 * MonthlySnapshot is what's left to read long-term usage history/trends
 * once the daily-granularity detail for a month is gone.
 */

export type MonthlySnapshotStatus = "ok" | "partial";

export interface IMonthlySnapshot {
    /** Asia/Kolkata calendar month this row covers, "YYYY-MM". Unique. */
    month: string;
    callsUsageEgressBytes: number;
    turnUsageEgressBytes: number;
    turnUsageIngressBytes: number;
    /** callsUsageEgressBytes + turnUsageEgressBytes, summed across the whole month. */
    totalEgressBytes: number;
    /** Calendar days in this month (28-31) - the count this row *should* have one DailyUsage row per. */
    daysExpected: number;
    /** DailyUsage rows actually found for this month at snapshot time - can be less than daysExpected if a day was never aggregated (e.g. the daily cron didn't run, or ran before DailyUsage tracking existed). */
    daysAggregated: number;
    /** Of daysAggregated, how many had DailyUsage.status "ok" (as opposed to "partial"/"error", which means that day's own figures were incomplete). */
    daysOk: number;
    /** "ok" only when daysAggregated === daysExpected AND daysOk === daysExpected - i.e. every calendar day in the month is accounted for and clean. Otherwise "partial": the totals above are a (possibly large) undercount for the month, not a true monthly figure. */
    status: MonthlySnapshotStatus;
    /** UTC instants bounding the Kolkata month this row covers - audit trail. */
    rangeStart: Date;
    rangeEnd: Date;
    aggregatedAt: Date;
    createdAt: Date;
    updatedAt: Date;
}

const MonthlySnapshotSchema = new Schema<IMonthlySnapshot>(
    {
        month: {
            type: String,
            required: true,
            unique: true,
            validate: {
                validator: (value: string) => /^\d{4}-\d{2}$/.test(value),
                message: "month must be formatted YYYY-MM",
            },
        },
        callsUsageEgressBytes: {
            type: Number,
            required: true,
            default: 0,
            min: 0,
        },
        turnUsageEgressBytes: {
            type: Number,
            required: true,
            default: 0,
            min: 0,
        },
        turnUsageIngressBytes: {
            type: Number,
            required: true,
            default: 0,
            min: 0,
        },
        totalEgressBytes: {
            type: Number,
            required: true,
            default: 0,
            min: 0,
        },
        daysExpected: {
            type: Number,
            required: true,
            min: 0,
        },
        daysAggregated: {
            type: Number,
            required: true,
            default: 0,
            min: 0,
        },
        daysOk: {
            type: Number,
            required: true,
            default: 0,
            min: 0,
        },
        status: {
            type: String,
            enum: ["ok", "partial"],
            required: true,
            default: "ok",
        },
        rangeStart: {
            type: Date,
            required: true,
        },
        rangeEnd: {
            type: Date,
            required: true,
        },
        aggregatedAt: {
            type: Date,
            required: true,
            default: () => new Date(),
        },
    },
    { timestamps: true }
);

// `month` already has a unique index from the field option above - this is
// what makes the monthly cron's upsert idempotent, the same pattern as
// DailyUsage.date in models/report.model.ts. This collection only ever
// gets one new row a month, so no further indexes are needed.

export const MonthlySnapshot =
    (mongoose.models.MonthlySnapshot as Model<IMonthlySnapshot> | undefined) ??
    model<IMonthlySnapshot>("MonthlySnapshot", MonthlySnapshotSchema);