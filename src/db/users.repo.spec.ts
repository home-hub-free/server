// Runs against an in-memory SQLite DB (NODE_ENV=test -> ":memory:" in connection.ts).
// Covers the household auth data layer: create/list, password hashing + verify,
// session mint/resolve/delete, prefs updates, and the FK cascade on delete.
import { usersRepo } from "./users.repo";
import { verifyPassword } from "../auth/passwords";

describe("UsersRepo + sessions", () => {
  it("creates a user, slugifies the id, and hides the hash", () => {
    const u = usersRepo.create({
      username: "David M",
      password: "hunter2",
      prefs: { tone: "casual" },
    });
    expect(u.id).toBe("david-m");
    expect(u.username).toBe("David M");
    expect(u.displayName).toBe("David M");
    expect(u.prefs).toEqual({ tone: "casual" });
    // PublicUser never carries the password hash.
    expect((u as any).pass_hash).toBeUndefined();
  });

  it("stores a verifiable scrypt hash, not plaintext", () => {
    usersRepo.create({ username: "alice", password: "s3cret" });
    const row = usersRepo.getRowByUsername("alice")!;
    expect(row.pass_hash).not.toContain("s3cret");
    expect(verifyPassword("s3cret", row.pass_hash)).toBe(true);
    expect(verifyPassword("wrong", row.pass_hash)).toBe(false);
  });

  it("mints a session that resolves to the owning user, then revokes it", () => {
    const u = usersRepo.create({ username: "bob", password: "pw" });
    const token = usersRepo.createSession(u.id);
    expect(usersRepo.resolveSession(token)?.id).toBe(u.id);
    usersRepo.deleteSession(token);
    expect(usersRepo.resolveSession(token)).toBeUndefined();
  });

  it("resolves an unknown/empty token to undefined", () => {
    expect(usersRepo.resolveSession("nope")).toBeUndefined();
    expect(usersRepo.resolveSession("")).toBeUndefined();
  });

  it("updates prefs and display name without touching the password", () => {
    const u = usersRepo.create({ username: "carol", password: "pw" });
    usersRepo.updatePrefs(u.id, { tone: "formal" });
    usersRepo.updateDisplayName(u.id, "Carol B");
    const after = usersRepo.getById(u.id)!;
    expect(after.prefs).toEqual({ tone: "formal" });
    expect(after.displayName).toBe("Carol B");
    expect(verifyPassword("pw", usersRepo.getRowByUsername("carol")!.pass_hash)).toBe(true);
  });

  it("setPassword replaces the hash", () => {
    const u = usersRepo.create({ username: "dave", password: "old" });
    usersRepo.setPassword(u.id, "new");
    const row = usersRepo.getRowByUsername("dave")!;
    expect(verifyPassword("old", row.pass_hash)).toBe(false);
    expect(verifyPassword("new", row.pass_hash)).toBe(true);
  });

  it("cascades sessions away when a user is removed", () => {
    const u = usersRepo.create({ username: "erin", password: "pw" });
    const token = usersRepo.createSession(u.id);
    usersRepo.remove(u.id);
    expect(usersRepo.getById(u.id)).toBeUndefined();
    expect(usersRepo.resolveSession(token)).toBeUndefined();
  });

  it("rejects a duplicate username", () => {
    usersRepo.create({ username: "frank", password: "pw" });
    expect(() => usersRepo.create({ username: "frank", password: "pw2" })).toThrow();
  });
});
