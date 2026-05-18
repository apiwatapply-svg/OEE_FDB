const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const path = require("path");
const fs = require("fs");
const sharp = require("sharp");
const cacheService = require("../services/cacheService");
const influxService = require("../services/influxService");
const {
    buildPseudoActualRow,
    sumActualByHour,
    applyCurrentHourInfluxOverride,
} = require("../services/actualOutputService");
const { getShiftDateUTC, getCurrentHourBoundaries, utcHourToThColumn } = require("../utils/timeUtils");
const { calcAvailability, calcMcStatusDurations, getMachineRunTimeMode, getCTCalcMode, getTargetDeductMode, getAvailabilityTargetConfig } = require("../services/oeeCalcService");

// Helper: สร้าง shift boundaries สำหรับ InfluxDB query (UTC)
function getShiftBoundariesForDate(dateStr) {
    // Shift: 07:00 TH → 00:00 UTC ถึง 07:00 TH วันถัดไป → 00:00 UTC + 24h
    const year = parseInt(dateStr.substring(0, 4));
    const month = parseInt(dateStr.substring(5, 7)) - 1;
    const day = parseInt(dateStr.substring(8, 10));
    const startUTC = new Date(Date.UTC(year, month, day, 0, 0, 0)); // 07:00 TH = 00:00 UTC
    const endUTC = new Date(Date.UTC(year, month, day + 1, 0, 0, 0)); // 07:00 TH next day
    return { startUTC, endUTC };
}

// Helper: ลำดับชั่วโมงของการทำงาน (07:00 - 06:00)
const SHIFT_HOURS = [
    "07", "08", "09", "10", "11", "12", "13", "14", "15", "16", "17", "18",
    "19", "20", "21", "22", "23", "00", "01", "02", "03", "04", "05", "06",
];

function hasPositiveValue(values) {
    return Array.isArray(values) && values.some((value) => Number(value) > 0);
}

function getCycleValue(source, hour) {
    if (!source) return 0;
    if (source.cycleTime) return Number(source.cycleTime[`cycle_${hour}`] || 0);
    return Number(source[`cycle_${hour}`] || 0);
}

function calcWeightedAvgCycleTime(cycleSource, actualByHour) {
    let weightedCt = 0;
    let outputForCt = 0;

    for (const hour of SHIFT_HOURS) {
        const output = Number(actualByHour[`actual_${hour}`] || 0);
        const cycleTime = getCycleValue(cycleSource, hour);
        if (output > 0 && cycleTime > 0) {
            weightedCt += cycleTime * output;
            outputForCt += output;
        }
    }

    return outputForCt > 0 ? weightedCt / outputForCt : 0;
}

async function loadCycleTimeRow(machineName, targetDate) {
    return prisma.tb_cycle_time_actual.findFirst({
        where: { machine_name: machineName, date: targetDate },
    });
}

async function loadAvailabilityArray(machineName, targetDate) {
    const availRow = await prisma.tb_availability_actual.findFirst({
        where: { machine_name: machineName, date: targetDate },
    });
    if (availRow) {
        return SHIFT_HOURS.map((hour) => availRow[`avail_${hour}`] || 0);
    }

    const effRow = await prisma.tb_efficiency_actual.findFirst({
        where: { machine_name: machineName, date: targetDate },
    });
    return SHIFT_HOURS.map((hour) => effRow ? (effRow[`eff_${hour}`] || 0) : 0);
}

async function calcMssqlMcStatusDurations(machineName, startUTC, endUTC) {
    const TH_OFFSET_MS = 7 * 60 * 60 * 1000;
    const startTH = new Date(startUTC.getTime() + TH_OFFSET_MS);
    const endTH = new Date(endUTC.getTime() + TH_OFFSET_MS);

    const rows = await prisma.tb_MCStatus.findMany({
        where: { MC: machineName, Datetime: { gte: startTH, lte: endTH } },
        orderBy: { Datetime: "asc" },
        select: { MC: true, Datetime: true, MCStatus: true },
    });
    const carryRows = await prisma.$queryRaw`
        SELECT MC, MCStatus, Datetime FROM (
            SELECT MC, MCStatus, Datetime,
                   ROW_NUMBER() OVER (PARTITION BY MC ORDER BY Datetime DESC) AS rn
            FROM tb_MCStatus WHERE MC = ${machineName} AND Datetime < ${startTH}
        ) t WHERE rn = 1
    `;

    const records = [];
    if (carryRows && carryRows.length > 0) {
        records.push({ MC: carryRows[0].MC, Datetime: startTH, MCStatus: carryRows[0].MCStatus });
    }
    records.push(...rows);

    if (records.length === 0) {
        return { runTimeSeconds: 0, excludedSeconds: 0, totalSeconds: Math.max(0, (endTH - startTH) / 1000) };
    }

    return calcMcStatusDurations(records, startTH, endTH);
}

module.exports = {
    // ============================================================
    // 1️⃣ GET /api/operator/picture/:emp_no
    // ============================================================
    getOperatorPicture: async (req, res) => {
        try {
            const { emp_no } = req.params;

            if (!emp_no)
                return res.status(400).json({ message: "emp_no is required" });

            // 🔍 ค้นหา operator
            const operator = await prisma.tbm_operator.findUnique({
                where: { emp_no },
            });

            // ✅ base directory ของ backend
            const baseDir = path.join(__dirname, "..");
            // ✅ path ของภาพ
            let imagePath = operator?.picture_path
                // ? operator.picture_path
                ? path.join(baseDir, "image", operator.picture_path)
                : path.join(baseDir, "image", "avg.png");
            // 🔹 ถ้าไม่เจอไฟล์ ให้ใช้ avg.png
            if (!fs.existsSync(imagePath)) {
                imagePath = path.join(baseDir, "image", "avg.png");
            }

            // ✅ resize ภาพให้เป็น 200x200
            const resizedImageBuffer = await sharp(imagePath)
                .resize(200, 200)
                .toBuffer();

            // ✅ ส่งกลับเป็น binary พร้อม header
            res.set("Content-Type", "image/png");
            res.send(resizedImageBuffer);
        } catch (error) {
            res.status(500).json({ message: "Error getting operator picture" });
        }
    },

    // ============================================================
    // 2️⃣ GET Last OEE
    // ============================================================
    getLastOEEByMachine: async (req, res) => {
        try {
            const { machine_name, date } = req.query;
            if (!machine_name) return res.status(400).json({ message: "machine_name is required" });

            let whereCondition = { machine_name, oee_value: { gt: 0 } };

            // ✅ Logic: หา OEE ของ "วันที่เลือก" (Selected Date)
            // ถ้าเลือกวันที่ 16 -> ให้หาของวันที่ 16
            let targetDate = date ? new Date(date) : new Date();
            let endOfTargetDay = new Date(targetDate);

            // ✅ Check if machine is manual
            const config = await prisma.tb_machine_plan_config.findUnique({
                where: { machine_name },
                select: { oee_mode: true }
            });
            const isManual = config && config.oee_mode === "manual";
            
            const serverTodayStr = getShiftDateUTC();
            const serverToday = new Date(serverTodayStr);

            // สำหรับเครื่อง manual, วันนี้ยังไม่มียอด NG ดังนั้นให้ดึงค่า OEE ของเมื่อวานแทน
            if (isManual && targetDate >= serverToday) {
                let yesterday = new Date(serverToday);
                yesterday.setDate(yesterday.getDate() - 1);
                endOfTargetDay = yesterday;
            }

            if (targetDate < serverToday) {
                // 🔹 กรณีดูข้อมูลย้อนหลัง: บังคับให้หาเฉพาะ "วันนั้น" เท่านั้น (ไม่ Fallback ไปวันก่อนหน้า)
                const startOfDayUTC = new Date(targetDate);
                startOfDayUTC.setUTCHours(0, 0, 0, 0);
                
                const endOfDayUTC = new Date(targetDate);
                endOfDayUTC.setUTCHours(23, 59, 59, 999);
                
                whereCondition.date = {
                    gte: startOfDayUTC,
                    lte: endOfDayUTC
                };
            } else {
                // 🔹 กรณีดูข้อมูลวันนี้: อนุญาตให้ดึงก้อนล่าสุด (รวมที่ Fallback มาจากเมื่อวานได้ถ้ายังไม่มีของวันนี้)
                endOfTargetDay.setUTCHours(23, 59, 59, 999); // ปรับหลีกเลี่ยง Timezone Shift
                whereCondition.date = {
                    lte: endOfTargetDay
                };
            }

            const data = await prisma.tb_oee.findFirst({
                where: whereCondition,
                orderBy: { date: "desc" },
            });

            if (!data) return res.json({ message: "ไม่พบข้อมูล", oee_value: 0 });
            res.json(data);
        } catch (err) {
            console.error(err);
            res.status(500).json({ message: "Get Last OEE Error" });
        }
    },

    // ============================================================
    // 3️⃣ GET Data Table (Calculated Values)
    // ============================================================
    getDataTable: async (req, res) => {
        try {
            const { machine_name, date, model_name } = req.query; // date format: YYYY-MM-DD
            if (!machine_name || !date) return res.status(400).json({ message: "require machine_name and date" });

            const targetDate = new Date(date);
            const todayStr = getShiftDateUTC();
            const isToday = date === todayStr;

            // 1. ดึงข้อมูล Target (ไม่ filter ด้วย model_name — target เป็น per machine/date)
            let whereCondition = { machine_name, date: targetDate };

            let outputTargetDB;
            const cachedTargetWrapper = isToday ? cacheService.getTarget(machine_name) : null;

            if (cachedTargetWrapper && cachedTargetWrapper.target) {
                outputTargetDB = cachedTargetWrapper.target;
            } else {
                const outputTargetDBResult = await prisma.tb_output_target.findFirst({
                    where: whereCondition,
                });
                outputTargetDB = outputTargetDBResult;
            }

            // 2. ดึงข้อมูล Actual — ใช้ cache ถ้าดูวันนี้
            let outputActualDBArray = [];
            const cachedData = isToday ? cacheService.getFullDay(machine_name) : null;
            if (cachedData) {
                outputActualDBArray = [buildPseudoActualRow(machine_name, targetDate, cachedData)];
            } else {
                // Keep all rows (both real model and "--") — per-hour fallback applied in SUM loop below
                outputActualDBArray = await prisma.tb_output_actual.findMany({
                    where: { machine_name, date: targetDate },
                });
            }

            // ✅ Fix: current hour → InfluxDB เป็น source of truth (ต้องอยู่นอก else เพื่อให้ทำงานทั้งกรณี cache และ MSSQL)
            if (isToday) {
                try {
                    outputActualDBArray = await applyCurrentHourInfluxOverride(outputActualDBArray, {
                        influxService,
                        machineName: machine_name,
                        date: targetDate,
                    });
                } catch (e) { /* non-critical — keep cache/MSSQL value */ }
            }

            if (!outputTargetDB) return res.json({ message: "No Target Data" });

            // --- 🕒 Logic การคำนวณเวลา (UTC-based) ---
            // ⚠️ ห้ามใช้ setHours(7) — ใช้ local timezone → ผิดบน server UTC (07:00 UTC ≠ 07:00 TH)
            // Shift 07:00 TH = 00:00 UTC เสมอ → ต้องใช้ getShiftBoundariesForDate
            const { startUTC: shiftStart, endUTC: shiftEnd } = getShiftBoundariesForDate(date);
            const now = new Date();

            // ถ้าวันที่ดู เป็นอดีต → เวลา "ปัจจุบัน" คือจบกะแล้ว
            // ถ้าวันที่ดู เป็นวันนี้ → เวลา "ปัจจุบัน" คือ now
            let calculationTime = now;
            if (now > shiftEnd) {
                calculationTime = shiftEnd;
            } else if (now < shiftStart) {
                calculationTime = shiftStart; // ยังไม่เริ่มกะ
            }


            // --- 🧮 เริ่มคำนวณ ---
            let outputTargetAccumCurrent = 0; // Target สะสม ณ เวลาปัจจุบัน (Pro-rated)
            let outputTargetDayTotal = 0;     // Target ทั้งวัน
            let outputActualSum = 0;          // Actual รวม
            let validSeconds = 0;             // วินาทีทำงาน (เฉพาะที่มี Target)
            const actualByHour = sumActualByHour(outputActualDBArray, SHIFT_HOURS);

            // Loop ตามชั่วโมงกะ (07 - 06)
            for (let i = 0; i < SHIFT_HOURS.length; i++) {
                const hStr = SHIFT_HOURS[i];
                const targetVal = outputTargetDB[`target_${hStr}`] || 0;
                
                const actualVal = actualByHour[`actual_${hStr}`] || 0;

                // 1. ผลรวม Actual ทั้งหมด
                outputActualSum += actualVal;

                // 2. ผลรวม Target ทั้งวัน (สำหรับ Achieve)
                outputTargetDayTotal += targetVal;

                // 3. คำนวณ Pro-rated Target และ Seconds
                // สร้างช่วงเวลาของชั่วโมงนี้ (UTC-safe: เพิ่ม ms ตรงๆ แทน setHours)
                const currentHourStart = new Date(shiftStart.getTime() + i * 3600000);
                const currentHourEnd   = new Date(currentHourStart.getTime() + 3600000);

                // ตรวจสอบว่า calculationTime อยู่ในช่วงไหน
                if (calculationTime >= currentHourEnd) {
                    // ผ่านชั่วโมงนี้มาเต็มๆ แล้ว -> คิดเต็ม
                    outputTargetAccumCurrent += targetVal;
                    if (targetVal > 0) validSeconds += 3600; // 1 ชม. = 3600 วิ
                } else if (calculationTime > currentHourStart && calculationTime < currentHourEnd) {
                    // อยู่ระหว่างชั่วโมงนี้ (เช่น ตอนนี้ 8:30) -> คิดตามสัดส่วนนาที
                    const minutesPassed = (calculationTime - currentHourStart) / 1000 / 60; // นาทีที่ผ่านไป
                    const ratio = minutesPassed / 60;

                    outputTargetAccumCurrent += Math.round(targetVal * ratio); // คิด target ตามสัดส่วน

                    if (targetVal > 0) {
                        validSeconds += (minutesPassed * 60); // บวกวินาทีที่ผ่านไปจริง
                    }
                }
                // ถ้า calculationTime < currentHourStart (อนาคต) -> ไม่บวก Target และ Time
            }

            // --- 📊 Final Calculation ---

            // Cycle Time Actual = วินาทีทำงาน / ผลรวม Output Actual
            // let cycleTimeActual = 0;
            // if (outputActualSum > 0) {
            //     cycleTimeActual = validSeconds / outputActualSum;
            // }

            // Efficiency Actual = (Actual รวม / Target สะสม ณ เวลานั้น) * 100
            // let efficiencyActual = 0;
            // if (outputTargetAccumCurrent > 0) {
            //     efficiencyActual = (outputActualSum / outputTargetAccumCurrent) * 100;
            // }

            // Achieve = Actual รวม / Target ทั้งวัน
            // let achieve = 0;
            // if (outputTargetDayTotal > 0) {
            //     achieve = (outputActualSum / outputTargetDayTotal) * 100;
            // }
            let achieve = 0;
            if (outputActualSum > 0) {
                achieve = (outputActualSum / outputTargetAccumCurrent) * 100;
            }
            // get oee data
            // ✅ Logic: หา OEE ของ "วันที่เลือก" (Selected Date)
            let endOfTargetDay = new Date(targetDate);

            // ✅ Check if machine is manual
            const machineConfig = await prisma.tb_machine_plan_config.findUnique({
                where: { machine_name },
                select: { oee_mode: true }
            });
            const isManual = machineConfig && machineConfig.oee_mode === "manual";
            
            const serverTodayStrTable = getShiftDateUTC();
            const serverTodayTable = new Date(serverTodayStrTable);

            // สำหรับเครื่อง manual, วันนี้ยังไม่มียอด NG ดังนั้นให้ดึงค่า OEE ของเมื่อวานแทน
            if (isManual && targetDate >= serverTodayTable) {
                let yesterday = new Date(serverTodayTable);
                yesterday.setDate(yesterday.getDate() - 1);
                endOfTargetDay = yesterday;
            }

            endOfTargetDay.setHours(23, 59, 59, 999);

            const dataOee = await prisma.tb_oee.findFirst({
                where: {
                    machine_name,
                    oee_value: { gt: 0 },
                    date: { lte: endOfTargetDay } // ✅ Filter by selected date (or yesterday for manual)
                },
                orderBy: { date: "desc" },
            });

            // }
            // 🆕 [Phase 8] ดึง Availability Actual
            let availabilityActual = 0;
            let cycleTimeActual = 0;

            // ✅ Config-driven: ควรหักเวลา Excluded ออกจาก Target หรือไม่
            const shouldDeductTarget = getTargetDeductMode(machine_name);

            if (isToday) {
                // วันนี้: CT จาก Cache หรือคำนวณสดถ้าระบุเป็น runtime_based
                const ctMode = getCTCalcMode(machine_name);
                if (ctMode === "runtime_based") {
                    const memoryOeeService = require("../services/memoryOeeService");
                    const { runTimeSec } = memoryOeeService.getDurationsNow(machine_name, calculationTime);
                    cycleTimeActual = outputActualSum > 0 ? runTimeSec / outputActualSum : 0;
                } else if (cachedData) {
                    cycleTimeActual = cachedData.overall.avgCycleTime || 0;
                }
                if (cycleTimeActual <= 0) {
                    const cycleTimeRow = await loadCycleTimeRow(machine_name, targetDate);
                    cycleTimeActual = calcWeightedAvgCycleTime(cycleTimeRow || cachedData, actualByHour);
                }

                const modeRunTime = getMachineRunTimeMode(machine_name);
                if (modeRunTime === "output_based") {
                    // AHV: ไม่มี MCStatus → คำนวณจาก output × avgCT
                    let cacheCt = cachedData?.overall?.avgCycleTime || 0;

                    // Fallback: ถ้า cache ว่าง → อ่าน avg CT จริงจาก tb_cycle_time_actual
                    if (cacheCt <= 0) {
                        const ctActualRow = await prisma.tb_cycle_time_actual.findFirst({
                            where: { machine_name, date: targetDate },
                        });
                        if (ctActualRow) {
                            let sumCt = 0, countHours = 0;
                            for (const h of SHIFT_HOURS) {
                                const hCt = ctActualRow[`cycle_${h}`] || 0;
                                if (hCt > 0) { sumCt += hCt; countHours++; }
                            }
                            cacheCt = countHours > 0 ? sumCt / countHours : 0;
                        }
                    }

                    const avgCt = cacheCt > 0 ? cacheCt : (outputTargetDB.cycle_time_target || 0);
                    const runTime = outputActualSum * avgCt;
                    availabilityActual = validSeconds > 0 ? Math.min(100, (runTime / validSeconds) * 100) : 0;
                    // output_based: ไม่หัก target (ไม่มี MCStatus → ไม่รู้ excluded)
                } else {
                    // status_based: ใช้ memoryOeeService
                    const memoryOeeService = require("../services/memoryOeeService");
                    let { runTimeSec, excludedSec, totalSec } = memoryOeeService.getDurationsNow(machine_name, calculationTime);
                    if (totalSec <= 0 || (runTimeSec <= 0 && excludedSec <= 0)) {
                        const mssqlDurations = await calcMssqlMcStatusDurations(machine_name, shiftStart, calculationTime);
                        runTimeSec = mssqlDurations.runTimeSeconds;
                        excludedSec = mssqlDurations.excludedSeconds;
                        totalSec = mssqlDurations.totalSeconds;
                    }
                    availabilityActual = calcAvailability(runTimeSec, excludedSec, totalSec);

                    // ✅ Fallback: ถ้า memoryOeeService คืน 0 (เพราะ Main Thread แยก RAM จาก Worker Thread)
                    // ให้ดึง availability ล่าสุดจาก tb_oee ที่ Cron เขียนทุกชั่วโมง
                    if (availabilityActual === 0) {
                        const latestOee = await prisma.tb_oee.findFirst({
                            where: {
                                machine_name,
                                date: { gte: targetDate, lt: new Date(targetDate.getTime() + 86400000) },
                                availability: { gt: 0 }
                            },
                            orderBy: { date: 'desc' },
                            select: { availability: true }
                        });
                        if (latestOee?.availability > 0) {
                            availabilityActual = latestOee.availability;
                        }
                    }

                    // ✅ หัก Excluded Time ออกจาก Target ตาม config
                    if (shouldDeductTarget && validSeconds > 0 && excludedSec > 0) {
                        const ratio = Math.max(0, validSeconds - excludedSec) / validSeconds;
                        outputTargetAccumCurrent = Math.round(outputTargetAccumCurrent * ratio);
                    }
                }
            } else {
                // 📅 วันเก่า: Availability จาก MSSQL
                const cycleTimeActualDB = await prisma.tb_cycle_time_actual.findFirst({
                    where: { machine_name, date: targetDate },
                });
                if (cycleTimeActualDB && cycleTimeActualDB.cycle_time) {
                    cycleTimeActual = cycleTimeActualDB.cycle_time;
                }

                const availRow = await prisma.tb_availability_actual.findFirst({
                    where: { machine_name, date: targetDate },
                });
                if (availRow && availRow.avail_actual != null) {
                    availabilityActual = availRow.avail_actual;
                } else {
                    const effActualDB = await prisma.tb_efficiency_actual.findFirst({
                        where: { machine_name, date: targetDate },
                    });
                    if (effActualDB && effActualDB.eff_actual != null) {
                        availabilityActual = effActualDB.eff_actual;
                    }
                }

                // ✅ Fallback สุดท้าย: ถ้าตาราง tb_availability/efficiency ยังไม่มีข้อมูล
                // ให้ดึง availability จาก tb_oee ที่ Cron เขียนทุกวัน (historical)
                if (availabilityActual === 0) {
                    const latestOee = await prisma.tb_oee.findFirst({
                        where: {
                            machine_name,
                            date: { gte: targetDate, lt: new Date(targetDate.getTime() + 86400000) },
                            availability: { gt: 0 }
                        },
                        orderBy: { date: 'desc' },
                        select: { availability: true }
                    });
                    if (latestOee?.availability > 0) {
                        availabilityActual = latestOee.availability;
                    }
                }

                // ✅ วันเก่า: หัก excluded ออกจาก Target ถ้า config = true
                if (shouldDeductTarget && validSeconds > 0) {
                    try {
                        const { startUTC: hShiftStart } = getShiftBoundariesForDate(date);
                        const hShiftEnd = new Date(hShiftStart.getTime() + 24 * 60 * 60 * 1000);
                        const TH_OFFSET_MS = 7 * 60 * 60 * 1000;
                        const hShiftStartTH = new Date(hShiftStart.getTime() + TH_OFFSET_MS);
                        const hShiftEndTH = new Date(hShiftEnd.getTime() + TH_OFFSET_MS);

                        const mcRows = await prisma.tb_MCStatus.findMany({
                            where: { MC: machine_name, Datetime: { gte: hShiftStartTH, lte: hShiftEndTH } },
                            orderBy: { Datetime: 'asc' },
                            select: { MC: true, Datetime: true, MCStatus: true }
                        });
                        const carryRows = await prisma.$queryRaw`
                            SELECT MC, MCStatus, Datetime FROM (
                                SELECT MC, MCStatus, Datetime,
                                       ROW_NUMBER() OVER (PARTITION BY MC ORDER BY Datetime DESC) AS rn
                                FROM tb_MCStatus WHERE MC = ${machine_name} AND Datetime < ${hShiftStartTH}
                            ) t WHERE rn = 1
                        `;
                        const allMcRecs = [];
                        if (carryRows && carryRows.length > 0) {
                            allMcRecs.push({ MC: carryRows[0].MC, Datetime: hShiftStartTH, MCStatus: carryRows[0].MCStatus });
                        }
                        allMcRecs.push(...mcRows);

                        if (allMcRecs.length > 0) {
                            const calcEndTime = calculationTime < hShiftEndTH ? calculationTime : hShiftEndTH;
                            const { excludedSeconds: totalExcluded } = calcMcStatusDurations(allMcRecs, hShiftStartTH, calcEndTime);
                            if (totalExcluded > 0) {
                                const ratio = Math.max(0, validSeconds - totalExcluded) / validSeconds;
                                outputTargetAccumCurrent = Math.round(outputTargetAccumCurrent * ratio);
                            }
                        }
                    } catch (e) {
                        console.error('[getDataTable] Historical target deduct failed:', e.message);
                    }
                }
            }

            // ✅ Phase 1: ดึง Model จาก InfluxDB (Actual) แทน Target
            let actualModel = "-";
            try {
                const { startUTC, endUTC } = getShiftBoundariesForDate(date);
                const queryEnd = now < endUTC ? now : endUTC;
                const actualModels = await influxService.queryActualModels(machine_name, startUTC, queryEnd);
                if (actualModels.length > 0) {
                    const models = actualModels.map(m => m.model_name).filter(m => m && m !== "--");
                    if (models.length > 0) actualModel = models.join(", ");
                }
            } catch (e) {
                console.error("getDataTable: InfluxDB model query failed:", e.message);
            }
            // Fallback chain: InfluxDB → tb_output_actual → tb_output_target
            if (actualModel === "-") {
                const actualRows = await prisma.tb_output_actual.findMany({
                    where: { machine_name, date: targetDate },
                    select: { model_name: true }
                });
                if (actualRows.length > 0) {
                    const distinctModels = [...new Set(actualRows.map(r => r.model_name).filter(m => m && m !== "--"))];
                    if (distinctModels.length > 0) {
                        actualModel = distinctModels.join(", ");
                    } else {
                        actualModel = outputTargetDB.model_name || "-";
                    }
                } else {
                    actualModel = outputTargetDB.model_name || "-";
                }
            }

            // Determine Availability Target
            const availConf = getAvailabilityTargetConfig(machine_name);
            const finalAvailTarget = typeof availConf === "number" ? availConf : (outputTargetDB.eff_target || 0);

            res.json({
                machine_name,
                model: actualModel,
                outputTarget: outputTargetAccumCurrent, // Target ณ เวลานั้น (Pro-rated)
                outputActual: outputActualSum,
                cycleTimeTarget: outputTargetDB.cycle_time_target,
                cycleTimeActual: parseFloat(cycleTimeActual.toFixed(2)),
                availabilityTarget: finalAvailTarget,
                availabilityActual: parseFloat(availabilityActual.toFixed(2)),
                Achieve: parseFloat(achieve.toFixed(2)),
                oee: dataOee ? dataOee.oee_value : 0,
                oeeDate: dataOee ? dataOee.date : null
            });

        } catch (err) {
            console.error(err);
            res.status(500).json({ message: "Get DataTable Error" });
        }
    },

    // ============================================================
    // 4️⃣ GET Actual Graph 1 (Output)
    // ============================================================
    getActualGraph1: async (req, res) => {
        try {
            const { machine_name, date, model_name } = req.query;
            if (!machine_name || !date) return res.status(400).json({ message: "Missing params" });

            const targetDate = new Date(date);
            const todayStr = getShiftDateUTC();
            const isToday = date === todayStr;

            // ไม่ filter ด้วย model_name — target เป็น per machine/date
            const outputTargetDB = await prisma.tb_output_target.findFirst({
                where: { machine_name, date: targetDate },
            });

            // ใช้ cache ถ้าดูวันนี้
            let outputActualDBArray = [];
            const cachedData = isToday ? cacheService.getFullDay(machine_name) : null;
            if (cachedData) {
                outputActualDBArray = [buildPseudoActualRow(machine_name, targetDate, cachedData)];
            } else {
                // Keep all rows — per-hour fallback applied in SUM loop below
                outputActualDBArray = await prisma.tb_output_actual.findMany({
                    where: { machine_name, date: targetDate },
                });
            }

            // ✅ Fix: current hour → InfluxDB เป็น source of truth
            if (isToday) {
                try {
                    outputActualDBArray = await applyCurrentHourInfluxOverride(outputActualDBArray, {
                        influxService,
                        machineName: machine_name,
                        date: targetDate,
                    });
                } catch (e) { /* non-critical — keep cache/MSSQL value */ }
            }

            let outputActual = [];
            let outputActualAccum = [];
            let outputTarget = [];
            let outputTargetAccum = [];

            let accActual = 0;
            let accTarget = 0;
            const actualByHour = sumActualByHour(outputActualDBArray, SHIFT_HOURS);

            for (const h of SHIFT_HOURS) {
                // Actual
                const act = actualByHour[`actual_${h}`] || 0;
                
                accActual += act;
                outputActual.push(act);
                outputActualAccum.push(accActual);

                // Target
                const tgt = outputTargetDB ? (outputTargetDB[`target_${h}`] || 0) : 0;
                accTarget += tgt;
                outputTarget.push(tgt);
                outputTargetAccum.push(accTarget);
            }

            res.json({
                hours: SHIFT_HOURS,
                outputActual,
                outputActualAccum,
                outputTarget,
                outputTargetAccum
            });

        } catch (err) {
            console.error(err);
            res.status(500).json({ message: "Get Graph1 Error" });
        }
    },

    // ============================================================
    // 5️⃣ GET Actual Graph 2 (CT & Efficiency)
    // ============================================================
    getActualGraph2: async (req, res) => {
        try {
            const { machine_name, date, model_name } = req.query;
            if (!machine_name || !date) return res.status(400).json({ message: "Missing params" });

            const targetDate = new Date(date);
            const todayStr = getShiftDateUTC();
            const isToday = date === todayStr;

            // ไม่ filter ด้วย model_name — target เป็น per machine/date
            // ดึง Target เพื่อเอาค่า CT/Eff target
            const outputTargetDB = await prisma.tb_output_target.findFirst({
                where: { machine_name, date: targetDate },
            });

            // ใช้ cache ถ้าดูวันนี้
            let ctActualDB;
            const cachedData = isToday ? cacheService.getFullDay(machine_name) : null;
            if (cachedData) {
                ctActualDB = { machine_name, date: targetDate };
                for (const h of SHIFT_HOURS) {
                    ctActualDB[`cycle_${h}`] = cachedData.cycleTime[`cycle_${h}`] || 0;
                }
            } else {
                ctActualDB = await prisma.tb_cycle_time_actual.findFirst({
                    where: { machine_name, date: targetDate },
                });
            }

            // 🆕 [Phase 8] Priority Read: Availability -> Fallback to Efficiency
            let availabilityArray = [];
            if (isToday) {
                 availabilityArray = cacheService.getAvailability(machine_name);
                 if (!hasPositiveValue(availabilityArray)) {
                    availabilityArray = await loadAvailabilityArray(machine_name, targetDate);
                 }
            } else {
                availabilityArray = await loadAvailabilityArray(machine_name, targetDate);
            }

            // ✅ Fix: current hour CT → InfluxDB เป็น source of truth (ต้องอยู่นอก else เพื่อให้ทำงานทั้งกรณี cache และ MSSQL)
            if (isToday && ctActualDB) {
                try {
                    const now = new Date();
                    const { start, thColumn } = getCurrentHourBoundaries(now);
                    const influxData = await influxService.queryMachineForHour(machine_name, start, now);
                    ctActualDB[`cycle_${thColumn}`] = (influxData && influxData.avg_cycle_time > 0) ? parseFloat(influxData.avg_cycle_time.toFixed(2)) : 0;
                } catch (e) { /* non-critical — keep cache/MSSQL value */ }
            }

            // ✅ Fix: current hour Availability → Calculate dynamically for Graph
            if (isToday && availabilityArray && availabilityArray.length === 24) {
                try {
                    const now = new Date();
                    const { start, thColumn } = getCurrentHourBoundaries(now);
                    const shiftIndex = SHIFT_HOURS.indexOf(thColumn);
                    if (shiftIndex !== -1) {
                        const totalHourSecs = Math.max(0, (now.getTime() - new Date(start).getTime()) / 1000);
                        const modeRunTime = getMachineRunTimeMode(machine_name);
                        let currentHourRun = 0;
                        let currentHourExcluded = 0;
                        
                        if (modeRunTime === "output_based") {
                            const influxData = await influxService.queryMachineForHour(machine_name, start, now);
                            let ctForRun = (influxData && influxData.avg_cycle_time > 0) ? influxData.avg_cycle_time : (outputTargetDB ? outputTargetDB.cycle_time_target : 0);
                            currentHourRun = (influxData ? influxData.output_count : 0) * parseFloat(ctForRun.toFixed(2));
                        } else {
                            const TH_OFFSET = 7 * 3600000;
                            const startTH = new Date(new Date(start).getTime() + TH_OFFSET);
                            const nowTH = new Date(now.getTime() + TH_OFFSET);
                            
                            const mcRecords = await prisma.tb_MCStatus.findMany({
                                where: { MC: machine_name, Datetime: { gte: startTH, lte: nowTH } },
                                orderBy: { Datetime: 'asc' },
                                select: { MC: true, Datetime: true, MCStatus: true }
                            });
                            
                            const carryOverRows = await prisma.$queryRaw`
                                SELECT MC, MCStatus, Datetime FROM (
                                    SELECT MC, MCStatus, Datetime, ROW_NUMBER() OVER (PARTITION BY MC ORDER BY Datetime DESC) AS rn
                                    FROM tb_MCStatus WHERE MC=${machine_name} AND Datetime < ${startTH}
                                ) t WHERE rn = 1
                            `;
                            
                            if (carryOverRows && carryOverRows.length > 0) {
                                mcRecords.unshift({ MC: carryOverRows[0].MC, MCStatus: carryOverRows[0].MCStatus, Datetime: startTH });
                            }
                            
                            if (mcRecords.length > 0) {
                                const { runTimeSeconds, excludedSeconds } = calcMcStatusDurations(mcRecords, startTH, nowTH);
                                currentHourRun = runTimeSeconds;
                                currentHourExcluded = excludedSeconds;
                            }
                        }
                        const currentAvail = calcAvailability(currentHourRun, currentHourExcluded, totalHourSecs);
                        availabilityArray[shiftIndex] = parseFloat(currentAvail.toFixed(2));
                    }
                } catch (e) {
                    console.error("⚠️ [Graph2] Live Avail Calc Error:", e.message);
                }
            }

            let cycleTimeActual = [];
            let cycleTimeTarget = [];
            let availabilityActual = availabilityArray;
            let availabilityTarget = [];

            const targetCTValue = outputTargetDB ? outputTargetDB.cycle_time_target : 0;
            const availConf = getAvailabilityTargetConfig(machine_name);
            const targetAvailValue = typeof availConf === "number" ? availConf : (outputTargetDB ? outputTargetDB.eff_target : 0);

            for (const h of SHIFT_HOURS) {
                // CT Actual
                const ctAct = ctActualDB ? (ctActualDB[`cycle_${h}`] || 0) : 0;
                cycleTimeActual.push(ctAct);

                // CT Target (ค่าเดียวกันทุกชม.)
                cycleTimeTarget.push(targetCTValue);

                // Avail Target (ค่าเดียวกันทุกชม.)
                availabilityTarget.push(targetAvailValue);
            }

            res.json({
                hours: SHIFT_HOURS,
                cycleTimeActual,
                cycleTimeTarget,
                availabilityActual,
                availabilityTarget
            });

        } catch (err) {
            console.error(err);
            res.status(500).json({ message: "Get Graph2 Error" });
        }
    },

    // ============================================================
    // 6️⃣ GET Models by Date (✅ Phase 1: InfluxDB Actual → fallback MSSQL)
    // ============================================================
    getModelsByDate: async (req, res) => {
        try {
            const { machine_name, date } = req.query;
            if (!machine_name || !date) {
                return res.status(400).json({ message: "machine_name and date required" });
            }

            const targetDate = new Date(date);

            // 1️⃣ Try InfluxDB first (actual models produced)
            try {
                const { startUTC, endUTC } = getShiftBoundariesForDate(date);
                const now = new Date();
                const queryEnd = now < endUTC ? now : endUTC;
                const actualModels = await influxService.queryActualModels(machine_name, startUTC, queryEnd);
                if (actualModels.length > 0) {
                    return res.json({ results: actualModels, source: "influxdb" });
                }
            } catch (e) {
                console.error("getModelsByDate: InfluxDB query failed, falling back:", e.message);
            }

            // 2️⃣ Fallback: tb_output_actual (Cron-written model_name)
            const actualRow = await prisma.tb_output_actual.findFirst({
                where: { machine_name, date: targetDate },
                select: { model_name: true },
            });
            if (actualRow?.model_name) {
                return res.json({ results: [{ model_name: actualRow.model_name }], source: "mssql_actual" });
            }

            // 3️⃣ Fallback: tb_output_target (original)
            const models = await prisma.tb_output_target.findMany({
                where: { machine_name, date: targetDate },
                select: { model_name: true },
                distinct: ['model_name']
            });

            return res.json({ results: models, source: "mssql_target" });
        } catch (error) {
            console.error("getModelsByDate error:", error);
            return res.status(500).json({ message: "Error fetching models", error: error.message });
        }
    }
};
