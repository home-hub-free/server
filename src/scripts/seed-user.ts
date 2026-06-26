/**
 * CLI to create (seed) a household account directly against the hub DB — useful
 * for first setup or a password reset without the dashboard. Run after a build:
 *
 *   npm run seed-user -- <username> <password> [displayName] [tone]
 *
 * Importing the repo opens the same local SQLite connection the hub uses (schema
 * applied on open). Re-running for an existing username RESETS that user's
 * password (a deliberate lock-out recovery path), otherwise creates a new one.
 */
import { usersRepo } from "../db/users.repo";

function main() {
  const [username, password, displayName, tone] = process.argv.slice(2);
  if (!username || !password) {
    console.error("usage: npm run seed-user -- <username> <password> [displayName] [tone]");
    process.exit(1);
  }

  const existing = usersRepo.getRowByUsername(username);
  if (existing) {
    usersRepo.setPassword(existing.id, password);
    if (tone) usersRepo.updatePrefs(existing.id, { tone });
    console.log(`reset password for existing user "${username}" (id ${existing.id})`);
    process.exit(0);
  }

  const user = usersRepo.create({
    username,
    password,
    displayName: displayName || undefined,
    prefs: tone ? { tone } : {},
  });
  console.log(`created user "${user.username}" (id ${user.id})`);
  process.exit(0);
}

main();
