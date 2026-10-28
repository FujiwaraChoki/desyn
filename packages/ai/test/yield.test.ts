import type { TextNode } from "@desyn/schema";
import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../src/agent/events";
import { runAgent } from "../src/agent/run";
import { MemoryHost } from "../src/memory-host";
import { sampleDesign, scriptedAgentModel } from "./helpers";

// Hosts with a time limit (Convex actions) pause the loop between steps and continue it in a new call.
describe("runAgent yieldWhen", () => {
  it("pauses between steps without forcing finish, then resumes from the history", async () => {
    const { design, ids } = sampleDesign();
    const host = new MemoryHost(design);
    const first = scriptedAgentModel([
      { calls: [{ name: "read_design", input: {} }] },
      {
        calls: [
          { name: "update_elements", input: { updates: [{ id: ids.headline, fontSize: 72 }] } },
        ],
      },
    ]);
    const events: AgentEvent[] = [];
    let steps = 0;
    const paused = await runAgent({
      host,
      goal: "Make the headline bigger",
      model: first,
      maxSteps: 10,
      onEvent: (e) => {
        events.push(e);
        if (e.type === "step") steps++;
      },
      yieldWhen: () => steps >= 2,
    });
    expect(paused.status).toBe("yielded");
    expect(paused.steps).toBe(2);
    expect(events.some((e) => e.type === "done")).toBe(false);
    // The forced `finish` never ran: both steps used the full tool set.
    expect(first.doStreamCalls.every((c) => (c.tools?.length ?? 0) > 1)).toBe(true);
    expect((host.getDesign().nodes[ids.headline] as TextNode).style.fontSize).toBe(72);

    const second = scriptedAgentModel([
      { calls: [{ name: "finish", input: { summary: "Headline is 72 px now." } }] },
    ]);
    const history: ModelMessage[] = [
      { role: "user", content: "Make the headline bigger" },
      ...paused.responseMessages,
    ];
    const resumed = await runAgent({
      host,
      goal: "Continue.",
      model: second,
      history,
      maxSteps: 8,
    });
    expect(resumed.status).toBe("completed");
    expect(resumed.summary).toBe("Headline is 72 px now.");
    // The resumed call saw the earlier tool calls and results.
    const prompt = JSON.stringify(second.doStreamCalls[0]?.prompt);
    expect(prompt).toContain("update_elements");
    expect(prompt).toContain("Continue.");
  });

  it("is ignored when the step was a final answer", async () => {
    const { design } = sampleDesign();
    const host = new MemoryHost(design);
    const model = scriptedAgentModel([{ text: "Nothing to change." }]);
    const result = await runAgent({ host, goal: "Check it", model, yieldWhen: () => true });
    expect(result.status).toBe("completed");
    expect(result.summary).toBe("Nothing to change.");
  });
});
