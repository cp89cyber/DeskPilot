import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { validateWorkflowResult } from "../../src/codex/schemas.js";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

function schemaTypeIncludes(schema: Record<string, unknown>, typeName: string): boolean {
  const type = schema.type;
  return type === typeName || (Array.isArray(type) && type.includes(typeName));
}

function assertObjectRequiredProperties(schema: unknown, location: string): void {
  if (!schema || typeof schema !== "object") {
    return;
  }

  const record = schema as Record<string, unknown>;
  const properties =
    record.properties && typeof record.properties === "object"
      ? (record.properties as Record<string, unknown>)
      : undefined;

  if (properties && schemaTypeIncludes(record, "object")) {
    expect(record.required, location).toEqual(Object.keys(properties));
  }

  if (properties) {
    for (const [key, value] of Object.entries(properties)) {
      assertObjectRequiredProperties(value, `${location}.${key}`);
    }
  }

  const items = record.items;
  if (items) {
    assertObjectRequiredProperties(items, `${location}[]`);
  }
}

describe("workflow JSON schemas", () => {
  it("requires every property on every object schema", () => {
    for (const fileName of [
      "daily-brief.json",
      "document-summary.json",
      "inbox-triage.json",
      "schedule-plan.json",
    ]) {
      const schema = JSON.parse(
        fs.readFileSync(path.join(repoRoot, "schemas", fileName), "utf8"),
      ) as unknown;

      assertObjectRequiredProperties(schema, fileName);
    }
  });

  it("normalizes nullable structured-output fields to undefined", () => {
    const inbox = validateWorkflowResult("inbox", {
      overview: "No urgent mail.",
      urgentThreads: [],
      replyRecommendations: [
        {
          threadId: "thread-1",
          recommendation: "No reply needed.",
          stagedActionId: null,
        },
      ],
      followUps: [
        {
          title: "Review budget",
          dueAt: null,
          status: "open",
          sourceRefs: ["thread:thread-1"],
        },
      ],
      stagedActionIds: [],
      sourceRefs: ["thread:thread-1"],
    }) as {
      replyRecommendations: Array<{ stagedActionId?: string }>;
      followUps: Array<{ dueAt?: string }>;
    };

    expect(inbox.replyRecommendations[0]?.stagedActionId).toBeUndefined();
    expect(inbox.followUps[0]?.dueAt).toBeUndefined();

    const schedule = validateWorkflowResult("schedule", {
      needsClarification: true,
      clarifyingQuestion: "Who should attend?",
      summary: null,
      proposedSlots: null,
      draftInvitation: null,
      stagedActionId: null,
      sourceRefs: [],
    }) as {
      summary?: string;
      proposedSlots?: unknown[];
      draftInvitation?: unknown;
      stagedActionId?: string;
    };

    expect(schedule.summary).toBeUndefined();
    expect(schedule.proposedSlots).toBeUndefined();
    expect(schedule.draftInvitation).toBeUndefined();
    expect(schedule.stagedActionId).toBeUndefined();
  });
});
