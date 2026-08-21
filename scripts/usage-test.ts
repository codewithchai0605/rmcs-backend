const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;

// Cloudflare rejects Analytics queries wider than 4w4d. Keep a margin below
// that limit so this script also remains safe around boundary timestamps.
const MAX_QUERY_RANGE_MS = 28 * 24 * 60 * 60 * 1000;

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

type UsageTotals = {
    callsUsageEgressBytes: number;
    callsTurnUsageEgressBytes: number;
};

type UsageResponse = {
    data?: {
        viewer?: {
            accounts?: Array<{
                callsUsageAdaptiveGroups?: Array<{ sum?: { egressBytes?: number | null } | null }>;
                callsTurnUsageAdaptiveGroups?: Array<{ sum?: { egressBytes?: number | null } | null }>;
            }>;
        };
    };
    errors?: Array<{ message: string }>;
};

async function fetchUsage(start: Date, end: Date): Promise<UsageTotals> {
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

    const result = (await response.json()) as UsageResponse;
    if (!response.ok || result.errors?.length) {
        throw new Error(`Cloudflare API error: ${JSON.stringify(result.errors ?? result)}`);
    }

    const account = result.data?.viewer?.accounts?.[0];
    if (!account) throw new Error("Cloudflare account was not found or is not accessible");

    return {
        callsUsageEgressBytes:
            account.callsUsageAdaptiveGroups?.reduce((total, group) => total + (group.sum?.egressBytes ?? 0), 0) ?? 0,
        callsTurnUsageEgressBytes:
            account.callsTurnUsageAdaptiveGroups?.reduce((total, group) => total + (group.sum?.egressBytes ?? 0), 0) ?? 0,
    };
}

const rangeEnd = new Date();

// Cloudflare retains data for a max of 4w4d (32 days). 
// Let's use 31 days to be safe.
const MAX_RETENTION_MS = 31 * 24 * 60 * 60 * 1000;
const retentionLimitDate = new Date(rangeEnd.getTime() - MAX_RETENTION_MS);

// Your original target start date
const targetStart = new Date("2026-07-10T00:00:00.000Z");

// Use whichever is more recent: your target start date, or Cloudflare's oldest allowed date
const rangeStart = new Date(Math.max(targetStart.getTime(), retentionLimitDate.getTime()));

if (Number.isNaN(rangeStart.getTime()) || rangeStart >= rangeEnd) {
    throw new Error("Invalid usage range");
}

const totals: UsageTotals = {
    callsUsageEgressBytes: 0,
    callsTurnUsageEgressBytes: 0,
};

for (let start = rangeStart; start < rangeEnd;) {
    const end = new Date(Math.min(start.getTime() + MAX_QUERY_RANGE_MS, rangeEnd.getTime()));
    const chunk = await fetchUsage(start, end);
    totals.callsUsageEgressBytes += chunk.callsUsageEgressBytes;
    totals.callsTurnUsageEgressBytes += chunk.callsTurnUsageEgressBytes;
    console.log(`Fetched ${start.toISOString()} to ${end.toISOString()}`, chunk);
    start = end;
}

console.log({
    ...totals,
    totalEgressBytes: totals.callsUsageEgressBytes + totals.callsTurnUsageEgressBytes,
});