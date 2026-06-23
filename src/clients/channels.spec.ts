import { buildSetRequests, channelValue, deviceToChannels, sensorToChannels, withChannelValue } from "./channels";

describe("channel projection (Stage 1 data-contract redesign)", () => {
  describe("deviceToChannels", () => {
    it("projects a light to a single boolean power actuator", () => {
      expect(deviceToChannels({ id: "l1", value: true, deviceCategory: "light" })).toEqual([
        { key: "power", role: "actuator", kind: "boolean", writable: true, value: true },
      ]);
    });

    it("coerces stringy/legacy boolean values", () => {
      expect(deviceToChannels({ id: "d1", value: "false", deviceCategory: "door" })[0].value).toBe(false);
      expect(deviceToChannels({ id: "d2", value: 1, deviceCategory: "door" })[0].value).toBe(true);
    });

    it("projects a dimmable-light to a 0-100 % brightness channel", () => {
      const [ch] = deviceToChannels({ id: "dim1", value: 42, deviceCategory: "dimmable-light" });
      expect(ch).toMatchObject({ key: "brightness", kind: "number", unit: "%", value: 42 });
      expect(ch.range).toEqual({ min: 0, max: 100, step: 1 });
    });

    it("marks blinds position as precision-owned", () => {
      const [ch] = deviceToChannels({ id: "b1", value: 80, deviceCategory: "blinds" });
      expect(ch).toMatchObject({ key: "position", precision: true, value: 80 });
    });

    it("returns no channels for a camera", () => {
      expect(deviceToChannels({ id: "cam1", value: null, deviceCategory: "camera" })).toEqual([]);
    });

    it("explodes the evap-cooler blob into 5 typed channels", () => {
      const channels = deviceToChannels({
        id: "cooler-sala",
        deviceCategory: "evap-cooler",
        zone: "sala",
        value: { fan: true, water: false, target: 26, "room-temp": 29.5, "unit-temp": 31 },
      });
      expect(channels.map((c) => [c.key, c.role, c.value])).toEqual([
        ["fan", "actuator", true],
        ["water", "actuator", false],
        ["target", "setting", 26],
        ["room-temp", "sensor", 29.5],
        ["unit-temp", "sensor", 31],
      ]);
      // target is a setting with a sane bounded range; readings are read-only.
      expect(channels.find((c) => c.key === "target")).toMatchObject({ unit: "C", range: { min: 16, max: 30, step: 1 } });
      expect(channels.find((c) => c.key === "room-temp")).toMatchObject({ writable: false, unit: "C" });
    });

    it("tolerates a missing/empty evap-cooler value object", () => {
      const channels = deviceToChannels({ id: "c2", deviceCategory: "evap-cooler", value: undefined });
      expect(channels).toHaveLength(5);
      expect(channels.every((c) => c.value === false || c.value === 0)).toBe(true);
    });

    it("falls back to one generic channel for unknown categories", () => {
      expect(deviceToChannels({ id: "x", value: 7, deviceCategory: "future-thing" })).toEqual([
        { key: "value", role: "actuator", kind: "number", writable: true, value: 7 },
      ]);
    });
  });

  describe("sensorToChannels", () => {
    it("projects motion/presence to a boolean presence sensor", () => {
      expect(sensorToChannels({ id: "m1", value: 1, sensorType: "motion" })).toEqual([
        { key: "presence", role: "sensor", kind: "boolean", writable: false, value: true },
      ]);
    });

    it("splits the colon-packed temp/humidity reading into two unit-tagged channels", () => {
      const channels = sensorToChannels({ id: "th1", value: "23.5:10.5", sensorType: "temp/humidity" });
      expect(channels).toEqual([
        { key: "temperature", role: "sensor", kind: "number", unit: "C", writable: false, value: 23.5 },
        { key: "humidity", role: "sensor", kind: "number", unit: "%", writable: false, value: 10.5 },
      ]);
    });

    it("tolerates an empty temp/humidity reading", () => {
      const channels = sensorToChannels({ id: "th2", value: "", sensorType: "temp/humidity" });
      expect(channels.map((c) => c.value)).toEqual([0, 0]);
    });
  });

  describe("buildSetRequests (Stage 3 /set shim)", () => {
    const ip = "10.0.0.5";

    describe("legacy fleet (channelAware: false) — byte-identical to the old wire", () => {
      it("emits a single /set?value= for a light", () => {
        expect(buildSetRequests({ ip, category: "light", channelAware: false, value: true })).toEqual([
          { url: "http://10.0.0.5/set?value=true" },
        ]);
      });

      it("emits the combined /set?fan=&water= for the cooler", () => {
        expect(
          buildSetRequests({ ip, category: "evap-cooler", channelAware: false, value: { fan: true, water: false } }),
        ).toEqual([{ url: "http://10.0.0.5/set?fan=true&water=false" }]);
      });

      it("never tags a channel (so failures revert the whole value, as before)", () => {
        const [req] = buildSetRequests({ ip, category: "dimmable-light", channelAware: false, value: 50 });
        expect(req).toEqual({ url: "http://10.0.0.5/set?value=50" });
        expect(req.channel).toBeUndefined();
      });
    });

    describe("channel-aware fleet", () => {
      it("addresses a single-value device by its channel, encoding booleans as 1/0", () => {
        expect(buildSetRequests({ ip, category: "light", channelAware: true, value: true })).toEqual([
          { url: "http://10.0.0.5/set?ch=power&value=1", channel: "power" },
        ]);
        expect(buildSetRequests({ ip, category: "dimmable-light", channelAware: true, value: 50 })).toEqual([
          { url: "http://10.0.0.5/set?ch=brightness&value=50", channel: "brightness" },
        ]);
      });

      it("emits one request per CHANGED cooler channel only", () => {
        const reqs = buildSetRequests({
          ip,
          category: "evap-cooler",
          channelAware: true,
          previous: { fan: false, water: false, target: 26 },
          value: { fan: true, water: false, target: 24 },
        });
        // fan changed (→1) and target changed (→24); water unchanged is omitted.
        expect(reqs).toEqual([
          { url: "http://10.0.0.5/set?ch=fan&value=1", channel: "fan" },
          { url: "http://10.0.0.5/set?ch=target&value=24", channel: "target" },
        ]);
      });

      it("emits nothing when no cooler channel changed", () => {
        expect(
          buildSetRequests({
            ip,
            category: "evap-cooler",
            channelAware: true,
            previous: { fan: true, water: true, target: 26 },
            value: { fan: true, water: true, target: 26 },
          }),
        ).toEqual([]);
      });

      it("emits nothing for a camera (no writable channels)", () => {
        expect(buildSetRequests({ ip, category: "camera", channelAware: true, value: null })).toEqual([]);
      });
    });
  });

  describe("channel value codec (Stage 4)", () => {
    it("reads a single-channel device's scalar value", () => {
      expect(channelValue("light", "power", true)).toBe(true);
      expect(channelValue("dimmable-light", "brightness", 42)).toBe(42);
    });

    it("reads a cooler sub-channel out of the blob", () => {
      const blob = { fan: true, water: false, target: 26, "room-temp": 29.5, "unit-temp": 31 };
      expect(channelValue("evap-cooler", "fan", blob)).toBe(true);
      expect(channelValue("evap-cooler", "room-temp", blob)).toBe(29.5);
    });

    it("reads temperature/humidity out of the t:h string", () => {
      expect(channelValue("temp/humidity", "temperature", "23.5:10.5")).toBe(23.5);
      expect(channelValue("temp/humidity", "humidity", "23.5:10.5")).toBe(10.5);
    });

    it("returns undefined for an unknown channel", () => {
      expect(channelValue("light", "brightness", true)).toBeUndefined();
    });

    it("round-trips read↔write for a cooler sub-channel without mutating input", () => {
      const blob = { fan: false, water: false, target: 26 };
      const next = withChannelValue("evap-cooler", blob, "fan", true);
      expect(next).toEqual({ fan: true, water: false, target: 26 });
      expect(blob.fan).toBe(false); // input untouched
      expect(channelValue("evap-cooler", "fan", next)).toBe(true);
    });

    it("writes a single-channel device value as the scalar itself", () => {
      expect(withChannelValue("dimmable-light", 0, "brightness", 80)).toBe(80);
    });

    it("rebuilds the t:h string when writing one temp/humidity channel", () => {
      expect(withChannelValue("temp/humidity", "23.5:10.5", "temperature", 24)).toBe("24:10.5");
    });
  });

  describe("presence-relay combo node (one node, presence sensor + relay actuator)", () => {
    it("projects both channels with their roles out of the blob", () => {
      const channels = deviceToChannels({
        id: "pr1",
        deviceCategory: "presence-relay",
        value: { presence: true, relay: false },
      });
      expect(channels).toEqual([
        { key: "presence", role: "sensor", kind: "boolean", writable: false, value: true },
        { key: "relay", role: "actuator", kind: "boolean", writable: true, value: false },
      ]);
    });

    it("writing the presence sub-value never clobbers the co-located relay", () => {
      const blob = { presence: false, relay: true };
      const next = withChannelValue("presence-relay", blob, "presence", true);
      expect(next).toEqual({ presence: true, relay: true });
      expect(blob.presence).toBe(false); // input untouched
      expect(channelValue("presence-relay", "relay", next)).toBe(true);
    });

    it("only the writable relay channel is actuated, encoded 1/0", () => {
      const reqs = buildSetRequests({
        ip: "10.0.0.5",
        category: "presence-relay",
        channelAware: true,
        previous: { presence: true, relay: false },
        value: { presence: true, relay: true },
      });
      // presence is a sensor (not writable) → never sent; relay changed → 1.
      expect(reqs).toEqual([{ url: "http://10.0.0.5/set?ch=relay&value=1", channel: "relay" }]);
    });
  });
});
