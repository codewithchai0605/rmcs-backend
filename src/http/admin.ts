import { env } from "../config/env.js";

interface UsageStats {
  callsUsageEgressBytes: number;
  callsTurnUsageEgressBytes: number;
  totalEgressBytes: number;
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

export async function getCloudflareUsage(): Promise<UsageStats> {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const token = env.CLOUDFLARE_API_TOKEN;

  if (!accountId || !token) {
    throw new Error("Cloudflare account credentials not configured");
  }

  // Start of current month in UTC.
  const now = new Date();

  const firstDayOfMonth = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      1,
      0,
      0,
      0,
      0
    )
  );

  const dateStr = firstDayOfMonth.toISOString();

  const query = `
    query GetRealtimeUsage(
      $accountTag: String!
      $datetimeGeq: String!
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

  const response = await fetch(
    "https://api.cloudflare.com/client/v4/graphql",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        query,
        variables: {
          accountTag: accountId,
          datetimeGeq: dateStr,
        },
      }),
    }
  );

  const result =
    (await response.json()) as CloudflareGraphQLResponse;

  if (!response.ok) {
    throw new Error(
      `Cloudflare API error: ${response.status} ${JSON.stringify(result)}`
    );
  }

  if (result.errors?.length) {
    throw new Error(
      `Cloudflare GraphQL error: ${JSON.stringify(result.errors)}`
    );
  }

  const account = result.data?.viewer?.accounts?.[0];

  if (!account) {
    throw new Error(
      "Cloudflare account was not found or is not accessible"
    );
  }

  const callsUsageEgressBytes =
    account.callsUsageAdaptiveGroups?.reduce(
      (total, group) =>
        total + (group.sum?.egressBytes ?? 0),
      0
    ) ?? 0;

  const callsTurnUsageEgressBytes =
    account.callsTurnUsageAdaptiveGroups?.reduce(
      (total, group) =>
        total + (group.sum?.egressBytes ?? 0),
      0
    ) ?? 0;

  const totalEgressBytes =
    callsUsageEgressBytes +
    callsTurnUsageEgressBytes;

  const totalEgressGB =
    totalEgressBytes / 1_000_000_000;

  return {
    callsUsageEgressBytes,
    callsTurnUsageEgressBytes,
    totalEgressBytes,
    totalEgressGB,
  };
}