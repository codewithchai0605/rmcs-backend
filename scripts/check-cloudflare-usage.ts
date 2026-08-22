/* eslint-disable no-console */
import "dotenv/config";

type JsonRecord = Record<string, unknown>;

function required(name: "ADMIN_USERNAME" | "ADMIN_PASSWORD"): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function readJson(response: Response): Promise<JsonRecord> {
  const text = await response.text();
  let body: JsonRecord;
  try {
    body = JSON.parse(text) as JsonRecord;
  } catch {
    throw new Error(`Expected JSON from ${response.url}, received HTTP ${response.status}`);
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${typeof body.error === "string" ? body.error : text}`);
  }
  return body;
}

function accessToken(loginResponse: JsonRecord): string {
  const tokens = loginResponse.tokens as JsonRecord | undefined;
  const token = loginResponse.accessToken ?? tokens?.accessToken;
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("Login succeeded but did not return an access token");
  }
  return token;
}

function bytesToGb(bytes: number): string {
  return (bytes / 1_000_000_000).toFixed(6);
}

async function main(): Promise<void> {
  const baseUrl = (process.env.ADMIN_USAGE_BASE_URL ?? process.env.ADMIN_API_URL ?? "http://localhost:8080").replace(/\/$/, "");
  const username = required("ADMIN_USERNAME");
  const password = required("ADMIN_PASSWORD");

  // This mirrors the Tauri client: authenticate first, then call the same
  // protected endpoint the dashboard uses. Passwords and tokens are never
  // printed.
  const login = await readJson(await fetch(`${baseUrl}/admin/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  }));

  const usage = await readJson(await fetch(`${baseUrl}/api/admin/cloudflare-usage`, {
    headers: { Authorization: `Bearer ${accessToken(login)}` },
  }));

  const callsBytes = Number(usage.callsUsageEgressBytes);
  const totalBytes = Number(usage.totalEgressBytes);
  const totalGb = Number(usage.totalEgressGB);

  if (![callsBytes, totalBytes, totalGb].every(Number.isFinite)) {
    throw new Error(`Usage endpoint returned an unexpected payload: ${JSON.stringify(usage)}`);
  }

  console.log(`Cloudflare usage from ${baseUrl}/api/admin/cloudflare-usage`);
  console.table({
    "Calls egress": { bytes: callsBytes, GB: bytesToGb(callsBytes) },
    Total: { bytes: totalBytes, GB: bytesToGb(totalBytes) },
  });
  console.log(`Endpoint totalEgressGB: ${totalGb.toFixed(6)} GB`);
  console.log("Raw payload:", JSON.stringify(usage));
}

main().catch((error: unknown) => {
  console.error("Cloudflare usage check failed:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
