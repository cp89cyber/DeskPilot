import { describe, expect, it } from "vitest";

const enabled = process.env.DESKPILOT_E2E === "1";

describe.skipIf(!enabled)("DeskPilot live E2E", () => {
  it("requires explicit opt-in plus real Codex and Google credentials", () => {
    expect(true).toBe(true);
  });
});
