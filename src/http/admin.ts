import { env } from "../config/env";
import { AppError } from "../core/errors";

/**
 * Cloudflare Realtime (Calls SFU) usage reporting, via Cloudflare's account
 * GraphQL Analytics API. Two credential pairs are involved in this app and
 * they are NOT interchangeable:
 *  - CLOUDFLARE_APP_ID / CLOUDFLARE_APP_TOKEN (see voice/cloudflareCalls.ts)
 *    create/manage individual SFU sessions.
 *  - CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN (used only here) is a
 *    normal account-level API token (Billing/Analytics read scope) used
 *    purely to ask "how much did we use".
 */

export interface CloudflareUsageWindow {
  callsUsageEgressBytes: number;
  callsTurnUsageEgressBytes: number;
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
    $datetimeLt: String
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

        callsTurnUsageAdaptiveGroups(
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
      }
    }
  }
`;

/**
 * Queries Cloudflare's GraphQL Analytics API for total Calls SFU + TURN
 * egress within [start, end). Shared by both the "usage so far this month"
 * admin route below and the per-day aggregation cron
 * (services/usageAggregation.service.ts) - the only difference between
 * those two callers is the date range they pass in.
 */
export async function fetchCloudflareUsageForRange(start: Date, end?: Date): Promise<CloudflareUsageWindow> {
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
        datetimeLt: end ? end.toISOString() : undefined,
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

  const callsTurnUsageEgressBytes =
    account.callsTurnUsageAdaptiveGroups?.reduce((total, group) => total + (group.sum?.egressBytes ?? 0), 0) ?? 0;

  return {
    callsUsageEgressBytes,
    callsTurnUsageEgressBytes,
    totalEgressBytes: callsUsageEgressBytes + callsTurnUsageEgressBytes,
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