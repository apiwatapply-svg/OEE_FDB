/**
 * Worker Thread — Realtime Services
 * ================================
 * Runs: MQTT, Real-time Polling, InfluxDB, Cache
 * ไม่มี: Cron Jobs (ย้ายไป worker_cron.js แล้ว)
 * ไม่มี: Express/Socket.IO — ส่ง payload กลับ Main Thread ผ่าน IPC
 *
 * IPC IN (รับจาก Main Thread):
 *   { type: "save_snapshot" }   — Graceful shutdown trigger
 *   { type: "cache_reload" }    — โหลด cache ใหม่จาก MSSQL (ส่งมาจาก cron worker)
 *   { type: "cache_rollover" }  — clearAndRollover สำหรับวันใหม่
 */
require("dotenv").config();
const { parentPort } = require("worker_threads");

// ── IPC Emit Functions ─────────────────────────────────
// แทน Socket.IO — ส่ง message กลับ Main Thread ให้ emit ให้

function emitToRoom(room, event, data) {
    parentPort.postMessage({ type: "emit", room, event, data });
}

function broadcast(event, data) {
    parentPort.postMessage({ type: "broadcast", event, data });
}

function log(message) {
    parentPort.postMessage({ type: "log", message });
}

// ── Load Services ──────────────────────────────────────
const { initClient } = require("./services/influxService");
const { hydrateFromMSSQL, hydrateAvailabilityFromMSSQL, hydrateRuntimeFromMSSQL, clearAndRollover } = require("./services/cacheService");
// Phase 11: State Snapshot Service — Checkpoint + Boot Recovery + Graceful Shutdown
const { loadAndRestore, startCheckpoint } = require("./services/stateSnapshotService");
// 🆕 pollMssqlStatusForWeb ย้ายมาอยู่ใน worker.js เพราะต้องการ mqttService instance ของ realtime thread
// (updateStateFromMssqlPoller ใช้ machineStateMem + localEmitToRoomFn ที่ init ใน worker.js)
const { pollMssqlStatusForWeb } = require("./services/cronService");
const { startRealtimePolling } = require("./services/realtimeService");
const {
    initializeMqtt,
    hydrateMqttMemoryFromInflux,
    scheduleResync,
} = require("./services/mqttService");

// Debounce flag + accumulated reasons: รอให้ hydrateFromMSSQL สจิระก่อน fire
// เก็บ reasons ทุกตัวที่มาในช่วง debounce เพื่อสรุปละว่าต้อง reloadAvail/reloadNg ด้วยไหม
let cacheReloadPending = false;
const cacheReloadReasons = new Set(); // เก็บ reasons ที่มาถึงระหว่าง debounce (ไม่ทิ้ง)

// ── Startup Sequence ───────────────────────────────────
async function startup() {
    try {
        log("🔧 Worker thread starting (Realtime only)...");

        // 1. Initialize InfluxDB client
        initClient();

        // 1.5. Phase 11: Boot Recovery — restore RAM state from snapshot (InfluxDB gap fill included)
        // ถ้า backup ไม่เก่าเกิน 2 ชม. จะ restore mqttMem + oeeState กลับมา แล้ว fill gap จาก InfluxDB
        // ถ้าไม่มี backup หรือ backup เก่าเกินไป → cold boot ตามปกติ
        await loadAndRestore();

        // 2. Hydrate cache from MSSQL (initial load สำหรับ realtime thread)
        // หมายเหตุ: cron worker จะ notify cache_reload หลัง backfill เสร็จ → hydrate ใหม่
        await hydrateFromMSSQL();

        // 2.1–2.16: backfillStartup, backfillNgStartup, backfillEventsStartup
        // ถูกย้ายไปรันใน worker_cron.js แล้ว (คนละ thread ไม่กระทบ UI)

        // 2.2 Hydrate Availability + Runtime cache
        await hydrateAvailabilityFromMSSQL();
        await hydrateRuntimeFromMSSQL();

        // 2.3–2.4: upsertOeeHourly, backfillOeeStartup
        // ถูกย้ายไปรันใน worker_cron.js แล้ว

        // 2.5 🆕 [Phase 4] Hydrate OEE Memory Stopwatch from MSSQL (cold-boot recovery)
        // ถ้า server รีสตาร์ทกลางวัน stopwatch จะถูก rebuild จาก MCStatus history ทันที
        const memOeeService = require('./services/memoryOeeService');
        const { getShiftDateUTC } = require('./utils/timeUtils');
        const todayShiftDate = getShiftDateUTC();
        await memOeeService.hydrateFromMssql(todayShiftDate);
        log(`✅ OEE memory stopwatch hydrated (shift: ${todayShiftDate})`);

        // 3. ไม่ startCronJobs() ที่นี่ — ย้ายไป worker_cron.js แล้ว

        // 4. Start real-time polling (emit via IPC instead of Socket.IO)
        startRealtimePolling(emitToRoom, broadcast);

        // 4.5 Sync MQTT memory from InfluxDB for current hour
        await hydrateMqttMemoryFromInflux();

        // 4.6 Start MQTT Service — receives ONLY new messages after this point
        initializeMqtt(emitToRoom, broadcast);

        // 4.7 Re-sync MQTT memory from InfluxDB after 5s (fix timing gap)
        scheduleResync();

        // 4.8 🆕 Force initial poll from MSSQL to populate live Status/Alarm in memory
        await pollMssqlStatusForWeb();

        const pollIntervalMs = Math.max(10000, Number(process.env.MSSQL_STATUS_POLL_MS || 300000));
        setInterval(async () => {
            try {
                await pollMssqlStatusForWeb();
            } catch (err) {
                console.error("[Worker] pollMssqlStatusForWeb error:", err.message);
            }
        }, pollIntervalMs);

        // 4.9 Phase 11: Start Checkpoint timer — save state to disk every 5 minutes
        // ต้องเริ่มหลังจาก services ทั้งหมดพร้อมแล้ว เพื่อให้ snapshot มีข้อมูลครบ
        startCheckpoint();

        log("✅ Worker thread startup completed! (Realtime ready — cron in separate thread)");
    } catch (err) {
        console.error("❌ Worker startup failed:", err);
        process.exit(1);
    }
}

startup();

// Phase 11: รับ IPC message จาก Main Thread
parentPort.on("message", async (msg) => {
    if (!msg || !msg.type) return;

    // Graceful Shutdown: Main Thread ส่ง save_snapshot มา
    if (msg.type === "save_snapshot") {
        try {
            const snapshotService = require("./services/stateSnapshotService");
            snapshotService.saveNow();
            console.log("[Worker] Snapshot saved on shutdown request.");
        } catch (e) {
            console.error("[Worker] Failed to save snapshot on shutdown:", e.message);
        }
        // แจ้ง Main Thread ว่า save เสร็จแล้ว → safe to call server.close()
        parentPort.postMessage({ type: "snapshot_saved" });
    }

    // 🆕 Cache Reload: Cron Worker แจ้งว่า MSSQL อัปเดตแล้ว
    // Debounce 3วิ: เพื่อป้องกัน hydrateFromMSSQL() ถูกเรียกซ้ำคืน cron startup
    // เก็บทุก reason สะสมไว้ใน Set — ไม่ทิ้ง reason ใดเลย
    if (msg.type === "cache_reload") {
        // เพิ่ม reason เข้า Set
        if (msg.reason) cacheReloadReasons.add(msg.reason);

        if (!cacheReloadPending) {
            cacheReloadPending = true;
            setTimeout(async () => {
                // สำเนา reasons ที่สะสมไว้ทั้งหมด แล้วล้าง Set
                const reasons = new Set(cacheReloadReasons);
                cacheReloadReasons.clear();

                try {
                    const cacheServiceModule = require("./services/cacheService");
                    await cacheServiceModule.hydrateFromMSSQL();

                    if ([...reasons].includes("events_backfill_done")) {
                        try {
                            const memOeeService = require("./services/memoryOeeService");
                            const { getShiftDateUTC } = require("./utils/timeUtils");
                            const shiftDate = getShiftDateUTC();
                            await memOeeService.hydrateFromMssql(shiftDate);
                            console.log(`[Worker] ✅ memoryOeeService rehydrated (shift: ${shiftDate})`);
                        } catch (rehydrateErr) {
                            console.error("[Worker] memoryOeeService rehydrate failed:", rehydrateErr.message);
                        }
                    }

                    // reloadAvail ถ้ามี reason ที่เกี่ยวกับ MCStatus/OEE
                    const needsAvail = ["hourly_done", "oee_hourly_done", "oee_startup_done",
                                        "oee_backfill_done", "backfill_startup_done", "daily_sync_done", "events_backfill_done"];
                    if ([...reasons].some(r => needsAvail.includes(r))) {
                        await cacheServiceModule.hydrateAvailabilityFromMSSQL();
                    }

                    // reloadNg ถ้ามี reason ที่เกี่ยวกับ NG
                    const needsNg = ["ng_hourly_done", "backfill_ng_done", "daily_sync_done"];
                    if ([...reasons].some(r => needsNg.includes(r))) {
                        await cacheServiceModule.hydrateNgFromMSSQL();
                    }

                    console.log(`[Worker] ✅ Cache reloaded (reasons: ${[...reasons].join(", ")})`);
                } catch (e) {
                    console.error("[Worker] Cache reload failed:", e.message);
                } finally {
                    cacheReloadPending = false;
                }
            }, 3000); // Debounce 3 วิ
        } else {
            console.log(`[Worker] Cache reload queued (reason: ${msg.reason}) — debounce active`);
        }
    }

    // 🆕 Cache Rollover: Daily rollover (00:05 TH) → clear cache + hydrate วันใหม่
    if (msg.type === "cache_rollover") {
        try {
            console.log("[Worker] 🌅 Cache rollover triggered");
            await clearAndRollover();
            console.log("[Worker] ✅ Cache rolled over successfully");
        } catch (e) {
            console.error("[Worker] Cache rollover failed:", e.message);
        }
    }
});
