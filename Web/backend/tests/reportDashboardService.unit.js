const assert = require("node:assert/strict");

const { __private } = require("../services/reportDashboardService");

assert.equal(__private.isFutureMonth("2026-06", "2026-05-08"), true);
assert.equal(__private.isFutureMonth("2026-05", "2026-05-08"), false);
assert.equal(__private.isFutureMonth("2026-04", "2026-05-08"), false);

assert.equal(__private.effectiveMonthDays("2026-04", "2026-05-08"), 30);
assert.equal(__private.effectiveMonthDays("2026-05", "2026-05-08"), 8);
assert.equal(__private.effectiveMonthDays("2026-06", "2026-05-08"), 0);

const monthlyRows = __private.aggregateMonthlyRows({
    buckets: [
        { key: "2026-04", label: "Apr" },
        { key: "2026-06", label: "Jun" },
    ],
    targets: [{ date: new Date("2026-04-01"), accum_target: 300, pc_target: 300, target_07: 300, eff_target: 95, cycle_time_target: 10 }],
    actuals: [],
    cycles: [],
    avails: [],
    effs: [],
    oees: [],
}, "2026-05-08");
assert.deepEqual(monthlyRows.map((row) => row.key), ["2026-04", "2026-06"]);
assert.equal(monthlyRows[0].outputTargetPerDay, 300);
assert.equal(monthlyRows[1].outputTargetPerDay, 300);
assert.equal(monthlyRows[1].availability, null);

console.log("reportDashboardService unit tests passed");
