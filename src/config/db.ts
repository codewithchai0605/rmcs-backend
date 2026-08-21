import mongoose from "mongoose";
import { env } from "./env.js";
import { logger } from "../core/logger.js";

/**
 * Connects Mongoose once at startup (see index.ts). Options below are
 * chosen for a small-to-medium single-instance deployment:
 *  - autoIndex is left on outside production. In production it's turned
 *    off (index builds run separately/at deploy time) since building
 *    indexes on every boot is a scalability foot-gun on a large
 *    collection - it's a full collection scan under a write lock window
 *    on older MongoDB versions and unnecessary I/O even on newer ones
 *    where it's online.
 *  - maxPoolSize/minPoolSize give the driver a sensible connection pool
 *    instead of the default of a single implicit connection ceiling
 *    surprise under load.
 *  - serverSelectionTimeoutMS fails fast (instead of hanging) if Mongo is
 *    unreachable at boot, so process managers restart/alert promptly.
 */
export const connectDb = async (): Promise<void> => {
    if (!env.MONGOOSE_URI) {
        throw new Error("MONGOOSE_URI is not set");
    }

    mongoose.connection.on("error", (error) => {
        logger.error("MongoDB connection error", { error: (error as Error).message });
    });
    mongoose.connection.on("disconnected", () => {
        logger.warn("MongoDB disconnected");
    });
    mongoose.connection.on("reconnected", () => {
        logger.info("MongoDB reconnected");
    });

    try {
        await mongoose.connect(env.MONGOOSE_URI, {
            autoIndex: env.NODE_ENV !== "production",
            maxPoolSize: 20,
            minPoolSize: 2,
            serverSelectionTimeoutMS: 10_000,
        });
        logger.info("MongoDB connected");
    } catch (error) {
        throw error;
    }
};