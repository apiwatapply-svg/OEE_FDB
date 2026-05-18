/**
 * Cron Service — Hourly Summary + Late Data + Daily Rollover
 * สรุปข้อมูลจาก InfluxDB → upsert MSSQL + update cache
 */
require("dotenv").config();
const cron = require("node-cron");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const influxService = require("./influxService");
const cacheService = require("./cacheService");
// 🔹 getMachineStateMem: lazy-required ใน flushMqttMemoryToDb() แทน เพื่อป้องกัน cron thread
// ที่ไม่ได้ init mqttService เรียก getMachineStateMem แล้วได้ empty Map
const {
    SHIFT_HOURS,
    utcHourToThColumn,
    thColumnToUtcHour,
    getPreviousHourBoundaries,
    getShiftDateUTC,
    getHourBoundariesUTC,
    getShiftIndex,
    getCurrentHourBoundaries,
} = require("../utils/timeUtils");
const { calcMcStatusDurations, calcMcStatusDurationsPerHour, calcAvailability, calcPerformance, getCTCalcMode, getNgMode, getMachineRunTimeMode } = require("./oeeCalcService");
const dayjs = require("dayjs");
const { generatePlanForMachine } = require("../controllers/PlanConfigController");

// ✅ Utility: Yield event loop to prevent blocking Realtime Worker (UI Freeze fix)
const yieldEventLoop = () => new Promise(resolve => setImmediate(resolve));

// ✅ Fix #2 (v3): True Queue-based lock — resolves thundering herd concurrency issue
const lockQueue = [];
let isLocked = false;
const LOCK_TIMEOUT_MS = 120000; // 120s max wait (handleLateData can take >60s)

const acquireLock = async (jobName) => {
    if (!isLocked) {
        isLocked = true;
        return true; 
    }
    
    console.log(`⏳ [Cron] ${jobName} waiting for lock...`);
    let timeoutId;
    
    try {
        await new Promise((resolve, reject) => {
            lockQueue.push(resolve);
            timeoutId = setTimeout(() => {
                const index = lockQueue.indexOf(resolve);
                if (index > -1) lockQueue.splice(index, 1);
                reject(new Error("Lock timeout"));
            }, LOCK_TIMEOUT_MS);
        });
        clearTimeout(timeoutId);
        return true;
    } catch (e) {
        console.log(`⚠️ [Cron] ${jobName} skipped — lock timeout (${LOCK_TIMEOUT_MS}ms)`);
        return false;
    }
};

const releaseLock = () => {
    if (lockQueue.length > 0) {
        // Pass the lock to the next job in the queue
        const next = lockQueue.shift();
        next(); 
    } else {
        // Queue empty, release the global lock
        isLocked = false; 
    }
};

// Track last processed time per machine for late data detection
const lastProcessedTime = {};

// 🆕 Bug #1 Fix: Debounce runtime recalc trigger — prevent hammering upsertRuntimeAndAvailabilityForHour
// every 15 min when network is unstable and statusRecovered stays true continuously.
let lastStatusRecoveredAt = 0;
const STATUS_RECOVERED_DEBOUNCE_MS = 30 * 60 * 1000; // 30 min
const LATE_DATA_MAX_HOURS = 6; // max backfill window (hours) — 12h is overkill for normal late-data scenarios
// 🔒 Minimum date for all backfill functions — do NOT touch data before this date (manually repaired)
const BACKFILL_MIN_DATE = new Date('2026-04-23T00:00:00.000Z');

/**
 * Start all cron jobs
 * @param {Function|null} onSyncComplete - callback(reason) เรียกเมื่อ job หนักเสร็จ
 *   reason: "hourly_done" | "late_data_done" | "oee_hourly_done" | "ng_hourly_done"
 *           | "daily_sync_done" | "rollover_done"
 *   Worker_cron จะส่ง IPC cache_reload ไปยัง realtime worker ผ่าน callback นี้
 */
function startCronJobs(onSyncComplete = null) {
    const hourlyExpr = process.env.CRON_HOURLY || "0 * * * *";
    const lateExpr = process.env.CRON_LATE_DATA || "*/15 * * * *";
    const rolloverExpr = process.env.CRON_DAILY_ROLLOVER || "5 0 * * *";

    // Job 1: Hourly summary — ทุกต้นชั่วโมง (ดึงจาก InfluxDB สำรองไว้)
    // ✅ Fix #2: Protected by heavyCronLock
    cron.schedule(hourlyExpr, async () => {
        if (!(await acquireLock("summarizeLastHour"))) return;
        try {
            console.log(`⏰ [Cron] Hourly summary starting at ${new Date().toISOString()}`);
            await summarizeLastHour();
            // 🆕 Notify realtime thread to reload cache (MSSQL updated)
            if (onSyncComplete) onSyncComplete("hourly_done");
        } finally { releaseLock(); }
    });

    // ❌ Removed: 5-Min MQTT Bulk Upsert — InfluxDB เป็น source of truth
    // MSSQL เขียนทุก 1 ชม. ผ่าน summarizeLastHour + backfillStartup ตอน restart

    // Job 2: Late data check — ทุก 15 นาที
    // ✅ Fix #2: Protected by heavyCronLock
    cron.schedule(lateExpr, async () => {
        if (!(await acquireLock("handleLateData"))) return;
        try {
            console.log(`🔍 [Cron] Late data check at ${new Date().toISOString()}`);
            await handleLateData();
            // 🆕 Notify realtime thread (late data may update MSSQL)
            if (onSyncComplete) onSyncComplete("late_data_done");
        } finally { releaseLock(); }
    });

    // Job 3: Daily rollover — 00:05 UTC (07:05 TH)
    // 🆕 ใน cron thread: ไม่เรียก cacheService.clearAndRollover() โดยตรง
    // เพราะ cacheService ของ cron thread คนละ instance กับ realtime thread
    // ส่ง rollover_done แทน → realtime thread ทำ clearAndRollover เอง
    cron.schedule(rolloverExpr, async () => {
        console.log(`🌅 [Cron] Daily rollover at ${new Date().toISOString()}`);
        // ถ้าไม่มี callback (worker.js เดิม) ยังคงทำ local clearAndRollover ได้
        if (onSyncComplete) {
            onSyncComplete("rollover_done");
        } else {
            await cacheService.clearAndRollover();
        }
    });

    // Job 3.5: Machine NG per station hourly
    const ngExpr = process.env.CRON_NG_HOURLY || "10 * * * *";
    cron.schedule(ngExpr, async () => {
        if (!(await acquireLock("summarizeNgHourly"))) return;
        try {
            console.log(`🎯 [Cron] Machine NG hourly saving at ${new Date().toISOString()}`);
            await summarizeNgHourly();
            // 🆕 Notify realtime thread (ngCache needs reload)
            if (onSyncComplete) onSyncComplete("ng_hourly_done");
        } finally { releaseLock(); }
    });

    // Job 4: OEE hourly — upsert availability + performance to tb_oee
    // ✅ Fix #2: Protected by heavyCronLock
    const oeeExpr = process.env.CRON_OEE_HOURLY || "5 * * * *";
    cron.schedule(oeeExpr, async () => {
        if (!(await acquireLock("upsertOeeHourly"))) return;
        try {
            console.log(`📈 [Cron] OEE hourly upsert at ${new Date().toISOString()}`);
            await upsertOeeHourly();
            // 🆕 Notify realtime thread
            if (onSyncComplete) onSyncComplete("oee_hourly_done");
        } finally { releaseLock(); }
    });

    // Job 4.5: Daily InfluxDB to MSSQL Sync — 00:15 UTC (07:15 TH)
    const dailySyncExpr = process.env.CRON_DAILY_SYNC || "15 0 * * *";
    cron.schedule(dailySyncExpr, async () => {
        if (!(await acquireLock("dailySyncInfluxToMssql"))) return;
        try {
            console.log(`🔄 [Cron] Daily Influx to MSSQL Sync starting at ${new Date().toISOString()}`);
            await runDailySync(3);
            // 🆕 Notify realtime thread
            if (onSyncComplete) onSyncComplete("daily_sync_done");
        } finally { releaseLock(); }
    });

    // ✅ Job 4.6 (pollMssqlStatusForWeb) ถูกย้ายไปอยู่ใน worker.js แล้ว
    // เพราะต้องการ mqttService instance ของ realtime thread โดยตรง
    // (updateStateFromMssqlPoller ใช้ machineStateMem + localEmitToRoomFn ที่ init ใน worker.js)

    // Job 5: Auto Plan Daily — 00:10 UTC (07:10 TH)
    const autoPlanExpr = process.env.CRON_AUTO_PLAN || "10 0 * * *";
    cron.schedule(autoPlanExpr, async () => {
        console.log(`📋 [Cron] Auto plan daily at ${new Date().toISOString()}`);
        await autoPlanDaily();
    });

    console.log("✅ Cron jobs started:");
    console.log(`   Hourly: "${hourlyExpr}"`);
    console.log(`   Late data: "${lateExpr}"`);
    console.log(`   Rollover: "${rolloverExpr}"`);
    console.log(`   OEE hourly: "${oeeExpr}"`);
    console.log(`   Daily Sync: "${dailySyncExpr}"`);
    console.log(`   Auto plan: "${autoPlanExpr}"`);
    if (onSyncComplete) console.log("   📡 Cache sync callback: enabled");
}

/**
 * 🆕 Flush MQTT Memory to MSSQL (Every 5 minutes)
 * ✅ Fix #2: Bulk query (1 query) instead of findFirst per machine (N queries)
 * ✅ Batch processing + event loop yield to prevent Frontend blocking
 */
async function flushMqttMemoryToDb() {
    const BATCH_SIZE = 10;
    try {
        // 🔹 Lazy require: ใช้ require ภายใน function เพื่อให้ cron thread ไม่พังเมื่อ module load
        const { getMachineStateMem } = require("./mqttService");
        const mem = getMachineStateMem();
        if (mem.size === 0) return;

        const now = new Date();
        const dateStr = now.toISOString().split("T")[0];
        const targetDate = new Date(`${dateStr}T00:00:00.000Z`);
        const { thColumn } = getCurrentHourBoundaries(now);
        const actualField = `actual_${thColumn}`;

        console.log(`💾 Flushing ${mem.size} machines to MSSQL for ${actualField}...`);

        // Filter machines that have data AND whose MQTT memory matches the current hour
        // ✅ Fix: ถ้า current_hour_label ไม่ตรงกับ thColumn → ข้อมูลเป็นของ ชม.ก่อนหน้า ห้ามเขียน
        const entries = [...mem.entries()].filter(
            ([_, s]) => (s.current_hour_actual > 0 || s.current_hour_ng > 0) && s.current_hour_label === thColumn
        );

        if (entries.length === 0) return;

        // ✅ Fix #2: Bulk query — 1 query instead of N findFirst calls
        const existingRows = await prisma.tb_output_actual.findMany({
            where: { date: targetDate },
            select: { machine_name: true, [actualField]: true }
        });
        const existingMap = {};
        for (const row of existingRows) {
            existingMap[row.machine_name] = row[actualField] || 0;
        }

        let updatedCount = 0;

        // ✅ Batch processing with event loop yield
        for (let i = 0; i < entries.length; i += BATCH_SIZE) {
            const batch = entries.slice(i, i + BATCH_SIZE);

            const results = await Promise.all(batch.map(async ([machineName, state]) => {
                try {
                    const mqttOutput = state.current_hour_actual;
                    const existingValue = existingMap[machineName] || 0;
                    if (existingValue >= mqttOutput) return false;

                    await upsertHourlyField("tb_output_actual", machineName, targetDate, actualField, mqttOutput, "Overall", null);
                    cacheService.updateHour(machineName, thColumn, mqttOutput, state.last_cycle_time, 0);
                    return true;
                } catch (err) {
                    console.error(`   ⚠️ Failed to flush ${machineName}:`, err.message);
                    return false;
                }
            }));

            updatedCount += results.filter(Boolean).length;

            // ✅ Yield event loop — ให้ API request อื่นแทรกได้
            if (i + BATCH_SIZE < entries.length) {
                await new Promise(resolve => setImmediate(resolve));
            }
        }

        // Recalculate overall ONLY for updated machines
        if (updatedCount > 0) {
            const updatedMachines = entries.map(([name]) => name);
            await recalcOverallInMSSQL(targetDate, updatedMachines);
            console.log(`💾 Flush complete. Updated ${updatedCount} machines.`);
        }

    } catch (err) {
        console.error("❌ Flush MQTT Memory failed:", err.message);
    }
}

/**
 * Job 1: Summarize last hour
 * Query InfluxDB for previous hour → upsert MSSQL → update cache
 */
async function summarizeLastHour() {
    try {
        const { dateStr, utcHour, thColumn, start, end } = getPreviousHourBoundaries();

        console.log(`📊 Summarizing hour UTC:${utcHour} (TH:${thColumn}) for ${dateStr}`);

        // 1. Query InfluxDB — all machines in 1 query
        const machineData = await influxService.queryAllMachinesForHour(start, end);

        if (Object.keys(machineData).length === 0) {
            console.log("   No data found for last hour.");
            return;
        }

        const targetDate = new Date(dateStr);

        // 2.5 🆕 Sync Status/Alarm Events from InfluxDB for the last hour
        try {
            console.log(`   🔄 Syncing InfluxDB events to MSSQL for last hour...`);
            await syncEventsFromInfluxDb(start, end);
        } catch (e) {
            console.error("   ⚠️ Failed to sync InfluxDB events in summarizeLastHour:", e.message);
        }

        // 2.6 🆕 [Phase 6] Runtime + Availability per machine for the last hour
        try {
            await upsertRuntimeAndAvailabilityForHour(thColumn, start, end, targetDate, Object.keys(machineData), machineData);
        } catch (e) {
            console.error("   ⚠️ Failed to upsert runtime/availability in summarizeLastHour:", e.message);
        }

        // 2. ✅ Upsert MSSQL for each machine (3 ops in parallel per machine)
        for (const [machineName, data] of Object.entries(machineData)) {
            let { output_count, avg_cycle_time, models } = data;
            
            // 🆕 Support ct_calc_modes
            const ctMode = getCTCalcMode(machineName);
            if (ctMode === "runtime_based") {
                // 🔧 Fix: getRuntime() คือ function ที่ถูกต้อง — getMachineCache ไม่ได้ export จาก cacheService
                const { runtime: runtimeArr } = cacheService.getRuntime(machineName);
                // runtime array เรียงตาม SHIFT_HOURS index ใช้ getShiftIndex เพื่อหา index
                const { getShiftIndex: getIdx } = require('../utils/timeUtils');
                const hourIdx = getIdx(thColumn);
                const hourRuntime = (runtimeArr && runtimeArr[hourIdx]) || 0;
                if (output_count > 0) {
                    avg_cycle_time = hourRuntime / output_count;
                } else {
                    avg_cycle_time = 0;
                }
            }

            const theoreticalMax = avg_cycle_time > 0 ? 3600 / avg_cycle_time : 0;
            const efficiency = theoreticalMax > 0 ? (output_count / theoreticalMax) * 100 : 0;

            // ✅ Upserts
            const upsertOps = [
                upsertHourlyField("tb_cycle_time_actual", machineName, targetDate, `cycle_${thColumn}`, parseFloat(avg_cycle_time.toFixed(2)), "cycle_time", null),
                upsertHourlyField("tb_efficiency_actual", machineName, targetDate, `eff_${thColumn}`, parseFloat(efficiency.toFixed(2)), "eff_actual", null),
            ];

            // 🆕 Auto-merge "--" to cached real model
            let finalModels = {};
            if (models && Object.keys(models).length > 0) {
                for (const [k, v] of Object.entries(models)) finalModels[k] = { ...v };
            } else {
                finalModels["--"] = { output_count };
            }

            if (finalModels["--"]) {
                const cached = cacheService.getFullDay(machineName);
                if (cached && cached.models) {
                    const realModels = Object.keys(cached.models).filter(m => m !== "--");
                    if (realModels.length > 0) {
                        const tgtModel = realModels[0];
                        if (!finalModels[tgtModel]) finalModels[tgtModel] = { output_count: 0 };
                        finalModels[tgtModel].output_count += finalModels["--"].output_count;
                        delete finalModels["--"];
                    }
                }
            }

            for (const [mName, mData] of Object.entries(finalModels)) {
                upsertOps.push(upsertHourlyField("tb_output_actual", machineName, targetDate, `actual_${thColumn}`, mData.output_count, "Overall", null, mName));
            }

            await Promise.all(upsertOps);

            cacheService.updateHour(machineName, thColumn, output_count, avg_cycle_time, efficiency);
            console.log(`   ✅ ${machineName}: output=${output_count}, ct=${avg_cycle_time.toFixed(2)}, eff=${efficiency.toFixed(1)}%`);

            // ✅ Yield event loop — ให้ API request อื่นแทรกได้
            await new Promise(resolve => setImmediate(resolve));
        }

        // 3. Recalculate Overall columns in MSSQL
        await recalcOverallInMSSQL(targetDate, Object.keys(machineData));

    } catch (err) {
        console.error("❌ Hourly summary failed:", err.message);
    }
}

/**
 * Upsert a single hourly field in MSSQL
 */
async function upsertHourlyField(tableName, machineName, date, fieldName, value, overallFieldName, overallValue, modelName = null) {
    try {
        const updateData = { [fieldName]: value };
        if (overallValue !== null && overallFieldName) {
            updateData[overallFieldName] = overallValue;
        }

        const createData = {
            machine_name: machineName,
            date,
            [fieldName]: value,
        };
        if (overallValue !== null && overallFieldName) {
            createData[overallFieldName] = overallValue;
        }

        let whereClause = { machine_name_date: { machine_name: machineName, date } };

        if (tableName === "tb_output_actual" && modelName !== null) {
            whereClause = { machine_name_date_model_name: { machine_name: machineName, date, model_name: modelName } };
            createData.model_name = modelName;
        }

        // Atomic upsert
        await prisma[tableName].upsert({
            where: whereClause,
            update: updateData,
            create: createData,
        });
    } catch (err) {
        console.error(`❌ Upsert ${tableName} for ${machineName} failed:`, err.message);
    }
}

/**
 * [Phase 6] Upsert runtime + availability for a given thColumn hour
 * Query tb_MCStatus for the hour window → compute per machine → upsert tb_mc_runtime_hourly + tb_availability_actual
 * @param {string} thColumn  - hour label "07", "08", ...
 * @param {Date}   start     - UTC start of that hour
 * @param {Date}   end       - UTC end of that hour
 * @param {Date}   targetDate
 * @param {string[]} machineNames - list to process (from machineData keys in summarizeLastHour)
 */
async function upsertRuntimeAndAvailabilityForHour(thColumn, start, end, targetDate, machineNames, influxHourData = null) {
    if (!machineNames || machineNames.length === 0) return;

    // Always query InfluxDB:
    //  - output_based: runtime = output × avgCT
    //  - status_based with no MCStatus: fallback to output × avgCT (machine was clearly running)
    let resolvedInfluxData = influxHourData;
    if (!resolvedInfluxData) {
        try {
            resolvedInfluxData = await influxService.queryAllMachinesForHour(start, end);
        } catch (e) {
            console.error("   ⚠️ [Phase 6] InfluxDB query failed:", e.message);
            resolvedInfluxData = {};
        }
    }

    // TH offset: DB stores Thai local time
    const TH_OFFSET_MS = 7 * 60 * 60 * 1000;
    const startTH = new Date(start.getTime() + TH_OFFSET_MS);
    const endTH = new Date(end.getTime() + TH_OFFSET_MS);

    // ── Step 1: Query MCStatus for the hour (all machines in 1 query) ──
    const mcStatusRows = await prisma.tb_MCStatus.findMany({
        where: { Datetime: { gte: startTH, lt: endTH } },
        orderBy: { Datetime: 'asc' },
        select: { MC: true, Datetime: true, MCStatus: true },
    });

    // Carry-over: last status per machine before this hour window
    const carryOverRows = await prisma.$queryRaw`
        SELECT MC, MCStatus, Datetime FROM (
            SELECT MC, MCStatus, Datetime, ROW_NUMBER() OVER (PARTITION BY MC ORDER BY Datetime DESC) AS rn
            FROM tb_MCStatus WHERE Datetime < ${startTH}
        ) t WHERE rn = 1
    `;

    // Build grouped records with carry-over prepended
    const mcStatusByMachine = {};
    for (const row of carryOverRows) {
        if (machineNames.includes(row.MC)) {
            mcStatusByMachine[row.MC] = [{ MC: row.MC, Datetime: startTH, MCStatus: row.MCStatus }];
        }
    }
    for (const rec of mcStatusRows) {
        if (!machineNames.includes(rec.MC)) continue;
        if (!mcStatusByMachine[rec.MC]) mcStatusByMachine[rec.MC] = [];
        mcStatusByMachine[rec.MC].push(rec);
    }

    // ── Step 2: Bulk fetch target rows (to know which hours are active) ──
    const allTargetRows = await prisma.tb_output_target.findMany({
        where: { date: targetDate },
        select: { machine_name: true, [`target_${thColumn}`]: true, eff_target: true }
    });
    const targetMap = {};
    for (const row of allTargetRows) targetMap[row.machine_name] = row;

    // ── Step 3: Per machine — calc runtime + availability → upsert ──
    const runtimeOps = [];
    const availOps = [];

    for (const machineName of machineNames) {
        try {
            const mcRecords = mcStatusByMachine[machineName] || [];
            const targetRow = targetMap[machineName];

            // Skip hours marked inactive by plan config
            const isHourActive = !targetRow || ((targetRow[`target_${thColumn}`] || 0) > 0);
            const totalSeconds = isHourActive ? 3600 : 0;

            let { runTimeSeconds, excludedSeconds } = calcMcStatusDurations(mcRecords, startTH, endTH);

            // 🔧 output_based override: คำนวณ runtime จาก output x avgCT แทน MCStatus
            const modeRunTime = getMachineRunTimeMode(machineName);
            if (modeRunTime === "output_based") {
                const hourData = (resolvedInfluxData[machineName]) || {};
                const hourOutput = hourData.output_count || 0;
                const hourAvgCt = hourData.avg_cycle_time || 0;
                runTimeSeconds = hourOutput * hourAvgCt;
                excludedSeconds = 0;
            }

            // 🆕 Long-term Fallback: status_based machine มี output แต่ไม่มี MCStatus records ในชั่วโมงนี้
            //   → เครื่องผลิตสินค้าชัดเจนว่าทำงานอยู่ แต่ IoT status_tb ไม่ได้ส่งข้อมูล
            //   → ใช้ output × avgCT เป็น estimated runtime แทนการรายงาน 0%
            //   หมายเหตุ: mcRecords มี carry-over ซึ่ง Datetime=startTH เสมอ (จาก carryOverRows)
            //             ดังนั้น "ไม่มีข้อมูลจริง" = filter เอาเฉพาะ records ที่ >= startTH จริงๆ
            const actualMcInWindow = mcRecords.filter(r => r.Datetime >= startTH && r.Datetime < endTH).length;
            if (modeRunTime !== "output_based" && actualMcInWindow === 0 && runTimeSeconds === 0) {
                const hourData = (resolvedInfluxData[machineName]) || {};
                const hourOutput = hourData.output_count || 0;
                const hourAvgCt = hourData.avg_cycle_time || 0;
                if (hourOutput > 0 && hourAvgCt > 0) {
                    runTimeSeconds = hourOutput * hourAvgCt;
                    excludedSeconds = 0;
                    console.log(`   ⚠️ [Phase 6] ${machineName} ${thColumn}: No MCStatus in window → output-based fallback (output=${hourOutput}, ct=${hourAvgCt.toFixed(2)}, runtime=${runTimeSeconds.toFixed(0)}s)`);
                }
            }

            // Availability = runTime / (total - excluded) × 100
            const availability = calcAvailability(runTimeSeconds, excludedSeconds, totalSeconds);

            // Upsert runtime row
            runtimeOps.push(
                prisma.tb_mc_runtime_hourly.upsert({
                    where: { machine_name_date: { machine_name: machineName, date: targetDate } },
                    update: {
                        [`runtime_${thColumn}`]: parseFloat(runTimeSeconds.toFixed(2)),
                        [`excluded_${thColumn}`]: parseFloat(excludedSeconds.toFixed(2)),
                    },
                    create: {
                        machine_name: machineName,
                        date: targetDate,
                        [`runtime_${thColumn}`]: parseFloat(runTimeSeconds.toFixed(2)),
                        [`excluded_${thColumn}`]: parseFloat(excludedSeconds.toFixed(2)),
                    },
                })
            );

            // Upsert availability row
            availOps.push(
                prisma.tb_availability_actual.upsert({
                    where: { machine_name_date: { machine_name: machineName, date: targetDate } },
                    update: { [`avail_${thColumn}`]: parseFloat(availability.toFixed(2)) },
                    create: {
                        machine_name: machineName,
                        date: targetDate,
                        [`avail_${thColumn}`]: parseFloat(availability.toFixed(2)),
                    },
                })
            );

            // ── Update in-memory cache (cron thread's own copy for diff-check) ──
            cacheService.updateHourRuntime(machineName, thColumn, runTimeSeconds, excludedSeconds);
            cacheService.updateHourAvailability(machineName, thColumn, availability);

            // ✅ Yield event loop
            await yieldEventLoop();
        } catch (err) {
            console.error(`   ❌ [Phase 6] Runtime/Avail calc failed for ${machineName}:`, err.message);
        }
    }

    // ── Step 4: Batch execute runtimeOps + availOps ──
    if (runtimeOps.length > 0) await Promise.all(runtimeOps);
    if (availOps.length > 0) await Promise.all(availOps);

    // ── Step 5: Recalculate totals (runtime_total, excluded_total, avail_actual) per machine ──
    await recalcRuntimeAndAvailTotals(targetDate, machineNames);

    console.log(`   ✅ [Phase 6] Runtime + Availability upserted for ${machineNames.length} machines (hour: ${thColumn})`);
}

/**
 * [Phase 6] Recalculate runtime_total, excluded_total, avail_actual for given machines on a date
 */
async function recalcRuntimeAndAvailTotals(targetDate, machineNames) {
    const { SHIFT_HOURS: HOURS } = require('../utils/timeUtils');

    const [runtimeRows, availRows] = await Promise.all([
        prisma.tb_mc_runtime_hourly.findMany({ where: { date: targetDate, machine_name: { in: machineNames } } }),
        prisma.tb_availability_actual.findMany({ where: { date: targetDate, machine_name: { in: machineNames } } }),
    ]);

    const CHUNK_SIZE = 10;
    for (let i = 0; i < runtimeRows.length; i += CHUNK_SIZE) {
        const chunk = runtimeRows.slice(i, i + CHUNK_SIZE);
        await Promise.all(chunk.map(async (row) => {
            let sumRuntime = 0;
            let sumExcluded = 0;
            for (const h of HOURS) {
                sumRuntime += row[`runtime_${h}`] || 0;
                sumExcluded += row[`excluded_${h}`] || 0;
            }
            await prisma.tb_mc_runtime_hourly.update({
                where: { id: row.id },
                data: {
                    runtime_total: parseFloat(sumRuntime.toFixed(2)),
                    excluded_total: parseFloat(sumExcluded.toFixed(2)),
                },
            });
        }));
        await yieldEventLoop();
    }

    for (let i = 0; i < availRows.length; i += CHUNK_SIZE) {
        const chunk = availRows.slice(i, i + CHUNK_SIZE);
        await Promise.all(chunk.map(async (row) => {
            // 🔧 Fix Bug: "Average of Averages" is mathematically flawed for availability.
            // Using average of hourly averages ignores 0% hours completely and heavily skews the daily number.
            // To ensure 100% consistency with tb_oee.availability, we simply fetch the true calculated OEE availability
            // and sync it to avail_actual, because tb_oee uses the accurate (Total Run Time / Total Active Time) formula.
            const oeeRow = await prisma.tb_oee.findFirst({
                where: { machine_name: row.machine_name, date: targetDate },
                select: { availability: true }
            });
            const trueAvail = oeeRow?.availability || 0;
            
            await prisma.tb_availability_actual.update({
                where: { id: row.id },
                data: { avail_actual: trueAvail },
            });
        }));
        await yieldEventLoop();
    }
}

/**
 * Recalculate Overall columns in MSSQL for given machines
 * ✅ Yield event loop ทุก 10 เครื่อง เพื่อไม่ให้ block Frontend
 */
async function recalcOverallInMSSQL(targetDate, machineNames) {
    for (let idx = 0; idx < machineNames.length; idx++) {
        const machineName = machineNames[idx];
        try {
            // Read current rows
            const outputRows = await prisma.tb_output_actual.findMany({
                where: { machine_name: machineName, date: targetDate },
            });
            const ctRow = await prisma.tb_cycle_time_actual.findFirst({
                where: { machine_name: machineName, date: targetDate },
            });

            if (outputRows.length === 0) continue;

            // Calculate Overall output
            let totalOutputMachine = 0;
            let sumCtWeighted = 0;
            let totalOutputForCt = 0;

            const outputUpdates = [];

            // 1) Update row-level 'Overall'
            for (const outputRow of outputRows) {
                let rowOverallOutput = 0;
                for (const h of SHIFT_HOURS) {
                    rowOverallOutput += (outputRow[`actual_${h}`] || 0);
                }
                outputUpdates.push(
                    prisma.tb_output_actual.update({
                        where: { id: outputRow.id },
                        data: { Overall: rowOverallOutput },
                    })
                );
            }

            // 2) Aggregate safe total output and CT using per-hour fallback to avoid double counting '--' rows
            for (const h of SHIFT_HOURS) {
                const realRows = outputRows.filter(r => r.model_name && r.model_name !== "--" && (r[`actual_${h}`] || 0) > 0);
                let outThisHour = 0;
                
                if (realRows.length > 0) {
                    outThisHour = realRows.reduce((sum, r) => sum + (r[`actual_${h}`] || 0), 0);
                } else {
                    const dashRow = outputRows.find(r => !r.model_name || r.model_name === "--");
                    outThisHour = dashRow ? (dashRow[`actual_${h}`] || 0) : 0;
                }

                totalOutputMachine += outThisHour;

                if (outThisHour > 0) {
                    const ct = ctRow ? (ctRow[`cycle_${h}`] || 0) : 0;
                    if (ct > 0) {
                        sumCtWeighted += ct * outThisHour;
                        totalOutputForCt += outThisHour;
                    }
                }
            }

            const avgCt = totalOutputForCt > 0 ? parseFloat((sumCtWeighted / totalOutputForCt).toFixed(2)) : 0;
            const todayStr = getShiftDateUTC();
            const isToday = targetDate.toISOString().split('T')[0] === todayStr;
            let totalHoursPassed;
            if (isToday) {
                const currentShiftIdx = getShiftIndex(utcHourToThColumn(new Date().getUTCHours()));
                totalHoursPassed = Math.min(currentShiftIdx + 1, SHIFT_HOURS.length);
            } else {
                totalHoursPassed = SHIFT_HOURS.length;
            }

            const targetRow = await prisma.tb_output_target.findFirst({
                where: { machine_name: machineName, date: targetDate },
            });
            let totalValidSeconds = 0;
            for (let i = 0; i < totalHoursPassed; i++) {
                const h = SHIFT_HOURS[i];
                const targetVal = targetRow ? (targetRow[`target_${h}`] || 0) : 0;
                if (targetVal > 0) {
                    totalValidSeconds += 3600;
                }
            }

            const theoreticalMax = avgCt > 0 ? totalValidSeconds / avgCt : 0;
            const overallEff = theoreticalMax > 0 ? (totalOutputMachine / theoreticalMax) * 100 : 0;

            // Update Overall columns - Batch by 5 parallel ops
            for (let b = 0; b < outputUpdates.length; b += 5) {
                await Promise.all(outputUpdates.slice(b, b + 5));
                await yieldEventLoop();
            }

            if (ctRow) {
                await prisma.tb_cycle_time_actual.update({
                    where: { id: ctRow.id },
                    data: { cycle_time: avgCt },
                });
            }

            const effRow = await prisma.tb_efficiency_actual.findFirst({
                where: { machine_name: machineName, date: targetDate },
            });
            if (effRow) {
                await prisma.tb_efficiency_actual.update({
                    where: { id: effRow.id },
                    data: { eff_actual: parseFloat(overallEff.toFixed(2)) },
                });
            }
        } catch (err) {
            console.error(`❌ Recalc overall for ${machineName} failed:`, err.message);
        }

        // ✅ Yield event loop ทุก 10 เครื่อง -> เปลี่ยนเป็นทุกเครื่อง
        await new Promise(resolve => setImmediate(resolve));
    }
}

/**
 * Job 2: Handle late-arriving data
 * Scan InfluxDB for last 48 hours, re-process any unprocessed data
 * ✅ Optimized: batch upserts + yield event loop to prevent Frontend blocking
 */
async function handleLateData() {
    const BATCH_SIZE = 50;
    try {
        const now = new Date();
        const todayStr = getShiftDateUTC();
        const lookbackMs = 48 * 60 * 60 * 1000; // 48 hours
        const startTime = new Date(now.getTime() - lookbackMs);

        // ── Step 1: Query InfluxDB once for 48h window ──
        const allData = await influxService.queryHoursRange(startTime, now);
        if (Object.keys(allData).length === 0) return;

        // Skip current hour (still in progress)
        const currentHourStart = new Date(now);
        currentHourStart.setUTCMinutes(0, 0, 0);

        // ── Step 2: Group InfluxDB data by date → machine → { field: value } ──
        // Structure: { "2026-03-05": { "AHV-001": { output: {actual_14: 100}, ct: {cycle_14: 4.2}, eff: {eff_14: 85.3} } } }
        const dateGroups = {};

        for (const [machineName, hourData] of Object.entries(allData)) {
            for (const [hourKey, data] of Object.entries(hourData)) {
                const hourDate = new Date(hourKey + ":00:00.000Z");
                if (hourDate.getTime() >= currentHourStart.getTime()) continue;

                // Check lastProcessedTime — skip if no change
                const cacheKey = `${machineName}_${hourKey}`;
                // ✅ Fix: Track both count AND timestamp — re-process if data arrived in last 30min
                const cached = lastProcessedTime[cacheKey];
                const isRecent = !cached?.lastSeenAt || (Date.now() - cached.lastSeenAt < 30 * 60 * 1000);
                if (cached?.count && data.output_count <= cached.count && !isRecent) {
                    continue;
                }

                const utcHour = hourDate.getUTCHours();
                const dateStr = hourDate.toISOString().split("T")[0];
                const thColumn = utcHourToThColumn(utcHour);
                const { output_count, avg_cycle_time, models } = data;
                const theoreticalMax = avg_cycle_time > 0 ? 3600 / avg_cycle_time : 0;
                const efficiency = theoreticalMax > 0 ? (output_count / theoreticalMax) * 100 : 0;

                if (!dateGroups[dateStr]) dateGroups[dateStr] = {};
                if (!dateGroups[dateStr][machineName]) dateGroups[dateStr][machineName] = { output: {}, models: {}, ct: {}, eff: {}, avail: {} };

                dateGroups[dateStr][machineName].ct[`cycle_${thColumn}`] = parseFloat(avg_cycle_time.toFixed(2));
                dateGroups[dateStr][machineName].eff[`eff_${thColumn}`] = parseFloat(efficiency.toFixed(2));

                const { getMachineRunTimeMode } = require("./oeeCalcService");
                if (getMachineRunTimeMode(machineName) === "output_based") {
                    dateGroups[dateStr][machineName].avail[`avail_${thColumn}`] = parseFloat(efficiency.toFixed(2));
                }

                if (models && Object.keys(models).length > 0) {
                    for (const [mName, mData] of Object.entries(models)) {
                        if (!dateGroups[dateStr][machineName].models[mName]) dateGroups[dateStr][machineName].models[mName] = {};
                        dateGroups[dateStr][machineName].models[mName][`actual_${thColumn}`] = mData.output_count;
                    }
                } else {
                    if (!dateGroups[dateStr][machineName].models["--"]) dateGroups[dateStr][machineName].models["--"] = {};
                    dateGroups[dateStr][machineName].models["--"][`actual_${thColumn}`] = output_count;
                }

                lastProcessedTime[cacheKey] = { count: output_count, lastSeenAt: Date.now() };

                // Update cache for today
                if (dateStr === todayStr) {
                    cacheService.updateHour(machineName, thColumn, output_count, avg_cycle_time, efficiency);
                }
            }
        }

        const dateKeys = Object.keys(dateGroups);
        if (dateKeys.length === 0) return;

        // ── Step 3: Per date — findMany + compare + batch update ──
        let totalUpdated = 0;
        let totalCreated = 0;

        for (const dateStr of dateKeys) {
            const targetDate = new Date(dateStr);
            const machineChanges = dateGroups[dateStr];

            // Load existing rows (4 queries per date — instead of N per machine)
            const [dbOutputRows, dbCtRows, dbEffRows, dbAvailRows] = await Promise.all([
                prisma.tb_output_actual.findMany({ where: { date: targetDate } }),
                prisma.tb_cycle_time_actual.findMany({ where: { date: targetDate } }),
                prisma.tb_efficiency_actual.findMany({ where: { date: targetDate } }),
                prisma.tb_availability_actual.findMany({ where: { date: targetDate } }),
            ]);

            // 🆕 Auto-discard "--" model when real model exists in MSSQL
            // InfluxDB data from before Telegraf restart is unreliable (model tag was missing)
            // → If MSSQL already has a real model row, drop "--" from changes entirely
            //   and queue the stale "--" row in MSSQL for deletion to prevent double-count.
            const staleRowsToDelete = [];
            for (const [mNameGroup, changes] of Object.entries(machineChanges)) {
                if (changes.models && changes.models["--"]) {
                    const realModels = dbOutputRows.filter(r => r.machine_name === mNameGroup && r.model_name && r.model_name !== "--");
                    if (realModels.length > 0) {
                        // Discard "--" from InfluxDB — real model rows are the source of truth
                        delete changes.models["--"];

                        // Queue stale "--" row in MSSQL for deletion (if it exists)
                        const staleRow = dbOutputRows.find(r => r.machine_name === mNameGroup && r.model_name === "--");
                        if (staleRow) {
                            staleRowsToDelete.push(staleRow.id);
                            console.log(`   🗑️ [LateData] Queued stale "--" row for ${mNameGroup} (id=${staleRow.id})`);
                        }
                    }
                    // If no real model exists → keep "--" as-is (machine Telegraf not yet restarted)
                }
            }

            // Execute stale "--" deletions before processing other changes
            if (staleRowsToDelete.length > 0) {
                await Promise.all(staleRowsToDelete.map(id => prisma.tb_output_actual.delete({ where: { id } })));
                console.log(`   🗑️ [LateData] Deleted ${staleRowsToDelete.length} stale "--" rows`);
            }

            // Build lookup maps
            const outputMap = {}; // "AHV-001_Model A" -> row
            for (const row of dbOutputRows) {
                if (staleRowsToDelete.includes(row.id)) continue; // skip just-deleted rows
                const mk = `${row.machine_name}_${row.model_name || "--"}`;
                outputMap[mk] = row;
            }
            const ctMap = {};
            for (const row of dbCtRows) ctMap[row.machine_name] = row;
            const effMap = {};
            for (const row of dbEffRows) effMap[row.machine_name] = row;
            const availMap = {};
            for (const row of dbAvailRows) availMap[row.machine_name] = row;

            // Collect pending DB operations
            const pendingOps = [];

            for (const [machineName, changes] of Object.entries(machineChanges)) {
                // Output
                if (changes.models) {
                    for (const [mName, mUpdates] of Object.entries(changes.models)) {
                        const mk = `${machineName}_${mName}`;
                        if (outputMap[mk]) {
                            pendingOps.push(prisma.tb_output_actual.update({
                                where: { id: outputMap[mk].id },
                                data: mUpdates,
                            }));
                            totalUpdated++;
                        } else {
                            pendingOps.push(prisma.tb_output_actual.create({
                                data: { machine_name: machineName, date: targetDate, model_name: mName, ...mUpdates },
                            }));
                            totalCreated++;
                        }
                    }
                }
                // Cycle Time
                if (Object.keys(changes.ct).length > 0) {
                    if (ctMap[machineName]) {
                        pendingOps.push(prisma.tb_cycle_time_actual.update({
                            where: { id: ctMap[machineName].id },
                            data: changes.ct,
                        }));
                        totalUpdated++;
                    } else {
                        pendingOps.push(prisma.tb_cycle_time_actual.create({
                            data: { machine_name: machineName, date: targetDate, ...changes.ct },
                        }));
                        totalCreated++;
                    }
                }
                // Efficiency
                if (Object.keys(changes.eff).length > 0) {
                    if (effMap[machineName]) {
                        pendingOps.push(prisma.tb_efficiency_actual.update({
                            where: { id: effMap[machineName].id },
                            data: changes.eff,
                        }));
                        totalUpdated++;
                    } else {
                        pendingOps.push(prisma.tb_efficiency_actual.create({
                            data: { machine_name: machineName, date: targetDate, ...changes.eff },
                        }));
                        totalCreated++;
                    }
                }
                // Availability (Output-based override)
                if (changes.avail && Object.keys(changes.avail).length > 0) {
                    if (availMap[machineName]) {
                        pendingOps.push(prisma.tb_availability_actual.update({
                            where: { id: availMap[machineName].id },
                            data: changes.avail,
                        }));
                        totalUpdated++;
                    } else {
                        pendingOps.push(prisma.tb_availability_actual.create({
                            data: { machine_name: machineName, date: targetDate, ...changes.avail },
                        }));
                        totalCreated++;
                    }
                }
            }

            // Batch execute with event loop yielding
            for (let i = 0; i < pendingOps.length; i += BATCH_SIZE) {
                const batch = pendingOps.slice(i, i + BATCH_SIZE);
                await Promise.all(batch);
                if (i + BATCH_SIZE < pendingOps.length) {
                    await new Promise(resolve => setImmediate(resolve));
                }
            }

            // Recalculate Overall
            const machinesForDate = Object.keys(machineChanges);
            await recalcOverallInMSSQL(targetDate, machinesForDate);
            await new Promise(resolve => setImmediate(resolve));
        }

        // ── Step 4: Late Data Event Sync (Check last 12 hours to avoid heavy querying) ──
        let recoveredEvents = { statusRecovered: false, alarmRecovered: false };
        try {
            const eventStartCutoff = new Date(now.getTime() - (12 * 60 * 60 * 1000));
            recoveredEvents = await syncEventsFromInfluxDb(eventStartCutoff, now);
        } catch (e) {
            console.error("❌ Late data event sync failed:", e.message);
        }

        // 🆕 Bug #1 Fix: Debounce — prevent runtime recalc loop from running every 15 min
        //   when network is unstable and statusRecovered stays true continuously.
        //   Only run if last recalc was > STATUS_RECOVERED_DEBOUNCE_MS ago.
        if (recoveredEvents && recoveredEvents.statusRecovered) {
            const now2 = Date.now();
            if (now2 - lastStatusRecoveredAt > STATUS_RECOVERED_DEBOUNCE_MS) {
                lastStatusRecoveredAt = now2;
                const activeMachinesRaw = await prisma.tbm_machine.findMany({ where: { status: 'active' }, select: { machine_name: true } });
                const activeMachines = activeMachinesRaw.map(m => m.machine_name);
                const statusMachines = activeMachines.filter(m => getMachineRunTimeMode(m) !== "output_based");
                if (statusMachines.length > 0) {
                    console.log(`⏳ Triggering runtime recalculation for past ${LATE_DATA_MAX_HOURS} hours due to recovered events...`);
                    for (let h = 1; h <= LATE_DATA_MAX_HOURS; h++) {
                        const pastDate = new Date(now.getTime() - (h * 60 * 60 * 1000));
                        const { dateStr, thColumn, start, end } = getCurrentHourBoundaries(pastDate);
                        const targetDateObj = new Date(dateStr + "T00:00:00.000Z");
                        await upsertRuntimeAndAvailabilityForHour(thColumn, start, end, targetDateObj, statusMachines);
                        // Yield between hours so other cron jobs can interleave
                        await yieldEventLoop();
                    }
                    console.log(`✅ Completed runtime recalculation (${LATE_DATA_MAX_HOURS}h window).`);
                }
            } else {
                const remainSec = Math.round((STATUS_RECOVERED_DEBOUNCE_MS - (now2 - lastStatusRecoveredAt)) / 1000);
                console.log(`⏩ [handleLateData] Runtime recalc skipped (debounced — ${remainSec}s remaining)`);
            }
        }

        if (totalUpdated > 0 || totalCreated > 0) {
            console.log(`🔍 Late data: ${totalUpdated} updated, ${totalCreated} created across ${dateKeys.length} dates (bulk)`);
        }
    } catch (err) {
        console.error("❌ Late data check failed:", err.message);
    }
}

/**
 * Startup / Sync: Backfill last N days + today from InfluxDB → MSSQL
 * ✅ Best Practice: findMany → compare in memory → batch update only changed records
 * ตรวจสอบและซ่อมข้อมูลย้อนหลัง N วัน (default 5 วัน ตอนรัน Node ใหม่)
 */
async function backfillStartup(days = 5) {
    const BACKFILL_DAYS = days;
    const BATCH_SIZE = 50; // records per transaction batch
    const BATCH_DELAY_MS = 100; // ms delay between batches to let DB breathe

    console.log(`🔄 [Startup] Backfilling last ${BACKFILL_DAYS} days + today from InfluxDB → MSSQL...`);

    try {
        const now = new Date();
        const todayStr = getShiftDateUTC();
        let totalUpdated = 0;
        let totalCreated = 0;

        // Loop from oldest day → today
        for (let i = BACKFILL_DAYS; i >= 0; i--) {
            const shiftDate = new Date(now);
            shiftDate.setUTCDate(shiftDate.getUTCDate() - i);
            const dateStr = shiftDate.toISOString().split("T")[0];

            // Shift boundaries
            const startOfShift = new Date(dateStr + "T00:00:00.000Z");
            let endOfShift;

            if (dateStr === todayStr) {
                // ✅ Include current hour: query up to NOW (not truncated to hour start)
                // This ensures corrupted current-hour data gets overwritten from InfluxDB
                endOfShift = new Date(now);
            } else {
                endOfShift = new Date(startOfShift);
                endOfShift.setUTCDate(endOfShift.getUTCDate() + 1);
            }

            // ── Step 1: Query InfluxDB once for this entire day ──
            const influxData = await influxService.queryHoursRange(startOfShift, endOfShift);
            const influxMachines = Object.keys(influxData);

            if (influxMachines.length === 0) {
                console.log(`   📅 ${dateStr}: No data in InfluxDB.`);
                continue;
            }

            const targetDate = new Date(dateStr);
            const isToday = (dateStr === todayStr);

            // Guard: do not backfill data before minimum allowed date
            if (targetDate < BACKFILL_MIN_DATE) {
                console.log(`   ⏭️ [Backfill] Skip ${dateStr} (before BACKFILL_MIN_DATE)`);
                continue;
            }

            // ── Step 2: Load existing MSSQL rows for this date (3 queries total) ──
            const [dbOutputRows, dbCtRows, dbEffRows] = await Promise.all([
                prisma.tb_output_actual.findMany({ where: { date: targetDate } }),
                prisma.tb_cycle_time_actual.findMany({ where: { date: targetDate } }),
                prisma.tb_efficiency_actual.findMany({ where: { date: targetDate } }),
            ]);

            // Build lookup maps
            const outputMap = {};
            for (const row of dbOutputRows) {
                const mk = `${row.machine_name}_${row.model_name || "--"}`;
                outputMap[mk] = row;
            }
            const ctMap = {};
            for (const row of dbCtRows) ctMap[row.machine_name] = row;
            const effMap = {};
            for (const row of dbEffRows) effMap[row.machine_name] = row;

            // ── Step 2.5: Auto-discard "--" data from InfluxDB when MSSQL has real model rows ──
            // InfluxDB data from before Telegraf restart is unreliable (no model tag → stored as "--")
            // If MSSQL already has a real model row for the machine, skip all "--" InfluxDB data
            // and delete any stale "--" rows in MSSQL to prevent double-count with SUM logic.
            const backfillStaleToDelete = [];
            for (const machineName of Object.keys(influxData)) {
                const hasRealModelInMssql = dbOutputRows.some(
                    r => r.machine_name === machineName && r.model_name && r.model_name !== "--"
                );
                if (!hasRealModelInMssql) continue; // No real model yet → keep "--" as-is

                // Check if any hour in InfluxDB for this machine has no model tag (→ "--")
                const hourData = influxData[machineName];
                const hasAnyDashHour = Object.values(hourData).some(
                    d => (!d.models || Object.keys(d.models).length === 0) && d.output_count > 0
                );
                if (!hasAnyDashHour) continue; // All hours already have model tags → nothing to do

                // Has real model in MSSQL + InfluxDB sending "--" → skip those hours
                // Remove hours that would produce "--" from influxData for this machine
                for (const [hourKey, data] of Object.entries(hourData)) {
                    if (!data.models || Object.keys(data.models).length === 0) {
                        delete influxData[machineName][hourKey];
                        console.log(`   ⏭️ [Backfill] Skipped "${machineName}" ${hourKey} "--" (real model exists in MSSQL)`);
                    }
                }
                // If all hours removed → remove machine entirely to skip CT/Eff upsert too
                if (Object.keys(influxData[machineName]).length === 0) {
                    delete influxData[machineName];
                }

                // Queue stale "--" row in MSSQL for deletion
                const staleRow = dbOutputRows.find(r => r.machine_name === machineName && r.model_name === "--");
                if (staleRow) {
                    backfillStaleToDelete.push(staleRow.id);
                    console.log(`   🗑️ [Backfill] Queued stale "--" row for ${machineName} (id=${staleRow.id})`);
                }
            }

            // Execute stale "--" deletions before building pendingOps
            if (backfillStaleToDelete.length > 0) {
                await Promise.all(backfillStaleToDelete.map(id => prisma.tb_output_actual.delete({ where: { id } })));
                // Remove deleted rows from outputMap so they won't be referenced
                for (const id of backfillStaleToDelete) {
                    const key = Object.keys(outputMap).find(k => outputMap[k].id === id);
                    if (key) delete outputMap[key];
                }
                console.log(`   🗑️ [Backfill] Deleted ${backfillStaleToDelete.length} stale "--" rows`);
            }

            // ── Step 3: Compare in memory & collect changes ──
            const pendingOps = []; // { type: 'update'|'create', table, ... }

            for (const [machineName, hourData] of Object.entries(influxData)) {
                const modelsChanges = {};
                const ctChanges = {};
                const effChanges = {};

                for (const [hourKey, data] of Object.entries(hourData)) {
                    const hourDate = new Date(hourKey + ":00:00.000Z");
                    const utcHour = hourDate.getUTCHours();
                    const thColumn = utcHourToThColumn(utcHour);

                    const { output_count, avg_cycle_time, models } = data;
                    if (output_count <= 0) continue;

                    const theoreticalMax = avg_cycle_time > 0 ? 3600 / avg_cycle_time : 0;
                    const efficiency = theoreticalMax > 0 ? (output_count / theoreticalMax) * 100 : 0;
                    const ctRounded = parseFloat(avg_cycle_time.toFixed(2));
                    const effRounded = parseFloat(efficiency.toFixed(2));

                    ctChanges[`cycle_${thColumn}`] = ctRounded;
                    effChanges[`eff_${thColumn}`] = effRounded;

                    if (models && Object.keys(models).length > 0) {
                        for (const [mName, mData] of Object.entries(models)) {
                            if (!modelsChanges[mName]) modelsChanges[mName] = {};
                            modelsChanges[mName][`actual_${thColumn}`] = mData.output_count;
                        }
                    } else {
                        if (!modelsChanges["--"]) modelsChanges["--"] = {};
                        modelsChanges["--"][`actual_${thColumn}`] = output_count;
                    }

                    // Update cache for today
                    if (isToday) {
                        cacheService.updateHour(machineName, thColumn, output_count, avg_cycle_time, efficiency);
                    }
                }

                // Build pending operations
                for (const [mName, mUpdates] of Object.entries(modelsChanges)) {
                    const mk = `${machineName}_${mName}`;
                    if (outputMap[mk]) {
                        pendingOps.push({ type: "update", table: "tb_output_actual", id: outputMap[mk].id, data: mUpdates, machineName });
                    } else {
                        pendingOps.push({ type: "create", table: "tb_output_actual", data: { machine_name: machineName, date: targetDate, model_name: mName, ...mUpdates }, machineName });
                    }
                }
                if (Object.keys(ctChanges).length > 0) {
                    if (ctMap[machineName]) {
                        pendingOps.push({ type: "update", table: "tb_cycle_time_actual", id: ctMap[machineName].id, data: ctChanges, machineName });
                    } else {
                        pendingOps.push({ type: "create", table: "tb_cycle_time_actual", data: { machine_name: machineName, date: targetDate, ...ctChanges }, machineName });
                    }
                }
                if (Object.keys(effChanges).length > 0) {
                    if (effMap[machineName]) {
                        pendingOps.push({ type: "update", table: "tb_efficiency_actual", id: effMap[machineName].id, data: effChanges, machineName });
                    } else {
                        pendingOps.push({ type: "create", table: "tb_efficiency_actual", data: { machine_name: machineName, date: targetDate, ...effChanges }, machineName });
                    }
                }
            }
            // ── Step 3.5: Zero out stale current hour data (today only) ──
            // flushMqttMemoryToDb bug may have written prev hour data to current hour column
            if (isToday) {
                const { thColumn: curThCol } = getCurrentHourBoundaries(now);
                const actualField = `actual_${curThCol}`;
                const cycleField = `cycle_${curThCol}`;
                const effField = `eff_${curThCol}`;

                for (const [machineName, dbRow] of Object.entries(outputMap)) {
                    if ((dbRow[actualField] || 0) <= 0) continue;

                    // Check if InfluxDB has data for this machine in current hour
                    const machineInflux = influxData[machineName];
                    let hasCurrentHourInflux = false;
                    if (machineInflux) {
                        for (const hourKey of Object.keys(machineInflux)) {
                            const utcHour = new Date(hourKey + ":00:00.000Z").getUTCHours();
                            if (utcHourToThColumn(utcHour) === curThCol) {
                                hasCurrentHourInflux = true;
                                break;
                            }
                        }
                    }

                    if (!hasCurrentHourInflux) {
                        pendingOps.push({ type: "update", table: "tb_output_actual", id: dbRow.id, data: { [actualField]: 0 }, machineName });
                        if (ctMap[machineName]) {
                            pendingOps.push({ type: "update", table: "tb_cycle_time_actual", id: ctMap[machineName].id, data: { [cycleField]: 0 }, machineName });
                        }
                        if (effMap[machineName]) {
                            pendingOps.push({ type: "update", table: "tb_efficiency_actual", id: effMap[machineName].id, data: { [effField]: 0 }, machineName });
                        }
                        cacheService.updateHour(machineName, curThCol, 0, 0, 0);
                        console.log(`   🧹 ${machineName}: zeroed stale ${actualField} (was ${dbRow[actualField]})`);
                    }
                }

                // ✅ Yield event loop to prevent UI freezing during large mapping
                await yieldEventLoop();
            }

            // ── Step 4: Batch execute pending operations ──
            if (pendingOps.length === 0) {
                console.log(`   📅 ${dateStr}: ✅ Up-to-date (${influxMachines.length} machines checked).`);
                continue;
            }

            let dayUpdated = 0;
            let dayCreated = 0;

            for (let b = 0; b < pendingOps.length; b += BATCH_SIZE) {
                const batch = pendingOps.slice(b, b + BATCH_SIZE);
                const txOps = batch.map(op => {
                    if (op.type === "update") {
                        return prisma[op.table].update({ where: { id: op.id }, data: op.data });
                    } else {
                        let whereClause = {};
                        if (op.table === "tb_output_actual") {
                            whereClause = { machine_name_date_model_name: { machine_name: op.data.machine_name, date: op.data.date, model_name: op.data.model_name || "--" } };
                        } else {
                            whereClause = { machine_name_date: { machine_name: op.data.machine_name, date: op.data.date } };
                        }
                        
                        // Use upsert instead of create to avoid duplicates from race conditions
                        return prisma[op.table].upsert({
                            where: whereClause,
                            update: op.data,
                            create: op.data,
                        });
                    }
                });

                try {
                    await prisma.$transaction(txOps);
                    for (const op of batch) {
                        if (op.type === "update") dayUpdated++;
                        else dayCreated++;
                    }
                } catch (batchErr) {
                    console.error(`   ❌ Batch error on ${dateStr} (batch ${Math.floor(b / BATCH_SIZE) + 1}):`, batchErr.message);
                    // Fallback: execute one by one so we don't lose all data in this batch
                    for (const op of batch) {
                        try {
                            if (op.type === "update") {
                                await prisma[op.table].update({ where: { id: op.id }, data: op.data });
                                dayUpdated++;
                            } else {
                                await prisma[op.table].create({ data: op.data });
                                dayCreated++;
                            }
                        } catch (singleErr) {
                            console.error(`   ❌ Single op failed: ${op.table} [${op.type}]:`, singleErr.message);
                        }
                    }
                }

                // Delay between batches to prevent connection pool exhaustion
                if (b + BATCH_SIZE < pendingOps.length) {
                    await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
                }
            }

            // ── Step 5: Recalculate Overall for this day ──
            const changedMachines = [...new Set(pendingOps.map(op => op.machineName).filter(Boolean))];
            const recalcMachines = changedMachines.length > 0 ? changedMachines : influxMachines;
            await recalcOverallInMSSQL(targetDate, recalcMachines);

            console.log(`   📅 ${dateStr}: ${dayUpdated} updated, ${dayCreated} created (${influxMachines.length} machines).`);
            totalUpdated += dayUpdated;
            totalCreated += dayCreated;
        }

        const totalChanged = totalUpdated + totalCreated;
        if (totalChanged > 0) {
            console.log(`✅ Backfill complete: ${totalUpdated} updated + ${totalCreated} created across ${BACKFILL_DAYS + 1} days.`);
        } else {
            console.log("✅ All data is up-to-date. No backfill needed.");
        }

    } catch (err) {
        console.error("❌ Backfill failed:", err.message);
    }
}

/**
 * Job 4: Hourly OEE upsert
 * Calculate Availability + Performance from MC Status → upsert tb_oee
 * ng_qty, quality, oee_value only written if still 0/null
 * ✅ Optimized: bulk-fetch output+target rows, batch upserts, yield event loop
 */
async function upsertOeeHourly() {
    try {
        const todayStr = getShiftDateUTC();
        const targetDate = new Date(todayStr);
        const now = new Date();

        // ✅ DB เก็บเวลาไทย (+7) ตรงๆ ใน Datetime column
        const year = parseInt(todayStr.substring(0, 4));
        const month = parseInt(todayStr.substring(5, 7)) - 1;
        const day = parseInt(todayStr.substring(8, 10));
        const shiftStart = new Date(Date.UTC(year, month, day, 7, 0, 0));
        const TH_OFFSET_MS = 7 * 60 * 60 * 1000;
        const nowTH = new Date(now.getTime() + TH_OFFSET_MS);

        // Query 1: Today's shift MC Status
        const todayMcStatus = await prisma.tb_MCStatus.findMany({
            where: { Datetime: { gte: shiftStart, lte: nowTH } },
            orderBy: { Datetime: "asc" },
            select: { MC: true, Datetime: true, MCStatus: true },
        });

        // Query 2: Last MC Status per machine BEFORE shiftStart (carry-over)
        const carryOverRows = await prisma.$queryRaw`
            SELECT MC, MCStatus, Datetime FROM (
                SELECT MC, MCStatus, Datetime, ROW_NUMBER() OVER (PARTITION BY MC ORDER BY Datetime DESC) AS rn
                FROM tb_MCStatus WHERE Datetime < ${shiftStart}
            ) t WHERE rn = 1
        `;

        // Build grouped records with carry-over prepended
        const mcStatusByMachine = {};
        for (const row of carryOverRows) {
            mcStatusByMachine[row.MC] = [{ MC: row.MC, Datetime: shiftStart, MCStatus: row.MCStatus }];
        }
        for (const rec of todayMcStatus) {
            if (!mcStatusByMachine[rec.MC]) mcStatusByMachine[rec.MC] = [];
            mcStatusByMachine[rec.MC].push(rec);
        }

        const machineNames = Object.keys(mcStatusByMachine);
        if (machineNames.length === 0) {
            console.log(`✅ [Cron] OEE hourly: no machines to process for ${todayStr}`);
            return;
        }

        // ✅ Bulk-fetch output + target rows for ALL machines (2 queries instead of N×2)
        const [allOutputRows, allTargetRows] = await Promise.all([
            prisma.tb_output_actual.findMany({ where: { date: targetDate } }),
            prisma.tb_output_target.findMany({ where: { date: targetDate } }),
        ]);
        // ✅ Group multi-model into per-hour fallback (Option B)
        const outputSumMap = {}; // { machineName: { actual_07: val, actual_08: val... } }
        // Group rows by machine first
        const machineRows = {};
        for (const row of allOutputRows) {
            if (!machineRows[row.machine_name]) machineRows[row.machine_name] = [];
            machineRows[row.machine_name].push(row);
        }
        // Then apply per-hour fallback for each machine
        for (const [mn, mRows] of Object.entries(machineRows)) {
            outputSumMap[mn] = {};
            for (const h of SHIFT_HOURS) {
                const realRows = mRows.filter(r => r.model_name !== "--" && (r[`actual_${h}`] || 0) > 0);
                if (realRows.length > 0) {
                    outputSumMap[mn][`actual_${h}`] = realRows.reduce((acc, r) => acc + (r[`actual_${h}`] || 0), 0);
                } else {
                    const dashRow = mRows.find(r => r.model_name === "--");
                    outputSumMap[mn][`actual_${h}`] = dashRow ? (dashRow[`actual_${h}`] || 0) : 0;
                }
            }
        }
        const targetMap = {};
        for (const row of allTargetRows) targetMap[row.machine_name] = row;

        // ✅ Bulk fetch NG (for over_reject logic)
        const allNgRows = await prisma.tb_machine_ng.findMany({ where: { date: targetDate } });
        const ngMap = {};
        for (const row of allNgRows) {
            if (!ngMap[row.machine_name]) ngMap[row.machine_name] = 0;
            for (const h of SHIFT_HOURS) {
                ngMap[row.machine_name] += (row[`ng_${h}`] || 0);
            }
        }

        // ✅ ดึง current hour output จาก InfluxDB
        const { start: currentHourStart } = getCurrentHourBoundaries(now);
        let currentHourData = {};
        try {
            currentHourData = await influxService.queryAllMachinesForHour(currentHourStart, now);
        } catch (e) {
            console.error("   ⚠️ OEE cron: failed to query InfluxDB for current hour:", e.message);
        }

        // ✅ Collect all upsert operations (CPU-only calculations, no DB calls)
        const upsertOps = [];

        for (const machineName of machineNames) {
            try {
                // Calc Availability and Performance dynamically
                const ngMode = getNgMode(machineName);
                const mcRecords = mcStatusByMachine[machineName] || [];
                const outputRow = outputSumMap[machineName]; // SUM ทุก model
                const targetRow = targetMap[machineName];
                
                let runTimeSeconds = 0;
                let excludedSeconds = 0;
                let totalActiveSeconds = 0;
                let totalOutput = 0;
                
                // For current hour output checking
                const currentData = currentHourData[machineName];
                // Determine current hour string (e.g. "09" or "14")
                const currentHourStr = nowTH.toISOString().substring(11, 13);

                for (let j = 0; j < SHIFT_HOURS.length; j++) {
                    const h = SHIFT_HOURS[j];
                    const isActive = !targetRow || (targetRow[`target_${h}`] > 0);
                    
                    const hStart = new Date(shiftStart.getTime() + j * 3600000);
                    const hEnd = new Date(hStart.getTime() + 3600000);

                    // Stop evaluating completely future hours
                    if (hStart >= nowTH) break;
                    
                    const blockEnd = new Date(Math.min(hEnd.getTime(), nowTH.getTime()));

                    if (isActive) {
                        // Sum actual output
                        // 🔧 Fix: current hour → prefer InfluxDB (live) INSTEAD OF MSSQL (not yet flushed)
                        //         past hours → use MSSQL (already summarized by hourly cron)
                        //         This prevents double-counting when both MSSQL and Influx have the same hour's data
                        if (h === currentHourStr) {
                            // Current active hour: use Influx live count OR fallback to MSSQL if Influx returns 0
                            const influxCount = (currentData && currentData.output_count > 0) ? currentData.output_count : 0;
                            const mssqlCount = outputRow ? (outputRow[`actual_${h}`] || 0) : 0;
                            totalOutput += influxCount > 0 ? influxCount : mssqlCount;
                        } else {
                            // Past hours: use MSSQL summarized data
                            totalOutput += (outputRow ? (outputRow[`actual_${h}`] || 0) : 0);
                        }

                        // Add runtime
                        const { runTimeSeconds: rTime, excludedSeconds: eTime } = calcMcStatusDurations(mcRecords, hStart, blockEnd);
                        runTimeSeconds += rTime;
                        excludedSeconds += eTime;
                        totalActiveSeconds += Math.max(0, (blockEnd.getTime() - hStart.getTime()) / 1000);
                    }
                }

                const availability = calcAvailability(runTimeSeconds, excludedSeconds, totalActiveSeconds);
                const idealCT = targetRow?.cycle_time_target || 0;
                
                // 🆕 ABR ng logic (over_reject): update effective output for performance
                let effectiveOutputForPerf = totalOutput;
                if (ngMode === "over_reject") {
                    const sumNg = ngMap[machineName] || 0;
                    effectiveOutputForPerf = Math.max(0, totalOutput - sumNg);
                }
                const performance = calcPerformance(effectiveOutputForPerf, idealCT, runTimeSeconds);

                // 🆕 Fetch existing OEE to get the saved ng_qty
                const existingOee = await prisma.tb_oee.findFirst({
                    where: { machine_name: machineName, date: targetDate }
                });
                const savedNgQty = existingOee?.ng_qty || 0;

                // 🆕 Recalculate Quality & OEE Value dynamically because totalOutput grows during the day
                let quality = 0;
                let oeeValue = 0;
                
                if (ngMode === "over_reject") {
                    quality = 100; // Always 100% for over_reject logic
                } else if (totalOutput > 0) {
                    quality = ((totalOutput - savedNgQty) / totalOutput) * 100;
                    if (quality < 0) quality = 0;
                }
                
                if (availability > 0 && performance > 0 && quality > 0) {
                    oeeValue = (availability / 100) * (performance / 100) * (quality / 100) * 100;
                }

                const dataToWrite = {
                    availability: parseFloat(availability.toFixed(2)),
                    performance: parseFloat(performance.toFixed(2)),
                    // 🆕 Must update quality and oee_value hourly!
                    quality: parseFloat(quality.toFixed(2)),
                    oee_value: parseFloat(oeeValue.toFixed(2)),
                };

                await prisma.tb_oee.upsert({
                    where: { machine_name_date: { machine_name: machineName, date: targetDate } },
                    update: dataToWrite,
                    create: { date: targetDate, machine_name: machineName, ...dataToWrite, ng_qty: 0, quality: 0, oee_value: 0 },
                });

                // ✅ Yield event loop inside heavy OEE calc
                await yieldEventLoop();
            } catch (err) {
                console.error(`   ❌ OEE calc failed for ${machineName}:`, err.message);
            }
        }

        console.log(`✅ [Cron] OEE hourly: updated machines for ${todayStr}`);
    } catch (err) {
        console.error("❌ OEE hourly cron failed:", err.message);
    }
}

/**
 * Job 5: Auto Plan Daily
 * อ่าน Config ทุกเครื่อง → สร้างแผนล่วงหน้า 7 วัน (ข้ามวันหยุด)
 */
async function autoPlanDaily() {
    try {
        const configs = await prisma.tb_machine_plan_config.findMany();
        let totalGenerated = 0;

        for (const config of configs) {
            try {
                const generated = await generatePlanForMachine(config);
                if (generated > 0) {
                    console.log(`   📋 ${config.machine_name}: สร้างแผน ${generated} วัน`);
                    totalGenerated += generated;
                }
            } catch (err) {
                console.error(`   ❌ Auto plan failed for ${config.machine_name}:`, err.message);
            }
        }

        console.log(`✅ [Cron] Auto plan complete: ${totalGenerated} plans for ${configs.length} machines`);
    } catch (err) {
        console.error("❌ Auto plan daily failed:", err.message);
    }
}

/**
 * Startup / Sync: Backfill OEE (Availability + Performance) for past days
 * ✅ recalc จาก MCStatus ย้อนหลัง → upsert tb_oee
 * ✅ Optimized: bulk-fetch output+target rows per date, batch upserts, yield event loop
 */
async function backfillOeeStartup(days = 5) {
    const BACKFILL_DAYS = days;
    console.log(`🔄 [Startup] Backfilling OEE (Availability/Performance) for last ${BACKFILL_DAYS} days...`);

    try {
        const now = new Date();
        const todayStr = getShiftDateUTC();
        let totalUpdated = 0;

        // Loop from oldest day → yesterday (today is handled by upsertOeeHourly)
        for (let i = BACKFILL_DAYS; i >= 1; i--) {
            const shiftDate = new Date(now);
            shiftDate.setUTCDate(shiftDate.getUTCDate() - i);
            const dateStr = shiftDate.toISOString().split("T")[0];
            const targetDate = new Date(dateStr);

            // Guard: do not backfill OEE before minimum allowed date
            if (targetDate < BACKFILL_MIN_DATE) {
                console.log(`   ⏭️ [OEE Backfill] Skip ${dateStr} (before BACKFILL_MIN_DATE)`);
                continue;
            }

            // Shift boundaries
            const year = parseInt(dateStr.substring(0, 4));
            const month = parseInt(dateStr.substring(5, 7)) - 1;
            const day = parseInt(dateStr.substring(8, 10));
            const shiftStart = new Date(Date.UTC(year, month, day, 7, 0, 0));
            const shiftEnd = new Date(Date.UTC(year, month, day + 1, 7, 0, 0));

            // Query MCStatus for this day's shift
            const mcStatusRows = await prisma.tb_MCStatus.findMany({
                where: { Datetime: { gte: shiftStart, lt: shiftEnd } },
                orderBy: { Datetime: "asc" },
                select: { MC: true, Datetime: true, MCStatus: true },
            });

            // Carry-over: last status before shift start
            const carryOverRows = await prisma.$queryRaw`
                SELECT MC, MCStatus, Datetime FROM (
                    SELECT MC, MCStatus, Datetime, ROW_NUMBER() OVER (PARTITION BY MC ORDER BY Datetime DESC) AS rn
                    FROM tb_MCStatus WHERE Datetime < ${shiftStart}
                ) t WHERE rn = 1
            `;

            // Group by machine
            const mcStatusByMachine = {};
            for (const row of carryOverRows) {
                mcStatusByMachine[row.MC] = [{ MC: row.MC, Datetime: shiftStart, MCStatus: row.MCStatus }];
            }
            for (const rec of mcStatusRows) {
                if (!mcStatusByMachine[rec.MC]) mcStatusByMachine[rec.MC] = [];
                mcStatusByMachine[rec.MC].push(rec);
            }

            const machineNames = Object.keys(mcStatusByMachine);
            if (machineNames.length === 0) {
                console.log(`   📅 ${dateStr}: No MCStatus data.`);
                continue;
            }

            // ✅ Bulk-fetch output + target + NG rows for this date (3 queries instead of N×3)
            const [allOutputRows, allTargetRows, allNgRows] = await Promise.all([
                prisma.tb_output_actual.findMany({ where: { date: targetDate } }),
                prisma.tb_output_target.findMany({ where: { date: targetDate } }),
                prisma.tb_machine_ng.findMany({ where: { date: targetDate } })
            ]);
            // 🔧 Fix: group all rows per machine (multi-model) instead of overwriting with single row
            const outputMap = {}; // { machineName: [rows] }
            for (const row of allOutputRows) {
                if (!outputMap[row.machine_name]) outputMap[row.machine_name] = [];
                outputMap[row.machine_name].push(row);
            }
            const targetMap = {};
            for (const row of allTargetRows) targetMap[row.machine_name] = row;
            const ngMap = {};
            for (const row of allNgRows) {
                if (!ngMap[row.machine_name]) ngMap[row.machine_name] = 0;
                for (const h of SHIFT_HOURS) {
                    ngMap[row.machine_name] += (row[`ng_${h}`] || 0);
                }
            }

            // ✅ Collect all upserts (CPU-only calculations, no DB calls in loop)
            const upsertOps = [];

            for (const machineName of machineNames) {
                try {
                    const mcRecords = mcStatusByMachine[machineName] || [];
                    const outputRows = outputMap[machineName] || []; // 🔧 now an array of all model rows
                    const targetRow = targetMap[machineName];

                    let runTimeSeconds = 0;
                    let excludedSeconds = 0;
                    let totalActiveSeconds = 0;
                    let totalOutput = 0;

                    let runtimeHData = {};
                    let availHData = {};

                    for (let j = 0; j < SHIFT_HOURS.length; j++) {
                        const h = SHIFT_HOURS[j];
                        const isActive = !targetRow || (targetRow[`target_${h}`] > 0);
                        
                        if (isActive) {
                            // 🔧 Fix: per-hour sum with multi-model fallback (same as oeeCalcService)
                            const realForHour = outputRows.filter(r => r.model_name !== '--' && (r[`actual_${h}`] || 0) > 0);
                            if (realForHour.length > 0) {
                                totalOutput += realForHour.reduce((acc, r) => acc + (r[`actual_${h}`] || 0), 0);
                            } else {
                                const dashRow = outputRows.find(r => r.model_name === '--');
                                totalOutput += dashRow ? (dashRow[`actual_${h}`] || 0) : 0;
                            }
                            const hStart = new Date(shiftStart.getTime() + j * 3600000);
                            const hEnd = new Date(hStart.getTime() + 3600000);
                            const { runTimeSeconds: rTime, excludedSeconds: eTime } = calcMcStatusDurations(mcRecords, hStart, hEnd);
                            
                            runTimeSeconds += rTime;
                            excludedSeconds += eTime;
                            totalActiveSeconds += 3600;

                            runtimeHData[`runtime_${h}`] = parseFloat(rTime.toFixed(2));
                            runtimeHData[`excluded_${h}`] = parseFloat(eTime.toFixed(2));
                            const hourAvail = calcAvailability(rTime, eTime, 3600);
                            availHData[`avail_${h}`] = parseFloat(hourAvail.toFixed(2));
                        }
                    }

                    // 🆕 [Phase 6] Backfill runtime hourly
                    await prisma.tb_mc_runtime_hourly.upsert({
                        where: { machine_name_date: { machine_name: machineName, date: targetDate } },
                        update: runtimeHData,
                        create: { machine_name: machineName, date: targetDate, ...runtimeHData }
                    });

                    // 🆕 [Phase 6] Backfill availability
                    await prisma.tb_availability_actual.upsert({
                        where: { machine_name_date: { machine_name: machineName, date: targetDate } },
                        update: availHData,
                        create: { machine_name: machineName, date: targetDate, ...availHData }
                    });

                    const availability = calcAvailability(runTimeSeconds, excludedSeconds, totalActiveSeconds);
                    const idealCT = targetRow?.cycle_time_target || 0;
                    
                    const ngMode = getNgMode(machineName);
                    let effectiveOutputForPerf = totalOutput;
                    if (ngMode === "over_reject") {
                        const sumNg = ngMap[machineName] || 0;
                        effectiveOutputForPerf = Math.max(0, totalOutput - sumNg);
                    }
                    const performance = calcPerformance(effectiveOutputForPerf, idealCT, runTimeSeconds);

                    // 🆕 Fetch existing OEE to get the saved ng_qty for backfilling
                    const existingOee = await prisma.tb_oee.findFirst({
                        where: { machine_name: machineName, date: targetDate }
                    });
                    const savedNgQty = existingOee?.ng_qty || 0;

                    let quality = 0;
                    let oeeValue = 0;
                    
                    // 🆕 ABR logic
                    if (ngMode === "over_reject") {
                        quality = 100;
                    } else if (totalOutput > 0) {
                        quality = ((totalOutput - savedNgQty) / totalOutput) * 100;
                        if (quality < 0) quality = 0;
                    }
                    
                    if (availability > 0 && performance > 0 && quality > 0) {
                        oeeValue = (availability / 100) * (performance / 100) * (quality / 100) * 100;
                    }

                    const dataToWrite = {
                        availability: parseFloat(availability.toFixed(2)),
                        performance: parseFloat(performance.toFixed(2)),
                        quality: parseFloat(quality.toFixed(2)),
                        oee_value: parseFloat(oeeValue.toFixed(2)),
                    };

                    await prisma.tb_oee.upsert({
                        where: { machine_name_date: { machine_name: machineName, date: targetDate } },
                        update: dataToWrite,
                        create: { date: targetDate, machine_name: machineName, ...dataToWrite, ng_qty: 0, quality: 0, oee_value: 0 },
                    });

                    // ✅ Yield event loop inside heavy historical calculation
                    await yieldEventLoop();
                } catch (err) {
                    console.error(`   ❌ OEE backfill calc failed for ${machineName} on ${dateStr}:`, err.message);
                }
            }

            // 🆕 [Phase 6] Recalculate totals for runtime and availability
            await recalcRuntimeAndAvailTotals(targetDate, machineNames);

            console.log(`   📅 ${dateStr}: OEE/Runtime backfilled for ${machineNames.length} machines.`);
            totalUpdated += machineNames.length;

            // ✅ Yield event loop between days
            await new Promise(resolve => setImmediate(resolve));
        }

        console.log(`✅ [Startup] OEE backfill complete: ${totalUpdated} records updated.`);
    } catch (err) {
        console.error("❌ OEE backfill startup failed:", err.message);
    }
}

/**
 * 🆕 Hourly summarized NG by station 
 * Reads InfluxDB for the past hour and upserts into tb_machine_ng
 */
async function summarizeNgHourly() {
    try {
        const now = new Date();
        const prevHourStart = new Date(now);
        prevHourStart.setUTCMinutes(0, 0, 0);
        prevHourStart.setUTCHours(prevHourStart.getUTCHours() - 1); // Go back 1 hour
        const prevHourEnd = new Date(prevHourStart);
        prevHourEnd.setUTCHours(prevHourEnd.getUTCHours() + 1);

        const dateStr = getShiftDateUTC(prevHourStart);
        const utcHour = prevHourStart.getUTCHours();
        const thColumn = utcHourToThColumn(utcHour);

        console.log(`🎯 [Cron] Summarizing NG for hour ${thColumn} (${dateStr})...`);

        // Get station config
        const stationsGrouped = await getStationConfigGrouped();
        const activeMachines = Object.keys(stationsGrouped);
        if (activeMachines.length === 0) return;

        let totalUpserts = 0;

        for (const machineName of activeMachines) {
             const stations = stationsGrouped[machineName];
             if (!stations || stations.length === 0) continue;

             const stationNgCounts = await influxService.queryNgByStationForHour(machineName, prevHourStart, prevHourEnd, stations);
             
             for (const st of stations) {
                 const ngVal = stationNgCounts[st.station_name] || 0;
                 if (ngVal > 0) {
                     await prisma.tb_machine_ng.upsert({
                         where: {
                             machine_name_date_station_id: {
                                 machine_name: machineName,
                                 date: new Date(dateStr),
                                 station_id: st.id      // ✅ Use station_id FK
                             }
                         },
                         update: {
                             [`ng_${thColumn}`]: ngVal
                         },
                         create: {
                             machine_name: machineName,
                             date: new Date(dateStr),
                             station_id: st.id,         // ✅ FK
                             [`ng_${thColumn}`]: ngVal
                         }
                     });
                     totalUpserts++;
                 }
             }

             // 🆕 Save True NG Parts as station_id = 0
             const trueNgVal = stationNgCounts['True_NG'] || 0;
             if (trueNgVal > 0) {
                 await prisma.tb_machine_ng.upsert({
                     where: {
                         machine_name_date_station_id: {
                             machine_name: machineName,
                             date: new Date(dateStr),
                             station_id: 0      // 🆕 0 represents True Part NG
                         }
                     },
                     update: { [`ng_${thColumn}`]: trueNgVal },
                     create: {
                         machine_name: machineName,
                         date: new Date(dateStr),
                         station_id: 0,
                         [`ng_${thColumn}`]: trueNgVal
                     }
                 });
                 totalUpserts++;
             }
             // 🆕 Sync RAM ngCache: MSSQL confirmed → realtimeService สามารถล้าง pendingPrevHour ได้
             cacheService.updateHourNg(machineName, thColumn, trueNgVal);
        }

        // Recalculate Overall_ng column for rows updated today
        await recalcOverallNg(new Date(dateStr));
        console.log(`✅ [Cron] NG summarized for ${dateStr} (upserted ${totalUpserts} station records)`);
    } catch (err) {
        console.error("❌ summarizeNgHourly failed:", err.message);
    }
}

/**
 * Helper to get active stations grouped by machine name
 */
async function getStationConfigGrouped() {
    const stations = await prisma.tbm_machine_station.findMany({
        where: { status: 'active' },
        orderBy: { station_number: 'asc' }
    });
    const grouped = {};
    for (const st of stations) {
        if (!grouped[st.machine_name]) grouped[st.machine_name] = [];
        grouped[st.machine_name].push(st);
    }
    return grouped;
}

/**
 * Recalculate the sum of ALL hour columns and update Overall_ng
 */
async function recalcOverallNg(targetDate) {
    const rows = await prisma.tb_machine_ng.findMany({
        where: { date: targetDate }
    });
    
    for (const row of rows) {
        let total = 0;
        for (const h of SHIFT_HOURS) {
            total += (row[`ng_${h}`] || 0);
        }
        await prisma.tb_machine_ng.update({
            where: { id: row.id },
            data: { Overall_ng: total }
        });
    }
}

/**
 * 🆕 Backfill NG data for a single day
 */
async function backfillNgSingleDay(startOfShift, endOfShift, dateStr) {
    const targetDate = new Date(dateStr);
    const stationsGrouped = await getStationConfigGrouped();
    const activeMachines = Object.keys(stationsGrouped);
    if (activeMachines.length === 0) return;

    let totalUpserts = 0;

    for (const machineName of activeMachines) {
        const stations = stationsGrouped[machineName];
        if (!stations || stations.length === 0) continue;

        // Loop over each hour of the shift
        let curHour = new Date(startOfShift);
        while (curHour < endOfShift) {
            const nextHour = new Date(curHour);
            nextHour.setUTCHours(nextHour.getUTCHours() + 1);

            // Break if the nextHour > endOfShift ONLY if it's the current hour we're backfilling
            const queryEnd = nextHour > endOfShift ? endOfShift : nextHour;
            const thColumn = utcHourToThColumn(curHour.getUTCHours());
            
            const stationNgCounts = await influxService.queryNgByStationForHour(machineName, curHour, queryEnd, stations);
            
            for (const st of stations) {
                 const ngVal = stationNgCounts[st.station_name] || 0;
                 if (ngVal > 0) {
                     await prisma.tb_machine_ng.upsert({
                         where: {
                             machine_name_date_station_id: {
                                 machine_name: machineName,
                                 date: targetDate,
                                 station_id: st.id      // ✅ Use station_id FK
                             }
                         },
                         update: {
                             [`ng_${thColumn}`]: ngVal
                         },
                         create: {
                             machine_name: machineName,
                             date: targetDate,
                             station_id: st.id,         // ✅ FK
                             [`ng_${thColumn}`]: ngVal
                         }
                     });
                     totalUpserts++;
                 }
             }

             // 🆕 Save True NG Parts as station_id = 0
             const trueNgVal = stationNgCounts['True_NG'] || 0;
             if (trueNgVal > 0) {
                 await prisma.tb_machine_ng.upsert({
                     where: {
                         machine_name_date_station_id: {
                             machine_name: machineName,
                             date: targetDate,
                             station_id: 0      // 🆕 0 represents True Part NG
                         }
                     },
                     update: { [`ng_${thColumn}`]: trueNgVal },
                     create: {
                         machine_name: machineName,
                         date: targetDate,
                         station_id: 0,
                         [`ng_${thColumn}`]: trueNgVal
                     }
                 });
                 totalUpserts++;
             }

            curHour = nextHour;
        }
    }
    await recalcOverallNg(targetDate);
    if (totalUpserts > 0) {
        console.log(`   🎯 NG Backfilled ${totalUpserts} station segments for ${dateStr}`);
    }
}

/**
 * 🆕 Backfill NG data on server startup / daily sync
 * Mirrors backfillStartup() logic — covers last N days + current moment (NOW)
 * Prevents NG data gaps when server was offline during a cron window
 */
async function backfillNgStartup(days = 5) {
    const BACKFILL_DAYS = days;
    console.log(`🔄 [Startup] Backfilling NG station data for last ${BACKFILL_DAYS} days + today...`);

    try {
        const now = new Date();
        const todayStr = getShiftDateUTC(now);

        for (let i = BACKFILL_DAYS; i >= 0; i--) {
            const shiftDate = new Date(now);
            shiftDate.setUTCDate(shiftDate.getUTCDate() - i);
            const dateStr = getShiftDateUTC(shiftDate);

            // Guard: do not backfill NG before minimum allowed date
            const ngTargetDate = new Date(dateStr);
            if (ngTargetDate < BACKFILL_MIN_DATE) {
                console.log(`   ⏭️ [NG Backfill] Skip ${dateStr} (before BACKFILL_MIN_DATE)`);
                continue;
            }

            const startOfShift = new Date(dateStr + "T00:00:00.000Z");
            let endOfShift;

            if (dateStr === todayStr) {
                // ✅ Today: up to NOW so any hours missed since last crash are backfilled
                endOfShift = new Date(now);
            } else {
                // Past days: full 24h window
                endOfShift = new Date(startOfShift);
                endOfShift.setUTCDate(endOfShift.getUTCDate() + 1);
            }

            await backfillNgSingleDay(startOfShift, endOfShift, dateStr);
        }

        console.log("✅ [Startup] NG backfill complete");
    } catch (err) {
        console.error("❌ backfillNgStartup failed:", err.message);
    }
}

/**
 * Core Logic to Sync Status and Alarm events from InfluxDB to MSSQL
 */
async function syncEventsFromInfluxDb(startUTC, endUTC) {
    const statusData = await influxService.queryStatusRange(startUTC, endUTC);
    const alarmData = await influxService.queryAlarmRange(startUTC, endUTC);

    const TH_OFFSET_MS = 7 * 60 * 60 * 1000;

    // MSSQL expects Thai Local Time physically stored in Datetime column.
    // So query range must also shift +7
    const startTH = new Date(startUTC.getTime() + TH_OFFSET_MS);
    const endTH = new Date(endUTC.getTime() + TH_OFFSET_MS);

    let statusRecovered = 0;
    let alarmRecovered = 0;

    // InfluxDB status_tb / alarm_tb always stores UTC timestamps (RFC3339).
    // MSSQL tb_MCStatus.Datetime stores Thai local time physically.
    // → Always add +7h. No conditional guessing needed.
    const getThaiTime = (utcDate) => new Date(utcDate.getTime() + TH_OFFSET_MS);

    if (statusData.length > 0) {
        const existingStatus = await prisma.tb_MCStatus.findMany({
            where: { Datetime: { gte: startTH, lt: endTH } },
            select: { MC: true, Datetime: true }
        });
        const existingSet = new Set(existingStatus.map(r => `${r.MC}_${r.Datetime.getTime()}`));

        const newStatus = statusData.filter(d => {
            return !existingSet.has(`${d.machine_name}_${getThaiTime(d.time).getTime()}`);
        });

        if (newStatus.length > 0) {
            await prisma.tb_MCStatus.createMany({
                data: newStatus.map(d => ({
                    Datetime: getThaiTime(d.time),
                    MC: d.machine_name,
                    MCStatus: d.status
                }))
            });
            statusRecovered = newStatus.length;
        }
    }

    if (alarmData.length > 0) {
        const existingAlarm = await prisma.tb_MCAlarm.findMany({
            where: { Datetime: { gte: startTH, lt: endTH } },
            select: { MC: true, Datetime: true }
        });
        const existingSet = new Set(existingAlarm.map(r => `${r.MC}_${r.Datetime.getTime()}`));

        const newAlarm = alarmData.filter(d => {
            return !existingSet.has(`${d.machine_name}_${getThaiTime(d.time).getTime()}`);
        });

        if (newAlarm.length > 0) {
            await prisma.tb_MCAlarm.createMany({
                data: newAlarm.map(d => ({
                    Datetime: getThaiTime(d.time),
                    MC: d.machine_name,
                    MCAlarm: d.alarm
                }))
            });
            alarmRecovered = newAlarm.length;
        }
    }

    if (statusRecovered > 0 || alarmRecovered > 0) {
        console.log(`   ✅ Recovered ${statusRecovered} Status and ${alarmRecovered} Alarm records from InfluxDB.`);
    }

    return { statusRecovered: statusRecovered > 0, alarmRecovered: alarmRecovered > 0 };
}

/**
 * Startup / Sync: Backfill historical Status and Alarm data from InfluxDB -> MSSQL
 * Used on server restart to recover missing real-time events.
 */
async function backfillEventsStartup(days = 5) {
    console.log(`🔄 [Startup] Backfilling last ${days} days for Status & Alarm from InfluxDB → MSSQL...`);
    try {
        const now = new Date();
        const start = new Date(now);
        start.setUTCDate(start.getUTCDate() - days);
        // Guard: clamp start to minimum allowed backfill date
        if (start < BACKFILL_MIN_DATE) {
            console.log(`   ⏭️ [Events Backfill] Clamped start from ${start.toISOString()} to BACKFILL_MIN_DATE`);
            start.setTime(BACKFILL_MIN_DATE.getTime());
        }
        await syncEventsFromInfluxDb(start, now);
    } catch (err) {
        console.error("❌ Events startup backfill failed:", err.message);
    }
}

/**
 * 🆕 5-Minute MSSQL Status Poller for Web Dashboard (Fallback mechanism)
 * Fetches the ABSOLUTE LATEST status & alarm from MSSQL for each machine
 * and updates mqttService memory + emits to web if it is newer.
 */
async function pollMssqlStatusForWeb() {
    try {
        const { updateStateFromMssqlPoller } = require("./mqttService");
        if (typeof updateStateFromMssqlPoller !== "function") return;

        console.log("🔍 [Cron] Polling latest MSSQL Status/Alarm for Web Sync...");

        const machines = await prisma.tbm_machine.findMany({
            where: { status: 'active' },
            select: { machine_name: true }
        });

        const statusRows = await prisma.$queryRaw`
            SELECT MC, MCStatus
            FROM (
                SELECT MC, MCStatus,
                       ROW_NUMBER() OVER (PARTITION BY MC ORDER BY Datetime DESC) AS rn
                FROM tb_MCStatus
            ) t
            WHERE rn = 1
        `;

        const alarmRows = await prisma.$queryRaw`
            SELECT MC, MCAlarm
            FROM (
                SELECT MC, MCAlarm,
                       ROW_NUMBER() OVER (PARTITION BY MC ORDER BY Datetime DESC) AS rn
                FROM tb_MCAlarm
            ) t
            WHERE rn = 1
        `;

        const statusMap = {};
        for (const row of statusRows || []) {
            statusMap[row.MC] = row.MCStatus;
        }

        const alarmMap = {};
        for (const row of alarmRows || []) {
            alarmMap[row.MC] = row.MCAlarm;
        }

        for (const m of machines) {
            const machineName = m.machine_name;
            updateStateFromMssqlPoller(machineName, statusMap[machineName], alarmMap[machineName]);
        }
    } catch (err) {
        console.error("❌ pollMssqlStatusForWeb failed:", err.message);
    }
}

/**
 * backfillRuntimeAvailStartup — Recalculate tb_mc_runtime_hourly + tb_availability_actual
 * สำหรับทุกชั่วโมงที่ผ่านมาแล้วในช่วง N วัน
 *
 * เรียกหลัง backfillEventsStartup เสมอ เพราะต้องการ MCStatus ที่ sync ล่าสุดแล้ว
 * @param {number} days - จำนวนวันย้อนหลัง (default 3)
 */
async function backfillRuntimeAvailStartup(days = 3) {
    console.log(`🔄 [RuntimeAvailBackfill] Starting for last ${days} day(s)...`);

    const now = new Date();
    // ชั่วโมง UTC ที่กำลังดำเนินอยู่ตอนนี้ (ยังไม่จบ → skip)
    const currentHourStart = new Date(now);
    currentHourStart.setUTCMinutes(0, 0, 0);
    currentHourStart.setUTCSeconds(0, 0);

    let totalHoursProcessed = 0;

    for (let i = days; i >= 0; i--) {
        const shiftDate = new Date(now);
        shiftDate.setUTCDate(shiftDate.getUTCDate() - i);
        const dateStr = shiftDate.toISOString().split("T")[0];
        const targetDate = new Date(dateStr);

        // Guard: do not recalculate runtime/availability before minimum allowed date
        if (targetDate < BACKFILL_MIN_DATE) {
            console.log(`   ⏭️ [RuntimeAvail Backfill] Skip ${dateStr} (before BACKFILL_MIN_DATE)`);
            continue;
        }

        // ดึงรายชื่อเครื่องที่มีข้อมูลในวันนั้น
        const outputRows = await prisma.tb_output_actual.findMany({
            where: { date: targetDate },
            select: { machine_name: true },
        });
        const machineNames = [...new Set(outputRows.map(r => r.machine_name))];

        if (machineNames.length === 0) {
            console.log(`   📅 ${dateStr}: No machines — skip`);
            continue;
        }

        console.log(`   📅 ${dateStr}: Recalculating ${SHIFT_HOURS.length} hours × ${machineNames.length} machines...`);
        let hoursProcessed = 0;

        for (const thCol of SHIFT_HOURS) {
            const utcHour = thColumnToUtcHour(thCol);
            const { start: startUTC, end: endUTC } = getHourBoundariesUTC(dateStr, utcHour);

            // Skip ชั่วโมงที่ยังดำเนินอยู่ (summarizeLastHour จะจัดการเอง)
            if (startUTC >= currentHourStart) continue;

            try {
                await upsertRuntimeAndAvailabilityForHour(thCol, startUTC, endUTC, targetDate, machineNames, null);
                hoursProcessed++;
            } catch (e) {
                console.error(`   ⚠️ [RuntimeAvailBackfill] ${dateStr} hour ${thCol}:`, e.message);
            }

            // Yield ทุกชั่วโมง เพื่อไม่บล็อก event loop
            await yieldEventLoop();
        }

        console.log(`   ✅ ${dateStr}: ${hoursProcessed} hours recalculated`);
        totalHoursProcessed += hoursProcessed;
        await yieldEventLoop();
    }

    console.log(`✅ [RuntimeAvailBackfill] Done — ${totalHoursProcessed} hour-slots recalculated across ${days + 1} day(s).`);
}

/**
 * runDailySync — sync InfluxDB → MSSQL สำหรับ N วันย้อนหลัง
 * Logic เดียวกับ dailySyncExpr cron job (07:15 TH)
 * เรียกได้ทั้งจาก cron และจาก startup เพื่อซ่อมแซมข้อมูลให้สอดคล้องกัน
 *
 * ลำดับที่ถูกต้อง:
 *   1. backfillStartup        — sync output/ct/eff จาก InfluxDB data_tb
 *   2. backfillNgStartup      — sync NG จาก InfluxDB ng_tb
 *   3. backfillEventsStartup  — sync MCStatus/Alarm จาก InfluxDB status_tb/alarm_tb (ก่อน OEE!)
 *   4. backfillRuntimeAvailStartup — recalc runtime + avail ต่อชั่วโมง ด้วย MCStatus ล่าสุด
 *   5. backfillOeeStartup     — คำนวณ OEE โดยใช้ runtime/avail ที่ถูกต้องแล้ว
 *
 * @param {number} days - จำนวนวันที่ต้องการ backfill (default 3)
 */
async function runDailySync(days = 3) {
    console.log(`🔄 [DailySync] Starting InfluxDB → MSSQL sync for last ${days} day(s)...`);
    await backfillStartup(days);              // 1. output/ct/eff
    await backfillNgStartup(days);            // 2. NG
    await backfillEventsStartup(days);        // 3. MCStatus/Alarm ← sync ก่อน OEE
    await backfillRuntimeAvailStartup(days);  // 4. Recalc runtime/avail ต่อชั่วโมง ← ใหม่
    await backfillOeeStartup(days);           // 5. OEE ← ใช้ MCStatus + runtime ที่ถูกต้องแล้ว
    console.log(`✅ [DailySync] Completed (${days} day(s) synced).`);
}

module.exports = {
    startCronJobs,
    runDailySync,
    summarizeLastHour,
    summarizeNgHourly,
    handleLateData,
    recalcOverallInMSSQL,
    backfillStartup,
    backfillNgStartup,
    backfillEventsStartup,
    backfillRuntimeAvailStartup,
    upsertOeeHourly,
    backfillOeeStartup,
    autoPlanDaily,
    syncEventsFromInfluxDb,
    pollMssqlStatusForWeb,
    upsertRuntimeAndAvailabilityForHour
};

