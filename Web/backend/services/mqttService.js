const mqtt = require("mqtt");
const dotenv = require("dotenv");
dotenv.config();

const { getShiftDateUTC, getCurrentHourBoundaries } = require("./../utils/timeUtils");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const fs = require("fs");
const path = require("path");

const machineCalcConfig = JSON.parse(fs.readFileSync(path.join(__dirname, "../config/machine_calc.json"), "utf8"));
const timezoneModes = machineCalcConfig.timezone_modes || {};
const defaultTzMode = timezoneModes["default"] || "local";
const MC_ALARM_MAX_LENGTH = 255;
const LEGACY_MC_ALARM_MAX_LENGTH = 50;
const MC_STATUS_REMARK_MAX_LENGTH = 255;

function truncateDbText(value, maxLength) {
    if (value === undefined || value === null) return null;
    const text = String(value);
    return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function parseUtcDateTime(value) {
    if (!value) return null;
    const text = String(value).trim();
    if (!text) return null;
    const normalized = text.includes("T") ? text : text.replace(" ", "T");
    const iso = normalized.endsWith("Z") ? normalized : `${normalized}Z`;
    const parsed = new Date(iso);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed;
}

function deriveAhvMachineNameFromHost(host) {
    if (!host) return null;
    const text = String(host);
    const match = text.match(/AHV[-_ ]?0*(\d{1,3})/i);
    if (!match) return null;
    const num = parseInt(match[1], 10);
    if (!Number.isFinite(num) || num <= 0) return null;
    return `AHV-${String(num).padStart(3, "0")}`;
}

function isDbValueTooLongError(error) {
    return String(error?.message || "").includes("too long for the column's type");
}

const getIsUTC = (machineName) => {
    for (const key of Object.keys(timezoneModes)) {
        if (key !== "default" && machineName.startsWith(key)) {
            return timezoneModes[key] === "utc";
        }
    }
    return defaultTzMode === "utc";
};

// 1. In-Memory Store for Machine States
// Key: machine_name, Value: Current State (current_hour_actual, current_hour_ng, cycle_time, etc.)
const machineStateMem = new Map();

// Helper to close out the hour and push to Cache immediately
function forceHourRolloverForMachine(machineName, currentState, currentThColumn) {
    if (!currentState) return;
    if (currentState.current_hour_label && currentState.current_hour_actual > 0) {
        try {
            const cacheService = require("./cacheService");
            const oldHour = currentState.current_hour_label;
            const oldOutput = currentState.current_hour_actual;
            const oldAvgCt = currentState.current_hour_actual > 0
                ? currentState.sum_cycle_time / currentState.current_hour_actual
                : 0;
            const theoreticalMax = oldAvgCt > 0 ? 3600 / oldAvgCt : 0;
            const oldEff = theoreticalMax > 0 ? (oldOutput / theoreticalMax) * 100 : 0;
            cacheService.updateHour(machineName, oldHour, oldOutput, oldAvgCt, oldEff);
        } catch (e) {
            console.error(`[MQTT] forceHourRolloverForMachine error:`, e.message);
        }
    }
    currentState.current_hour_actual = 0;
    currentState.current_hour_ng = 0;
    currentState.current_hour_station_ng = {}; 
    currentState.sum_cycle_time = 0;
    currentState.current_hour_label = currentThColumn;
}

// Function to force rollover for ALL machines (called by realtimeService at xx:00:00)
function forceHourRolloverAll(currentThColumn) {
    let count = 0;
    for (const [machineName, state] of machineStateMem.entries()) {
        if (state.current_hour_label !== currentThColumn) {
            forceHourRolloverForMachine(machineName, state, currentThColumn);
            count++;
        }
    }
    if (count > 0) {
        console.log(`🔄 [MQTT] Forced hour rollover to ${currentThColumn} for ${count} machines`);
    }
}

const OUTPUT_DEDUP_WINDOW_MS = Math.max(parseInt(process.env.OUTPUT_DEDUP_WINDOW_MS || "7200000", 10) || 0, 0);
const OUTPUT_DEDUP_MAX_KEYS_PER_MACHINE = Math.max(parseInt(process.env.OUTPUT_DEDUP_MAX_KEYS_PER_MACHINE || "10000", 10) || 0, 1000);
const outputDedupMem = new Map();

function shouldDropDuplicateOutput(machineName, dateTimeKey, nowMs) {
    if (!machineName || !dateTimeKey) return false;
    if (OUTPUT_DEDUP_WINDOW_MS <= 0) return false;

    let map = outputDedupMem.get(machineName);
    if (!map) {
        map = new Map();
        outputDedupMem.set(machineName, map);
    }

    const cutoff = nowMs - OUTPUT_DEDUP_WINDOW_MS;
    for (const [k, t] of map) {
        if (t >= cutoff && map.size <= OUTPUT_DEDUP_MAX_KEYS_PER_MACHINE) break;
        map.delete(k);
    }

    if (map.has(dateTimeKey)) return true;
    map.set(dateTimeKey, nowMs);
    return false;
}

// 2. In-Memory Store for Station Configs
// Key: machine_name, Value: Array of stations { station_number, station_name }
let stationConfigMem = new Map();

let localEmitToRoomFn = null;
let localBroadcastFn = null;

// Optional: Keep track of raw history if needed for other places
const initializeMqtt = async (emitToRoomFn, broadcastFn) => {
    localEmitToRoomFn = emitToRoomFn;
    localBroadcastFn = broadcastFn;
    // ✅ Pre-load station configs for MQTT parsing
    try {
        const { PrismaClient } = require("@prisma/client");
        const prisma = new PrismaClient();
        const stations = await prisma.tbm_machine_station.findMany({
            where: { status: 'active' },
            orderBy: { station_number: 'asc' }
        });
        
        stationConfigMem.clear();
        for (const st of stations) {
            if (!stationConfigMem.has(st.machine_name)) {
                stationConfigMem.set(st.machine_name, []);
            }
            stationConfigMem.get(st.machine_name).push(st);
        }
        console.log(`✅ [MQTT] Loaded station configs for ${stationConfigMem.size} machines`);
    } catch (e) {
        console.error("⚠️ [MQTT] Failed to load station configs:", e.message);
    }

    const mqttUrl = process.env.MQTT_URL || "mqtt://192.168.100.99:1883";
    // ✅ Hardcoded: dotenv strips # (treats as comment) so we can't use .env for wildcard topics
    const topic = "factory/#";

    console.log(`[MQTT] Connecting to broker at ${mqttUrl}...`);
    const client = mqtt.connect(mqttUrl, {
        clientId: `backend_server_${Math.random().toString(16).substring(2, 8)}`,
        clean: true,
        connectTimeout: 4000,
        reconnectPeriod: 1000,
    });

    client.on("connect", () => {
        console.log(`✅ [MQTT] Connected to broker successfully!`);
        client.subscribe(topic, { qos: 2 }, (err) => {
            if (err) {
                console.error("[MQTT] Subscribe Error:", err);
            } else {
                console.log(`✅ [MQTT] Subscribed to topic: ${topic}`);
            }
        });
    });

    client.on("message", async (topic, message) => {
        try {
            // Telegraf sends JSON Payload
            const data = JSON.parse(message.toString());
            const machineType = data.tags?.machine_type;
            const host = data.tags?.host || data.tags?.hostname;
            let machineName = data.tags?.machine_name;
            if (machineType === "AHV") {
                const derived = deriveAhvMachineNameFromHost(host);
                if (derived) machineName = derived;
            }

            if (!machineName) return;

            const now = new Date();

            // ✅ Fix: Use data timestamp instead of NOW for hour bucketing
            // Telegraf Starlark processor writes Date_Time_UTC from the actual .dat file
            let dataTime = now;
            if (data.fields?.Date_Time_UTC) {
                const parsed = parseUtcDateTime(data.fields.Date_Time_UTC);
                if (parsed) dataTime = parsed;
            }

            // ✅ Fix: Reject messages older than 25 hours (stale/replay data)
            const ageMs = now.getTime() - dataTime.getTime();
            if (ageMs > 25 * 60 * 60 * 1000) return;

            // Determine which hour this data actually belongs to (based on DATA time, not NOW)
            const { thColumn: dataThColumn } = getCurrentHourBoundaries(dataTime);
            const { thColumn: currentThColumn } = getCurrentHourBoundaries(now);

            const ct = data.fields?.cycle_time || 0;
            const isNg = data.fields?.judg_result && data.fields.judg_result.includes("NG");

            // ✅ 🆕 แยกประมวลผล Status / Alarm ก่อนตรวจสอบ thColumn
            // เพราะ Status/Alarm ไม่เกี่ยวกับการตัดชั่วโมง (และเพื่อป้องกันปัญหาเวลาคาบเกี่ยว)
            const measurementName = data.name;

            if (measurementName === "status_tb" || measurementName === "alarm_tb") {
                // ถ้าเก่าเกิน 5 นาทีให้ทิ้งไป (InfluxDB sync จะคอยถมประวัติย้อนหลังให้)
                // ป้องกันปัญหา Telegraf อ่านไฟล์ .csv ย้อนหลังแล้วสาดข้อมูลทีละ 10,000 record
                if (ageMs > 5 * 60 * 1000) return;

                let currentState = machineStateMem.get(machineName) || {
                    machine_name: machineName,
                    current_hour_actual: 0,
                    current_hour_ng: 0,
                    current_hour_station_ng: {},
                    last_cycle_time: 0,
                    sum_cycle_time: 0,
                    last_update: now,
                    current_hour_label: currentThColumn,
                    live_status: null,
                    live_alarm: null,
                };

                if (measurementName === "status_tb") {
                    const statusStr = data.fields?.Status;
                    if (statusStr) {
                                                // 1. เขียนลง MSSQL 
                        // ตรวจสอบจาก Config ว่าเครื่องส่งเวลามาเป็น UTC หรือไม่
                        const isUTC = getIsUTC(machineName);
                        let thaiDataTimeMs = dataTime.getTime();
                        if (isUTC) {
                            thaiDataTimeMs += 7 * 60 * 60 * 1000; // Convert UTC to Local Thai Time
                        }
                        const thaiDataTime = new Date(thaiDataTimeMs);

                        let remarkToSave = null;
                        if (statusStr === "MC_Alarm" || statusStr === "MC_Error") {
                            try {
                                const recentAlarm = await prisma.tb_MCAlarm.findFirst({
                                    where: { 
                                        MC: machineName,
                                        Datetime: { 
                                            gte: new Date(thaiDataTime.getTime() - 2000),
                                            lte: new Date(thaiDataTime.getTime() + 2000)
                                        }
                                    },
                                    orderBy: { Datetime: 'desc' },
                                    select: { MCAlarm: true }
                                });
                                if (recentAlarm) remarkToSave = recentAlarm.MCAlarm;
                            } catch (e) {
                                console.error(`[MQTT] recentAlarm lookup error for ${machineName}:`, e.message);
                            }
                        }

                        try {
                            await prisma.tb_MCStatus.create({
                                data: {
                                    Datetime: thaiDataTime,
                                    MC: machineName,
                                    MCStatus: statusStr,
                                    UTC_Time: dataTime, // 🆕 เก็บเวลา UTC เดิมไว้เพื่อประวัติที่ชัดเจน
                                    Remark: remarkToSave
                                }
                            });
                            // ✅ [Phase 2] Feed live status into In-Memory OEE Stopwatch
                            // เรียก processStatusChange ทันทีหลังเขียน MSSQL สำเร็จ
                            // เพื่อให้ Stopwatch เริ่มนับวินาทีใหม่จาก status นี้ได้เลย
                            try {
                                const memOeeService = require('./memoryOeeService');
                                // 🆕 Pass dataTime (Pure UTC) to memoryOeeService
                                memOeeService.processStatusChange(machineName, statusStr, dataTime);
                            } catch (memErr) {
                                console.error(`[MQTT] memoryOeeService.processStatusChange error (${machineName}):`, memErr.message);
                            }
                        } catch (e) {
                            console.error(`[MQTT] tb_MCStatus Insert Error for ${machineName}:`, e.message);
                        }

                        // 2. เมื่อเขียนเสร็จให้ไปดึงจาก MSSQL มาแสดง เพื่อ update ปัจจุบัน
                        const latestStatus = await prisma.tb_MCStatus.findFirst({
                            where: { MC: machineName },
                            orderBy: { Datetime: 'desc' },
                            select: { MCStatus: true, Datetime: true }
                        });
                        
                        if (latestStatus) {
                            currentState.live_status = latestStatus.MCStatus;
                            currentState.last_update = now;
                            machineStateMem.set(machineName, currentState);

                            // แปลงกลับเป็น UTC จริง (ลบ 7 ชั่วโมง) ก่อนแจ้งให้ Frontend
                            // ถ้าเวลาล่าสุดมันเป็น Local Thai (เดินหน้าไป 7 ชม.) 
                            // เราต้องลบ 7 กลับเป็น UTC ก่อนใช้แสดงในไทม์ไลน์หน้าบ้าน
                            let realUtcMs = latestStatus.Datetime.getTime();
                            if (realUtcMs - Date.now() > 3 * 3600 * 1000) {
                                realUtcMs -= 7 * 60 * 60 * 1000;
                            }
                            const realUtcTime = new Date(realUtcMs);

                            // (Removed pushRealtimeMcStatus call)

                            const mcUpdatePayload = { machine_name: machineName, status: latestStatus.MCStatus, datetime: realUtcTime.toISOString() };
                            if (localEmitToRoomFn) localEmitToRoomFn(`machine:${machineName}`, "mc_status_updated", mcUpdatePayload);
                            if (localBroadcastFn) localBroadcastFn("mc_status_updated", mcUpdatePayload);
                        }
                    }
                } else if (measurementName === "alarm_tb") {
                    const alarmStr = data.fields?.Alarm;
                    if (alarmStr) {
                        const alarmToSave = truncateDbText(alarmStr, MC_ALARM_MAX_LENGTH);
                        const remarkToSave = truncateDbText(alarmStr, MC_STATUS_REMARK_MAX_LENGTH);
                        if (String(alarmStr).length > MC_ALARM_MAX_LENGTH) {
                            console.warn(`[MQTT] Alarm text truncated for ${machineName}: ${String(alarmStr).length} -> ${MC_ALARM_MAX_LENGTH}`);
                        }
                                                // 1. เขียนลง MSSQL 
                        const isUTC = getIsUTC(machineName);
                        let thaiDataTimeMs = dataTime.getTime();
                        if (isUTC) {
                            thaiDataTimeMs += 7 * 60 * 60 * 1000; // Convert UTC to Local Thai Time
                        }
                        const thaiDataTime = new Date(thaiDataTimeMs);

                        try {
                            await prisma.tb_MCAlarm.create({
                                data: {
                                    Datetime: thaiDataTime,
                                    MC: machineName,
                                    MCAlarm: alarmToSave,
                                    UTC_Time: dataTime // 🆕 เก็บเวลา UTC เดิมไว้
                                }
                            });
                        } catch (e) {
                            let savedWithLegacyFallback = false;
                            if (isDbValueTooLongError(e) && String(alarmToSave).length > LEGACY_MC_ALARM_MAX_LENGTH) {
                                try {
                                    await prisma.tb_MCAlarm.create({
                                        data: {
                                            Datetime: thaiDataTime,
                                            MC: machineName,
                                            MCAlarm: truncateDbText(alarmToSave, LEGACY_MC_ALARM_MAX_LENGTH),
                                            UTC_Time: dataTime
                                        }
                                    });
                                    console.warn(`[MQTT] tb_MCAlarm.MCAlarm still appears to be NVARCHAR(${LEGACY_MC_ALARM_MAX_LENGTH}); saved legacy truncated alarm for ${machineName}. Expand the MSSQL column to NVARCHAR(${MC_ALARM_MAX_LENGTH}) to store full text.`);
                                    savedWithLegacyFallback = true;
                                } catch (retryError) {
                                    console.error(`[MQTT] tb_MCAlarm Insert Retry Error for ${machineName}:`, retryError.message);
                                    savedWithLegacyFallback = true;
                                }
                            }
                            if (!savedWithLegacyFallback) {
                                console.error(`[MQTT] tb_MCAlarm Insert Error for ${machineName}:`, e.message);
                            }
                        }

                        // 🆕 Update recent MC_Alarm status with this remark
                        try {
                            const recentStatus = await prisma.tb_MCStatus.findFirst({
                                where: {
                                    MC: machineName,
                                    MCStatus: { in: ["MC_Alarm", "MC_Error"] },
                                    Datetime: { 
                                        gte: new Date(thaiDataTime.getTime() - 2000),
                                        lte: new Date(thaiDataTime.getTime() + 2000)
                                    },
                                    Remark: null
                                },
                                orderBy: { Datetime: 'desc' }
                            });

                            if (recentStatus) {
                                await prisma.tb_MCStatus.update({
                                    where: { ID: recentStatus.ID },
                                    data: { Remark: remarkToSave }
                                });
                            }
                        } catch (e) {
                            console.error(`[MQTT] tb_MCStatus Remark Update Error:`, e.message);
                        }

                        // 2. ไปดึงจาก MSSQL มาแสดง
                        const latestAlarm = await prisma.tb_MCAlarm.findFirst({
                            where: { MC: machineName },
                            orderBy: { Datetime: 'desc' },
                            select: { MCAlarm: true, Datetime: true }
                        });
                        
                        if (latestAlarm) {
                            currentState.live_alarm = latestAlarm.MCAlarm;
                            currentState.last_update = now;
                            machineStateMem.set(machineName, currentState);

                            let realUtcMs = latestAlarm.Datetime.getTime();
                            if (realUtcMs - Date.now() > 3 * 3600 * 1000) {
                                realUtcMs -= 7 * 60 * 60 * 1000;
                            }
                            const realUtcTime = new Date(realUtcMs);

                            const alarmUpdatePayload = { machine_name: machineName, alarm: latestAlarm.MCAlarm, datetime: realUtcTime.toISOString() };
                            if (localEmitToRoomFn) localEmitToRoomFn(`machine:${machineName}`, "mc_status_updated", alarmUpdatePayload);
                            if (localBroadcastFn) localBroadcastFn("mc_status_updated", alarmUpdatePayload);
                        }
                    }
                }
                return; // จบการทำงาน Status / Alarm
            }

            // ถ้าไม่ใช่ status_tb หรือ alarm_tb (เป็น Output/Data)
            // ✅ Fix: ข้อมูลชั่วโมงเก่า → Drop ทิ้ง (ให้ InfluxDB + MSSQL Cron จัดการ)
            if (dataThColumn !== currentThColumn) {
                return;
            }

            // ── Current hour data → accumulate in machineStateMem as before ──

            let currentState = machineStateMem.get(machineName) || {
                machine_name: machineName,
                current_hour_actual: 0,
                current_hour_ng: 0,
                current_hour_station_ng: {}, // 🆕 Per-station NG counts
                last_cycle_time: 0,
                sum_cycle_time: 0,
                last_update: now,
                current_hour_label: currentThColumn, // initialize correctly
                live_status: null,
                live_alarm: null,
            };

            // ถ้าไม่ใช่ status_tb หรือ alarm_tb แต่อาจเป็น data_tb หรือ mqtt_consumer ก็ประมวลผลต่อ (บวก Output)

            // If hour changed, flush old hour to cache THEN reset the accumulator
            if (currentState.current_hour_label !== currentThColumn) {
                forceHourRolloverForMachine(machineName, currentState, currentThColumn);
            }

            // Aggregate data (1 message = 1 part)
            if (machineType === "AHV") {
                const raw = data.fields?.Date_Time_UTC;
                const dtKey = raw != null ? String(raw).trim() : "";
                if (dtKey && shouldDropDuplicateOutput(machineName, dtKey, now.getTime())) {
                    return;
                }
            }

            currentState.current_hour_actual += 1;
            if (isNg) {
                currentState.current_hour_ng += 1;
                
                // 🆕 Parse judg_result for per-station NG
                const stations = stationConfigMem.get(machineName);
                if (stations && data.fields?.judg_result) {
                    const resultsArray = data.fields.judg_result.split(',');
                    let isPartNg = false; // 🆕 Track if this specific part is NG
                    
                    for (const st of stations) {
                        // ng_id = position in judg_result (1-indexed)
                        // station_number = UI column order only
                        const index = st.ng_id - 1;
                        if (index >= 0 && index < resultsArray.length && resultsArray[index].trim() === 'NG') {
                            currentState.current_hour_station_ng[st.station_name] = 
                                (currentState.current_hour_station_ng[st.station_name] || 0) + 1;
                            isPartNg = true;
                        }
                    }
                    
                    // 🆕 Record True NG Parts
                    if (isPartNg) {
                        currentState.current_hour_station_ng['True_NG'] = 
                            (currentState.current_hour_station_ng['True_NG'] || 0) + 1;
                    }
                }
            }

            // ✅ Track sum for proper average CT calculation
            if (ct > 0) {
                currentState.sum_cycle_time += ct;
            }
            currentState.last_cycle_time = currentState.current_hour_actual > 0
                ? currentState.sum_cycle_time / currentState.current_hour_actual
                : ct;
            currentState.last_update = now;

            machineStateMem.set(machineName, currentState);

            // ✅ fastPollAndEmit (realtimeService.js) reads from machineStateMem every 2s
            // and emits "realtime_output" to frontend — no need to emit from here

        } catch (err) {
            console.error("[MQTT] Error processing message:", err.message);
        }
    });

    client.on("error", (err) => {
        console.error("[MQTT] Connection error:", err.message);
    });

    client.on("offline", () => {
        console.warn("[MQTT] Client goes offline");
    });

    client.on("reconnect", () => {
        console.log("[MQTT] Reconnecting...");
        // ✅ Fix: Re-sync memory from InfluxDB after reconnect
        // Delay 3s to let reconnect complete + data flush
        setTimeout(async () => {
            try {
                await hydrateMqttMemoryFromInflux();
                console.log("✅ [MQTT] Memory re-synced after reconnect");
            } catch (err) {
                console.error("⚠️ [MQTT] Reconnect re-sync failed:", err.message);
            }
        }, 3000);
    });
};

const getMachineStateMem = () => machineStateMem;

/**
 * Cold Boot Recovery: Set MQTT Memory to match InfluxDB for the current hour.
 * Called AFTER backfillStartup (MSSQL is already correct)
 * and BEFORE initializeMqtt (MQTT hasn't started yet).
 */
async function hydrateMqttMemoryFromInflux() {
    try {
        const influxService = require("./influxService");
        const now = new Date();
        const { thColumn, start } = getCurrentHourBoundaries(now);

        console.log(`🔄 [MQTT] Syncing memory for current hour (${thColumn}) from InfluxDB...`);

        const machineData = await influxService.queryAllMachinesForHour(start, now);
        let count = 0;

        for (const [machineName, data] of Object.entries(machineData)) {
            const outputCount = data.output_count || 0;
            const avgCt = data.avg_cycle_time || 0;
            
            // 🆕 Sync station NG via queryNgByStationForHour
            let stationNg = {};
            const stations = stationConfigMem.get(machineName);
            if (stations && stations.length > 0) {
                stationNg = await influxService.queryNgByStationForHour(machineName, start, now, stations);
            }

            machineStateMem.set(machineName, {
                machine_name: machineName,
                current_hour_actual: outputCount,
                current_hour_ng: 0, // ng count for OEE handled by summarizeLastHour
                current_hour_station_ng: stationNg, // 🆕 Sync station NG
                last_cycle_time: avgCt,
                sum_cycle_time: avgCt * outputCount, // reconstruct sum from avg
                last_update: now,
                current_hour_label: thColumn,
                live_status: null, // Reset status on initial full sync
                live_alarm: null,
            });
            count++;
        }

        console.log(`✅ [MQTT] Memory synced: ${count} machines loaded for hour ${thColumn}`);
    } catch (err) {
        console.error("⚠️ [MQTT] Memory sync failed:", err.message);
    }
}

/**
 * Delayed Re-sync: Correct MQTT memory after MQTT has subscribed.
 * Called 5 seconds after initializeMqtt to eliminate timing gap.
 * Uses absolute overwrite — InfluxDB is source of truth.
 * ✅ Low-spec friendly: single lightweight query, runs only once.
 */
function scheduleResync() {
    setTimeout(async () => {
        try {
            const influxService = require("./influxService");
            const now = new Date();
            const { thColumn, start } = getCurrentHourBoundaries(now);

            const machineData = await influxService.queryAllMachinesForHour(start, now);

            for (const [machineName, data] of Object.entries(machineData)) {
                const currentState = machineStateMem.get(machineName);
                if (!currentState || currentState.current_hour_label !== thColumn) continue;

                const influxCount = data.output_count || 0;
                const influxAvgCt = data.avg_cycle_time || 0;

                // 🆕 Sync station NG via queryNgByStationForHour
                let stationNg = currentState.current_hour_station_ng || {};
                const stations = stationConfigMem.get(machineName);
                if (stations && stations.length > 0) {
                    stationNg = await influxService.queryNgByStationForHour(machineName, start, now, stations);
                }

                // ✅ Overwrite with InfluxDB truth — fixes any timing gap drift
                currentState.current_hour_actual = influxCount;
                currentState.sum_cycle_time = influxAvgCt * influxCount;
                currentState.last_cycle_time = influxAvgCt;
                currentState.current_hour_station_ng = stationNg; // 🆕 Overwrite station NG
                machineStateMem.set(machineName, currentState);
            }

            console.log(`✅ [MQTT] Re-synced memory from InfluxDB (${Object.keys(machineData).length} machines)`);
        } catch (err) {
            console.error("⚠️ [MQTT] Re-sync failed:", err.message);
        }
    }, 5000);
}

/**
 * Update state from the 5-Minute MSSQL Poller fallback mechanism.
 * Forces the memory to match the latest MSSQL database row and emits to Web UI.
 */
function updateStateFromMssqlPoller(machineName, liveStatus, liveAlarm) {
    if (!machineStateMem.has(machineName)) {
        // We only patch initialized machines, or we could create a dummy state
        machineStateMem.set(machineName, {
            machine_name: machineName,
            current_hour_actual: 0,
            current_hour_ng: 0,
            current_hour_station_ng: {},
            last_cycle_time: 0,
            sum_cycle_time: 0,
            last_update: new Date(),
            current_hour_label: "",
            live_status: liveStatus,
            live_alarm: liveAlarm,
        });
    }

    const state = machineStateMem.get(machineName);
    let changed = false;

    if (liveStatus !== undefined && state.live_status !== liveStatus) {
        state.live_status = liveStatus;
        if (liveStatus !== null) {
            const payload = { machine_name: machineName, status: liveStatus, datetime: new Date().toISOString() };
            if (localEmitToRoomFn) localEmitToRoomFn(`machine:${machineName}`, "mc_status_updated", payload);
            if (localBroadcastFn) localBroadcastFn("mc_status_updated", payload);
            changed = true;
        }
    }

    if (liveAlarm !== undefined && state.live_alarm !== liveAlarm) {
        state.live_alarm = liveAlarm;
        if (liveAlarm !== null) {
            const payload = { machine_name: machineName, alarm: liveAlarm, datetime: new Date().toISOString() };
            if (localEmitToRoomFn) localEmitToRoomFn(`machine:${machineName}`, "mc_status_updated", payload);
            if (localBroadcastFn) localBroadcastFn("mc_status_updated", payload);
            changed = true;
        }
    }

    if (changed) {
        state.last_update = new Date();
    }
}

/**
 * Restore state into MQTT memory (from state snapshot)
 */
function restoreMachineStateMem(snapshotObj) {
    machineStateMem.clear();
    for (const [key, value] of Object.entries(snapshotObj)) {
        if (value.last_update) value.last_update = new Date(value.last_update);
        machineStateMem.set(key, value);
    }
}

module.exports = {
    initializeMqtt,
    getMachineStateMem,
    restoreMachineStateMem,
    hydrateMqttMemoryFromInflux,
    scheduleResync,
    updateStateFromMssqlPoller,
    forceHourRolloverAll
};
