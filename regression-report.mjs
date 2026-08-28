import { runRegressionGate } from './server.mjs';

const results = runRegressionGate();
const matches = results.filter((result) => result.match);
const mismatches = results.filter((result) => !result.match);

console.log(`04 regression: ${matches.length}/${results.length} совпали`);
for (const result of mismatches) {
  console.log(`${result.id}: expected ${result.expected.rule}/${result.expected.action}, actual ${result.actual ? `${result.actual.rule}/${result.actual.action}` : 'no rule'}`);
}

if (mismatches.length) process.exitCode = 1;