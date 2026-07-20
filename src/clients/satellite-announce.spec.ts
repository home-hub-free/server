// SATELLITE_VOLUME_FEEDBACK transport: a direct POST to SATELLITE_AUDIO_URL, a silent
// no-op when unset (same default-off posture as the ingestion seam) so tests/sim/gate
// never fire a real announce. Mock axios + the logger so a delivery failure is
// asserted without a real network call or console noise.
const axiosPost = jest.fn((..._a: any[]) => Promise.resolve({ data: {} }));
jest.mock("axios", () => ({ __esModule: true, default: { post: (...a: any[]) => axiosPost(...a) } }));
const logSpy = jest.fn();
jest.mock("../logger", () => ({ log: (...a: any[]) => logSpy(...a), EVENT_TYPES: { error: "[ERROR]" } }));

import { announceToZone } from "./satellite-announce";

const flush = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  axiosPost.mockClear();
  logSpy.mockClear();
  delete process.env.SATELLITE_AUDIO_URL;
});

describe("announceToZone", () => {
  it("is a no-op when SATELLITE_AUDIO_URL is unset (keeps tests/sim/gate silent)", () => {
    expect(() => announceToZone("Volumen al cuarenta y cinco por ciento.", "cocina")).not.toThrow();
    expect(axiosPost).not.toHaveBeenCalled();
  });

  it("POSTs { text, zone } to the configured URL with a bounded timeout", () => {
    process.env.SATELLITE_AUDIO_URL = "http://127.0.0.1:1880/satellite-announce";
    announceToZone("Volumen al cuarenta y cinco por ciento.", "cocina");
    expect(axiosPost).toHaveBeenCalledWith(
      "http://127.0.0.1:1880/satellite-announce",
      { text: "Volumen al cuarenta y cinco por ciento.", zone: "cocina" },
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
  });

  it("never throws when the POST rejects — logs one line instead", async () => {
    process.env.SATELLITE_AUDIO_URL = "http://127.0.0.1:1880/satellite-announce";
    axiosPost.mockImplementationOnce(() => Promise.reject(new Error("ECONNREFUSED")));
    expect(() => announceToZone("hola", "cocina")).not.toThrow();
    await flush();
    expect(logSpy).toHaveBeenCalledTimes(1);
  });
});
