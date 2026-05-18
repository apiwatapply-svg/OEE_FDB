/**
 * Real-time Service — InfluxDB Poller + Socket.IO
 * Fast Loop (2s): ดึง InfluxDB + Cache → คำนวณ Output, CT, Eff, Target, Achieve → emit
 * Slow Loop (5min): ดึง MSSQL → คำนวณ Availability, Performance, Quality, OEE → emit
 */
require("dotenv").config();
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const influxService = require("./influxService");
const cacheService = require("./cacheService");
const { getMachineStateMem, forceHourRolloverAll } = require("./mqttService"); // 🆕 Use MQTT Memory
const {
    getMachineRunTimeMode,
    calcMcStatusDurations,
    calcAvailability,
    calcPerformance,
    calcAutoOeeMetrics,
    getTargetDeductMode,
} = require("./oeeCalcService");
const {
    SHIFT_HOURS,
    utcHourToThColumn,
    getCurrentHourBoundaries,
    getShiftDateUTC,
    getElapsedSecondsInHour,
    getShiftIndex,
} = require("../utils/timeUtils");

let fastTimer = null;
let slowTimer = null;
// ✅ Worker Thread: Abstract emit functions (replaces ioInstance)
let emitFn = null;      // (room, event, data) => void
let broadcastFn = null; // (event, data) => void
// ✅ Fix #5: Delta update — track last emitted data per machine for dashboard
const lastEmittedData = new Map(); // key: machineName, value: { output, cycleTime }
const lastAutoEmittedData = new Map(); // 🆕 Track auto machine OEE changes
let lastOeeUpsertTime = 0; // 🆕 Throttle MSSQL writes

let machineModeCache = new Map(); // 🆕 Cached machine modes (auto/manual)
let sharedMcRecordsCache = {};    // 🆕 Shared MCStatus records between slow and fast loop
let autoNgCache = {
    data: {},              // current hour NG (จาก InfluxDB current hour)
    pendingPrevHour: {},   // 🆕 NG ชม.ก่อน รอ Cron (:10) confirm (bridge 10-min gap)
    lastHourColumn: null,  // 🆕 detect การเปลี่ยนชั่วโมง
    lastFetch: 0,
}; // 🆕 Cached NG counts for auto machines
let modeCacheTimer = null;

/**
 * Start real-time polling — 2 loops
 * @param {Function} _emitFn - (room, event, data) → emit to room
 * @param {Function} _broadcastFn - (event, data) → broadcast to all
 */
function startRealtimePolling(_emitFn, _broadcastFn) {
    emitFn = _emitFn;
    broadcastFn = _broadcastFn;
    const fastMs = parseInt(process.env.REALTIME_FAST_POLL_MS || "2000", 10);
    const slowMs = parseInt(process.env.REALTIME_SLOW_POLL_MS || "300000", 10);  // 🆕 ปรับ Default เป็น 5 นาที (300000) กลับสู่ปกติ

    // 🆕 ข้อมูล Mode เครื่องจักร (อัปเดตทุกๆ 2 นาทีโดยไม่กวนลูปความเร็วสูง)
    async function refreshModeCache() {
        try {
            const configs = await prisma.tb_machine_plan_config.findMany({ select: { machine_name: true, oee_mode: true } });
            const machines = await prisma.tbm_machine.findMany({ select: { machine_name: true, machine_type: true } });
            
            const fs = require("fs");
            const path = require("path");
            const machineCalcConfig = JSON.parse(fs.readFileSync(path.join(__dirname, "../config/machine_calc.json"), "utf-8"));
            const ngModes = machineCalcConfig.ng_modes || {};

            const typeMap = new Map(machines.map(m => [m.machine_name, m.machine_type]));
            
            machineModeCache = new Map(configs.map(c => {
                const mType = typeMap.get(c.machine_name) || "Unknown";
                const ngMode = ngModes[mType] || ngModes["default"] || "visual_ng";
                return [c.machine_name, { oee_mode: c.oee_mode || "manual", ng_mode: ngMode }];
            }));
        } catch(e) {}
        modeCacheTimer = setTimeout(refreshModeCache, 120000);
    }
    refreshModeCache();

    // ── Fast Loop (MQTT Memory + Cache → Production Data) ──
    async function fastLoop() {
        try {
            await fastPollAndEmit();
        } catch (e) {
            console.error("❌ Fast poll error:", e.message);
        }
        fastTimer = setTimeout(fastLoop, fastMs);
    }
    fastLoop();

    // ── Slow Loop (MSSQL → MCStatus + OEE) ──
    async function slowLoop() {
        try {
            await slowPollAndEmit();
        } catch (e) {
            console.error("❌ Slow poll error:", e.message);
        }
        slowTimer = setTimeout(slowLoop, slowMs);
    }
    slowLoop();

    // Server time broadcast (every 1s)
    setInterval(() => {
        if (broadcastFn) broadcastFn("server_time", new Date().toISOString());
    }, 1000);

    console.log(`📡 Real-time polling started: Fast=${fastMs}ms, Slow=${slowMs}ms (safe-loop)`);
}

function stopRealtimePolling() {
    if (fastTimer) { clearTimeout(fastTimer); fastTimer = null; }
    if (slowTimer) { clearTimeout(slowTimer); slowTimer = null; }
    if (modeCacheTimer) { clearTimeout(modeCacheTimer); modeCacheTimer = null; }
    console.log("📡 Real-time polling stopped");
}

// ═══════════════════════════════════════════════════════
// Fast Loop: InfluxDB + Cache → Production Data
// Query: 1 InfluxDB | Data: Cache (in-memory) | ไม่ Query MSSQL
// emit "realtime_output" ทุก 2 วินาที
// ═══════════════════════════════════════════════════════
async function fastPollAndEmit() {
    try {
        const now = new Date();
        const { dateStr, thColumn, start } = getCurrentHourBoundaries(now);
        const elapsedSeconds = getElapsedSecondsInHour(now);
        const currentShiftIndex = getShiftIndex(thColumn);

        // 🆕 [Phase 12] Force MQTT RAM to rollover at exactly xx:00
        // This ensures the previous hour is closed and pushed to Cache without waiting for a new message
        forceHourRolloverAll(thColumn);

        // 🆕 [Step 3] NG Cache: RAM (past) + pending + InfluxDB (current hour only)
        // — ฟังก์ชั่นนี้ทำแค่ current hour (ไม่ใช่ตั้งแต่ต้นกะอีกต่อไป)

        // 3a. Detect hour change → ย้าย currentHour → pendingPrevHour
        const prevHourColumn = autoNgCache.lastHourColumn;
        if (prevHourColumn && prevHourColumn !== thColumn) {
            // ชั่วโมงเปลี่ยน: บันทึก NG ชม.ที่แล้วไว้ รอ Cron :10 มา confirm
            autoNgCache.pendingPrevHour = { ...autoNgCache.data };
            autoNgCache.data = {}; // reset สำหรับชั่วโมงใหม่
        }
        autoNgCache.lastHourColumn = thColumn;

        // 3b. Auto-clear pendingPrevHour: ตรวจว่า Cron confirm ngCache แล้วหรือยัง
        // Cron เขียน prevHourColumn → ngCache แล้ว → isNgHourConfirmed = true → ล้าง pending
        if (prevHourColumn && Object.keys(autoNgCache.pendingPrevHour).length > 0) {
            const firstMachine = Object.keys(autoNgCache.pendingPrevHour)[0];
            if (cacheService.isNgHourConfirmed(firstMachine, prevHourColumn)) {
                autoNgCache.pendingPrevHour = {};
            }
        }

        // 3c. Fetch current hour NG from InfluxDB (เฉพาะ window เดียว ไม่ใช่ทั้งวัน)
        if (now.getTime() - autoNgCache.lastFetch > 10000) {
            autoNgCache.lastFetch = now.getTime();
            influxService.queryAllMachinesNgCount(start, now) // start = currentHourStart
                .then(data => {
                    // 🆕 Override raw InfluxDB count with True_NG from MQTT memory (which correctly filters unused stations)
                    const mem = getMachineStateMem();
                    for (const [machineName, state] of mem.entries()) {
                        if (state && state.current_hour_station_ng && state.current_hour_station_ng['True_NG'] !== undefined) {
                            data[machineName] = state.current_hour_station_ng['True_NG'];
                        }
                    }
                    autoNgCache.data = data;
                })
                .catch(e => console.error("Fast poll NG sync failed:", e.message));
        }

        // 1. Get current hour data from MQTT Memory
        const machineStateMem = getMachineStateMem();

        // Convert MQTT data format to match expected structure
        // ✅ Fix: Only use MQTT data if it matches the current hour
        // If the machine hasn't received a new message yet in this hour,
        // its memory still has old hour data → treat as 0
        const currentHourData = {};
        for (const [machineName, state] of machineStateMem.entries()) {
            const baseData = {
                live_status: state.live_status || null,
                live_alarm: state.live_alarm || null,
            };

            if (state.current_hour_label === thColumn) {
                currentHourData[machineName] = {
                    ...baseData,
                    output_count: state.current_hour_actual || 0,
                    avg_cycle_time: state.last_cycle_time || 0,
                    station_ng: state.current_hour_station_ng || {} // 🆕 Include station NG
                };
            } else {
                // MQTT memory still has old hour data — don't use it
                currentHourData[machineName] = {
                    ...baseData,
                    output_count: 0,
                    avg_cycle_time: 0,
                    station_ng: {} // 🆕
                };
            }
        }

        // 2. Combine machine names from Cache + MQTT
        const allCache = cacheService.getAllMachinesCache();
        const allMachineNames = new Set([
            ...Object.keys(allCache),
            ...Object.keys(currentHourData),
        ]);

        // 3. Build payload per machine — ใช้ Cache + InfluxDB เท่านั้น
        const dashboardMachines = {};
        const dashboardMachinesUpdate = {}; // 🆕 Update OEE เฉพาะ Auto Machine

        for (const machineName of allMachineNames) {
            const cached = cacheService.getFullDay(machineName);
            const currentData = currentHourData[machineName] || { output_count: 0, avg_cycle_time: 0 };

            // Calculate excluded seconds in current hour
            let currentHourExcluded = 0;
            const mcRecords = sharedMcRecordsCache[machineName] || [];
            if (mcRecords.length > 0) {
                const TH_OFFSET = 7 * 3600000;
                const startTH = new Date(new Date(start).getTime() + TH_OFFSET);
                const nowTH = new Date(now.getTime() + TH_OFFSET);
                const { excludedSeconds } = calcMcStatusDurations(mcRecords, startTH, nowTH);
                currentHourExcluded = excludedSeconds;
            }
            const adjustedElapsedSeconds = Math.max(0, elapsedSeconds - currentHourExcluded);

            // CT Fallback: ถ้า MQTT memory ยังไม่มี CT ชั่วโมงปัจจุบัน (ต้นชั่วโมง / server restart)
            // → ใช้ CT ชั่วโมงก่อนหน้า จาก cache หรือ cycle_time_target แทน
            const targetEntry = cacheService.getTarget(machineName);
            const targets = targetEntry?.target || {};
            const prevHour = currentShiftIndex > 0 ? SHIFT_HOURS[currentShiftIndex - 1] : null;
            const cachedPrevCt = (prevHour && cached) ? (cached.cycleTime[`cycle_${prevHour}`] || 0) : 0;
            const targetCt = targetEntry?.target?.cycle_time_target || 0;
            const effectiveCt = currentData.avg_cycle_time > 0
                ? currentData.avg_cycle_time
                : (cachedPrevCt > 0 ? cachedPrevCt : targetCt);

            // Current hour efficiency
            const theoreticalMax = effectiveCt > 0 && adjustedElapsedSeconds > 0
                ? adjustedElapsedSeconds / effectiveCt : 0;
            const currentEfficiency = theoreticalMax > 0
                ? (currentData.output_count / theoreticalMax) * 100 : 0;

            // Build hourly arrays: cache (past) + InfluxDB (current)
            const hourlyOutput = [];
            const hourlyCycleTime = [];
            const hourlyEfficiency = [];
            const hourlyOutputAccum = [];
            let accum = 0;

            for (let i = 0; i < SHIFT_HOURS.length; i++) {
                const h = SHIFT_HOURS[i];
                let out = 0, ct = 0, eff = 0;

                if (i < currentShiftIndex) {
                    // Past hours → from cache
                    out = cached ? (cached.output[`actual_${h}`] || 0) : 0;
                    ct = cached ? (cached.cycleTime[`cycle_${h}`] || 0) : 0;
                    eff = cached ? (cached.efficiency[`eff_${h}`] || 0) : 0;
                } else if (i === currentShiftIndex) {
                    // Current hour → from InfluxDB (CT with fallback to prev hour / target)
                    out = currentData.output_count;
                    // ✅ Fix: Show Cycle Time 0 visually if there is no output for the hour
                    ct = out > 0 ? parseFloat(effectiveCt.toFixed(2)) : 0;
                    eff = parseFloat(currentEfficiency.toFixed(2));
                }

                accum += out;
                hourlyOutput.push(out);
                hourlyCycleTime.push(ct);
                hourlyEfficiency.push(eff);
                hourlyOutputAccum.push(accum);
            }

            // Overall daily aggregates
            const totalOutput = accum;
            let sumCtWeighted = 0, totalOutputForCt = 0;

            for (let i = 0; i <= currentShiftIndex && i < SHIFT_HOURS.length; i++) {
                const out = hourlyOutput[i];
                const ct = hourlyCycleTime[i];
                if (out > 0 && ct > 0) {
                    sumCtWeighted += ct * out;
                    totalOutputForCt += out;
                }
            }

            const targetCtOverall = targets.cycle_time_target || 0;
            // 🆕 Fallback priority: 1. Real-time calculated -> 2. DB's Overall Daily Avg -> 3. Target CT
            // We prioritize the DB overall average over the single previous hour to match machine_report and layout_dashboard exactly.
            const prevOverallCt = cached?.overall?.avgCycleTime || 0;
            const overallAvgCt = totalOutputForCt > 0 
                ? sumCtWeighted / totalOutputForCt 
                : (prevOverallCt > 0 ? prevOverallCt : targetCtOverall);

            // Target & Achieve (from cache — no MSSQL)
            // Note: targetEntry and targets are already defined above for CT fallback

            // Overall efficiency — only count hours with target > 0
            let totalValidSeconds = 0;
            for (let i = 0; i <= currentShiftIndex && i < SHIFT_HOURS.length; i++) {
                const h = SHIFT_HOURS[i];
                const targetVal = targets[`target_${h}`] || 0;
                if (targetVal > 0) {
                    if (i < currentShiftIndex) {
                        totalValidSeconds += 3600;
                    } else {
                        // Current hour passed time (up to 3600s)
                        const mins = now.getMinutes();
                        const secs = now.getSeconds();
                        totalValidSeconds += (mins * 60) + secs;
                    }
                }
            }

            const overallTheoreticalMax = overallAvgCt > 0 ? totalValidSeconds / overallAvgCt : 0;
            const overallEff = overallTheoreticalMax > 0 ? (totalOutput / overallTheoreticalMax) * 100 : 0;

            // Accumulated target (pro-rated) — หัก Excluded time ตาม config
            const shouldDeductTarget = getTargetDeductMode(machineName);
            // pre-compute shiftDayStart สำหรับคำนวณรายชั่วโมง
            const { dateStr: shiftDateStr } = getCurrentHourBoundaries(now);
            const [sy, sm, sd] = shiftDateStr.split('-').map(Number);
            const shiftDayStart = new Date(Date.UTC(sy, sm - 1, sd, 0, 0, 0));

            let overallAccumTarget = 0;
            if (targetEntry && targetEntry.target) {
                for (let i = 0; i <= currentShiftIndex && i < SHIFT_HOURS.length; i++) {
                    const h = SHIFT_HOURS[i];
                    const targetVal = targets[`target_${h}`] || 0;
                    if (targetVal <= 0) continue; // ไม่มีแผนชั่วโมงนี้ → อย่าบวก

                    if (i < currentShiftIndex) {
                        // ชั่วโมงที่ผ่านมาแล้ว → คำนวณ excluded ต่อชั่วโมง (ถ้า config = true)
                        if (shouldDeductTarget && mcRecords.length > 0) {
                            const TH_OFFSET = 7 * 3600000;
                            const hourStart = new Date(shiftDayStart.getTime() + i * 3600000 + TH_OFFSET);
                            const hourEnd = new Date(hourStart.getTime() + 3600000);
                            const { excludedSeconds: hourExcluded } = calcMcStatusDurations(mcRecords, hourStart, hourEnd);
                            const ratio = hourExcluded > 0 ? Math.max(0, 3600 - hourExcluded) / 3600 : 1;
                            overallAccumTarget += Math.round(targetVal * ratio);
                        } else {
                            overallAccumTarget += targetVal;
                        }
                    } else {
                        // ชั่วโมงปัจจุบัน: ใช้ Effective Time (adjustedElapsedSeconds ที่หัก excluded แล้ว)
                        const ratio = Math.min(adjustedElapsedSeconds / 3600, 1);
                        overallAccumTarget += Math.round(targetVal * ratio);
                    }
                }
            }

            const overallAchieve = overallAccumTarget > 0 ? (totalOutput / overallAccumTarget) * 100 : 0;

            // 🆕 [Phase 7] Get Hourly Availability from Cache array
            const hourlyAvailability = cacheService.getAvailability(machineName);

            // 🛠️ Calculate Current Hour Availability dynamically for Fast Loop
            const totalHourSecs = Math.max(0, (now.getTime() - new Date(start).getTime()) / 1000);
            const modeRunTime = getMachineRunTimeMode(machineName);
            let currentHourRun = 0;
            if (modeRunTime === "output_based") {
                currentHourRun = currentData.output_count * parseFloat(effectiveCt.toFixed(2));
            } else {
                const mcRecords = sharedMcRecordsCache[machineName] || [];
                if (mcRecords.length > 0) {
                    const TH_OFFSET = 7 * 3600000;
                    const startTH = new Date(new Date(start).getTime() + TH_OFFSET);
                    const nowTH = new Date(now.getTime() + TH_OFFSET);
                    const { runTimeSeconds } = calcMcStatusDurations(mcRecords, startTH, nowTH);
                    currentHourRun = runTimeSeconds;
                }
            }
            const currentAvail = calcAvailability(currentHourRun, currentHourExcluded, totalHourSecs);
            if (currentShiftIndex < hourlyAvailability.length) {
                hourlyAvailability[currentShiftIndex] = parseFloat(currentAvail.toFixed(2));
            }

            // 🆕 Daily Availability สำหรับ output_based machines (real-time ทุก 2 วิ)
            // output_based ใช้ totalOutput × avgCT หารด้วย totalValidSeconds
            let dailyAvailability = undefined; // number | undefined
            if (modeRunTime === "output_based") {
                const avgCtForAvail = overallAvgCt > 0 ? overallAvgCt : (targets.cycle_time_target || 0);
                if (avgCtForAvail > 0 && totalValidSeconds > 0) {
                    const dailyRunTimeSecs = totalOutput * avgCtForAvail;
                    dailyAvailability = parseFloat(Math.min(100, (dailyRunTimeSecs / totalValidSeconds) * 100).toFixed(2));
                }
            }

            // Build full production payload
            const machinePayload = {
                currentHour: {
                    hour: thColumn,
                    shiftIndex: currentShiftIndex,
                    output: currentData.output_count,
                    // ✅ Fix: Only show Cycle Time if output > 0
                    cycleTime: currentData.output_count > 0 ? parseFloat(effectiveCt.toFixed(2)) : 0,
                    efficiency: parseFloat(currentEfficiency.toFixed(2)),
                    stationNg: currentData.station_ng || {}, // 🆕 Pass to frontend
                    live_status: currentData.live_status, // 🆕 Real-Time Status
                    live_alarm: currentData.live_alarm,   // 🆕 Real-Time Alarm
                },
                daily: {
                    totalOutput,
                    accumTarget: overallAccumTarget,
                    achieve: parseFloat(overallAchieve.toFixed(2)),
                    avgCycleTime: parseFloat(overallAvgCt.toFixed(2)),
                    overallEfficiency: parseFloat(overallEff.toFixed(2)),
                    // 🆕 availability สำหรับ output_based (ส่งทุก 2 วิ); ส่วน status_based รอ Slow Loop
                    ...(dailyAvailability !== undefined && { availability: dailyAvailability }),
                    hourly: {
                        output: hourlyOutput,
                        cycleTime: hourlyCycleTime,
                        efficiency: hourlyEfficiency,
                        availability: hourlyAvailability,
                        outputAccum: hourlyOutputAccum,
                    },
                },
            };

            // ── ส่งเฉพาะเครื่องที่มีคนดู (Room: "machine:<name>") — มี hourly arrays ──
            if (emitFn) {
                emitFn(`machine:${machineName}`, "realtime_output", {
                    serverTimeUTC: now.toISOString(),
                    shiftDate: dateStr,
                    currentHourTH: thColumn,
                    currentShiftIndex,
                    elapsedSeconds: adjustedElapsedSeconds,
                    machines: { [machineName]: machinePayload },
                });
            }

            // Dashboard: check for changes (delta update)
            // ✅ Fix #5: Only include machines whose key values changed
            // ✅ Bug fix: Also track shiftIndex — when hour changes, ALL machines must update
            const lastData = lastEmittedData.get(machineName);
            const currentOutput = machinePayload.daily.totalOutput;
            const currentCt = machinePayload.currentHour.cycleTime;
            const currentDailyCt = machinePayload.daily.avgCycleTime;
            const currentTarget = machinePayload.daily.accumTarget;
            const currentAchieve = machinePayload.daily.achieve;
            const currentStationNgStr = JSON.stringify(machinePayload.currentHour.stationNg); // 🆕 Convert to string for deep compare
            const currentStatus = machinePayload.currentHour.live_status;
            const currentAlarm = machinePayload.currentHour.live_alarm;
            // 🆕 Calculate current Availability matching float scale for delta check
            const currentAvailTruncated = parseFloat(currentAvail.toFixed(2));

            const hasChanged = !lastData ||
                lastData.output !== currentOutput ||
                lastData.cycleTime !== currentCt ||
                lastData.dailyCycleTime !== currentDailyCt ||
                lastData.accumTarget !== currentTarget ||
                lastData.achieve !== currentAchieve ||
                lastData.shiftIndex !== currentShiftIndex ||
                lastData.stationNgStr !== currentStationNgStr ||
                lastData.status !== currentStatus ||
                lastData.alarm !== currentAlarm ||
                lastData.availability !== currentAvailTruncated;

            if (hasChanged) {
                dashboardMachines[machineName] = machinePayload;
                lastEmittedData.set(machineName, {
                    output: currentOutput,
                    cycleTime: currentCt,
                    dailyCycleTime: currentDailyCt,
                    accumTarget: currentTarget,
                    achieve: currentAchieve,
                    shiftIndex: currentShiftIndex,
                    stationNgStr: currentStationNgStr, // 🆕 Store stringified state
                    status: currentStatus,
                    alarm: currentAlarm,
                    availability: currentAvailTruncated, // 🆕 Track numeric decay correctly
                });
            }

            // 🆕 [Phase 3] Auto Machine Real-Time OEE Calculation using In-Memory Stopwatch
            // ใช้ memoryOeeService.getDurationsNow() แทน calcMcStatusDurations() จาก MSSQL Cache
            // → A/P/Q/OEE อัปเดตทุก 2 วินาทีโดยไม่ Query MSSQL
            const mCacheConfig = machineModeCache.get(machineName) || {};
            if (mCacheConfig.oee_mode === "auto") {
                const memOeeService = require('./memoryOeeService');
                // ✅ [Bug Fix] ส่ง now (UTC ms) ตรงๆ — ไม่บวก +7h
                // lastStatusTime ใน State เก็บเป็น UTC ms (จาก new Date() ใน mqttService)
                // ถ้าบวก +7h → tickingSec ใหญ่เกิน 7 ชั่วโมง → A ≈ 100% ผิดพลาด

                // ✅ ดึงเวลาจาก Stopwatch RAM แทน MSSQL (Zero DB Load)
                let { runTimeSec: runTimeSeconds, excludedSec: excludedSeconds, totalSec: totalSeconds } = memOeeService.getDurationsNow(machineName, now);

                const targetEntry = cacheService.getTarget(machineName);
                const idealCT = targetEntry?.target?.cycle_time_target || 0;

                const modeRunTime = getMachineRunTimeMode(machineName);
                if (modeRunTime === "output_based") {
                    // AHV: ไม่ใช้ Stopwatch → ใช้ Output × AvgCT แทน
                    const avgToUse = overallAvgCt > 0 ? overallAvgCt : idealCT;
                    runTimeSeconds = totalOutput * avgToUse;
                }

                // 🆕 [Step 3d] NG total = RAM (past Cron-confirmed) + pending (bridge) + InfluxDB (current hour)
                const pastNg = cacheService.getNgPastHours(machineName);
                const pendingNg = autoNgCache.pendingPrevHour[machineName] || 0;
                const currentHourNg = autoNgCache.data[machineName] || 0;
                const ngQty = pastNg + pendingNg + currentHourNg;

                const availability = calcAvailability(runTimeSeconds, excludedSeconds, totalSeconds);
                const { performance, quality, oeeValue } = calcAutoOeeMetrics({
                    totalOutput,
                    ngQty,
                    availability,
                    idealCT,
                    runTimeSeconds,
                    ngMode: mCacheConfig.ng_mode,
                });

                const autoOeePayload = {
                    availability: parseFloat(availability.toFixed(2)),
                    performance,
                    quality,
                    oee: oeeValue,
                    over_reject_qty: mCacheConfig.ng_mode === "over_reject" ? ngQty : undefined,
                    ngQty: mCacheConfig.ng_mode === "over_reject" ? 0 : ngQty,
                    oeeMode: "auto"
                };

                const lastAutoData = lastAutoEmittedData.get(machineName);
                if (!lastAutoData ||
                    lastAutoData.oee !== autoOeePayload.oee ||
                    lastAutoData.availability !== autoOeePayload.availability ||
                    lastAutoData.performance !== autoOeePayload.performance ||
                    lastAutoData.quality !== autoOeePayload.quality ||
                    lastAutoData.ngQty !== autoOeePayload.ngQty ||
                    lastAutoData.over_reject_qty !== autoOeePayload.over_reject_qty ||
                    lastAutoData.status !== currentStatus) {

                    dashboardMachinesUpdate[machineName] = {
                        daily: autoOeePayload,
                        currentHour: { live_status: currentStatus }
                    };
                    lastAutoEmittedData.set(machineName, {
                        ...autoOeePayload,
                        status: currentStatus
                    });
                }
            }
        }

        // ── ส่งข้อมูลรวมให้ Dashboard (Room: "dashboard") ──
        // ✅ Fix #5: Only emit if there are changed machines (delta)
        if (emitFn && Object.keys(dashboardMachines).length > 0) {
            emitFn("dashboard", "realtime_output", {
                serverTimeUTC: now.toISOString(),
                shiftDate: dateStr,
                currentHourTH: thColumn,
                currentShiftIndex,
                elapsedSeconds, // For global backward compatibility, though individual machines use adjustedElapsedSeconds to compute theoretical max
                machines: dashboardMachines,
                isDelta: true, // ✅ Frontend should merge, not replace
            });
        }

        // ── ส่งข้อมูล OEE ของตัวลูก Auto (หลอกยิงจาก FastLoop) ทับ realtime_update ──
        if (broadcastFn && Object.keys(dashboardMachinesUpdate).length > 0) {
            broadcastFn("realtime_update", {
                serverTimeUTC: now.toISOString(),
                shiftDate: dateStr,
                machines: dashboardMachinesUpdate, // contains daily {availability, performance...}
            });
        }
    } catch (err) {
        console.error("❌ Fast poll error:", err.message);
    }
}

// Removed mcStatusCache and pushRealtimeMcStatus as they are no longer used

// ═══════════════════════════════════════════════════════
// Slow Loop: MSSQL only → MCStatus + Quality + OEE
// Query: 2 MSSQL queries (MCStatus + tb_oee) | ไม่ Query InfluxDB
// emit "realtime_update" ทุก 5 นาที
// ✅ Timeout protection: ไม่ให้ค้างเกิน 30 วินาที
// ═══════════════════════════════════════════════════════
async function slowPollAndEmit() {
    const TIMEOUT_MS = 30000;
    try {
        await Promise.race([
            _slowPollAndEmitInner(),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error("SlowPoll timeout (30s)")), TIMEOUT_MS)
            ),
        ]);
    } catch (err) {
        console.error("⚠️ [SlowPoll] timed out or failed:", err.message);
    }
}

async function _slowPollAndEmitInner() {
    try {
        const now = new Date();
        const { dateStr } = getCurrentHourBoundaries(now);

        const year = parseInt(dateStr.substring(0, 4));
        const month = parseInt(dateStr.substring(5, 7)) - 1;
        const day = parseInt(dateStr.substring(8, 10));
        const shiftStart = new Date(Date.UTC(year, month, day, 7, 0, 0));

        const TH_OFFSET_MS = 7 * 60 * 60 * 1000;
        const nowTH = new Date(now.getTime() + TH_OFFSET_MS);

        // ✅ Fix #1: Removing complex incremental cache because it causes late-arriving events
        // (MQTT latency, reconnects) to be completely dropped if inserted with retroactive Datetime.
        // Querying a single day's records takes <10ms and is fully cached by DB buffers.
        const todayMcStatus = await prisma.tb_MCStatus.findMany({
            where: { Datetime: { gte: shiftStart, lte: nowTH } },
            orderBy: { Datetime: "asc" },
            select: { MC: true, Datetime: true, MCStatus: true },
        });

        const carryOverRows = await prisma.$queryRaw`
            SELECT MC, MCStatus, Datetime FROM (
                SELECT MC, MCStatus, Datetime, ROW_NUMBER() OVER (PARTITION BY MC ORDER BY Datetime DESC) AS rn
                FROM tb_MCStatus WHERE Datetime < ${shiftStart}
            ) t WHERE rn = 1
        `;

        // Stale Carryover Guard: ถ้า carry-over เก่าเกิน 24h และไม่มี Status ใหม่วันนี้
        // → ไม่ใช้ carry-over นั้น (ป้องกัน Plan_Stop เก่าทำให้ excluded = total → A = 0)
        const STALE_CARRYOVER_MS = 24 * 60 * 60 * 1000; // 24 hours
        const machinesWithTodayStatus = new Set(todayMcStatus.map(r => r.MC));

        const mcStatusByMachine = {};
        for (const row of carryOverRows) {
            const carryoverAgeMs = shiftStart - new Date(row.Datetime);
            if (!machinesWithTodayStatus.has(row.MC) && carryoverAgeMs > STALE_CARRYOVER_MS) {
                // Stale carry-over with no today's records — skip to avoid false exclusion
                continue;
            }
            mcStatusByMachine[row.MC] = [{ MC: row.MC, Datetime: shiftStart, MCStatus: row.MCStatus }];
        }
        for (const rec of todayMcStatus) {
            if (!mcStatusByMachine[rec.MC]) mcStatusByMachine[rec.MC] = [];
            mcStatusByMachine[rec.MC].push(rec);
        }
        
        sharedMcRecordsCache = mcStatusByMachine; // ✅ Share updated status for fastLoop

        // 2. Query tb_oee for today (Quality data)
        const targetDate = new Date(dateStr);
        const oeeRows = await prisma.tb_oee.findMany({
            where: { date: targetDate },
            select: { machine_name: true, quality: true, oee_value: true, ng_qty: true },
        });
        const oeeByMachine = {};
        for (const row of oeeRows) {
            oeeByMachine[row.machine_name] = row;
        }

        // 2b. ใช้ machineModeCache จากลูปใหญ่แทนการ query ใหม่
        const modeMap = machineModeCache;

        // 2c. 🆕 NG ทั้งวัน = RAM (past hours) + pendingPrevHour (bridge) + InfluxDB current hour
        // ไม่ต้อง query InfluxDB แยกอีก — currentHourData ถูกดึงแล้วใน block ทัดไป (output)
        // autoNgCache สยะอยู่ใน Fast Loop แล้ว

        // 3. Build status payload — เฉพาะ Availability, Performance, Quality, OEE
        const machines = {};
        const allMachineNames = new Set([
            ...Object.keys(mcStatusByMachine),
            ...Object.keys(oeeByMachine),
        ]);

        // ✅ ดึง current hour output จาก InfluxDB เพื่อรวมใน Performance calculation
        const { start: currentHourStart } = getCurrentHourBoundaries(now);
        let currentHourData = {};
        try {
            currentHourData = await influxService.queryAllMachinesForHour(currentHourStart, now);
        } catch (e) {
            console.error("   ⚠️ Slow poll: failed to query InfluxDB for current hour:", e.message);
        }

        // ✅ Bulk-fetch target rows for ALL machines (1 query instead of N)
        const allTargetRows = await prisma.tb_output_target.findMany({ where: { date: targetDate } });
        const targetMap = {};
        for (const row of allTargetRows) targetMap[row.machine_name] = row;

        // ✅ Collect upsert operations (no DB calls in loop)
        const upsertOps = [];

        // ✅ Pre-fetch Actual rows as fallback if cache is missing (Crucial for output_based machines)
        const allActualRows = await prisma.tb_output_actual.findMany({ where: { date: targetDate } });
        // ✅ SUM ทุก model row เป็น fallback เมื่อ cache ว่าง (รองรับ multi-model per day)
        const actualSumMap = {};
        for (const row of allActualRows) {
            if (!actualSumMap[row.machine_name]) actualSumMap[row.machine_name] = {};
            for (const h of SHIFT_HOURS) {
                actualSumMap[row.machine_name][`actual_${h}`] =
                    (actualSumMap[row.machine_name][`actual_${h}`] || 0) + (row[`actual_${h}`] || 0);
            }
        }

        for (const machineName of allMachineNames) {
            // Availability & Performance from MCStatus
            const mcRecords = mcStatusByMachine[machineName] || [];
            let { runTimeSeconds, excludedSeconds, totalSeconds } = calcMcStatusDurations(mcRecords, shiftStart, nowTH);

            // 🆕 ดึง MCStatus ล่าสุดจาก DB records ที่มีอยู่แล้ว (ไม่ต้อง query เพิ่ม)
            const latestMcStatus = mcRecords.length > 0 ? mcRecords[mcRecords.length - 1].MCStatus : null;
            const modeRunTime = getMachineRunTimeMode(machineName);

            // ✅ ดึง CT_target จาก pre-fetched map (ไม่ query DB)
            const targetRow = targetMap[machineName];
            const idealCT = targetRow?.cycle_time_target || 0;

            // totalOutput for performance: cache (past hours) + InfluxDB (current hour)
            // ✅ ข้าม current hour จาก cache → ใช้ InfluxDB เท่านั้น (ป้องกันนับซ้ำ)
            const cached = cacheService.getFullDay(machineName);
            const { thColumn } = getCurrentHourBoundaries(now);
            const currentShiftIndex = getShiftIndex(thColumn);
            let totalOutput = 0;
            let sumCtWeighted = 0;

            if (cached) {
                for (let i = 0; i < SHIFT_HOURS.length; i++) {
                    if (i === currentShiftIndex) continue; // ข้าม current hour
                    const out = cached.output[`actual_${SHIFT_HOURS[i]}`] || 0;
                    const ct = cached.cycleTime[`cycle_${SHIFT_HOURS[i]}`] || 0;
                    totalOutput += out;
                    if (out > 0 && ct > 0) sumCtWeighted += ct * out;
                }
            } else {
                // Fallback: หาก cache หายกลางคัน ให้ใช้ db เป็นฐานสำหรับชั่วโมงอดีต
                const actualSumRow = actualSumMap[machineName];
                if (actualSumRow) {
                    for (let i = 0; i < SHIFT_HOURS.length; i++) {
                        if (i === currentShiftIndex) continue;
                        totalOutput += (actualSumRow[`actual_${SHIFT_HOURS[i]}`] || 0);
                    }
                }
            }
            // current hour → InfluxDB เท่านั้น (source of truth)
            const currentData = currentHourData[machineName];
            const currOut = currentData?.output_count || 0;
            const currCt = currentData?.avg_cycle_time || 0;
            totalOutput += currOut;
            if (currOut > 0 && currCt > 0) sumCtWeighted += currCt * currOut;

            const overallAvgCt = totalOutput > 0 ? sumCtWeighted / totalOutput : 0;

            if (modeRunTime === "output_based") {
                const avgToUse = overallAvgCt > 0 ? overallAvgCt : idealCT;
                runTimeSeconds = totalOutput * avgToUse;
            }

            const availability = calcAvailability(runTimeSeconds, excludedSeconds, totalSeconds);
            let performance = calcPerformance(totalOutput, idealCT, runTimeSeconds);

            // Quality & OEE — แยกตาม oee_mode (auto/manual)
            const oeeData = oeeByMachine[machineName];
            const mCacheConfig = modeMap.get(machineName) || { oee_mode: "manual", ng_mode: "visual_ng" };
            const mode = mCacheConfig.oee_mode;

            let quality = 0;
            let oeeValue = 0;
            let ngQty = 0;

            if (mode === "auto") {
                // 🆕 [Step 4] NG total = RAM (past Cron-confirmed) + pending (bridge) + InfluxDB (current hour)
                const pastNg = cacheService.getNgPastHours(machineName);
                const pendingNg = autoNgCache.pendingPrevHour[machineName] || 0;
                const currentHourNg = autoNgCache.data[machineName] || 0; // Fast Loop อัปเดตทุก 10s อยู่แล้ว
                ngQty = pastNg + pendingNg + currentHourNg;
                
                if (mCacheConfig.ng_mode === "over_reject") {
                    // หักลบของเสียออกจากยอดเป้าหมายสำหรับ Performance
                    const outputForOee = Math.max(0, totalOutput - ngQty);
                    performance = calcPerformance(outputForOee, idealCT, runTimeSeconds);
                    quality = 100; // ล็อคให้ Quality เป็น 100% เสมอ
                } else {
                    quality = totalOutput > 0 ? ((totalOutput - ngQty) / totalOutput) * 100 : 0;
                    if (quality < 0) quality = 0;
                }

                oeeValue = (availability > 0 && performance > 0 && quality > 0)
                    ? (availability / 100) * (performance / 100) * (quality / 100) * 100
                    : 0;
            } else {
                quality = oeeData?.quality || 0;
                ngQty = oeeData?.ng_qty || 0;
                oeeValue = (availability > 0 && performance > 0 && quality > 0)
                    ? (availability / 100) * (performance / 100) * (quality / 100) * 100
                    : oeeData?.oee_value || 0;
            }

            let dailyPayload = {
                availability: parseFloat(availability.toFixed(2)),
                performance: parseFloat(performance.toFixed(2)),
                ngQty: mCacheConfig.ng_mode === "over_reject" ? 0 : ngQty,
                over_reject_qty: mCacheConfig.ng_mode === "over_reject" ? ngQty : undefined,
                oeeMode: mode,
                // 🆕 [Phase 7] ส่ง hourly array กลับไปเพื่ออัปเดต Availability แกนขวา
                hourly: {
                    availability: cacheService.getAvailability(machineName)
                }
            };

            // ✅ For manual machines, prevent overwriting yesterday's OEE with today's incomplete OEE
            const todayStr = getShiftDateUTC();
            if (mode === "auto" || dateStr !== todayStr) {
                dailyPayload.quality = parseFloat(quality.toFixed(2));
                dailyPayload.oee = parseFloat(oeeValue.toFixed(2));
            }

            // 🆕 ซิงค์ MQTT Memory กลับจาก DB ถ้า live_status ยังเป็น null
            // (กรณี backend เพิ่งรีสตาร์ท ยังไม่ได้รับ MQTT status_tb ครั้งแรก)
            const currentMemState = getMachineStateMem().get(machineName);
            if (currentMemState && currentMemState.live_status === null && latestMcStatus) {
                currentMemState.live_status = latestMcStatus;
                getMachineStateMem().set(machineName, currentMemState);
            }

            machines[machineName] = {
                daily: dailyPayload,
                currentHour: {
                    live_status: latestMcStatus, // 🆕 ส่งสถานะล่าสุดจาก MSSQL (ทุก 5 นาที)
                },
            };

            if (machineName === "ABR-003") {
                console.log(`[DEBUG ABR-003] slowLoop writing to DB: A=${availability}, P=${performance}, Q=${quality}, OEE=${oeeValue}`);
                console.log(`                runTime=${runTimeSeconds}, excluded=${excludedSeconds}, total=${totalSeconds}`);
            }

            // ✅ Queue upsert (ไม่ await ทีละตัว)
            const upsertData = {
                availability: parseFloat(availability.toFixed(2)),
                performance: parseFloat(performance.toFixed(2)),
            };
            if (mode === "auto") {
                upsertData.ng_qty = ngQty;
                upsertData.quality = parseFloat(quality.toFixed(2));
                upsertData.oee_value = parseFloat(oeeValue.toFixed(2));
            }

            // ✅ Write to DB at most once every 30 seconds to prevent huge disk I/O when running at 2s interval
            if (now.getTime() - lastOeeUpsertTime >= 30000) {
                upsertOps.push(
                    prisma.tb_oee.upsert({
                        where: { machine_name_date: { machine_name: machineName, date: targetDate } },
                        update: upsertData,
                        create: {
                            date: targetDate,
                            machine_name: machineName,
                            availability: parseFloat(availability.toFixed(2)),
                            performance: parseFloat(performance.toFixed(2)),
                            ng_qty: mode === "auto" ? ngQty : 0,
                            quality: mode === "auto" ? parseFloat(quality.toFixed(2)) : 0,
                            oee_value: mode === "auto" ? parseFloat(oeeValue.toFixed(2)) : 0,
                        },
                    }).catch(err => console.error(`   ❌ Slow poll upsert tb_oee failed for ${machineName}:`, err.message))
                );
            }
        }

        // ✅ Batch execute all upserts with event loop yielding
        if (upsertOps.length > 0) {
            const BATCH_SIZE = 50;
            for (let i = 0; i < upsertOps.length; i += BATCH_SIZE) {
                const batch = upsertOps.slice(i, i + BATCH_SIZE);
                await Promise.all(batch);
                if (i + BATCH_SIZE < upsertOps.length) {
                    await new Promise(resolve => setImmediate(resolve));
                }
            }
            lastOeeUpsertTime = now.getTime();
            console.log(`✅ [SlowPoll] OEE upserted to DB for ${Object.keys(machines).length} machines (${dateStr})`);
        }


        // 3. Emit status update (broadcast to all — ข้อมูล MCStatus ทุกคนต้องได้)
        if (broadcastFn) {
            broadcastFn("realtime_update", {
                serverTimeUTC: now.toISOString(),
                shiftDate: dateStr,
                machines,
            });
        }
    } catch (err) {
        console.error("❌ Slow poll error:", err.message);
    }
}

module.exports = {
    startRealtimePolling,
    stopRealtimePolling,
    fastPollAndEmit,
    slowPollAndEmit,
    // (Removed export of pushRealtimeMcStatus)
};
