// SATELLITE_VOLUME_FEEDBACK debounce: a slider drag emits a burst of writes; only the
// LAST settled (zone, volume) within a 1200ms trailing window per node id should reach
// the announce sink. Fake timers + an injected sink so the debounce is asserted
// without a real clock or HTTP call.
jest.mock("../clients/satellite-announce", () => ({ announceToZone: jest.fn() }));

import { announceToZone } from "../clients/satellite-announce";
import { scheduleVolumeAnnounce, _reset } from "./volume-announce";

const sink = jest.fn();

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ["performance"] });
  sink.mockClear();
  (announceToZone as jest.Mock).mockClear();
  _reset();
});

afterEach(() => {
  _reset();
  jest.useRealTimers();
});

describe("scheduleVolumeAnnounce", () => {
  it("announces the Spanish-worded template after the debounce window", () => {
    scheduleVolumeAnnounce("sat1", "cocina", 45, sink);
    expect(sink).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1199);
    expect(sink).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(sink).toHaveBeenCalledWith("Volumen al cuarenta y cinco por ciento.", "cocina");
  });

  it("collapses a burst to ONE call carrying only the final settled value", () => {
    scheduleVolumeAnnounce("sat1", "cocina", 10, sink);
    jest.advanceTimersByTime(400);
    scheduleVolumeAnnounce("sat1", "cocina", 20, sink);
    jest.advanceTimersByTime(400);
    scheduleVolumeAnnounce("sat1", "cocina", 45, sink);
    jest.advanceTimersByTime(1200);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith("Volumen al cuarenta y cinco por ciento.", "cocina");
  });

  it("debounces independently per node id", () => {
    scheduleVolumeAnnounce("sat1", "cocina", 30, sink);
    scheduleVolumeAnnounce("sat2", "sala", 70, sink);
    jest.advanceTimersByTime(1200);
    expect(sink).toHaveBeenCalledTimes(2);
    expect(sink).toHaveBeenCalledWith("Volumen al treinta por ciento.", "cocina");
    expect(sink).toHaveBeenCalledWith("Volumen al setenta por ciento.", "sala");
  });

  it("skips scheduling entirely when zone is empty (delivery can't resolve an IP)", () => {
    scheduleVolumeAnnounce("sat1", "", 45, sink);
    jest.advanceTimersByTime(5000);
    expect(sink).not.toHaveBeenCalled();
  });

  it("announces 0 (plays silently but honestly — no special mute copy)", () => {
    scheduleVolumeAnnounce("sat1", "cocina", 0, sink);
    jest.advanceTimersByTime(1200);
    expect(sink).toHaveBeenCalledWith("Volumen al cero por ciento.", "cocina");
  });

  it("defaults the sink to the real satellite-announce client when none is injected", () => {
    scheduleVolumeAnnounce("sat1", "cocina", 45);
    jest.advanceTimersByTime(1200);
    expect(announceToZone).toHaveBeenCalledWith("Volumen al cuarenta y cinco por ciento.", "cocina");
  });
});
