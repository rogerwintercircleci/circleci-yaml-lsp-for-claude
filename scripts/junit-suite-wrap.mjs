#!/usr/bin/env node
//
// junit-suite-wrap.mjs — make Node's JUnit output parseable by CircleCI.
//
// Node's built-in `--test-reporter=junit` emits <testcase> elements directly under
// the root <testsuites> for top-level test() calls (no intermediate <testsuite>).
// CircleCI's JUnit parser rejects that ("invalid testsuites element: testcase").
// This wraps the loose testcases in a single <testsuite>. Idempotent: a no-op if a
// <testsuite> is already present.
//
// Usage: junit-suite-wrap.mjs <path-to-junit.xml>

import { readFileSync, writeFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  process.stderr.write("usage: junit-suite-wrap.mjs <junit.xml>\n");
  process.exit(2);
}

let xml = readFileSync(file, "utf8");

if (/<testsuite[\s>]/.test(xml)) process.exit(0); // already wrapped

const tests = (xml.match(/<testcase[\s>]/g) || []).length;
const failures = (xml.match(/<failure[\s>]/g) || []).length;
const errors = (xml.match(/<error[\s>]/g) || []).length;

xml = xml
  .replace("<testsuites>", `<testsuites>\n\t<testsuite name="node:test" tests="${tests}" failures="${failures}" errors="${errors}">`)
  .replace("</testsuites>", "\t</testsuite>\n</testsuites>");

writeFileSync(file, xml);
process.stderr.write(`[junit-suite-wrap] wrapped ${tests} testcase(s) in a <testsuite> (failures=${failures}, errors=${errors})\n`);
