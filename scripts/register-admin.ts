import "dotenv/config";

import mongoose from "mongoose";
import { connectDb } from "../src/config/db";
import { env } from "../src/config/env";
import { Admin, ADMIN_ROLES, type AdminRole } from "../src/models/admin.model";

function printUsage(): void {
  console.log(`Usage:
  npm run register-admin -- --username admin --password strongpass --email admin@example.com --role superadmin

Environment variables (used if flags are omitted):
  ADMIN_USERNAME
  ADMIN_PASSWORD
  ADMIN_EMAIL
  ADMIN_ROLE (superadmin|admin|viewer)

Notes:
  - This script creates the first admin only.
  - It refuses to run if an admin already exists.
  - Password is never printed.
`);
}

function parseArgs(): Record<string, string | undefined> {
  const values: Record<string, string | undefined> = {};
  const args = process.argv.slice(2);

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) {
      continue;
    }

    const key = arg.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith("--")) {
      values[key] = next;
      i += 1;
    } else {
      values[key] = process.env[`ADMIN_${key.toUpperCase()}`];
    }
  }

  return {
    username: values.username ?? process.env.ADMIN_USERNAME,
    password: values.password ?? process.env.ADMIN_PASSWORD,
    email: values.email ?? process.env.ADMIN_EMAIL,
    role: values.role ?? process.env.ADMIN_ROLE ?? "superadmin",
  };
}

function assertValidRole(role: string): asserts role is AdminRole {
  if (!ADMIN_ROLES.includes(role as AdminRole)) {
    throw new Error(`Invalid role: ${role}. Allowed roles: ${ADMIN_ROLES.join(", ")}`);
  }
}

async function main(): Promise<void> {
  const { username, password, email, role } = parseArgs();

  if (!username || !password) {
    printUsage();
    process.exit(1);
  }

  assertValidRole(role ?? "superadmin");

  if (!env.MONGOOSE_URI) {
    throw new Error("MONGOOSE_URI is not set. Add it to your .env before creating the first admin.");
  }

  await connectDb();

  const existingAdmin = await Admin.findOne({}).lean();
  if (existingAdmin) {
    console.error("A first admin already exists in the database.");
    console.error(`Existing admin: ${existingAdmin.username} (${existingAdmin.role})`);
    process.exit(1);
  }

  const passwordHash = await Admin.hashPassword(password);
  const admin = await Admin.create({
    username: username.trim().toLowerCase(),
    email: email?.trim().toLowerCase() || undefined,
    passwordHash,
    role,
    isActive: true,
    failedLoginAttempts: 0,
  });

  console.log("Admin created successfully.");
  console.log(JSON.stringify({
    id: admin._id.toString(),
    username: admin.username,
    email: admin.email ?? null,
    role: admin.role,
    createdAt: admin.createdAt,
  }, null, 2));

  await mongoose.disconnect();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("Failed to create admin:", message);
  process.exit(1);
});
