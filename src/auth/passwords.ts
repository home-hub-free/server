import crypto from "crypto";

/**
 * Password hashing + token minting for the hub's simple household login.
 *
 * Uses Node's built-in `crypto.scrypt` so we add NO native/runtime dependency
 * (better-sqlite3 is already the only native dep). A stored hash is the string
 * `"<salt-hex>:<derivedKey-hex>"`; verification is constant-time.
 */

const KEYLEN = 64;
const SALT_BYTES = 16;

/** Hash a plaintext password → "salt:key" hex, safe to persist. */
export function hashPassword(plain: string): string {
  const salt = crypto.randomBytes(SALT_BYTES).toString("hex");
  const key = crypto.scryptSync(plain, salt, KEYLEN).toString("hex");
  return `${salt}:${key}`;
}

/** Constant-time check of a plaintext password against a stored "salt:key" hash. */
export function verifyPassword(plain: string, stored: string): boolean {
  const [salt, keyHex] = stored.split(":");
  if (!salt || !keyHex) return false;
  const key = Buffer.from(keyHex, "hex");
  const test = crypto.scryptSync(plain, salt, KEYLEN);
  // Lengths must match for timingSafeEqual; a malformed stored hash fails closed.
  if (key.length !== test.length) return false;
  return crypto.timingSafeEqual(key, test);
}

/** A fresh opaque session token (32 random bytes, hex). */
export function newToken(): string {
  return crypto.randomBytes(32).toString("hex");
}
