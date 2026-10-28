import { checkContentLinks, formatProblems } from "../src/lib/link-check.ts";

/** Source-level link check over every MDX page (no server needed). Exits 1 on any broken link. */
const report = await checkContentLinks();
if (report.problems.length > 0) {
  console.error(formatProblems(report.problems));
  console.error(`\n${report.problems.length} broken link(s) in ${report.pages} pages.`);
  process.exit(1);
}
console.log(`All ${report.links} links in ${report.pages} pages resolve.`);
