/**
 * Side-effect module: import this FIRST in the server entrypoint so the legacy
 * JSON → SQLite migration runs before any module that reads the DB at import time
 * (the assistant singleton, the bootstrap sensor). Importing it opens the
 * connection (applying the schema) and performs the one-time migration.
 */
import { importLegacyJson } from "./migrate";

importLegacyJson();
