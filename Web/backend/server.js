require("dotenv").config();
const express = require("express");
const app = express();
const http = require("http");
const { Server } = require("socket.io");

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE"]
  }
});

// 🏠 Socket.IO Room Management
io.on("connection", (socket) => {
  console.log(`🔌 Client connected: ${socket.id}`);

  // Client สามารถ join room ของเครื่องจักรที่สนใจ
  socket.on("joinRoom", (roomName) => {
    socket.join(roomName);
    console.log(`🏠 ${socket.id} joined room: ${roomName}`);
  });

  // Client ออกจาก room เมื่อเปลี่ยนหน้า
  socket.on("leaveRoom", (roomName) => {
    socket.leave(roomName);
    console.log(`🚪 ${socket.id} left room: ${roomName}`);
  });

  socket.on("disconnect", () => {
    console.log(`❌ Client disconnected: ${socket.id}`);
  });
});

// 🟢 Attach IO to App for use in Controllers
app.set("io", io);
const cors = require("cors");
const fileUpload = require("express-fileupload");
const bodyParser = require("body-parser");
const port = process.env.PORT || 5005;

// 1️⃣ ต้อง parse JSON ก่อน (สำคัญสุด)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ✅ Gzip Compression — ลด bandwidth ~80% (ต้องอยู่ก่อน static/routes ทั้งหมด)
const compression = require("compression");
app.use(compression());

// 2️⃣ เปิด CORS ก่อน routes
app.use(cors());

// 3️⃣ (ถ้าอยากใช้ body-parser เสริมก็ใส่ได้หลัง express.json)
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// 4️⃣ fileUpload ต้องมาทีหลังสุดเสมอ
app.use(fileUpload());

// 5️⃣ Static files
app.use("/image", express.static("image"));

// ✅ Serve Static Frontend with smart Cache-Control
const path = require("path");
const frontendOut = path.join(__dirname, "../fontend/out");

// Next.js hashed chunks (_next/static/) → cache 1 ปี (ชื่อไฟล์มี hash, เปลี่ยนทุก build)
app.use("/_next/static", express.static(path.join(frontendOut, "_next/static"), {
  maxAge: "365d",
  immutable: true,
}));

// Static assets (bootstrap, plugins, dist) → cache 7 วัน
app.use("/bootstrap", express.static(path.join(frontendOut, "bootstrap"), { maxAge: "7d" }));
app.use("/plugins", express.static(path.join(frontendOut, "plugins"), { maxAge: "7d" }));
app.use("/dist", express.static(path.join(frontendOut, "dist"), { maxAge: "7d" }));

// HTML pages → ห้าม cache เด็ดขาด (ป้องกัน browser เก็บ gzip payload แล้วกด F5 เป็นภาษาต่างดาว)
app.use(express.static(frontendOut, {
  extensions: ["html"],
  etag: false,
  lastModified: false,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith(".html")) {
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
    }
  },
}));

// ✅ Initialize InfluxDB client in Main Thread (for API controllers that query InfluxDB)
const { initClient } = require("./services/influxService");
initClient();

// ✅ Controllers//
const oeeDashboardController = require("./controllers/OeeDashboardController");
const modelController = require("./controllers/ModelController");
const outputTargetController = require("./controllers/OutputTargetController");
const historyWorkingController = require("./controllers/HistoryWorkingController");
const machineController = require("./controllers/MachineController");
const reportDashboardController = require("./controllers/ReportDashboardController");
const reportController = require("./controllers/ReportController"); // 🆕
const machineNgController = require("./controllers/MachineNgController"); // 🆕
const mcStatusController = require("./controllers/MCStatusController"); // 🆕 Machine Status
const planConfigController = require("./controllers/PlanConfigController"); // 🆕 Plan Config
const holidayController = require("./controllers/HolidayController"); // 🆕 Holidays
const oeeUpdateController = require("./controllers/OeeUpdateController"); // 🆕 OEE Update

const { apiCache } = require("./middleware/apiCacheMiddleware"); // 🆕 API Cache

// =========================================
// 📦 OEE DASHBOARD ROUTES
// =========================================
app.get("/api/oee/getPicture/:emp_no", oeeDashboardController.getOperatorPicture);
app.get("/api/oee/getLastOEE", apiCache(5), oeeDashboardController.getLastOEEByMachine);
app.get("/api/oee/getDataTable", apiCache(5), oeeDashboardController.getDataTable);
app.get("/api/oee/getGraph1", apiCache(5), oeeDashboardController.getActualGraph1);
app.get("/api/oee/getGraph2", apiCache(5), oeeDashboardController.getActualGraph2);
app.get("/api/oee/getModelsByDate", apiCache(5), oeeDashboardController.getModelsByDate);
// =========================================
// 🧩 MODEL ROUTES
// =========================================
app.get("/api/model/listModel", modelController.listModel);
app.get("/api/model/listModelType", modelController.listModelType); // ✅ Add Route

// =========================================
// 📦 OUTPUT TARGET ROUTES
// =========================================
app.post("/api/outputTarget/createOutputTargetRange", outputTargetController.createOutputTargetRange);
app.put("/api/outputTarget/updateOutputTargetRange", outputTargetController.updateOutputTargetRange);
app.delete("/api/outputTarget/deleteOutputTarget", outputTargetController.deleteOutputTarget);
app.get("/api/outputTarget/getOutputTarget", outputTargetController.getOutputTarget)
app.get("/api/outputTarget/getLastTargetDate", outputTargetController.getLastTargetDate);
app.get("/api/outputTarget/listOutputTarget/:area/:type/:machine_name", outputTargetController.listOutputTarget);

// =========================================
// 🆕 PLAN CONFIG ROUTES
// =========================================
app.get("/api/planConfig/get/:machine_name", planConfigController.getConfig);
app.post("/api/planConfig/upsert", planConfigController.upsertConfig);
app.get("/api/planConfig/list", planConfigController.listConfigs);
app.post("/api/planConfig/generatePlan", planConfigController.generatePlan);
app.post("/api/planConfig/updateDayShift", planConfigController.updateDayShift);
app.post("/api/planConfig/updateDayHours", planConfigController.updateDayHours);
app.post("/api/planConfig/updateDayEffCt", planConfigController.updateDayEffCt);

// =========================================
// 🆕 HOLIDAY ROUTES
// =========================================
app.get("/api/holiday/list/:machine_name", holidayController.listHolidays);
app.post("/api/holiday/toggle", holidayController.toggleHoliday);
app.post("/api/holiday/copy", holidayController.copyHolidays);

// =========================================
// 🆕 OEE UPDATE ROUTES
// =========================================
app.get("/api/oee-update/list", oeeUpdateController.list);
app.post("/api/oee-update/set-mode", oeeUpdateController.setMode);
app.post("/api/oee-update/manual-ng", oeeUpdateController.manualNg);
app.post("/api/oee-update/manual-ng-batch", oeeUpdateController.manualNgBatch);
app.post("/api/oee-update/manual-ng-multi-machine", oeeUpdateController.manualNgMultiMachine);
app.get("/api/oee-update/history/:machine", oeeUpdateController.history);
app.get("/api/oee-update/auto-ng/:machine", oeeUpdateController.autoNg);
// =========================================
// 🧍 History Working Routes
// =========================================
app.get("/api/historyWorking/getOperatorIdWorking/:machine_name", historyWorkingController.getOperatorIdWorking);
app.get("/api/historyWorking/getHistoryByDate", historyWorkingController.getHistoryByDate); // ✅ Add Route
app.get("/api/historyWorking/getActiveCrossDayOperator", historyWorkingController.getActiveCrossDayOperator); // ✅ Cross-Day Operator
app.post("/api/historyWorking/createStartTime", historyWorkingController.createStartTime);
app.put("/api/historyWorking/updateEndTime/:id", historyWorkingController.updateEndTime);

// =========================================
// 🛠️ ROUTES — MachineController
// =========================================
app.get("/api/machine/listArea", machineController.listArea);
app.get("/api/machine/listType/:area", machineController.listType);
app.get("/api/machine/listMachines/:area/:type", machineController.listMachines);
app.get("/api/machine/listTypeWithMachines/:area", machineController.listTypeWithMachines);
app.get("/api/machine/listProcess/:machine_type", machineController.listProcess);
app.get("/api/machine/listAllMachinesByArea", machineController.listAllMachinesByArea); // 🆕 Layout Dashboard
app.get("/api/machine/getMachinesWithTodayData", machineController.getMachinesWithTodayData); // 🆕 Layout Dashboard Cards

// ... REPORT ROUTES
app.get("/api/report/daily-dashboard", apiCache(60), reportDashboardController.getDailyDashboard);
app.get("/api/report/monthly-dashboard", apiCache(60), reportDashboardController.getMonthlyDashboard);
app.get("/api/report/machine-report", reportController.getMachineReport); // 🆕 // ✅ Add Route
app.get("/api/report/machine-ng-report", machineNgController.getMachineNgReport); // 🆕 Machine NG Report Route

// =========================================
// 📊 MC STATUS ROUTES
// =========================================
app.get("/api/mcstatus/timeline", mcStatusController.getTimeline); // 🆕 Machine Status Timeline
app.get("/api/mcstatus/latest-all", mcStatusController.getLatestAll); // 🆕 Latest status for all machines

// =========================================
// ⚙️ CONFIG ROUTES
// =========================================
const configRoutes = require("./routes/configRoutes");
app.use("/api/config", configRoutes);

// 🆕 SERVER TIME ENDPOINT
app.get("/api/oee/getServerTime", (req, res) => {
  res.json({ serverTimeUTC: new Date().toISOString() });
});

// ✅ Catch-All Route for SPA (must be last)
app.get(/(.*)/, (req, res, next) => {
  // ข้าม API routes และ static file requests (มี extension เช่น .js, .css, .png)
  if (req.path.startsWith("/api/") || req.path.match(/\.\w+$/)) {
    return next();
  }

  // ✅ ป้องกัน browser cache gzip payload → กด F5 แล้วเป็นภาษาต่างดาว
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Content-Type", "text/html; charset=utf-8");

  // ลองส่งไฟล์ HTML ตรงตาม path ก่อน (เช่น /oee_production/machine_report/ → out/.../index.html)
  const htmlPath = path.join(frontendOut, req.path, "index.html");
  res.sendFile(htmlPath, (err) => {
    if (err) {
      // ถ้าไม่พบหน้านั้น → ส่ง root index.html เป็น SPA fallback
      res.sendFile(path.join(frontendOut, "index.html"));
    }
  });
});

// ✅ Worker Thread — Background services run in separate thread
const { Worker } = require("worker_threads");

// Phase 11: Graceful Shutdown — import stateSnapshotService ให้ Main Thread
// (Worker thread มี snapshot ของตัวเอง แต่ Main Thread ต้อง save ด้วยถ้าถูกสั่ง shutdown)
// NOTE: stateSnapshotService อ่าน mqttService/memoryOeeService ที่อยู่ใน Worker Thread
// การ save จาก Main Thread จึงเป็น "best-effort" — ส่วน Worker Thread save ทุก 5 นาทีผ่าน startCheckpoint()
// Graceful shutdown จึงดัก signal เพื่อ notify Worker ให้ save ก่อน terminate
let workerRef = null;     // Realtime Worker — เก็บ reference สำหรับ shutdown
let workerCronRef = null; // 🆕 Cron Worker — เก็บ reference สำหรับ shutdown

// Start Express server FIRST — so frontend can connect immediately
server.listen(port, () => {
  console.log("🚀 API server running at port", port);

  // Spawn worker thread AFTER Express is listening
  const worker = new Worker("./worker.js");
  workerRef = worker; // Phase 11: เก็บ reference สำหรับ graceful shutdown

  // ── IPC: Realtime Worker → Main Thread (Socket.IO emit) ──
  const handleWorkerMessage = (msg) => {
    switch (msg.type) {
      case "emit":
        io.to(msg.room).emit(msg.event, msg.data);
        break;
      case "broadcast":
        io.emit(msg.event, msg.data);
        break;
      case "log":
        console.log(`[Worker] ${msg.message}`);
        break;
      // Phase 11: Worker แจ้งว่า snapshot saved → safe to exit
      case "snapshot_saved":
        console.log("[Shutdown] Worker snapshot saved. Closing server...");
        server.close(() => process.exit(0));
        break;
    }
  };

  worker.on("message", handleWorkerMessage);

  worker.on("error", (err) => {
    console.error("❌ Worker thread error:", err);
  });

  worker.on("exit", (code) => {
    if (code !== 0) {
      console.error(`⚠️ Worker thread exited with code ${code}, restarting...`);
      // Auto-restart worker on crash
      setTimeout(() => {
        const newWorker = new Worker("./worker.js");
        workerRef = newWorker;
        newWorker.on("message", handleWorkerMessage); // ✅ Fixed: properly bind the message handler
        newWorker.on("error", (err) => console.error("❌ Worker error:", err));
      }, 2000);
    }
  });

  console.log("🔧 Worker thread spawned for background services");

  // 🆕 Spawn Cron Worker Thread (Heavy DB write — แยก thread เพื่อไม่กระทบ UI)
  const spawnCronWorker = () => {
    const cronWorker = new Worker("./worker_cron.js");
    workerCronRef = cronWorker;

    // ── IPC: Cron Worker → Main Thread → Relay ไปยัง Realtime Worker ──
    cronWorker.on("message", (msg) => {
      if (!msg || !msg.type) return;
      switch (msg.type) {
        case "log":
          // Forward log จาก cron worker
          console.log(`[CronWorker] ${msg.message}`);
          break;
        case "cache_reload":
          // 📡 Relay → Realtime Worker ให้โหลด cache ใหม่จาก MSSQL
          if (workerRef) {
            workerRef.postMessage({ type: "cache_reload", reason: msg.reason });
          }
          break;
        case "cache_rollover":
          // 📡 Relay → Realtime Worker ให้ clearAndRollover
          if (workerRef) {
            workerRef.postMessage({ type: "cache_rollover" });
          }
          break;
      }
    });

    cronWorker.on("error", (err) => {
      console.error("❌ Cron worker thread error:", err);
    });

    cronWorker.on("exit", (code) => {
      if (code !== 0) {
        console.error(`⚠️ Cron worker thread exited with code ${code}, restarting in 5s...`);
        // Auto-restart cron worker on crash (5 วิ delay เพื่อป้องกัน restart loop)
        setTimeout(() => {
          console.log("🔄 [CronWorker] Restarting...");
          spawnCronWorker();
        }, 5000);
      } else {
        console.log("[CronWorker] Exited cleanly.");
      }
    });

    console.log("🔧 Cron worker thread spawned (heavy DB write isolated)");
  };

  spawnCronWorker();
});

// ─────────────────────────────────────────────────────────
// Phase 11: Graceful Shutdown Handler
// ดัก SIGTERM (systemd/PM2 stop) และ SIGINT (Ctrl+C)
// ─────────────────────────────────────────────────────────
function gracefulShutdown(signal) {
  console.log(`\n🛑 [Shutdown] Received ${signal}. Starting graceful shutdown...`);

  // Force exit ถ้าใช้เวลาเกิน 10 วินาที (ป้องกัน hang)
  const forceExit = setTimeout(() => {
    console.error("⚠️ [Shutdown] Timeout exceeded. Force exiting.");
    process.exit(1);
  }, 10000);
  forceExit.unref(); // ไม่ให้ setTimeout นี้ block process ปิดตัวปกติ

  // ส่ง message ให้ Worker Thread save snapshot ก่อน terminate
  if (workerRef) {
    console.log("[Shutdown] Requesting worker to save snapshot...");
    workerRef.postMessage({ type: "save_snapshot" });
    // Worker จะตอบกลับด้วย snapshot_saved → server.close() → process.exit(0)
  } else {
    // ไม่มี Worker → ปิด server ตรง
    server.close(() => {
      console.log("[Shutdown] Server closed. Exiting.");
      process.exit(0);
    });
  }

  // 🆕 Terminate Cron Worker ด้วย (ไม่รอ snapshot เพราะ cron ไม่มี state สำคัญใน RAM)
  if (workerCronRef) {
    workerCronRef.terminate();
    console.log("[Shutdown] Cron worker terminated.");
  }
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT",  () => gracefulShutdown("SIGINT"));
