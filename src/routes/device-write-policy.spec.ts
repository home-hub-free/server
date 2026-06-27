// The manual-lock boundary for actuation writes. The agent reaches the hub through the same
// /device-update door as a dashboard user (manualTrigger, which bypasses all conditions), so the
// only thing standing between an autonomous inference and a user's manual override is this policy:
// "is there a human behind THIS write?" Dashboard/user-command writes win; agent-initiative writes
// respect the lock. See device-routes.decideWritePolicy.
import { decideWritePolicy } from "./device-write-policy";

describe("decideWritePolicy — manual-lock boundary", () => {
  describe("a human is behind the write → bypass + latch", () => {
    it("dashboard tap on a locked device actuates and (re)latches", () => {
      expect(decideWritePolicy({ source: "dashboard", nodeManual: true })).toEqual({ skip: false, latch: true });
    });

    it("dashboard tap on an unlocked device latches (grabs the wheel)", () => {
      expect(decideWritePolicy({ source: "dashboard", nodeManual: false })).toEqual({ skip: false, latch: true });
    });

    it("agent relaying a user command (onBehalfOf:user) wins over a manual lock — a spoken command IS the user", () => {
      expect(decideWritePolicy({ source: "voice", onBehalfOf: "user", nodeManual: true })).toEqual({ skip: false, latch: true });
      expect(decideWritePolicy({ source: "llm", onBehalfOf: "user", nodeManual: true })).toEqual({ skip: false, latch: true });
    });
  });

  describe("no human behind the write (agent initiative) → respect the lock, never latch", () => {
    it("agent initiative on a LOCKED device is skipped", () => {
      expect(decideWritePolicy({ source: "llm", onBehalfOf: "agent", nodeManual: true })).toEqual({ skip: true, latch: false });
    });

    it("absent onBehalfOf is treated as agent initiative (safe default for an un-updated gateway)", () => {
      expect(decideWritePolicy({ source: "llm", nodeManual: true })).toEqual({ skip: true, latch: false });
      expect(decideWritePolicy({ source: "voice", nodeManual: true })).toEqual({ skip: true, latch: false });
    });

    it("agent initiative on an UNLOCKED device actuates but does not grab the wheel", () => {
      expect(decideWritePolicy({ source: "llm", onBehalfOf: "agent", nodeManual: false })).toEqual({ skip: false, latch: false });
    });
  });

  describe("a `setting`-role channel (e.g. cooler target) is a setpoint, not an actuator override", () => {
    it("never lock-gated, even for agent initiative on a locked cooler", () => {
      expect(decideWritePolicy({ source: "llm", onBehalfOf: "agent", nodeManual: true, channelRole: "setting" })).toEqual({
        skip: false,
        latch: false,
      });
    });

    it("never latches, even for a dashboard write (would freeze the closed loop)", () => {
      expect(decideWritePolicy({ source: "dashboard", nodeManual: false, channelRole: "setting" })).toEqual({
        skip: false,
        latch: false,
      });
    });
  });
});
