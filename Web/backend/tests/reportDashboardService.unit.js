const assert = require("node:assert/strict");
const dayjs = require("dayjs");

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

const abrMachines = [{ machine_name: "ABR-003", machine_type: "ABR" }];
const abrReportGroups = __private.getReportGroupsForMachines(abrMachines);
const abrResolver = __private.buildStatusResolverByMachine(abrMachines);
const abrBuckets = __private.buildShiftTimeBuckets(dayjs("2026-05-18").startOf("month"), 31, "day", new Date("2026-05-18T04:00:00.000Z"));
const abrStatusRows = [
    { MC: "ABR-003", MCStatus: "Plan_Stop", Datetime: new Date(Date.UTC(2026, 4, 18, 7, 0, 0)) },
    { MC: "ABR-003", MCStatus: "MC_Alarm", Remark: "RCON SOFT ALARM", Datetime: new Date(Date.UTC(2026, 4, 18, 8, 0, 0)) },
    { MC: "ABR-003", MCStatus: "MC_Error", Remark: "LDIN Support Tray Load Close", Datetime: new Date(Date.UTC(2026, 4, 18, 8, 10, 0)) },
    { MC: "ABR-003", MCStatus: "MC_Error", Remark: "LDIN Support Tray Load Close", Datetime: new Date(Date.UTC(2026, 4, 18, 8, 12, 0)) },
    { MC: "ABR-003", MCStatus: "Pick_NG", Datetime: new Date(Date.UTC(2026, 4, 18, 8, 15, 0)) },
    { MC: "ABR-003", MCStatus: "Wait_Part", Datetime: new Date(Date.UTC(2026, 4, 18, 8, 25, 0)) },
    { MC: "ABR-003", MCStatus: "Signal_Lost", Datetime: new Date(Date.UTC(2026, 4, 18, 8, 45, 0)) },
    { MC: "ABR-003", MCStatus: "Run_Time", Datetime: new Date(Date.UTC(2026, 4, 18, 9, 0, 0)) },
    { MC: "ABR-003", MCStatus: "MM_Repair", Datetime: new Date(Date.UTC(2026, 4, 18, 9, 45, 0)) },
    { MC: "ABR-003", MCStatus: "Run_Time", Datetime: new Date(Date.UTC(2026, 4, 18, 10, 0, 0)) },
];
const abrDowntimeMap = __private.aggregateDowntime(abrStatusRows, abrBuckets, abrReportGroups, abrResolver);
const abrMay18 = abrDowntimeMap.get("2026-05-18");

assert.equal(abrMay18.runtimeMinutes, 105);
assert.equal(abrMay18.downtime.mc_alarm, 10);
assert.equal(abrMay18.downtime.mc_error, 5);
assert.equal(abrMay18.downtime.maintenance, 15);
assert.equal(abrMay18.downtime.pick_ng, 10);
assert.equal(abrMay18.downtime.wait_part, 20);
assert.equal(abrMay18.downtime.offline, undefined);
assert.equal(abrMay18.downtime.adjust, 0);
assert.equal(abrMay18.downtimeCounts.mc_alarm, 1);
assert.equal(abrMay18.downtimeCounts.mc_error, 1);
assert.equal(abrMay18.downtimeCounts.maintenance, 1);
assert.equal(abrMay18.downtimeCounts.pick_ng, 1);
assert.equal(abrMay18.downtimeCounts.wait_part, 1);
assert.equal(abrMay18.downtimeCounts.offline, undefined);
assert.equal(abrMay18.downtimeCounts.adjust, 0);
assert.equal(__private.getBucketBaseMinutes(abrMay18), 240);
assert.equal(__private.getBucketBaseMinutes(abrMay18, 6), 1440);

const ahvMachines = [
    { machine_name: "AHV-001", machine_type: "AHV" },
    { machine_name: "AHV-002", machine_type: "AHV" },
];
const ahvReportGroups = __private.getReportGroupsForMachines(ahvMachines);
const ahvResolver = __private.buildStatusResolverByMachine(ahvMachines);
const ahvBuckets = __private.buildShiftTimeBuckets(dayjs("2026-05-11").startOf("month"), 31, "day", new Date("2026-05-12T00:00:00.000Z"));
const ahvStatusRows = [
    { MC: "AHV-001", MCStatus: "MC_Stop", Datetime: new Date(Date.UTC(2026, 4, 11, 7, 0, 0)) },
    { MC: "AHV-001", MCStatus: "Setter_Adjust", Datetime: new Date(Date.UTC(2026, 4, 11, 8, 0, 0)) },
    { MC: "AHV-001", MCStatus: "QC_Qualify", Datetime: new Date(Date.UTC(2026, 4, 11, 8, 30, 0)) },
    { MC: "AHV-001", MCStatus: "QC_Check_Master", Datetime: new Date(Date.UTC(2026, 4, 11, 8, 45, 0)) },
    { MC: "AHV-001", MCStatus: "Prod_Cleaning", Datetime: new Date(Date.UTC(2026, 4, 11, 9, 0, 0)) },
    { MC: "AHV-001", MCStatus: "Prod_Check_Master", Datetime: new Date(Date.UTC(2026, 4, 11, 9, 10, 0)) },
    { MC: "AHV-001", MCStatus: "Wait_Part", Datetime: new Date(Date.UTC(2026, 4, 11, 9, 20, 0)) },
    { MC: "AHV-001", MCStatus: "Cut_Lot", Datetime: new Date(Date.UTC(2026, 4, 11, 9, 30, 0)) },
    { MC: "AHV-001", MCStatus: "MC_Alarm", Datetime: new Date(Date.UTC(2026, 4, 11, 9, 40, 0)) },
    { MC: "AHV-001", MCStatus: "Run_Time", Datetime: new Date(Date.UTC(2026, 4, 11, 9, 50, 0)) },
    { MC: "AHV-002", MCStatus: "MC_Stop", Datetime: new Date(Date.UTC(2026, 4, 11, 7, 0, 0)) },
    { MC: "AHV-002", MCStatus: "Run_Time", Datetime: new Date(Date.UTC(2026, 4, 11, 9, 0, 0)) },
];
const ahvDowntimeMap = __private.aggregateDowntime(ahvStatusRows, ahvBuckets, ahvReportGroups, ahvResolver);
const ahvMay11 = ahvDowntimeMap.get("2026-05-11");
assert.equal(ahvReportGroups.some((group) => group.key === "machine_stop"), false);
assert.equal(ahvMay11.downtime.machine_stop, undefined);
assert.equal(ahvMay11.downtime.adjust, 30);
assert.equal(ahvMay11.downtime.qc_qualify, 30);
assert.equal(ahvMay11.downtime.prod_cleaning, 10);
assert.equal(ahvMay11.downtime.prod_check_master, 10);
assert.equal(ahvMay11.downtime.wait_part, 10);
assert.equal(ahvMay11.downtime.cut_lot, 10);
assert.equal(ahvMay11.downtime.mc_alarm, 10);
assert.equal(__private.getBucketBaseMinutes(ahvMay11, ahvMachines.length), 2880);
assert.equal(Number(((ahvMay11.downtime.qc_qualify / __private.getBucketBaseMinutes(ahvMay11, ahvMachines.length)) * 100).toFixed(2)), 1.04);

const abrAlarmSummary = __private.summarizeAlarmDowntimeFromStatus(
    abrStatusRows,
    new Date(Date.UTC(2026, 4, 18, 7, 0, 0)),
    new Date(Date.UTC(2026, 4, 18, 11, 0, 0)),
    abrResolver
);
assert.deepEqual(abrAlarmSummary, [
    { alarm: "RCON SOFT ALARM", count: 1, minutes: 10 },
    { alarm: "LDIN Support Tray Load Close", count: 1, minutes: 5 },
]);

const sameTimestampRows = [
    { ID: 1n, MC: "ABR-003", MCStatus: "MC_Error", Remark: "Blocked alarm", Datetime: new Date(Date.UTC(2026, 4, 18, 8, 0, 0)) },
    { ID: 2n, MC: "ABR-003", MCStatus: "Run_Time", Datetime: new Date(Date.UTC(2026, 4, 18, 8, 0, 0)) },
    { ID: 3n, MC: "ABR-003", MCStatus: "Run_Time", Datetime: new Date(Date.UTC(2026, 4, 18, 9, 0, 0)) },
];
assert.deepEqual(__private.summarizeAlarmDowntimeFromStatus(
    sameTimestampRows,
    new Date(Date.UTC(2026, 4, 18, 7, 0, 0)),
    new Date(Date.UTC(2026, 4, 18, 10, 0, 0)),
    abrResolver
), []);

const carryRows = [
    { MC: "ABR-003", MCStatus: "MC_Error", Remark: "Yesterday alarm", Datetime: new Date(Date.UTC(2026, 4, 18, 7, 0, 0)), __isCarry: true },
    { MC: "ABR-003", MCStatus: "MC_Error", Remark: "Yesterday alarm", Datetime: new Date(Date.UTC(2026, 4, 18, 8, 0, 0)) },
    { MC: "ABR-003", MCStatus: "Run_Time", Datetime: new Date(Date.UTC(2026, 4, 18, 9, 0, 0)) },
];
const carryDowntimeMap = __private.aggregateDowntime(carryRows, abrBuckets, abrReportGroups, abrResolver);
const carryMay18 = carryDowntimeMap.get("2026-05-18");
assert.equal(carryMay18.downtime.mc_error, 120);
assert.equal(carryMay18.downtimeCounts.mc_error, 0);

const carryAlarmSummary = __private.summarizeAlarmDowntimeFromStatus(
    carryRows,
    new Date(Date.UTC(2026, 4, 18, 7, 0, 0)),
    new Date(Date.UTC(2026, 4, 18, 10, 0, 0)),
    abrResolver
);
assert.deepEqual(carryAlarmSummary, [
    { alarm: "Yesterday alarm", count: 0, minutes: 120 },
]);

console.log("reportDashboardService unit tests passed");
