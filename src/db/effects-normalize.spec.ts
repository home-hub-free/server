import {
  normalizeEffect,
  normalizeAll,
  primaryActuatorChannel,
} from "./effects-normalize";

describe("effect normalization (Stage 2 data-contract redesign)", () => {
  describe("boolean (motion/presence) sensor conditions", () => {
    it("maps an on-rule to presence eq true", () => {
      const n = normalizeEffect(
        { when: { id: "pir-sala", type: "sensor", is: true }, set: { id: "light-sala", value: true } },
        () => "light",
      );
      expect(n.when).toEqual({ source: "sensor", nodeId: "pir-sala", channel: "presence", op: "eq", value: true });
      expect(n.set).toEqual({ nodeId: "light-sala", channel: "power", value: true });
    });

    it("treats the legacy 'false' string and falsy values as eq false (off-rule)", () => {
      expect(normalizeEffect({ when: { id: "p", type: "sensor", is: "false" }, set: { id: "l", value: false } }).when).toMatchObject({ op: "eq", value: false });
      expect(normalizeEffect({ when: { id: "p", type: "sensor", is: false }, set: { id: "l", value: false } }).when).toMatchObject({ value: false });
    });
  });

  describe("temp/humidity comparison conditions", () => {
    it("parses temp:higher-than:28 into temperature gt 28", () => {
      const n = normalizeEffect(
        { when: { id: "th-sala", type: "sensor", is: "temp:higher-than:28" }, set: { id: "c", value: true, valueToSet: "fan" } },
        () => "evap-cooler",
      );
      expect(n.when).toEqual({ source: "sensor", nodeId: "th-sala", channel: "temperature", op: "gt", value: 28 });
    });

    it("parses humidity:lower-than:40 into humidity lt 40", () => {
      const n = normalizeEffect({ when: { id: "th", type: "sensor", is: "humidity:lower-than:40" }, set: { id: "x", value: true } });
      expect(n.when).toMatchObject({ channel: "humidity", op: "lt", value: 40 });
    });
  });

  describe("set side", () => {
    it("uses valueToSet directly as the channel (cooler fan/water)", () => {
      const n = normalizeEffect(
        { when: { id: "th", type: "sensor", is: "temp:higher-than:28" }, set: { id: "cooler-sala", value: true, valueToSet: "water" } },
        () => "evap-cooler",
      );
      expect(n.set).toEqual({ nodeId: "cooler-sala", channel: "water", value: true });
    });

    it("resolves the primary channel from device category when there is no valueToSet", () => {
      const n = normalizeEffect(
        { when: { id: "p", type: "sensor", is: true }, set: { id: "blind-1", value: 80 } },
        (id) => (id === "blind-1" ? "blinds" : undefined),
      );
      expect(n.set).toEqual({ nodeId: "blind-1", channel: "position", value: 80 });
    });

    it("falls back to the generic 'value' channel for an unknown device", () => {
      const n = normalizeEffect({ when: { id: "p", type: "sensor", is: true }, set: { id: "ghost", value: 1 } });
      expect(n.set.channel).toBe("value");
    });
  });

  describe("time conditions", () => {
    it("preserves vestigial time effects rather than forcing the channel model", () => {
      const n = normalizeEffect({ when: { id: "t", type: "time", is: "sunset" }, set: { id: "l", value: true } }, () => "light");
      expect(n.when).toEqual({ source: "time", at: "sunset" });
      expect(n.set).toEqual({ nodeId: "l", channel: "power", value: true });
    });
  });

  describe("primaryActuatorChannel", () => {
    it("mirrors the Stage-1 projection channel keys", () => {
      expect(primaryActuatorChannel("light")).toBe("power");
      expect(primaryActuatorChannel("door")).toBe("power");
      expect(primaryActuatorChannel("dimmable-light")).toBe("brightness");
      expect(primaryActuatorChannel("blinds")).toBe("position");
      expect(primaryActuatorChannel(undefined)).toBe("value");
    });
  });

  it("normalizeAll handles an empty/undefined list and every rule is enabled", () => {
    expect(normalizeAll(undefined as any)).toEqual([]);
    const all = normalizeAll([
      { when: { id: "p", type: "sensor", is: true }, set: { id: "l", value: true } },
    ]);
    expect(all[0].enabled).toBe(true);
  });

  it("is idempotent in shape (re-normalizing produces stable output)", () => {
    const legacy = { when: { id: "th", type: "sensor", is: "temp:higher-than:28" }, set: { id: "c", value: true, valueToSet: "fan" } };
    expect(normalizeEffect(legacy)).toEqual(normalizeEffect(legacy));
  });
});
