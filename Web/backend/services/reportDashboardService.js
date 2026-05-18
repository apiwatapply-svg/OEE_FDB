const dayjs = require("dayjs");
const { PrismaClient } = require("@prisma/client");
const fs = require("fs");
const path = require("path");
const { sumHourlyFields } = require("./oeeCalcService");
const { groupActualRowsByMachineAndDate, sumActualTotal } = require("./actualOutputService");

const prisma = new PrismaClient();
const TH_OFFSET_MS = 7 * 60 * 60 * 1000;

const SHIFT_HOURS = [
    "07", "08", "09", "10", "11", "12", "13", "14", "15", "16", "17", "18",
    "19", "20", "21", "22", "23", "00", "01", "02", "03", "04", "05", "06",
];

const SHIFT_A_HOURS = ["07", "08", "09", "10", "11", "12", "13", "14"];
const SHIFT_B_HOURS = ["15", "16", "17", "18", "19", "20", "21", "22"];
const SHIFT_C_HOURS = ["23", "00", "01", "02", "03", "04", "05", "06"];

const RUNTIME_STATUS = "Run_Time";
const STATUS_CONFIG_PATH = path.join(__dirname, "../config/machine_status.json");
let cachedStatusConfig = null;

function loadStatusConfig() {
    if (cachedStatusConfig) return cachedStatusConfig;
    cachedStatusConfig = JSON.parse(fs.readFileSync(STATUS_CONFIG_PATH, "utf8"));
    return cachedStatusConfig;
}

function getTypeStatusConfig(machineType, config = loadStatusConfig()) {
    return config.machineTypes?.[machineType] || config.default || { statuses: [], reportGroups: [] };
}

function getReportGroupsForMachines(machines, config = loadStatusConfig()) {
    const merged = new Map();
    const machineTypes = [...new Set(machines.map((machine) => machine.machine_type).filter(Boolean))];
    const typeConfigs = machineTypes.length
        ? machineTypes.map((machineType) => getTypeStatusConfig(machineType, config))
        : [config.default];

    for (const typeConfig of typeConfigs) {
        for (const group of typeConfig.reportGroups || []) {
            if (!merged.has(group.key)) merged.set(group.key, group);
        }
    }

    return [...merged.values()];
}

function buildStatusResolverByMachine(machines, config = loadStatusConfig()) {
    const resolver = new Map();
    for (const machine of machines) {
        const typeConfig = getTypeStatusConfig(machine.machine_type, config);
        const statuses = new Map((typeConfig.statuses || []).map((status) => [status.key, status]));
        resolver.set(machine.machine_name, { typeConfig, statuses });
    }
    return resolver;
}

function resolveStatusReportInfo(row, resolverByMachine) {
    const machineResolver = resolverByMachine.get(row.MC);
    const statusDef = machineResolver?.statuses?.get(row.MCStatus);

    if (statusDef?.reportGroup) return statusDef.reportGroup;
    if (statusDef?.group === "running" || row.MCStatus === RUNTIME_STATUS) return "runtime";
    if (statusDef?.group === "excluded") return "excluded";
    if (statusDef?.group === "offline") return "offline";
    return null;
}

function createEmptyDowntime(reportGroups, fillValue = 0) {
    return Object.fromEntries(reportGroups.map((group) => [group.key, fillValue]));
}

function normalizeDateKey(date) {
    return dayjs(date).format("YYYY-MM-DD");
}

function monthKey(date) {
    return dayjs(date).format("YYYY-MM");
}

function getDbLocalNow(now = new Date()) {
    return new Date(new Date(now).getTime() + TH_OFFSET_MS);
}

function getCurrentShiftDateKey(now = new Date()) {
    const dbNow = getDbLocalNow(now);
    if (dbNow.getUTCHours() < 7) dbNow.setUTCDate(dbNow.getUTCDate() - 1);
    return dbNow.toISOString().slice(0, 10);
}

function isFutureDay(bucketKey, today = new Date()) {
    return bucketKey > getCurrentShiftDateKey(today);
}

function isFutureMonth(bucketKey, today = new Date()) {
    return bucketKey > getCurrentShiftDateKey(today).slice(0, 7);
}

function effectiveMonthDays(bucketKey, today = new Date()) {
    if (isFutureMonth(bucketKey, today)) return 0;
    const bucketStart = dayjs(`${bucketKey}-01`).startOf("month");
    const currentDay = dayjs(today);
    if (bucketStart.isSame(currentDay, "month")) return currentDay.date();
    return bucketStart.daysInMonth();
}

function perDay(total, days) {
    if (!days) return 0;
    return Number((Number(total || 0) / days).toFixed(2));
}

function sumValues(rows, field) {
    return rows.reduce((total, row) => total + Number(row[field] || 0), 0);
}

function avgValues(rows, field) {
    const values = rows.map((row) => Number(row[field] || 0)).filter((value) => value > 0);
    if (values.length === 0) return 0;
    return values.reduce((total, value) => total + value, 0) / values.length;
}

function createMachineFilter({ area, type, machine }) {
    const where = { status: "active" };
    if (area && area !== "all") where.machine_area = area;
    if (type && type !== "all") where.machine_type = type;
    if (machine && machine !== "ALL" && machine !== "all") where.machine_name = machine;
    return where;
}

async function getMachines(filters) {
    return prisma.tbm_machine.findMany({
        where: createMachineFilter(filters),
        select: { machine_name: true, machine_area: true, machine_type: true },
        orderBy: { machine_name: "asc" },
    });
}

async function getReportRows(machineNames, startDate, endDate) {
    const where = {
        machine_name: { in: machineNames },
        date: { gte: startDate, lte: endDate },
    };

    return Promise.all([
        prisma.tb_output_target.findMany({ where }),
        prisma.tb_output_actual.findMany({ where }),
        prisma.tb_cycle_time_actual.findMany({ where }),
        prisma.tb_availability_actual.findMany({ where }),
        prisma.tb_efficiency_actual.findMany({ where }),
        prisma.tb_oee.findMany({ where }),
    ]);
}

async function getStatusRows(machineNames, startTime, endTime) {
    const carryRows = await Promise.all(machineNames.map((machineName) => (
        prisma.tb_MCStatus.findFirst({
            where: { MC: machineName, Datetime: { lt: startTime } },
            orderBy: { Datetime: "desc" },
            select: { ID: true, MC: true, MCStatus: true, Datetime: true, Remark: true },
        })
    )));

    const rows = await prisma.tb_MCStatus.findMany({
        where: {
            MC: { in: machineNames },
            Datetime: { gte: startTime, lt: endTime },
        },
        orderBy: [{ MC: "asc" }, { Datetime: "asc" }, { ID: "asc" }],
        select: { ID: true, MC: true, MCStatus: true, Datetime: true, Remark: true },
    });

    return [...carryRows.filter(Boolean).map((row) => ({ ...row, Datetime: startTime, __isCarry: true })), ...rows];
}

function buildTimeBuckets(start, count, unit) {
    return Array.from({ length: count }, (_, index) => {
        const bucketStart = unit === "day" ? dayjs(start).add(index, "day") : dayjs(start).add(index, "month");
        const bucketEnd = unit === "day" ? bucketStart.add(1, "day") : bucketStart.add(1, "month");
        return {
            key: unit === "day" ? bucketStart.format("YYYY-MM-DD") : bucketStart.format("YYYY-MM"),
            label: unit === "day" ? String(bucketStart.date()) : bucketStart.format("MMM"),
            start: bucketStart.toDate(),
            end: bucketEnd.toDate(),
        };
    });
}

function buildShiftTimeBuckets(start, count, unit, today = new Date()) {
    const currentShiftKey = getCurrentShiftDateKey(today);
    const currentShiftMonth = currentShiftKey.slice(0, 7);
    const dbNow = getDbLocalNow(today);

    return Array.from({ length: count }, (_, index) => {
        const bucketStartKey = unit === "day"
            ? dayjs(start).add(index, "day").format("YYYY-MM-DD")
            : dayjs(start).add(index, "month").format("YYYY-MM");
        const bucketEndKey = unit === "day"
            ? dayjs(start).add(index + 1, "day").format("YYYY-MM-DD")
            : dayjs(start).add(index + 1, "month").format("YYYY-MM");
        const [startYear, startMonth, startDay = 1] = bucketStartKey.split("-").map(Number);
        const [endYear, endMonth, endDay = 1] = bucketEndKey.split("-").map(Number);
        const bucketStart = new Date(Date.UTC(startYear, startMonth - 1, startDay, 7, 0, 0));
        const bucketEnd = new Date(Date.UTC(endYear, endMonth - 1, endDay, 7, 0, 0));

        let effectiveEnd = bucketEnd;
        if (unit === "day") {
            if (bucketStartKey > currentShiftKey) effectiveEnd = bucketStart;
            else if (bucketStartKey === currentShiftKey) effectiveEnd = new Date(Math.min(bucketEnd.getTime(), dbNow.getTime()));
        } else {
            if (bucketStartKey > currentShiftMonth) effectiveEnd = bucketStart;
            else if (bucketStartKey === currentShiftMonth) effectiveEnd = new Date(Math.min(bucketEnd.getTime(), dbNow.getTime()));
        }

        return {
            key: bucketStartKey,
            label: unit === "day" ? String(Number(bucketStartKey.slice(8, 10))) : dayjs(`${bucketStartKey}-01`).format("MMM"),
            start: bucketStart,
            end: bucketEnd,
            effectiveEnd,
        };
    });
}

function getBucketBaseMinutes(bucket) {
    const bucketEnd = bucket.effectiveEnd || bucket.end;
    return Math.max(0, (bucketEnd.getTime() - bucket.start.getTime()) / 60000);
}

function addDurationToBuckets(bucketMap, start, end, reportGroup) {
    if ((!reportGroup || reportGroup === "excluded" || reportGroup === "offline") || end <= start) return;

    for (const bucket of bucketMap.values()) {
        const overlapStart = Math.max(start.getTime(), bucket.start.getTime());
        const bucketEnd = bucket.effectiveEnd || bucket.end;
        const overlapEnd = Math.min(end.getTime(), bucketEnd.getTime());
        if (overlapEnd > overlapStart) {
            const minutes = (overlapEnd - overlapStart) / 60000;
            if (reportGroup === "runtime") {
                bucket.runtimeMinutes += minutes;
            } else if (Object.prototype.hasOwnProperty.call(bucket.downtime, reportGroup)) {
                bucket.downtime[reportGroup] += minutes;
            }
        }
    }
}

function findBucketForTime(buckets, time) {
    for (const bucket of buckets) {
        if (time >= bucket.start && time < bucket.end) return bucket;
    }
    return null;
}

function compareStatusRows(a, b) {
    const timeDiff = new Date(a.Datetime).getTime() - new Date(b.Datetime).getTime();
    if (timeDiff !== 0) return timeDiff;
    const aId = a.ID == null ? 0n : BigInt(a.ID);
    const bId = b.ID == null ? 0n : BigInt(b.ID);
    if (aId === bId) return 0;
    return aId < bId ? -1 : 1;
}

function isSameStatusContinuation(current, previous, includeRemark = false) {
    if (current.__isCarry) return true;
    if (!previous) return false;
    if (previous.MC !== current.MC) return false;
    if (previous.MCStatus !== current.MCStatus) return false;
    if (!includeRemark) return true;
    return String(previous.Remark || "").trim() === String(current.Remark || "").trim();
}

function aggregateDowntime(statusRows, buckets, reportGroups, resolverByMachine) {
    const reportGroupKeys = new Set(reportGroups.map((group) => group.key));
    const bucketMap = new Map(buckets.map((bucket) => [bucket.key, {
        ...bucket,
        downtime: createEmptyDowntime(reportGroups),
        downtimeCounts: createEmptyDowntime(reportGroups),
        runtimeMinutes: 0,
    }]));
    const rowsByMachine = new Map();

    for (const row of statusRows) {
        if (!rowsByMachine.has(row.MC)) rowsByMachine.set(row.MC, []);
        rowsByMachine.get(row.MC).push(row);
    }

    for (const rows of rowsByMachine.values()) {
        rows.sort(compareStatusRows);
        for (let index = 0; index < rows.length; index += 1) {
            const current = rows[index];
            const next = rows[index + 1];
            const segmentStart = new Date(current.Datetime);
            const lastBucketEnd = buckets[buckets.length - 1].effectiveEnd || buckets[buckets.length - 1].end;
            const segmentEnd = next ? new Date(next.Datetime) : lastBucketEnd;
            const reportGroup = resolveStatusReportInfo(current, resolverByMachine);
            addDurationToBuckets(bucketMap, segmentStart, segmentEnd, reportGroup);

            if (reportGroup && reportGroupKeys.has(reportGroup) && !isSameStatusContinuation(current, rows[index - 1])) {
                const bucket = findBucketForTime(buckets, segmentStart);
                if (bucket) {
                    const agg = bucketMap.get(bucket.key);
                    if (agg) agg.downtimeCounts[reportGroup] += 1;
                }
            }
        }
    }

    return bucketMap;
}

function summarizeAlarmDowntimeFromStatus(statusRows, startTime, endTime, resolverByMachine, limit = 8) {
    const rowsByMachine = new Map();
    for (const row of statusRows) {
        if (!rowsByMachine.has(row.MC)) rowsByMachine.set(row.MC, []);
        rowsByMachine.get(row.MC).push(row);
    }

    const summary = new Map(); // alarmKey -> { alarm, count, minutes }
    const add = (alarmKey, minutes, countInc) => {
        const existing = summary.get(alarmKey) || { alarm: alarmKey, count: 0, minutes: 0 };
        existing.minutes += minutes;
        existing.count += countInc;
        summary.set(alarmKey, existing);
    };

    for (const rows of rowsByMachine.values()) {
        rows.sort(compareStatusRows);
        const groups = [];
        for (const row of rows) {
            const timeKey = new Date(row.Datetime).getTime();
            const last = groups[groups.length - 1];
            if (last && last.timeKey === timeKey) {
                last.rows.push(row);
            } else {
                groups.push({ timeKey, rows: [row] });
            }
        }

        let previousActiveAlarm = null;
        for (let index = 0; index < groups.length; index += 1) {
            const group = groups[index];
            const nextGroup = groups[index + 1];
            const segmentStart = new Date(group.timeKey);
            const segmentEndRaw = nextGroup ? new Date(nextGroup.timeKey) : endTime;

            const alarmRows = group.rows.filter((row) => {
                const reportGroup = resolveStatusReportInfo(row, resolverByMachine);
                return reportGroup === "mc_alarm" || reportGroup === "mc_error";
            });
            const hasBlockingStatus = group.rows.some((row) => {
                const reportGroup = resolveStatusReportInfo(row, resolverByMachine);
                return reportGroup !== "mc_alarm" && reportGroup !== "mc_error";
            });

            if (alarmRows.length === 0 || hasBlockingStatus) {
                previousActiveAlarm = null;
                continue;
            }

            const current = alarmRows[alarmRows.length - 1];
            const overlapStart = new Date(Math.max(segmentStart.getTime(), startTime.getTime()));
            const overlapEnd = new Date(Math.min(segmentEndRaw.getTime(), endTime.getTime()));
            if (overlapEnd <= overlapStart) {
                previousActiveAlarm = current;
                continue;
            }

            const minutes = (overlapEnd.getTime() - overlapStart.getTime()) / 60000;
            const alarmKey = current.Remark ? String(current.Remark).trim() : "Other";
            const countInc = (segmentStart >= startTime && segmentStart < endTime && !isSameStatusContinuation(current, previousActiveAlarm, true)) ? 1 : 0;
            add(alarmKey, minutes, countInc);
            previousActiveAlarm = current;
        }
    }

    const rows = [...summary.values()].sort((a, b) => b.minutes - a.minutes);
    if (rows.length <= limit) return rows.map((row) => ({
        alarm: row.alarm,
        count: row.count,
        minutes: Number(row.minutes.toFixed(2)),
    }));

    const top = rows.slice(0, limit - 1).map((row) => ({ ...row }));
    const rest = rows.slice(limit - 1);
    const otherTotal = rest.reduce((total, row) => ({
        alarm: "Other",
        count: total.count + row.count,
        minutes: total.minutes + row.minutes,
    }), { alarm: "Other", count: 0, minutes: 0 });
    if (otherTotal.minutes > 0 || otherTotal.count > 0) {
        const existingOther = top.find((row) => row.alarm === "Other");
        if (existingOther) {
            existingOther.count += otherTotal.count;
            existingOther.minutes += otherTotal.minutes;
        } else {
            top.push(otherTotal);
        }
    }
    const merged = top.sort((a, b) => b.minutes - a.minutes);
    return merged.map((row) => ({
        alarm: row.alarm,
        count: row.count,
        minutes: Number(row.minutes.toFixed(2)),
    }));
}

function aggregateDailyRows({ buckets, targets, actuals, cycles, avails, effs, oees }) {
    const actualRowsByMachineDate = groupActualRowsByMachineAndDate(actuals, normalizeDateKey);

    return buckets.map((bucket) => {
        const targetRows = targets.filter((row) => normalizeDateKey(row.date) === bucket.key);
        const cycleRows = cycles.filter((row) => normalizeDateKey(row.date) === bucket.key);
        const availRows = avails.filter((row) => normalizeDateKey(row.date) === bucket.key);
        const effRows = effs.filter((row) => normalizeDateKey(row.date) === bucket.key);
        const oeeRows = oees.filter((row) => normalizeDateKey(row.date) === bucket.key);
        const actualTotal = Object.values(actualRowsByMachineDate).reduce((total, rowsByDate) => {
            return total + sumActualTotal(rowsByDate[bucket.key] || [], SHIFT_HOURS);
        }, 0);
        const outputA = Object.values(actualRowsByMachineDate).reduce((total, rowsByDate) => {
            return total + sumActualTotal(rowsByDate[bucket.key] || [], SHIFT_A_HOURS);
        }, 0);
        const outputB = Object.values(actualRowsByMachineDate).reduce((total, rowsByDate) => {
            return total + sumActualTotal(rowsByDate[bucket.key] || [], SHIFT_B_HOURS);
        }, 0);
        const outputC = Object.values(actualRowsByMachineDate).reduce((total, rowsByDate) => {
            return total + sumActualTotal(rowsByDate[bucket.key] || [], SHIFT_C_HOURS);
        }, 0);
        const hasTargetRows = targetRows.length > 0;

        return {
            key: bucket.key,
            label: bucket.label,
            output: actualTotal,
            outputA,
            outputB,
            outputC,
            outputTarget: hasTargetRows
                ? (sumValues(targetRows, "accum_target") || targetRows.reduce((total, row) => total + sumHourlyFields(row, "target", SHIFT_HOURS), 0))
                : null,
            availability: avgValues(availRows, "avail_actual") || avgValues(effRows, "eff_actual") || avgValues(oeeRows, "availability"),
            efficiencyTarget: hasTargetRows ? avgValues(targetRows, "eff_target") : null,
            cycleTime: avgValues(cycleRows, "cycle_time"),
            cycleTimeTarget: hasTargetRows ? avgValues(targetRows, "cycle_time_target") : null,
            performance: avgValues(oeeRows, "performance"),
            quality: avgValues(oeeRows, "quality"),
            oee: avgValues(oeeRows, "oee_value"),
        };
    });
}

function emptyFutureMonth(bucket) {
    return {
        key: bucket.key,
        label: bucket.label,
        output: null,
        outputA: null,
        outputB: null,
        outputC: null,
        outputTarget: null,
        outputPerDay: null,
        outputPerDayA: null,
        outputPerDayB: null,
        outputPerDayC: null,
        outputTargetPerDay: null,
        availability: null,
        efficiencyTarget: null,
        cycleTime: null,
        cycleTimeTarget: null,
        performance: null,
        quality: null,
        oee: null,
    };
}

function aggregateMonthlyRows({ buckets, targets, actuals, cycles, avails, effs, oees }, today = new Date()) {
    const actualRowsByMachineDate = groupActualRowsByMachineAndDate(actuals, normalizeDateKey);

    let lastOutputTargetPerDay = null;
    let lastEfficiencyTarget = null;
    let lastCycleTarget = null;

    const rows = [];

    for (const bucket of buckets) {
        const future = isFutureMonth(bucket.key, today);
        const monthDaysForTarget = dayjs(`${bucket.key}-01`).daysInMonth();

        if (future) {
            const row = emptyFutureMonth(bucket);
            if (lastOutputTargetPerDay != null) {
                row.outputTargetPerDay = lastOutputTargetPerDay;
                row.outputTarget = Number((lastOutputTargetPerDay * monthDaysForTarget).toFixed(0));
            }
            if (lastEfficiencyTarget != null) row.efficiencyTarget = lastEfficiencyTarget;
            if (lastCycleTarget != null) row.cycleTimeTarget = lastCycleTarget;
            rows.push(row);
            continue;
        }

        const targetRows = targets.filter((row) => monthKey(row.date) === bucket.key);
        const cycleRows = cycles.filter((row) => monthKey(row.date) === bucket.key);
        const availRows = avails.filter((row) => monthKey(row.date) === bucket.key);
        const effRows = effs.filter((row) => monthKey(row.date) === bucket.key);
        const oeeRows = oees.filter((row) => monthKey(row.date) === bucket.key);
        const actualEntries = Object.values(actualRowsByMachineDate).flatMap((rowsByDate) => {
            return Object.entries(rowsByDate).filter(([dateKey]) => monthKey(dateKey) === bucket.key);
        });
        const hasReportData = targetRows.length > 0 || cycleRows.length > 0 || availRows.length > 0 || effRows.length > 0 || oeeRows.length > 0 || actualEntries.length > 0;
        if (!hasReportData) continue;

        const output = Object.values(actualRowsByMachineDate).reduce((total, rowsByDate) => {
            return total + Object.entries(rowsByDate).reduce((dateTotal, [dateKey, rows]) => {
                return monthKey(dateKey) === bucket.key ? dateTotal + sumActualTotal(rows, SHIFT_HOURS) : dateTotal;
            }, 0);
        }, 0);

        const outputA = Object.values(actualRowsByMachineDate).reduce((total, rowsByDate) => {
            return total + Object.entries(rowsByDate).reduce((dateTotal, [dateKey, rows]) => {
                return monthKey(dateKey) === bucket.key ? dateTotal + sumActualTotal(rows, SHIFT_A_HOURS) : dateTotal;
            }, 0);
        }, 0);

        const outputB = Object.values(actualRowsByMachineDate).reduce((total, rowsByDate) => {
            return total + Object.entries(rowsByDate).reduce((dateTotal, [dateKey, rows]) => {
                return monthKey(dateKey) === bucket.key ? dateTotal + sumActualTotal(rows, SHIFT_B_HOURS) : dateTotal;
            }, 0);
        }, 0);

        const outputC = Object.values(actualRowsByMachineDate).reduce((total, rowsByDate) => {
            return total + Object.entries(rowsByDate).reduce((dateTotal, [dateKey, rows]) => {
                return monthKey(dateKey) === bucket.key ? dateTotal + sumActualTotal(rows, SHIFT_C_HOURS) : dateTotal;
            }, 0);
        }, 0);

        const hasTargetRows = targetRows.length > 0;
        let outputTargetPerDay = null;
        if (hasTargetRows) {
            // ถ้านี่คือดูหลายเครื่องรวมกัน, Target/day ของทั้งแผนก = ผลรวมเป้าหมายทั้งหมดในเดือน / จำนวนวันที่มีการตั้งเป้าหมาย (หา distinct date)
            const distinctDatesWithTarget = new Set(targetRows.map(r => r.date.toISOString().slice(0, 10))).size;
            
            // ให้เอา "เป้าหมายรวมของทุกเครื่องในวันนั้นๆ" มาบวกกันก่อน เพื่อหาเป้าหมายเฉลี่ยต่อวันแบบรวมเครื่อง
            // ใช้ pc_target หรือผลรวมรายชั่วโมง แทน accum_target เพราะพบว่าใน DB ค่า accum_target เป็น 0 เกือบทุกวัน
            const sumTargets = targetRows.reduce((total, row) => total + (row.pc_target || sumHourlyFields(row, "target", SHIFT_HOURS)), 0);
            outputTargetPerDay = distinctDatesWithTarget > 0 ? Number((sumTargets / distinctDatesWithTarget).toFixed(2)) : null;
        }

        let efficiencyTarget = hasTargetRows ? avgValues(targetRows, "eff_target") : null;
        let cycleTimeTarget = hasTargetRows ? avgValues(targetRows, "cycle_time_target") : null;

        if (outputTargetPerDay != null && Number(outputTargetPerDay) > 0) lastOutputTargetPerDay = outputTargetPerDay;
        else if (lastOutputTargetPerDay != null) outputTargetPerDay = lastOutputTargetPerDay;

        if (efficiencyTarget != null && Number(efficiencyTarget) > 0) lastEfficiencyTarget = efficiencyTarget;
        else if (lastEfficiencyTarget != null) efficiencyTarget = lastEfficiencyTarget;

        if (cycleTimeTarget != null && Number(cycleTimeTarget) > 0) lastCycleTarget = cycleTimeTarget;
        else if (lastCycleTarget != null) cycleTimeTarget = lastCycleTarget;

        const monthDaysForOutput = effectiveMonthDays(bucket.key, today);
        let outputTarget = outputTargetPerDay != null ? Number((outputTargetPerDay * monthDaysForTarget).toFixed(0)) : null;

        rows.push({
            key: bucket.key,
            label: bucket.label,
            output,
            outputA,
            outputB,
            outputC,
            outputTarget,
            outputPerDay: perDay(output, monthDaysForOutput),
            outputPerDayA: perDay(outputA, monthDaysForOutput),
            outputPerDayB: perDay(outputB, monthDaysForOutput),
            outputPerDayC: perDay(outputC, monthDaysForOutput),
            outputTargetPerDay,
            availability: avgValues(availRows, "avail_actual") || avgValues(effRows, "eff_actual") || avgValues(oeeRows, "availability"),
            efficiencyTarget,
            cycleTime: avgValues(cycleRows, "cycle_time"),
            cycleTimeTarget,
            performance: avgValues(oeeRows, "performance"),
            quality: avgValues(oeeRows, "quality"),
            oee: avgValues(oeeRows, "oee_value"),
        });
    }

    return rows;
}

function getDistinctValues(rows, field) {
    return [...new Set(rows.map((row) => row[field]).filter((value) => value && value !== "--"))];
}

async function getDailyDashboard({ month, area = "all", type = "all", machine = "ALL", model = "all" }) {
    const monthStart = dayjs(month).startOf("month");
    const monthEnd = dayjs(month).endOf("month");
    const today = new Date();
    const machines = await getMachines({ area, type, machine });
    const machineNames = machines.map((item) => item.machine_name);
    const statusConfig = loadStatusConfig();
    const reportGroups = getReportGroupsForMachines(machines, statusConfig);
    if (machineNames.length === 0) return { filters: { month, area, type, machine, model }, machines: [], modelNames: [], days: [], alarmSummary: [], statusReportGroups: reportGroups };

    const [targets, actualsRaw, cycles, avails, effs, oees] = await getReportRows(machineNames, monthStart.toDate(), monthEnd.toDate());
    const actuals = model && model !== "all" ? actualsRaw.filter((row) => row.model_name === model) : actualsRaw;
    const buckets = buildShiftTimeBuckets(monthStart, monthEnd.date(), "day", today);
    const resolverByMachine = buildStatusResolverByMachine(machines, statusConfig);
    const statusStart = buckets[0].start;
    const statusEnd = buckets[buckets.length - 1].end;
    const statusRows = await getStatusRows(machineNames, statusStart, statusEnd);
    const downtimeMap = aggregateDowntime(statusRows, buckets, reportGroups, resolverByMachine);
    const alarmSummary = summarizeAlarmDowntimeFromStatus(statusRows, statusStart, statusEnd, resolverByMachine);

    const rawDays = aggregateDailyRows({ buckets, targets, actuals, cycles, avails, effs, oees }).map((day) => {
        const downtimeAgg = downtimeMap.get(day.key);
        const isFuture = isFutureDay(day.key, today);
        return {
            ...day,
            output: isFuture ? null : day.output,
            outputA: isFuture ? null : day.outputA,
            outputB: isFuture ? null : day.outputB,
            outputC: isFuture ? null : day.outputC,
            availability: isFuture ? null : day.availability,
            cycleTime: isFuture ? null : day.cycleTime,
            performance: isFuture ? null : day.performance,
            quality: isFuture ? null : day.quality,
            oee: isFuture ? null : day.oee,
            downtime: isFuture ? createEmptyDowntime(reportGroups, null) : (downtimeAgg?.downtime || createEmptyDowntime(reportGroups)),
            downtimeCounts: isFuture ? createEmptyDowntime(reportGroups, null) : (downtimeAgg?.downtimeCounts || createEmptyDowntime(reportGroups)),
            runtimeMinutes: isFuture ? null : (downtimeAgg?.runtimeMinutes || 0),
            statusBaseMinutes: isFuture ? null : getBucketBaseMinutes(downtimeAgg || day),
        };
    });

    let lastOutputTarget = null;
    let lastEfficiencyTarget = null;
    let lastCycleTarget = null;
    const days = rawDays.map((day) => {
        if (day.outputTarget != null && Number(day.outputTarget) > 0) lastOutputTarget = day.outputTarget;
        else if (lastOutputTarget != null) day.outputTarget = lastOutputTarget;

        if (day.efficiencyTarget != null && Number(day.efficiencyTarget) > 0) lastEfficiencyTarget = day.efficiencyTarget;
        else if (lastEfficiencyTarget != null) day.efficiencyTarget = lastEfficiencyTarget;

        if (day.cycleTimeTarget != null && Number(day.cycleTimeTarget) > 0) lastCycleTarget = day.cycleTimeTarget;
        else if (lastCycleTarget != null) day.cycleTimeTarget = lastCycleTarget;

        return day;
    });

    return {
        filters: { month, area, type, machine, model },
        machines,
        modelNames: getDistinctValues(actualsRaw, "model_name"),
        days,
        alarmSummary,
        statusReportGroups: reportGroups,
    };
}

async function getMonthlyDashboard({ year, area = "all", type = "all", machine = "ALL", model = "all" }) {
    const fiscalStart = dayjs(`${year}-04-01`).startOf("month");
    const fiscalEnd = fiscalStart.add(12, "month").subtract(1, "day");
    const today = new Date();
    const machines = await getMachines({ area, type, machine });
    const machineNames = machines.map((item) => item.machine_name);
    const statusConfig = loadStatusConfig();
    const reportGroups = getReportGroupsForMachines(machines, statusConfig);
    if (machineNames.length === 0) return { filters: { year, area, type, machine, model }, machines: [], modelNames: [], months: [], alarmSummary: [], statusReportGroups: reportGroups };

    const [targets, actualsRaw, cycles, avails, effs, oees] = await getReportRows(machineNames, fiscalStart.toDate(), fiscalEnd.toDate());
    const actuals = model && model !== "all" ? actualsRaw.filter((row) => row.model_name === model) : actualsRaw;
    const buckets = buildShiftTimeBuckets(fiscalStart, 12, "month", today);
    const resolverByMachine = buildStatusResolverByMachine(machines, statusConfig);
    const statusRows = await getStatusRows(machineNames, buckets[0].start, buckets[buckets.length - 1].end);
    const downtimeMap = aggregateDowntime(statusRows, buckets, reportGroups, resolverByMachine);
    const rawMonths = aggregateMonthlyRows({ buckets, targets, actuals, cycles, avails, effs, oees }, today).map((monthRow) => {
        const downtimeAgg = downtimeMap.get(monthRow.key);
        const future = isFutureMonth(monthRow.key, today);
        return {
            ...monthRow,
            downtime: future ? createEmptyDowntime(reportGroups, null) : (downtimeAgg?.downtime || createEmptyDowntime(reportGroups)),
            downtimeCounts: future ? createEmptyDowntime(reportGroups, null) : (downtimeAgg?.downtimeCounts || createEmptyDowntime(reportGroups)),
            runtimeMinutes: future ? null : (downtimeAgg?.runtimeMinutes || 0),
            statusBaseMinutes: future ? null : getBucketBaseMinutes(downtimeAgg || monthRow),
        };
    });

    let lastOutputTarget = null;
    let lastEfficiencyTarget = null;
    let lastCycleTarget = null;
    const months = rawMonths.map((monthRow) => {
        if (monthRow.outputTarget != null && Number(monthRow.outputTarget) > 0) lastOutputTarget = monthRow.outputTarget;
        else if (lastOutputTarget != null) monthRow.outputTarget = lastOutputTarget;

        if (monthRow.efficiencyTarget != null && Number(monthRow.efficiencyTarget) > 0) lastEfficiencyTarget = monthRow.efficiencyTarget;
        else if (lastEfficiencyTarget != null) monthRow.efficiencyTarget = lastEfficiencyTarget;

        if (monthRow.cycleTimeTarget != null && Number(monthRow.cycleTimeTarget) > 0) lastCycleTarget = monthRow.cycleTimeTarget;
        else if (lastCycleTarget != null) monthRow.cycleTimeTarget = lastCycleTarget;

        const monthStart = dayjs(`${monthRow.key}-01`).startOf("month");
        const monthDays = monthStart.daysInMonth();
        monthRow.outputTargetPerDay = monthRow.outputTarget == null ? null : perDay(monthRow.outputTarget, monthDays);
        return monthRow;
    });

    return {
        filters: { year, area, type, machine, model },
        machines,
        modelNames: getDistinctValues(actualsRaw, "model_name"),
        months,
        alarmSummary: [],
        statusReportGroups: reportGroups,
    };
}

module.exports = {
    getDailyDashboard,
    getMonthlyDashboard,
    __private: {
        aggregateMonthlyRows,
        aggregateDowntime,
        summarizeAlarmDowntimeFromStatus,
        buildShiftTimeBuckets,
        buildStatusResolverByMachine,
        getReportGroupsForMachines,
        getBucketBaseMinutes,
        getCurrentShiftDateKey,
        effectiveMonthDays,
        isFutureMonth,
        isFutureDay,
        perDay,
    },
};
