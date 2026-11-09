const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const root = __dirname;
const html = fs.readFileSync(path.join(root, "Демо.html"), "utf8");
const data = JSON.parse(html.match(/<script id="model-data" type="application\/json">([^]*?)<\/script>/)[1]);
const engine = html.match(/<script id="scenario-engine">([^]*?)<\/script>/)[1];
const ctx = vm.createContext({});
vm.runInContext(engine, ctx);
const rows = fs.readFileSync(path.join(root, "scenario-grid.csv"), "utf8").trim().split(/\r?\n/).slice(1);
assert.equal(rows.length, 363);
for (const row of rows) {
  const [basin, cap, shift, ...expected] = row.split(",");
  const result = ctx.compareScenario(data[basin].loads, +cap, +shift, 4, 3, true);
  result.options.forEach((option, i) => assert.ok(Math.abs(option.gap - +expected[i]) < 1e-5, row));
}
assert.equal(ctx.decisionDeadline("2027-Q1", 90), "2026-10-03");
const rules = ctx.permissions(data.azov.periods, data.azov.loads, 68, 0, 4, "2026-11-09", 45, 90, true);
assert.equal(rules.moveAllowed, false);
assert.equal(rules.reserveAllowed, true);
const qualified = ctx.compareScenario(data.azov.loads, 68, 0, 4, 3, rules.moveAllowed, rules.reserveAllowed);
assert.equal(qualified.code, "h1");
assert.equal(ctx.compareScenario(data.azov.loads, 68, 0, 4, 3, false, false).code, "check");
assert.equal(ctx.compareScenario(data.baltic.loads, 68, -5, 4, 3, false, false).code, "b0");
for (const text of html.matchAll(/<script(?: id="scenario-engine")?>([^]*?)<\/script>/g)) new vm.Script(text[1]);
console.log("363 Python/JavaScript scenarios and calendar boundary controls passed.");
