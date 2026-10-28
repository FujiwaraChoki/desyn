import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildThemeCss, buildVariablesCss } from "../src/css.ts";

const outputs = {
  "variables.css": buildVariablesCss(),
  "theme.css": buildThemeCss(),
};

for (const [name, css] of Object.entries(outputs)) {
  const target = fileURLToPath(new URL(`../src/${name}`, import.meta.url));
  writeFileSync(target, css);
  console.log(`wrote ${target}`);
}
