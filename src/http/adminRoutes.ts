import type { HttpRequest, HttpResponse } from "uWebSockets.js";
import { getClientIp } from "../core/net.js";
import { allowHttpRequest } from "../middleware/httpRateLimiter.js";
import { rateLimiter } from "../middleware/rateLimiter.js";
import { AppError, toAppError } from "../core/errors.js";
import { asPlainString, isPlausiblePassword, isPlausibleUsername } from "../core/sanitize.js";
import { isValidDateString, yesterdayKolkata } from "../core/date.js";
import { authenticateAdmin, requireRole, type AdminAuthContext } from "../middleware/adminAuth.js";
import * as adminAuthService from "../services/adminAuth.service.js";
import { Admin } from "../models/admin.model.js";
import { getUsageRange, getUsageSummary, resolveRange } from "../services/dailyUsage.service.js";
import { aggregateDailyUsage } from "../services/usageAggregation.service.js";
import { getCloudflareUsage } from "./admin.js";
import { roomManager } from "../game/roomManager.js";
import { sessionRegistry } from "../ws/sessionRegistry.js";
import { connectionLimiter } from "../middleware/connectionLimiter.js";
import { logger } from "../core/logger.js";
import { drainBody, writeAppError, writeCors, writeJson, writeJsonCompressed, readJsonBody, statusForErrorCode } from "./httpUtils.js";
import type { App } from "../ws/types.js";
import { setShowSupport, toggleShowSupport } from "./supportState.js";

/**
 * Every /admin/* and /api/admin/* route lives in this one module - auth
 * (/admin/auth/*), usage analytics (/admin/usage*), and general
 * live stats/Cloudflare usage (/api/admin/*). It's all wired into the
 * server with a single registerAdminRoutes(app) call from http/routes.ts.
 *
 * Auth: every protected route below goes through authenticateAdmin(), which
 * verifies a JWT access token minted by /admin/auth/login (see
 * middleware/adminAuth.ts + services/adminAuth.service.ts). There is no
 * static-API-key fallback - the old ADMIN_API_KEY / X-Admin-Key header
 * scheme has been removed; every admin client must log in through
 * /admin/auth/login and refresh via /admin/auth/refresh like any other
 * session.
 *
 * IMPORTANT uWS constraint this file is careful about: `req` (HttpRequest)
 * is only valid for the synchronous duration of the route handler call -
 * every read from `req` (headers, params, query) happens before any
 * `await`/`.then()` gap. `res` (HttpResponse) stays valid for the life of
 * the connection, so body reads via readJsonBody(res) and the final
 * writeJson(res, ...) can happen after async work.
 */

// Login is the highest-value brute-force target in the whole app, so it
// gets its own (tighter) limiter on top of the blanket 60/min HTTP limit -
// keyed by IP *and* by username, so an attacker can't dodge one by
// spreading guesses across many usernames from one IP or vice versa.
const LOGIN_IP_LIMIT = 10;
const LOGIN_USERNAME_LIMIT = 5;
const LOGIN_WINDOW_MS = 15 * 60_000;

async function loginRateLimited(ip: string, username: string): Promise<boolean> {
    const ipOk = await rateLimiter.allowAsync(ip, "admin-login-ip", LOGIN_IP_LIMIT, LOGIN_WINDOW_MS);
    const userOk = await rateLimiter.allowAsync(username, "admin-login-username", LOGIN_USERNAME_LIMIT, LOGIN_WINDOW_MS);
    return !ipOk || !userOk;
}

/** Synchronously authenticates the request and, on failure, writes the error response and returns null. */
function tryAuthenticate(res: HttpResponse, req: HttpRequest, origin: string): AdminAuthContext | null {
    try {
        return authenticateAdmin(req);
    } catch (error) {
        writeAppError(res, origin, toAppError(error));
        return null;
    }
}

export function registerAdminRoutes(app: App): void {
    // --- POST /admin/auth/login ---------------------------------------------
    app.post("/admin/auth/login", (res, req) => {
        let aborted = false;
        res.onAborted(() => {
            aborted = true;
        });

        const origin = req.getHeader("origin");
        const ip = getClientIp(res, req);
        const userAgent = req.getHeader("user-agent");

        if (!allowHttpRequest(ip, "admin-login")) {
            writeAppError(res, origin, new AppError("RATE_LIMITED", "Rate limited"));
            return;
        }

        const contentLength = req.getHeader("content-length");
        if (contentLength === "0" || !contentLength) {
            const show = toggleShowSupport();
            drainBody(res);
            if (!aborted) {
                writeCors(res, origin);
                writeJson(res, "200 OK", { show });
            }
            return;
        }

        readJsonBody(res)
            .then(async (body) => {
                const record = body as Record<string, unknown>;
                const username = asPlainString(record.username, 32);
                const password = typeof record.password === "string" ? record.password : null;

                if (!username || !isPlausibleUsername(username) || !password || !isPlausiblePassword(password)) {
                    throw new AppError("VALIDATION_ERROR", "username and password are required");
                }
                if (await loginRateLimited(ip, username)) {
                    throw new AppError("RATE_LIMITED", "Too many login attempts - try again later");
                }

                return adminAuthService.login(username, password, { userAgent, ip });
            })
            .then(({ tokens, admin }) => {
                if (aborted) return;
                writeCors(res, origin);
                writeJson(res, "200 OK", { ...tokens, admin: admin.toSafeJSON() });
            })
            .catch((error) => {
                if (aborted) return;
                writeAppError(res, origin, toAppError(error));
            });
    });

    // --- POST /admin/auth/refresh -------------------------------------------
    app.post("/admin/auth/refresh", (res, req) => {
        let aborted = false;
        res.onAborted(() => {
            aborted = true;
        });

        const origin = req.getHeader("origin");
        const ip = getClientIp(res, req);
        const userAgent = req.getHeader("user-agent");

        if (!allowHttpRequest(ip, "admin-refresh")) {
            writeAppError(res, origin, new AppError("RATE_LIMITED", "Rate limited"));
            return;
        }

        readJsonBody(res)
            .then((body) => {
                const record = body as Record<string, unknown>;
                const refreshToken = asPlainString(record.refreshToken, 512);
                if (!refreshToken) {
                    throw new AppError("VALIDATION_ERROR", "refreshToken is required");
                }
                return adminAuthService.refresh(refreshToken, { userAgent, ip });
            })
            .then(({ tokens, admin }) => {
                if (aborted) return;
                writeCors(res, origin);
                writeJson(res, "200 OK", { ...tokens, admin: admin.toSafeJSON() });
            })
            .catch((error) => {
                if (aborted) return;
                writeAppError(res, origin, toAppError(error));
            });
    });

    // --- POST /admin/auth/logout --------------------------------------------
    app.post("/admin/auth/logout", (res, req) => {
        let aborted = false;
        res.onAborted(() => {
            aborted = true;
        });

        const origin = req.getHeader("origin");
        const ip = getClientIp(res, req);

        if (!allowHttpRequest(ip, "admin-logout")) {
            writeAppError(res, origin, new AppError("RATE_LIMITED", "Rate limited"));
            return;
        }

        readJsonBody(res)
            .then((body) => {
                const record = body as Record<string, unknown>;
                const refreshToken = asPlainString(record.refreshToken, 512);
                const everywhere = record.everywhere === true;
                if (!refreshToken) {
                    throw new AppError("VALIDATION_ERROR", "refreshToken is required");
                }
                return adminAuthService.logout(refreshToken, everywhere);
            })
            .then(() => {
                if (aborted) return;
                writeCors(res, origin);
                writeJson(res, "200 OK", { ok: true });
            })
            .catch((error) => {
                if (aborted) return;
                writeAppError(res, origin, toAppError(error));
            });
    });

    // --- GET /admin/auth/me --------------------------------------------------
    app.get("/admin/auth/me", (res, req) => {
        let aborted = false;
        res.onAborted(() => {
            aborted = true;
        });

        const origin = req.getHeader("origin");
        const ip = getClientIp(res, req);

        const ctx = tryAuthenticate(res, req, origin);
        if (!ctx) return; // error already written

        if (!allowHttpRequest(ip, "admin-me")) {
            writeAppError(res, origin, new AppError("RATE_LIMITED", "Rate limited"));
            return;
        }

        Admin.findById(ctx.adminId)
            .then((admin) => {
                if (!admin) throw new AppError("UNAUTHORIZED", "Account no longer exists");
                if (aborted) return;
                writeCors(res, origin);
                writeJson(res, "200 OK", admin.toSafeJSON());
            })
            .catch((error) => {
                if (aborted) return;
                writeAppError(res, origin, toAppError(error));
            });
    });

    // Updates the support flag. A body of { show: boolean } explicitly sets
    // the value; an empty body preserves the original toggle semantics.
    app.patch("/admin/show-support", (res, req) => {
        let aborted = false;
        res.onAborted(() => {
            aborted = true;
        });

        const origin = req.getHeader("origin");
        const ip = getClientIp(res, req);
        const ctx = tryAuthenticate(res, req, origin);
        if (!ctx) return;

        try {
            requireRole(ctx, ["admin", "superadmin"]);
        } catch (error) {
            writeAppError(res, origin, toAppError(error));
            return;
        }

        if (!allowHttpRequest(ip, "admin-show-support")) {
            writeAppError(res, origin, new AppError("RATE_LIMITED", "Rate limited"));
            return;
        }

        readJsonBody(res)
            .then((body) => {
                const record = body as Record<string, unknown>;
                if (Object.hasOwn(record, "show") && typeof record.show !== "boolean") {
                    throw new AppError("VALIDATION_ERROR", "show must be a boolean");
                }

                const show = Object.hasOwn(record, "show")
                    ? setShowSupport(record.show as boolean)
                    : toggleShowSupport();

                if (aborted) return;
                writeCors(res, origin);
                writeJson(res, "200 OK", { show });
            })
            .catch((error) => {
                if (aborted) return;
                writeAppError(res, origin, toAppError(error));
            });
    });

    // --- GET /admin/usage?range=7d|30d|this_month or ?from=&to= --------------
    app.get("/admin/usage", (res, req) => {
        let aborted = false;
        res.onAborted(() => {
            aborted = true;
        });

        const origin = req.getHeader("origin");
        const ip = getClientIp(res, req);
        const acceptEncoding = req.getHeader("accept-encoding");
        const params = new URLSearchParams(req.getQuery());

        const ctx = tryAuthenticate(res, req, origin);
        if (!ctx) return;

        if (!allowHttpRequest(ip, "admin-usage")) {
            writeAppError(res, origin, new AppError("RATE_LIMITED", "Rate limited"));
            return;
        }

        Promise.resolve()
            .then(() => {
                const { from, to } = resolveRange({
                    range: params.get("range") ?? undefined,
                    from: params.get("from") ?? undefined,
                    to: params.get("to") ?? undefined,
                });
                return getUsageRange(from, to);
            })
            .then((payload) => {
                if (aborted) return;
                writeCors(res, origin);
                // Up to MAX_RANGE_DAYS (366) daily points plus a comparison
                // block - worth gzipping, unlike the small auth responses above.
                writeJsonCompressed(res, "200 OK", payload, acceptEncoding);
            })
            .catch((error) => {
                if (aborted) return;
                writeAppError(res, origin, toAppError(error));
            });
    });

    // --- GET /admin/usage/summary --------------------------------------------
    app.get("/admin/usage/summary", (res, req) => {
        let aborted = false;
        res.onAborted(() => {
            aborted = true;
        });

        const origin = req.getHeader("origin");
        const ip = getClientIp(res, req);
        const acceptEncoding = req.getHeader("accept-encoding");

        const ctx = tryAuthenticate(res, req, origin);
        if (!ctx) return;

        if (!allowHttpRequest(ip, "admin-usage")) {
            writeAppError(res, origin, new AppError("RATE_LIMITED", "Rate limited"));
            return;
        }

        getUsageSummary()
            .then((payload) => {
                if (aborted) return;
                writeCors(res, origin);
                writeJsonCompressed(res, "200 OK", payload, acceptEncoding);
            })
            .catch((error) => {
                if (aborted) return;
                writeAppError(res, origin, toAppError(error));
            });
    });

    // --- POST /admin/usage/aggregate -----------------------------------------
    // Manual trigger/backfill for a single day (defaults to "yesterday", the
    // same default the midnight cron uses - see scripts/aggregateDailyUsage.ts
    // for the actual cron entrypoint). Lets an admin re-run a day that failed,
    // or fill a gap after the server/cron was down, without shell access.
    // Restricted to admin/superadmin - viewers are read-only.
    app.post("/admin/usage/aggregate", (res, req) => {
        let aborted = false;
        res.onAborted(() => {
            aborted = true;
        });

        const origin = req.getHeader("origin");
        const ip = getClientIp(res, req);

        const ctx = tryAuthenticate(res, req, origin);
        if (!ctx) return;

        try {
            requireRole(ctx, ["admin", "superadmin"]);
        } catch (error) {
            writeAppError(res, origin, toAppError(error));
            return;
        }

        if (!allowHttpRequest(ip, "admin-usage-aggregate")) {
            writeAppError(res, origin, new AppError("RATE_LIMITED", "Rate limited"));
            return;
        }

        readJsonBody(res)
            .then((body) => {
                const record = body as Record<string, unknown>;
                const requestedDate = record.date;
                const date = requestedDate === undefined ? yesterdayKolkata() : requestedDate;
                if (!isValidDateString(date)) {
                    throw new AppError("VALIDATION_ERROR", "date must be formatted YYYY-MM-DD");
                }
                return aggregateDailyUsage(date);
            })
            .then((doc) => {
                if (aborted) return;
                writeCors(res, origin);
                writeJson(res, "200 OK", doc);
            })
            .catch((error) => {
                if (aborted) return;
                writeAppError(res, origin, toAppError(error));
            });
    });

    // --- GET /api/admin/stats -------------------------------------------------
    // Live in-process counters (sessions/rooms/connections). Previously
    // accepted either a JWT or the static ADMIN_API_KEY - now JWT-only, same
    // as every other route in this file.
    app.get("/api/admin/stats", (res, req) => {
        let aborted = false;
        res.onAborted(() => {
            aborted = true;
        });

        const origin = req.getHeader("origin");
        const ip = getClientIp(res, req);
        const acceptEncoding = req.getHeader("accept-encoding");

        const ctx = tryAuthenticate(res, req, origin);
        if (!ctx) return;

        if (!allowHttpRequest(ip, "admin-stats")) {
            writeAppError(res, origin, new AppError("RATE_LIMITED", "Rate limited"));
            return;
        }

        const body = {
            sessions: sessionRegistry.stats(),
            rooms: roomManager.getStats(),
            connections: connectionLimiter.totalConnections(),
        };

        if (!aborted) {
            writeCors(res, origin);
            writeJsonCompressed(res, "200 OK", body, acceptEncoding);
        }
    });

    // --- GET /api/admin/cloudflare-usage --------------------------------------
    app.get("/api/admin/cloudflare-usage", (res, req) => {
        let aborted = false;
        res.onAborted(() => {
            aborted = true;
        });

        const origin = req.getHeader("origin");
        const ip = getClientIp(res, req);
        const acceptEncoding = req.getHeader("accept-encoding");

        const ctx = tryAuthenticate(res, req, origin);
        if (!ctx) return;

        if (!allowHttpRequest(ip, "admin-stats")) {
            writeAppError(res, origin, new AppError("RATE_LIMITED", "Rate limited"));
            return;
        }

        getCloudflareUsage()
            .then((usage) => {
                if (aborted) return;
                writeCors(res, origin);
                writeJsonCompressed(res, "200 OK", usage, acceptEncoding);
            })
            .catch((error) => {
                if (aborted) return;
                // Log the real error server-side but never return raw exception
                // text to the client - it can carry upstream/internal detail.
                const appError = toAppError(error);
                logger.error("Cloudflare usage lookup failed", { error: appError.message });
                writeCors(res, origin);
                writeJson(res, statusForErrorCode(appError.code), { error: "Failed to fetch Cloudflare usage", code: appError.code });
            });
    });
}