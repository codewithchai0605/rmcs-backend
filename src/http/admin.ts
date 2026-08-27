import { env } from "../config/env";
import { AppError } from "../utils/errors";

/**
 * Cloudflare Realtime (Calls SFU + TURN) usage reporting, via Cloudflare's
 * account GraphQL Analytics API. Two credential pairs are involved in this
 * app and they are NOT interchangeable:
 *  - CLOUDFLARE_APP_ID / CLOUDFLARE_APP_TOKEN (see voice/cloudflare.calls.ts)
 *    create/manage individual SFU sessions.
 *  - CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN (used only here) is a
 *    normal account-level API token (Billing/Analytics read scope) used
 *    purely to ask "how much did we use".
 */

export interface CloudflareUsageWindow {
  callsUsageEgressBytes: number;
  /** Bytes Cloudflare's TURN relay sent to clients (see getTurnIceServers in voice/cloudflare.calls.ts) - billed the same as callsUsageEgressBytes. 0 whenever TURN isn't configured or wasn't used in this window. */
  turnUsageEgressBytes: number;
  /** Bytes TURN relayed from clients - not billed, kept for visibility only. */
  turnUsageIngressBytes: number;
  /** callsUsageEgressBytes + turnUsageEgressBytes. */
  totalEgressBytes: number;
}

export interface UsageStats extends CloudflareUsageWindow {
  totalEgressGB: number;
}

interface CloudflareGraphQLResponse {
  data?: {
    viewer?: {
      accounts?: Array<{
        callsUsageAdaptiveGroups?: Array<{
          sum?: {
            egressBytes?: number | null;
          } | null;
        }>;
        callsTurnUsageAdaptiveGroups?: Array<{
          sum?: {
            egressBytes?: number | null;
            ingressBytes?: number | null;
          } | null;
        }>;
      }>;
    };
  };
  errors?: Array<{
    message: string;
    path?: unknown;
    extensions?: unknown;
  }>;
}

const USAGE_QUERY = `
  query GetRealtimeUsage(
    $accountTag: String!
    $datetimeGeq: String!
    $datetimeLt: String!
  ) {
    viewer {
      accounts(
        filter: {
          accountTag: $accountTag
        }
      ) {
        callsUsageAdaptiveGroups(
          filter: {
            datetime_geq: $datetimeGeq
            datetime_lt: $datetimeLt
          }
          limit: 1
        ) {
          sum {
            egressBytes
          }
        }

        # Same [start, end) window as callsUsageAdaptiveGroups above, so the
        # two sums are directly comparable/addable. Uses datetime_geq/_lt
        # (not the date_geq/date_leq shown in Cloudflare's own TURN
        # analytics examples) to match that window exactly - if Cloudflare
        # ever rejects datetime_* here, switch both this filter and the
        # variables below to day-granularity date_geq/date_leq instead.
        callsTurnUsageAdaptiveGroups(
          filter: {
            datetime_geq: $datetimeGeq
            datetime_lt: $datetimeLt
          }
          limit: 1
        ) {
          sum {
            egressBytes
            ingressBytes
          }
        }

      }
    }
  }
`;

/**
 * Queries Cloudflare's GraphQL Analytics API for total Calls SFU + TURN
 * egress within [start, end). Shared by both the "usage so far this month"
 * admin route below and the per-day aggregation cron
 * (services/usage.aggregation.service.ts) - the only difference between
 * those two callers is the date range they pass in.
 */
export async function fetchCloudflareUsageForRange(start: Date, end = new Date()): Promise<CloudflareUsageWindow> {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const token = env.CLOUDFLARE_API_TOKEN;

  if (!accountId || !token) {
    throw new AppError("AUTH_NOT_CONFIGURED", "Cloudflare account credentials not configured");
  }

  const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      query: USAGE_QUERY,
      variables: {
        accountTag: accountId,
        datetimeGeq: start.toISOString(),
        datetimeLt: end.toISOString(),
      },
    }),
  });

  const result = (await response.json()) as CloudflareGraphQLResponse;

  if (!response.ok) {
    throw new AppError("VOICE_UPSTREAM_ERROR", `Cloudflare API error: ${response.status} ${JSON.stringify(result)}`);
  }

  if (result.errors?.length) {
    throw new AppError("VOICE_UPSTREAM_ERROR", `Cloudflare GraphQL error: ${JSON.stringify(result.errors)}`);
  }

  const account = result.data?.viewer?.accounts?.[0];

  if (!account) {
    throw new AppError("VOICE_UPSTREAM_ERROR", "Cloudflare account was not found or is not accessible");
  }

  const callsUsageEgressBytes =
    account.callsUsageAdaptiveGroups?.reduce((total, group) => total + (group.sum?.egressBytes ?? 0), 0) ?? 0;
  const turnUsageEgressBytes =
    account.callsTurnUsageAdaptiveGroups?.reduce((total, group) => total + (group.sum?.egressBytes ?? 0), 0) ?? 0;
  const turnUsageIngressBytes =
    account.callsTurnUsageAdaptiveGroups?.reduce((total, group) => total + (group.sum?.ingressBytes ?? 0), 0) ?? 0;

  return {
    callsUsageEgressBytes,
    turnUsageEgressBytes,
    turnUsageIngressBytes,
    totalEgressBytes: callsUsageEgressBytes + turnUsageEgressBytes,
  };
}

/** Cumulative usage for the current calendar month to date (UTC), used by GET /api/admin/cloudflare-usage. */
export async function getCloudflareUsage(): Promise<UsageStats> {
  const now = new Date();
  const firstDayOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));

  const window = await fetchCloudflareUsageForRange(firstDayOfMonth);

  return {
    ...window,
    totalEgressGB: window.totalEgressBytes / 1_000_000_000,
  };
}