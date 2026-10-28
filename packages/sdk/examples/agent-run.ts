// Ask Desyn's agent to restyle a design and follow its events live (Server-Sent Events).
// Run: DESYN_API_KEY=dsk_… pnpm tsx examples/agent-run.ts <designId> "Make it feel more premium"
import { DesynClient } from "@desyn/sdk";

const [designId, goal = "Make it feel more premium. Keep the product photo and the price."] =
  process.argv.slice(2);
if (!designId) throw new Error("usage: agent-run.ts <designId> [goal]");

const desyn = new DesynClient({
  ...(process.env.DESYN_API_URL ? { baseUrl: process.env.DESYN_API_URL } : {}),
});
const run = await desyn.agent.start(designId, { goal });
console.log(`Run ${run.id} started`);

for await (const event of desyn.agent.events(run.id)) {
  if (event.type === "tool-call") console.log("→", event.tool);
  else if (event.type === "text") process.stdout.write(String(event.text));
  else if (event.type === "question") {
    console.log(`\n? ${event.question}`);
    // Answer automatically with the first option; a real integration would ask the user.
    const options = (event.options as string[] | undefined) ?? [];
    await desyn.agent.answer(run.id, options[0] ?? "Yes");
  } else if (event.type === "done") console.log(`\nDone: ${event.summary}`);
}

const finished = await desyn.agent.get(run.id);
console.log(`Status ${finished.status}, ${finished.costCredits} credits`);
