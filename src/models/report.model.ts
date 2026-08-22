import mongoose, { Schema, model, type Model } from "mongoose";

/**
 * One pre-aggregated document per Asia/Kolkata calendar day, written by the
 * usage-aggregation cron (see services/usageAggregation.service.ts) so
 * historical analytics (7D/30D/this-month graphs) read this small
 * collection instead of re-querying Cloudflare's GraphQL Analytics API -
 * which is both slow and rate-limited - every time an admin opens a
 * dashboard.
 *
 * NOTE: this file was originally a bare, unexported `IReport` stub for a
 * single `usageInBytes` figure. It's completed/renamed in place here
 * (rather than adding a second, duplicate model) to store the full
 * Cloudflare Calls SFU usage plus aggregation bookkeeping.
 */

export type DailyUsageStatus = "ok" | "partial" | "error";

export interface IDailyUsage {
    /** Asia/Kolkata calendar date this row covers, "YYYY-MM-DD". Unique. */
    date: string;
    callsUsageEgressBytes: number;
    totalEgressBytes: number;
    /** Bump when the analytics source/semantics change, so old rows refresh. */
    sfuAnalyticsVersion: number;
    status: DailyUsageStatus;
    errorMessage?: string;
    /** UTC instants bounding the Kolkata day this row covers - audit trail. */
    rangeStart: Date;
    rangeEnd: Date;
    aggregatedAt: Date;
    createdAt: Date;
    updatedAt: Date;
}

const DailyUsageSchema = new Schema<IDailyUsage>(
    {
        date: {
            type: String,
            required: true,
            unique: true,
            validate: {
                validator: (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value),
                message: "date must be formatted YYYY-MM-DD",
            },
        },
        callsUsageEgressBytes: {
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
        sfuAnalyticsVersion: {
            type: Number,
            required: true,
            default: 2,
        },
        status: {
            type: String,
            enum: ["ok", "partial", "error"],
            required: true,
            default: "ok",
        },
        errorMessage: {
            type: String,
            maxlength: 1000,
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

// `date` already has a unique index from the field option above - this is
// what makes aggregation idempotent (see usageAggregation.service.ts, which
// always upserts by `date` rather than inserting). A second compound index
// covers range-scan reads (`date` between from/to) ordered for graph output;
// Mongo can satisfy those queries with the unique single-field index alone,
// so nothing else is added here.
DailyUsageSchema.index({ status: 1, date: -1 });

export const DailyUsage =
    (mongoose.models.DailyUsage as Model<IDailyUsage> | undefined) ?? model<IDailyUsage>("DailyUsage", DailyUsageSchema);
