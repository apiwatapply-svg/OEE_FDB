/**
 * worker_cron.js — Cron Heavy-Write Worker Thread
 * ================================================
 * Runs ONLY: Cron Jobs + InfluxDB→MSSQL backfill
 * ไม่มี: Socket.IO, MQTT, realtimeService, memoryOeeService
 *
 * เหตุผลที่แยก Thread: Prisma write หนักๆ (upsert 500+ rows)
 * ยึด libuv native thread pool → Socket.IO emit รอคิว → กราฟค้าง
 * แยก thread = cron หนักได้เต็มที่โดยไม่กระทบ UI เลย
 *
 * IPC Messages ที่ส่งออก:
 *   { type: "cache_reload" }     — บอก realtime worker ให้โหลด cache ใหม่จาก MSSQL
 *   { type: "cache_rollover" }   — บอก realtime worker ให้ clearAndRollover
 *   { type: "log", message }     — forward log ไปยัง Main Thread
 */
require("dotenv").config();
const { parentPort } = require("worker_threads");

// ── IPC Helpers ────────────────────────────────────────────────────────────
function log(message) {
    parentPort.postMessage({ type: "log", message });
}

/**
 * แจ้ง realtime worker ให้โหลด cache ใหม่จาก MSSQL
 * @param {string} reason — e.g. "hourly_done", "backfill_startup_done"
 */
function notifyCacheReload(reason) {
    parentPort.postMessage({ type: "cache_reload", reason });
    log(`📡 [CronWorker] Cache reload notified (${reason})`);
}

/**
 * แจ้ง realtime worker ให้ clearAndRollover (ต้นกะวันใหม่)
 * rollover ต้องทำใน realtime thread เพราะ cache ของ realtime คือ source of truth
 */
function notifyCacheRollover() {
    parentPort.postMessage({ type: "cache_rollover" });
    log("🌅 [CronWorker] Cache rollover notified");
}

// ── Callback ที่ส่งให้ startCronJobs ──────────────────────────────────────
// จะถูกเรียกเมื่อ cron job แต่ละตัวสำเร็จ
function onCronJobDone(reason) {
    if (reason === "rollover_done") {
        notifyCacheRollover();
    } else {
        // hourly_done, late_data_done, oee_hourly_done, ng_hourly_done,
        // daily_sync_done → ทั้งหมด reload cache
        notifyCacheReload(reason);
    }
}

// ── Load Services (Cron-only ไม่ต้องการ mqttService / memoryOeeService) ──
const { initClient } = require("./services/influxService");

// cacheService ใน cron thread: ใช้สำหรับ diff-check ใน backfillStartup
// (ไม่ได้ share instance กับ realtime thread — JS heap แยกกัน)
const {
    hydrateFromMSSQL,
    hydrateAvailabilityFromMSSQL,
    hydrateRuntimeFromMSSQL,
} = require("./services/cacheService");

const {
    startCronJobs,
    backfillStartup,
    backfillNgStartup,
    backfillEventsStartup,
    backfillRuntimeAvailStartup,
    upsertOeeHourly,
    backfillOeeStartup,
} = require("./services/cronService");

// ── Startup Sequence ───────────────────────────────────────────────────────
async function startup() {
    try {
        log("🔧 [CronWorker] Cron worker starting...");

        // 1. Initialize InfluxDB client
        initClient();

        // 2. Hydrate cron thread's own cache (สำหรับ diff-check ใน backfillStartup)
        // หมายเหตุ: hydrate นี้ไม่ได้ส่งผลต่อ realtime thread
        await hydrateFromMSSQL();

        // 3. Backfill InfluxDB → MSSQL (5 วัน) — หนักสุด ทำได้เต็มที่เพราะคนละ thread
        log("🔄 [CronWorker] Starting backfillStartup...");
        await backfillStartup();
        notifyCacheReload("backfill_startup_done"); // 📡

        // 4. Backfill NG station data (5 วัน)
        log("🔄 [CronWorker] Starting backfillNgStartup...");
        await backfillNgStartup();
        notifyCacheReload("backfill_ng_done"); // 📡

        // 5. Backfill Status & Alarm from InfluxDB → MSSQL
        log("🔄 [CronWorker] Starting backfillEventsStartup...");
        await backfillEventsStartup();
        notifyCacheReload("events_backfill_done"); // 📡 ให้ realtime worker rehydrate stopwatch จาก MSSQL

        // 5.5 Recalculate runtime/availability per hour
        log("🔄 [CronWorker] Starting backfillRuntimeAvailStartup...");
        await backfillRuntimeAvailStartup();

        // 6. Hydrate Availability + Runtime สำหรับ cron thread's internal use
        await hydrateAvailabilityFromMSSQL();
        await hydrateRuntimeFromMSSQL();

        // 7. OEE upsert ทันทีตอน startup
        log("🔄 [CronWorker] Running upsertOeeHourly...");
        await upsertOeeHourly();
        notifyCacheReload("oee_startup_done"); // 📡

        // 8. OEE Backfill (past 5 days)
        log("🔄 [CronWorker] Starting backfillOeeStartup...");
        await backfillOeeStartup();
        notifyCacheReload("oee_backfill_done"); // 📡
        // หมายเหตุ: steps 3-8 ครอบคลุม 5 วัน รวมถึงวันนี้+เมื่อวาน
        // ไม่จำเป็นต้อง runDailySync(1) ซ้ำอีกครั้ง (ซ้อนทับ — ข้อมูลเดิม)

        // 9. เริ่ม Cron Jobs พร้อม callback
        startCronJobs(onCronJobDone);

        log("✅ [CronWorker] Cron worker startup completed!");
    } catch (err) {
        log(`❌ [CronWorker] Startup failed: ${err.message}`);
        console.error("❌ [CronWorker] Startup failed:", err);
        process.exit(1);
    }
}

startup();

// IPC: รับ message จาก Main Thread (เผื่อไว้ในอนาคต เช่น manual trigger)
parentPort.on("message", (msg) => {
    if (msg && msg.type === "ping") {
        parentPort.postMessage({ type: "pong" });
    }
});
