/**
 * Side-effect module: import this FIRST in the server entrypoint so the legacy
 * JSON → SQLite migration runs before any module that reads the DB at import time
 * (the assistant singleton, the bootstrap sensor). Importing it opens the
 * connection (applying the schema) and performs the one-time migration.
 */
import { importLegacyJson } from "./migrate";
import { usersRepo } from "./users.repo";

importLegacyJson();

/**
 * First-boot household seed: if no users exist, create one admin member so the
 * dashboard is reachable. Credentials come from SEED_USER / SEED_PASS; if no
 * password is set we generate one and print it ONCE to the log (the operator
 * should change it in the settings UI). Real members are added there too.
 */
function seedFirstUser(): void {
  if (!usersRepo.isEmpty()) return;
  const username = process.env.SEED_USER || "david";
  let password = process.env.SEED_PASS;
  let generated = false;
  if (!password) {
    password = require("crypto").randomBytes(6).toString("hex");
    generated = true;
  }
  usersRepo.create({ username, displayName: username, password });
  console.log(`[auth] seeded first user "${username}"`);
  if (generated) {
    console.log(
      `[auth] generated password for "${username}": ${password}  (change it in Settings → Household)`,
    );
  }
}

seedFirstUser();
