import mongoose, { Schema, model, type Model } from "mongoose";

/**
 * One pre-aggregated document per Asia/Kolkata calendar day, written by the
 * usage-aggregation cron (see services/usage.aggregation.service.ts) so
 * historical analytics (7D/30D/this-month graphs) read this small
 * collection instead of re-querying Cloudflare's GraphQL Analytics API -
 * which is both slow and rate-limited - every time an admin opens a
 * dashboard.
 *
 * NOTE: this file was originally a bare, unexported `IReport` stub for a
 * single `usageInBytes` figure. It's completed/renamed in place here
 * (rather than adding a second, duplicate model) to store the full
 * Cloudflare Calls SFU usage plus aggregation bookkeeping.
 *
 * UPDATE (TURN): originally this only tracked Calls SFU egress -
 * `totalEgressBytes` was literally just a copy of `callsUsageEgressBytes`.
 * Now that voice can also relay through Cloudflare's TURN service (see
 * voice/cloudflare.calls.ts getTurnIceServers), `turnUsageEgressBytes` /
 * `turnUsageIngressBytes` track that separately - queried from Cloudflare's
 * `callsTurnUsageAdaptiveGroups` dataset alongside the existing
 * `callsUsageAdaptiveGroups` one (see http/admin.ts) - and
 * `totalEgressBytes` is now their actual sum, not a copy of one of them.
 */

export type DailyUsageStatus = "ok" | "partial" | "error";

export interface IDailyUsage {
    /** Asia/Kolkata calendar date this row covers, "YYYY-MM-DD". Unique. */
    date: string;
    callsUsageEgressBytes: number;
    /** Bytes Cloudflare's TURN relay sent to clients - billed the same way as callsUsageEgressBytes. 0 for rows aggregated before TURN was added (see sfuAnalyticsVersion) or on days TURN wasn't used. */
    turnUsageEgressBytes: number;
    /** Bytes TURN relayed from clients to Cloudflare - not billed (Cloudflare only bills egress), tracked for visibility/ops only (e.g. spotting credential abuse). */
    turnUsageIngressBytes: number;
    /** callsUsageEgressBytes + turnUsageEgressBytes - the actual total billed egress for the day. */
    totalEgressBytes: number;
    /** Bump when the analytics source/semantics change, so old rows refresh. 3: added turnUsageEgressBytes/turnUsageIngressBytes and totalEgressBytes became a real sum instead of a copy of callsUsageEgressBytes - rows at version < 3 predate TURN tracking entirely, not just "TURN unused that day". */
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
        sfuAnalyticsVersion: {
            type: Number,
            required: true,
            default: 3,
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
// what makes aggregation idempotent (see usage.aggregation.service.ts, which
// always upserts by `date` rather than inserting). A second compound index
// covers range-scan reads (`date` between from/to) ordered for graph output;
// Mongo can satisfy those queries with the unique single-field index alone,
// so nothing else is added here.
DailyUsageSchema.index({ status: 1, date: -1 });

export const DailyUsage =
    (mongoose.models.DailyUsage as Model<IDailyUsage> | undefined) ?? model<IDailyUsage>("DailyUsage", DailyUsageSchema);