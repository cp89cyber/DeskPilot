import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

describe("compiled CLI", () => {
  it(
    "builds and prints help without loading SQLite at startup",
    () => {
      execFileSync(npmCommand, ["run", "build"], {
        cwd: repoRoot,
        stdio: "pipe",
      });

      const output = execFileSync(
        process.execPath,
        [path.join(repoRoot, "dist", "cli.js"), "--help"],
        {
          cwd: repoRoot,
          encoding: "utf8",
        },
      );

      expect(output).toContain("DeskPilot: a Codex-CLI-based office agent");
      expect(output).toContain("setup");
      expect(output).toContain("followups");
    },
    60000,
  );
});
