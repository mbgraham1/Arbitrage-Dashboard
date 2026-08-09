import { describe, it, expect } from "vitest";
import { thinFireSnapshot, thinFireFromExecResult } from "./auto-thin-fire";

// Threshold: 0.1% of trade size (the default settings.thinEdgeWarnPct).
const base = {
  isDryRun: false,
  thinEdgeWarnPct: 0.1,
  description: "USD→BTC→SOL→USD",
  at: 1_000_000,
};

describe("thinFireSnapshot (shared OB/TRI/graph AUTO thin-edge predicate)", () => {
  it("returns a snapshot for a LIVE fire below the threshold", () => {
    // 0.1% of $50 = $0.05 — $0.01 profit is razor-thin.
    const snap = thinFireSnapshot({ ...base, profitUsd: 0.01, tradeSizeUsd: 50 });
    expect(snap).toEqual({
      profitUsd: 0.01,
      tradeSizeUsd: 50,
      description: base.description,
      at: base.at,
    });
  });

  it("returns null for a LIVE fire at or above the threshold", () => {
    expect(thinFireSnapshot({ ...base, profitUsd: 0.05, tradeSizeUsd: 50 })).toBeNull(); // exactly at
    expect(thinFireSnapshot({ ...base, profitUsd: 0.5, tradeSizeUsd: 50 })).toBeNull(); // comfortably above
  });

  it("NEVER returns a snapshot for a dry run, regardless of profit", () => {
    expect(thinFireSnapshot({ ...base, isDryRun: true, profitUsd: 0.0001, tradeSizeUsd: 50 })).toBeNull();
    expect(thinFireSnapshot({ ...base, isDryRun: true, profitUsd: -1, tradeSizeUsd: 10 })).toBeNull();
    expect(thinFireSnapshot({ ...base, isDryRun: true, profitUsd: 0, tradeSizeUsd: 10 })).toBeNull();
  });

  it("warns on a live fire with negative estimated profit (worse than thin)", () => {
    const snap = thinFireSnapshot({ ...base, profitUsd: -0.02, tradeSizeUsd: 10 });
    expect(snap).not.toBeNull();
    expect(snap!.profitUsd).toBe(-0.02);
  });

  it("returns null when trade size is missing or invalid (no divide-by-zero banners)", () => {
    expect(thinFireSnapshot({ ...base, profitUsd: 0.01, tradeSizeUsd: null })).toBeNull();
    expect(thinFireSnapshot({ ...base, profitUsd: 0.01, tradeSizeUsd: undefined })).toBeNull();
    expect(thinFireSnapshot({ ...base, profitUsd: 0.01, tradeSizeUsd: 0 })).toBeNull();
    expect(thinFireSnapshot({ ...base, profitUsd: 0.01, tradeSizeUsd: -5 })).toBeNull();
  });

  it("returns null when profit is missing (rejected before an estimate was computed)", () => {
    expect(thinFireSnapshot({ ...base, profitUsd: null, tradeSizeUsd: 50 })).toBeNull();
    expect(thinFireSnapshot({ ...base, profitUsd: undefined, tradeSizeUsd: 50 })).toBeNull();
  });

  it("respects a trader-tuned threshold", () => {
    // 1% of $10 = $0.10 — $0.08 is thin at 1% but fine at 0.1%.
    expect(thinFireSnapshot({ ...base, thinEdgeWarnPct: 1, profitUsd: 0.08, tradeSizeUsd: 10 })).not.toBeNull();
    expect(thinFireSnapshot({ ...base, thinEdgeWarnPct: 0.1, profitUsd: 0.08, tradeSizeUsd: 10 })).toBeNull();
  });
});

describe("thinFireFromExecResult (post-execution gate — banner only after real orders)", () => {
  const thinLive = { ...base, profitUsd: 0.001, tradeSizeUsd: 25 };

  it("returns a snapshot only when success && executed on a thin LIVE result", () => {
    const snap = thinFireFromExecResult({ ...thinLive, success: true, executed: true });
    expect(snap).toEqual({
      profitUsd: 0.001,
      tradeSizeUsd: 25,
      description: base.description,
      at: base.at,
    });
  });

  it("NEVER warns when the preflight rejected the attempt (no orders placed)", () => {
    // r.success=true but executed=false is the OB endpoint's preflight-rejection shape.
    expect(thinFireFromExecResult({ ...thinLive, success: true, executed: false })).toBeNull();
    expect(thinFireFromExecResult({ ...thinLive, success: false, executed: false })).toBeNull();
    expect(thinFireFromExecResult({ ...thinLive, success: false, executed: true })).toBeNull();
  });

  it("NEVER warns on executed dry runs, regardless of profit", () => {
    expect(thinFireFromExecResult({ ...thinLive, success: true, executed: true, isDryRun: true })).toBeNull();
  });

  it("applies the same thin-edge threshold to executed live results", () => {
    // 0.1% of $25 = $0.025 — at/above the threshold never warns.
    expect(thinFireFromExecResult({ ...base, success: true, executed: true, profitUsd: 0.025, tradeSizeUsd: 25 })).toBeNull();
    expect(thinFireFromExecResult({ ...base, success: true, executed: true, profitUsd: 1, tradeSizeUsd: 25 })).toBeNull();
  });

  it("returns null when the result lacks profit or trade size", () => {
    expect(thinFireFromExecResult({ ...base, success: true, executed: true, profitUsd: null, tradeSizeUsd: 25 })).toBeNull();
    expect(thinFireFromExecResult({ ...base, success: true, executed: true, profitUsd: 0.001, tradeSizeUsd: null })).toBeNull();
  });
});
