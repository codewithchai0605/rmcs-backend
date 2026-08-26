import type { BunRequest } from "bun";
import { getClientIp } from "../utils/net";
import { allowHttpRequest } from "../middleware/http.rate.limiter";
import { rateLimiter } from "../middleware/rate.limiter";
import { AppError, toAppError } from "../utils/errors";
import { asPlainString, isPlausiblePassword, isPlausibleUsername } from "../utils/sanitize";
import { isValidDateString, yesterdayKolkata } from "../utils/date";
import { authenticateAdmin, requireRole, type AdminAuthContext } from "../middleware/admin.auth";
import * as adminAuthService from "../services/admin.auth.service";
import { Admin } from "../models/admin.model";
import { getUsageRange, getUsageSummary, resolveRange } from "../services/daily.usage.service";
import { aggregateDailyUsage } from "../services/usage.aggregation.service";
import { getCloudflareUsage } from "./admin";
import { roomManager } from "../game/room.manager";
import { sessionRegistry } from "../websocket/session.registry";
import { connectionLimiter } from "../middleware/connection.limiter";
import { logger } from "../utils/logger";
import { appErrorResponse, corsHeaders, jsonResponse, jsonResponseCompressed, readJsonBody, statusForErrorCode } from "./http.utils";
import type { App } from "../websocket/types";
import { setShowSupport, toggleShowSupport } from "./support.state";
import { route } from "./route.helpers";

/**
 * Every /admin/* and /api/admin/* route lives in this one module - auth
 * (/admin/auth/*), usage analytics (/admin/usage*), and general live
 * stats/Cloudflare usage (/api/admin/*). buildAdminRoutes() returns a route
 * map that gets spread into the main Bun.serve({ routes }) object in
 * routes.ts (was a single registerAdminRoutes(app) call onto the shared uWS
 * app before).
 *
 * Auth: every protected route below goes through authenticateAdmin(), which
 * verifies a JWT access token minted by /admin/auth/login (see
 * middleware/admin.auth.ts + services/admin.auth.service.ts). There is no
 * static-API-key fallback - every admin client must log in through
 * /admin/auth/login and refresh via /admin/auth/refresh like any other
 * session.
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

/** Authenticates the request; on failure throws (caller turns it into a Response via appErrorResponse). */
function tryAuthenticate(req: Request): AdminAuthContext {
  return authenticateAdmin(req);
}

// --- POST /admin/auth/login -------------------------------------------------
async function handleLogin(req: BunRequest<string>, server: App): Promise<Response> {
  const origin = req.headers.get("origin");
  const ip = getClientIp(req, server);
  const userAgent = req.headers.get("user-agent") ?? undefined;

  if (!allowHttpRequest(ip, "admin-login")) {
    return appErrorResponse(origin, new AppError("RATE_LIMITED", "Rate limited"));
  }

  const contentLength = req.headers.get("content-length");
  if (contentLength === "0" || !contentLength) {
    const show = toggleShowSupport();
    return jsonResponse("200 OK", { show }, corsHeaders(origin));
  }

  try {
    const body = (await readJsonBody(req)) as Record<string, unknown>;
    const username = asPlainString(body.username, 32);
    const password = typeof body.password === "string" ? body.password : null;

    if (!username || !isPlausibleUsername(username) || !password || !isPlausiblePassword(password)) {
      throw new AppError("VALIDATION_ERROR", "username and password are required");
    }
    if (await loginRateLimited(ip, username)) {
      throw new AppError("RATE_LIMITED", "Too many login attempts - try again later");
    }

    const { tokens, admin } = await adminAuthService.login(username, password, { userAgent, ip });
    return jsonResponse("200 OK", { ...tokens, admin: admin.toSafeJSON() }, corsHeaders(origin));
  } catch (error) {
    return appErrorResponse(origin, toAppError(error));
  }
}

// --- POST /admin/auth/refresh -----------------------------------------------
async function handleRefresh(req: BunRequest<string>, server: App): Promise<Response> {
  const origin = req.headers.get("origin");
  const ip = getClientIp(req, server);
  const userAgent = req.headers.get("user-agent") ?? undefined;

  if (!allowHttpRequest(ip, "admin-refresh")) {
    return appErrorResponse(origin, new AppError("RATE_LIMITED", "Rate limited"));
  }

  try {
    const body = (await readJsonBody(req)) as Record<string, unknown>;
    const refreshToken = asPlainString(body.refreshToken, 512);
    if (!refreshToken) {
      throw new AppError("VALIDATION_ERROR", "refreshToken is required");
    }
    const { tokens, admin } = await adminAuthService.refresh(refreshToken, { userAgent, ip });
    return jsonResponse("200 OK", { ...tokens, admin: admin.toSafeJSON() }, corsHeaders(origin));
  } catch (error) {
    return appErrorResponse(origin, toAppError(error));
  }
}

// --- POST /admin/auth/logout ------------------------------------------------
async function handleLogout(req: BunRequest<string>, server: App): Promise<Response> {
  const origin = req.headers.get("origin");
  const ip = getClientIp(req, server);

  if (!allowHttpRequest(ip, "admin-logout")) {
    return appErrorResponse(origin, new AppError("RATE_LIMITED", "Rate limited"));
  }

  try {
    const body = (await readJsonBody(req)) as Record<string, unknown>;
    const refreshToken = asPlainString(body.refreshToken, 512);
    const everywhere = body.everywhere === true;
    if (!refreshToken) {
      throw new AppError("VALIDATION_ERROR", "refreshToken is required");
    }
    await adminAuthService.logout(refreshToken, everywhere);
    return jsonResponse("200 OK", { ok: true }, corsHeaders(origin));
  } catch (error) {
    return appErrorResponse(origin, toAppError(error));
  }
}

// --- GET /admin/auth/me ------------------------------------------------------
async function handleMe(req: BunRequest<string>, server: App): Promise<Response> {
  const origin = req.headers.get("origin");
  const ip = getClientIp(req, server);

  try {
    const ctx = tryAuthenticate(req);
    if (!allowHttpRequest(ip, "admin-me")) {
      throw new AppError("RATE_LIMITED", "Rate limited");
    }

    const admin = await Admin.findById(ctx.adminId);
    if (!admin) throw new AppError("UNAUTHORIZED", "Account no longer exists");
    return jsonResponse("200 OK", admin.toSafeJSON(), corsHeaders(origin));
  } catch (error) {
    return appErrorResponse(origin, toAppError(error));
  }
}

// Updates the support flag. A body of { show: boolean } explicitly sets the
// value; an empty body preserves the original toggle semantics.
async function handleShowSupportPatch(req: BunRequest<string>, server: App): Promise<Response> {
  const origin = req.headers.get("origin");
  const ip = getClientIp(req, server);

  try {
    const ctx = tryAuthenticate(req);
    requireRole(ctx, ["admin", "superadmin"]);

    if (!allowHttpRequest(ip, "admin-show-support")) {
      throw new AppError("RATE_LIMITED", "Rate limited");
    }

    const body = (await readJsonBody(req)) as Record<string, unknown>;
    if (Object.hasOwn(body, "show") && typeof body.show !== "boolean") {
      throw new AppError("VALIDATION_ERROR", "show must be a boolean");
    }

    const show = Object.hasOwn(body, "show") ? setShowSupport(body.show as boolean) : toggleShowSupport();
    return jsonResponse("200 OK", { show }, corsHeaders(origin));
  } catch (error) {
    return appErrorResponse(origin, toAppError(error));
  }
}

// --- GET /admin/usage?range=7d|30d|this_month or ?from=&to= -----------------
async function handleUsage(req: BunRequest<string>, server: App): Promise<Response> {
  const origin = req.headers.get("origin");
  const ip = getClientIp(req, server);
  const acceptEncoding = req.headers.get("accept-encoding");
  const params = new URL(req.url).searchParams;

  try {
    tryAuthenticate(req);
    if (!allowHttpRequest(ip, "admin-usage")) {
      throw new AppError("RATE_LIMITED", "Rate limited");
    }

    const { from, to } = resolveRange({
      range: params.get("range") ?? undefined,
      from: params.get("from") ?? undefined,
      to: params.get("to") ?? undefined,
    });
    const payload = await getUsageRange(from, to);
    // Up to MAX_RANGE_DAYS (366) daily points plus a comparison block -
    // worth gzipping, unlike the small auth responses above.
    return jsonResponseCompressed("200 OK", payload, acceptEncoding, corsHeaders(origin));
  } catch (error) {
    return appErrorResponse(origin, toAppError(error));
  }
}

// --- GET /admin/usage/summary -------------------------------------------------
async function handleUsageSummary(req: BunRequest<string>, server: App): Promise<Response> {
  const origin = req.headers.get("origin");
  const ip = getClientIp(req, server);
  const acceptEncoding = req.headers.get("accept-encoding");

  try {
    tryAuthenticate(req);
    if (!allowHttpRequest(ip, "admin-usage")) {
      throw new AppError("RATE_LIMITED", "Rate limited");
    }

    const payload = await getUsageSummary();
    return jsonResponseCompressed("200 OK", payload, acceptEncoding, corsHeaders(origin));
  } catch (error) {
    return appErrorResponse(origin, toAppError(error));
  }
}

// --- POST /admin/usage/aggregate ---------------------------------------------
// Manual trigger/backfill for a single day (defaults to "yesterday", the
// same default the midnight cron uses). Lets an admin re-run a day that
// failed, or fill a gap after the server/cron was down, without shell
// access. Restricted to admin/superadmin - viewers are read-only.
async function handleUsageAggregate(req: BunRequest<string>, server: App): Promise<Response> {
  const origin = req.headers.get("origin");
  const ip = getClientIp(req, server);

  try {
    const ctx = tryAuthenticate(req);
    requireRole(ctx, ["admin", "superadmin"]);

    if (!allowHttpRequest(ip, "admin-usage-aggregate")) {
      throw new AppError("RATE_LIMITED", "Rate limited");
    }

    const body = (await readJsonBody(req)) as Record<string, unknown>;
    const requestedDate = body.date;
    const date = requestedDate === undefined ? yesterdayKolkata() : requestedDate;
    if (!isValidDateString(date)) {
      throw new AppError("VALIDATION_ERROR", "date must be formatted YYYY-MM-DD");
    }
    const doc = await aggregateDailyUsage(date);
    return jsonResponse("200 OK", doc, corsHeaders(origin));
  } catch (error) {
    return appErrorResponse(origin, toAppError(error));
  }
}

// --- GET /api/admin/stats -----------------------------------------------------
// Live in-process counters (sessions/rooms/connections). JWT-only, same as
// every other route in this file.
async function handleAdminStats(req: BunRequest<string>, server: App): Promise<Response> {
  const origin = req.headers.get("origin");
  const ip = getClientIp(req, server);
  const acceptEncoding = req.headers.get("accept-encoding");

  try {
    tryAuthenticate(req);
    if (!allowHttpRequest(ip, "admin-stats")) {
      throw new AppError("RATE_LIMITED", "Rate limited");
    }

    const body = {
      sessions: sessionRegistry.stats(),
      rooms: roomManager.getStats(),
      connections: connectionLimiter.totalConnections(),
    };
    return jsonResponseCompressed("200 OK", body, acceptEncoding, corsHeaders(origin));
  } catch (error) {
    return appErrorResponse(origin, toAppError(error));
  }
}

// --- GET /api/admin/cloudflare-usage ------------------------------------------
async function handleCloudflareUsage(req: BunRequest<string>, server: App): Promise<Response> {
  const origin = req.headers.get("origin");
  const ip = getClientIp(req, server);
  const acceptEncoding = req.headers.get("accept-encoding");

  try {
    tryAuthenticate(req);
    if (!allowHttpRequest(ip, "admin-stats")) {
      throw new AppError("RATE_LIMITED", "Rate limited");
    }

    const usage = await getCloudflareUsage();
    return jsonResponseCompressed("200 OK", usage, acceptEncoding, corsHeaders(origin));
  } catch (error) {
    // Log the real error server-side but never return raw exception text to
    // the client - it can carry upstream/internal detail, so the response
    // body always gets this fixed string instead of appError.message.
    const appError = toAppError(error);
    logger.error("Cloudflare usage lookup failed", { error: appError.message });
    return jsonResponse(statusForErrorCode(appError.code), { error: "Failed to fetch Cloudflare usage", code: appError.code }, corsHeaders(origin));
  }
}

export function buildAdminRoutes() {
  return {
    "/admin/auth/login": route("POST", handleLogin),
    "/admin/auth/refresh": route("POST", handleRefresh),
    "/admin/auth/logout": route("POST", handleLogout),
    "/admin/auth/me": route("GET", handleMe),
    "/admin/show-support": route("PATCH", handleShowSupportPatch),
    "/admin/usage": route("GET", handleUsage),
    "/admin/usage/summary": route("GET", handleUsageSummary),
    "/admin/usage/aggregate": route("POST", handleUsageAggregate),
    "/api/admin/stats": route("GET", handleAdminStats),
    "/api/admin/cloudflare-usage": route("GET", handleCloudflareUsage),
  };
}
