const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const root = __dirname;
const html = fs.readFileSync(path.join(root, "Демо.html"), "utf8");
const config = JSON.parse(fs.readFileSync(path.join(root, "planning-inputs.json"), "utf8"));
const embedded = id => JSON.parse(html.match(new RegExp(`<script id="${id}" type="application/json">([^]*?)<\\/script>`))[1]);
const data = embedded("model-data"), settings = embedded("planning-settings");
assert.equal(html.includes("__MODEL_DATA__"), false);
assert.equal(settings.as_of, config.as_of);
assert.deepEqual(settings.basin_demo, config.basin_demo);
assert.deepEqual(settings.calendar, config.calendar);
assert.equal(settings.horizon_quarters, config.forecast?.horizon_quarters ?? 4);
for (const [id,value] of Object.entries({capacity:config.basin_demo.capacity_Mt_per_quarter,
  repair:config.basin_demo.repair_loss_Mt,reserve:config.basin_demo.reserve_Mt,asof:config.as_of,
  "reserve-lead":config.calendar.reserve_lead_calendar_days,"repair-lead":config.calendar.repair_move_lead_calendar_days})) {
  assert.equal(html.match(new RegExp(`id="${id}" value="([^"]+)"`))[1], String(value));
}
assert.equal(/id="movable" checked/.test(html), config.basin_demo.allow_move);
const engine = html.match(/<script id="scenario-engine">([^]*?)<\/script>/)[1];
const ctx = vm.createContext({}); vm.runInContext(engine, ctx);
const common = config.basin_demo;
const rows = fs.readFileSync(path.join(root, "scenario-grid.csv"), "utf8").trim().split(/\r?\n/).slice(1);
assert.equal(rows.length, 363);
for (const row of rows) {
  const [basin, cap, shift, ...expected] = row.split(",");
  const result = ctx.compareScenario(data[basin].loads, +cap, +shift, common.repair_loss_Mt, common.reserve_Mt, common.allow_move);
  for (const option of result.options) {
    const column = {b0:0,h1:1,h2:2}[option.id];
    assert.ok(Math.abs(option.gap - +expected[column]) < 1e-5, row);
  }
  if (!common.allow_move) assert.equal(expected[2], "");
}
let forecastChecks = 0;
for (const model of Object.values(data)) {
  assert.equal(model.history.length, 18); assert.equal(model.forecasts.length, 4);
  for (let horizon=1; horizon<=4; horizon++) {
    const selected = ctx.forecastWindow(model, horizon);
    assert.equal(selected.length, horizon);
    assert.equal(ctx.planningCovered(model,horizon), horizon===4);
    const row = selected.at(-1), reference = model.history.find(r=>r.period===row.source_period);
    assert.equal(row.value, reference.value); assert.equal(row.source_value, reference.value);
    assert.equal(row.source_url, reference.source_url); assert.equal(row.published_on, reference.published_on);
    const [year,quarter]=row.period.split("-Q").map(Number);
    assert.equal(row.source_period, `${year-1}-Q${quarter}`);
    forecastChecks++;
  }
  assert.throws(()=>ctx.forecastWindow(model,0)); assert.throws(()=>ctx.forecastWindow(model,5));
}
assert.equal(ctx.decisionDeadline("2027-Q1",90), "2026-10-03");
const boundary = ctx.permissions(data.azov.periods,data.azov.loads,68,0,4,"2026-10-03",45,90,true);
const expired = ctx.permissions(data.azov.periods,data.azov.loads,68,0,4,"2026-10-04",45,90,true);
assert.equal(boundary.moveAllowed,true); assert.equal(expired.moveAllowed,false);
const rules = ctx.permissions(data.azov.periods,data.azov.loads,68,0,4,"2026-11-12",45,90,true);
assert.equal(rules.moveAllowed,false); assert.equal(rules.reserveAllowed,true);
assert.equal(ctx.compareScenario(data.azov.loads,68,0,4,3,false,true).code,"h1");
assert.equal(ctx.compareScenario(data.baltic.loads,68,-5,4,3,false,false).code,"b0");
for (const script of html.matchAll(/<script(?: id="scenario-engine")?>([^]*?)<\/script>/g)) new vm.Script(script[1]);
console.log(`363 scenarios, ${forecastChecks} forecast horizons, shared defaults and calendar boundaries passed.`);
