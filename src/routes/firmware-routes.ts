import { Express, Request, Response } from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";

/**
 * Pull-based OTA endpoint. Devices (via HomeHubDevice::checkForUpdate) call
 * GET /firmware/<category> with their current build in the x-ESP8266-version /
 * x-ESP32-version header. We answer 304 when they already run the published
 * build, otherwise stream the .bin with an x-MD5 header the ESP update client
 * verifies before flashing.
 *
 * Store layout (populated by `./hub publish`):
 *   server/firmware/manifest.json        { "<category>": "<version>" }
 *   server/firmware/<category>/firmware.bin
 *
 * Category is the device's declared name with '/' sanitized to '-'
 * (e.g. "temp/humidity" -> "temp-humidity"), matching the firmware key.
 */

const FIRMWARE_DIR = path.resolve("firmware");
const MANIFEST = path.join(FIRMWARE_DIR, "manifest.json");

export function ensureFirmwareStore() {
  if (!fs.existsSync(FIRMWARE_DIR)) {
    fs.mkdirSync(FIRMWARE_DIR, { recursive: true });
  }
  if (!fs.existsSync(MANIFEST)) {
    fs.writeFileSync(MANIFEST, JSON.stringify({}, null, 2));
  }
}

function readManifest(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  } catch {
    return {};
  }
}

export function initFirmwareRoutes(app: Express) {
  app.get("/firmware/:category", (request: Request, response: Response) => {
    const category = request.params.category;
    const published = readManifest()[category];
    const binPath = path.join(FIRMWARE_DIR, category, "firmware.bin");

    if (!published || !fs.existsSync(binPath)) {
      return response.status(404).send("no firmware published for category");
    }

    // Express lower-cases header names; ESP sends x-ESP8266-version / x-ESP32-version.
    const current =
      (request.headers["x-esp8266-version"] as string) ||
      (request.headers["x-esp32-version"] as string) ||
      "";

    if (current && current === published) {
      return response.status(304).end();
    }

    const bin = fs.readFileSync(binPath);
    const md5 = crypto.createHash("md5").update(bin).digest("hex");
    response.setHeader("Content-Type", "application/octet-stream");
    response.setHeader("Content-Length", bin.length);
    response.setHeader(
      "Content-Disposition",
      `attachment; filename=${category}.bin`
    );
    response.setHeader("x-MD5", md5);
    return response.send(bin);
  });
}
