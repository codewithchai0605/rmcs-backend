import { env } from "../config/env";

const connectionsByIp = new Map<string, number>();

function tryAcquire(ip: string): boolean {
  const current = connectionsByIp.get(ip) ?? 0;
  if (current >= env.MAX_CONNECTIONS_PER_IP) {
    return false;
  }
  connectionsByIp.set(ip, current + 1);
  return true;
}

function release(ip: string): void {
  const current = connectionsByIp.get(ip) ?? 0;
  if (current <= 1) {
    connectionsByIp.delete(ip);
  } else {
    connectionsByIp.set(ip, current - 1);
  }
}

function countFor(ip: string): number {
  return connectionsByIp.get(ip) ?? 0;
}

function totalConnections(): number {
  let total = 0;
  for (const count of connectionsByIp.values()) total += count;
  return total;
}

export const connectionLimiter = {
  tryAcquire,
  release,
  countFor,
  totalConnections,
};
