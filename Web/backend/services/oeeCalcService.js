/**
 * OEE Calculation Service — Shared functions for Availability & Performance
 * Used by: realtimeService.js (socket every 5s), cronService.js (hourly upsert tb_oee)
 */

// MC Statuses that are excluded from operating time (not counted as downtime NOR running)
const EXCLUDED_STATUSES = new Set(["Plan_Stop", "Break_Time", "Preventive", "Signal_Lost"]);
// MC Status that counts as running
const RUNNING_STATUS = "Run_Time";

/**
 * Check if status should be excluded. Also catches any status containing 'Preventive'
 */
function isExcludedStatus(status) {
    if (!status) return false;
    if (EXCLUDED_STATUSES.has(status)) return true;
    if (status.includes("Preventive")) return true;
    return false;
}

const fs = require('fs');
const path = require('path');
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const { SHIFT_HOURS } = require("../utils/timeUtils");
const { sumActualByHour } = require("./actualOutputService");
let machineCalcConfig = null;

function roundMetric(value, digits = 2) {
    return parseFloat((Number(value) || 0).toFixed(digits));
}

function sumHourlyFields(row, prefix, hours = SHIFT_HOURS) {
    if (!row) return 0;
    return hours.reduce((sum, h) => sum + (row[`${prefix}_${h}`] || 0), 0);
}

function sumHourlyRows(rows, prefix, hours = SHIFT_HOURS) {
    return (rows || []).reduce((sum, row) => sum + sumHourlyFields(row, prefix, hours), 0);
}

function calcRejectSummary(machineOutput, rejectQty) {
    const output = Number(machineOutput) || 0;
    const reject = Number(rejectQty) || 0;
    return {
        rejectQty: reject,
        totalOutput: Math.max(0, output - reject),
        rejectPercent: output > 0 ? roundMetric((reject / output) * 100) : 0,
    };
}

function getMachineRunTimeMode(machineName) {
    if (!machineCalcConfig) {
        try {
            const configPath = path.join(__dirname, '../config/machine_calc.json');
            machineCalcConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        } catch (e) {
            console.error("⚠️ [Config] failed to load machine_calc.json:", e.message);
            machineCalcConfig = { default_mode: "status_based", custom_modes: {}, ct_calc_modes: { default: "runtime_based" } };
        }
    }
    
    // Check prefix match
    for (const prefix of Object.keys(machineCalcConfig.custom_modes)) {
        if (machineName.startsWith(prefix)) {
            return machineCalcConfig.custom_modes[prefix];
        }
    }
    return machineCalcConfig.default_mode || "status_based";
}

/**
 * Get CT calculation mode for a machine (runtime_based or influx_avg)
 */
function getCTCalcMode(machineName) {
    if (!machineCalcConfig) {
        getMachineRunTimeMode(machineName); // Force load config
    }
    
    if (machineCalcConfig.ct_calc_modes) {
        for (const prefix of Object.keys(machineCalcConfig.ct_calc_modes)) {
            if (prefix !== 'default' && machineName.startsWith(prefix)) {
                return machineCalcConfig.ct_calc_modes[prefix];
            }
        }
    }
    return machineCalcConfig.ct_calc_modes?.default || "runtime_based";
}

/**
 * Get Quality calculation mode (visual_ng or over_reject)
 */
function getNgMode(machineName) {
    if (!machineCalcConfig) {
        getMachineRunTimeMode(machineName); // Force load config
    }
    
    if (machineCalcConfig.ng_modes) {
        for (const prefix of Object.keys(machineCalcConfig.ng_modes)) {
            if (prefix !== 'default' && machineName.startsWith(prefix)) {
                return machineCalcConfig.ng_modes[prefix];
            }
        }
    }
    return machineCalcConfig.ng_modes?.default || "visual_ng";
}

/**
 * Get Target Deduct Mode — ควรหัก Excluded Time ออกจาก Output Target หรือไม่
 * true  = หัก Plan_Stop/Break_Time/Preventive ออกจาก Target (เช่น ABR)
 * false = ไม่หัก (เช่น AHV ที่ไม่มี MCStatus)
 */
function getTargetDeductMode(machineName) {
    if (!machineCalcConfig) {
        getMachineRunTimeMode(machineName); // force load config
    }
    const deductMap = machineCalcConfig.target_deduct_excluded || {};
    for (const prefix of Object.keys(deductMap)) {
        if (prefix !== 'default' && machineName.startsWith(prefix)) {
            return deductMap[prefix];
        }
    }
    return deductMap.default ?? false;
}

/**
 * Get Availability Target Config
 * "eff_target" = ใช้ค่าที่กรอกมากับ Plan, number = ใช้ค่า Fix ตัวเลขตาม Config
 */
function getAvailabilityTargetConfig(machineName) {
    if (!machineCalcConfig) {
        getMachineRunTimeMode(machineName); // force load config
    }
    const availMap = machineCalcConfig.availability_targets || {};
    for (const prefix of Object.keys(availMap)) {
        if (prefix !== 'default' && machineName.startsWith(prefix)) {
            return availMap[prefix];
        }
    }
    return availMap.default ?? "eff_target";
}

/**
 * Calculate run time and excluded time from MC Status records for a given shift period.
 *
 * @param {Array<{Datetime: Date, MCStatus: string}>} records - sorted by Datetime ASC
 * @param {Date} shiftStart - shift start time (e.g. 07:00 TH)
 * @param {Date} endTime - current time or shift end time
 * @returns {{ runTimeSeconds: number, excludedSeconds: number, totalSeconds: number }}
 */
function calcMcStatusDurations(records, shiftStart, endTime) {
    let runTimeSeconds = 0;
    let excludedSeconds = 0;
    const totalSeconds = Math.max(0, (endTime - shiftStart) / 1000);

    if (records.length === 0) {
        return { runTimeSeconds: 0, excludedSeconds: 0, totalSeconds };
    }

    for (let i = 0; i < records.length; i++) {
        const rec = records[i];
        const segStart = new Date(Math.max(rec.Datetime.getTime(), shiftStart.getTime()));
        const segEnd = i + 1 < records.length
            ? new Date(Math.min(records[i + 1].Datetime.getTime(), endTime.getTime()))
            : endTime;

        const durationSec = Math.max(0, (segEnd - segStart) / 1000);

        if (rec.MCStatus === RUNNING_STATUS) {
            runTimeSeconds += durationSec;
        } else if (isExcludedStatus(rec.MCStatus)) {
            excludedSeconds += durationSec;
        }
        // Other statuses = downtime (not counted in either)
    }

    return { runTimeSeconds, excludedSeconds, totalSeconds };
}

/**
 * Calculate run time and excluded time from MC Status records split per hour
 *
 * @param {Array<{Datetime: Date, MCStatus: string}>} records - sorted by Datetime ASC
 * @param {Date} shiftStart - shift start time
 * @param {number} shiftHours - number of hours to calculate (default 24)
 * @returns {Array<{ runTimeSeconds: number, excludedSeconds: number, totalSeconds: number }>}
 */
function calcMcStatusDurationsPerHour(records, shiftStart, shiftHours = 24) {
    const hourlyDurations = [];
    
    for (let i = 0; i < shiftHours; i++) {
        const hourStart = new Date(shiftStart.getTime() + i * 3600000);
        const hourEnd = new Date(hourStart.getTime() + 3600000);
        hourlyDurations.push(calcMcStatusDurations(records, hourStart, hourEnd));
    }
    
    return hourlyDurations;
}

/**
 * Calculate Availability %
 * Availability = RunTime / OperatingTime × 100
 * OperatingTime = TotalTime − ExcludedTime
 *
 * @param {number} runTimeSeconds
 * @param {number} excludedSeconds
 * @param {number} totalSeconds
 * @returns {number} availability percentage (0–100+)
 */
function calcAvailability(runTimeSeconds, excludedSeconds, totalSeconds) {
    const operatingTime = totalSeconds - excludedSeconds;
    if (operatingTime <= 0) return 0;
    const a = (runTimeSeconds / operatingTime) * 100;
    return Math.min(100, Math.max(0, a));
}

/**
 * Calculate Performance %
 * Performance = (TotalOutput × IdealCT) / RunTime × 100
 *
 * @param {number} totalOutput - total pieces produced
 * @param {number} idealCT - ideal cycle time in seconds
 * @param {number} runTimeSeconds - total run time in seconds
 * @returns {number} performance percentage (0–100+)
 */
function calcPerformance(totalOutput, idealCT, runTimeSeconds) {
    if (runTimeSeconds <= 0 || idealCT <= 0) return 0;
    const p = (totalOutput * idealCT) / runTimeSeconds * 100;
    // Cap at 150% to prevent extreme metric spikes, but allow some breathing room above 100%
    return Math.min(150, Math.max(0, p));
}

function calcVisualQuality(totalOutput, ngQty) {
    const output = Number(totalOutput) || 0;
    const ng = Number(ngQty) || 0;
    if (output <= 0) return 0;
    return Math.max(0, ((output - ng) / output) * 100);
}

function calcOeeValue(availability, performance, quality, fallbackValue = 0) {
    if (availability > 0 && performance > 0 && quality > 0) {
        return (availability / 100) * (performance / 100) * (quality / 100) * 100;
    }
    return fallbackValue || 0;
}

function calcManualNgMetrics(totalOutput, ngQty, availability, performance) {
    const quality = calcVisualQuality(totalOutput, ngQty);
    const oeeValue = calcOeeValue(availability, performance, quality);
    return {
        quality: roundMetric(quality),
        oeeValue: roundMetric(oeeValue),
    };
}

function calcAutoOeeMetrics({ totalOutput, ngQty, availability, idealCT, runTimeSeconds, ngMode, fallbackOeeValue = 0 }) {
    const outputForOee = ngMode === "over_reject"
        ? Math.max(0, (Number(totalOutput) || 0) - (Number(ngQty) || 0))
        : (Number(totalOutput) || 0);
    const performance = calcPerformance(outputForOee, idealCT, runTimeSeconds);
    const quality = ngMode === "over_reject" ? 100 : calcVisualQuality(totalOutput, ngQty);
    const oeeValue = calcOeeValue(availability, performance, quality, fallbackOeeValue);

    return {
        outputForOee,
        performance: roundMetric(performance),
        quality: roundMetric(quality),
        oeeValue: roundMetric(oeeValue),
    };
}

/**
 * Recalculate OEE (Availability & Performance) for a specific machine on a specific date.
 */
async function recalculateAPQForDay(machineName, targetDate) {
    try {
        const dateStr = targetDate.toISOString().split("T")[0];

        const year = parseInt(dateStr.substring(0, 4));
        const month = parseInt(dateStr.substring(5, 7)) - 1;
        const day = parseInt(dateStr.substring(8, 10));

        const shiftStart = new Date(Date.UTC(year, month, day, 7, 0, 0));
        const shiftEnd = new Date(Date.UTC(year, month, day + 1, 7, 0, 0));

        const mcStatusRows = await prisma.tb_MCStatus.findMany({
            where: {
                MC: machineName,
                Datetime: { gte: shiftStart, lt: shiftEnd }
            },
            orderBy: { Datetime: "asc" },
            select: { MC: true, Datetime: true, MCStatus: true },
        });

        const carryOverRows = await prisma.$queryRaw`
            SELECT MC, MCStatus, Datetime FROM (
                SELECT MC, MCStatus, Datetime, ROW_NUMBER() OVER (PARTITION BY MC ORDER BY Datetime DESC) AS rn
                FROM tb_MCStatus WHERE MC = ${machineName} AND Datetime < ${shiftStart}
            ) t WHERE rn = 1
        `;

        const mcRecords = [];
        if (carryOverRows && carryOverRows.length > 0) {
            mcRecords.push({ MC: carryOverRows[0].MC, Datetime: shiftStart, MCStatus: carryOverRows[0].MCStatus });
        }
        mcRecords.push(...mcStatusRows);

        if (mcRecords.length === 0) {
            console.log(`[OEE Backfill] Null MCStatus data for ${machineName} on ${dateStr}`);
            return;
        }

        const [outputRows, targetRow, ctRow] = await Promise.all([
            prisma.tb_output_actual.findMany({ where: { machine_name: machineName, date: targetDate } }),
            prisma.tb_output_target.findFirst({ where: { machine_name: machineName, date: targetDate } }),
            prisma.tb_cycle_time_actual.findFirst({ where: { machine_name: machineName, date: targetDate } }),
        ]);

        // ✅ Pre-compute SUM per hour: per-hour fallback (Option B)
        const outputSumPerHour = sumActualByHour(outputRows, SHIFT_HOURS);

        let runTimeSeconds = 0;
        let excludedSeconds = 0;
        let totalActiveSeconds = 0;
        let totalOutput = 0;

        for (let i = 0; i < SHIFT_HOURS.length; i++) {
            const h = SHIFT_HOURS[i];
            const isActive = !targetRow || (targetRow[`target_${h}`] > 0);
            
            if (isActive) {
                totalOutput += (outputSumPerHour[`actual_${h}`] || 0);

                const hStart = new Date(shiftStart.getTime() + i * 3600000);
                const hEnd = new Date(hStart.getTime() + 3600000);
                const { runTimeSeconds: rTime, excludedSeconds: eTime } = calcMcStatusDurations(mcRecords, hStart, hEnd);
                
                runTimeSeconds += rTime;
                excludedSeconds += eTime;
                totalActiveSeconds += 3600;
            }
        }

        // 🆕 output_based override: AHV ไม่มี MCStatus → ใช้ Output × AvgCT แทน
        if (getMachineRunTimeMode(machineName) === "output_based") {
            let sumCtWeighted = 0;
            let totalOutputForCt = 0;
            for (let i = 0; i < SHIFT_HOURS.length; i++) {
                const h = SHIFT_HOURS[i];
                const out = outputSumPerHour[`actual_${h}`] || 0;
                const ct  = ctRow ? (ctRow[`cycle_${h}`] || 0) : 0;
                if (out > 0 && ct > 0) {
                    sumCtWeighted += ct * out;
                    totalOutputForCt += out;
                }
            }
            const avgCtAcross = totalOutputForCt > 0 ? (sumCtWeighted / totalOutputForCt) : 0;
            const avgToUse = avgCtAcross > 0 ? avgCtAcross : (targetRow?.cycle_time_target || 0);
            runTimeSeconds = totalOutput * avgToUse;
            excludedSeconds = 0;
        }

        const availability = calcAvailability(runTimeSeconds, excludedSeconds, totalActiveSeconds);
        const idealCT = targetRow?.cycle_time_target || 0;
        const performance = calcPerformance(totalOutput, idealCT, runTimeSeconds);

        const existingOee = await prisma.tb_oee.findFirst({ where: { machine_name: machineName, date: targetDate } });
        const finalNgQty = existingOee?.ng_qty || 0;
        const quality = calcVisualQuality(totalOutput, finalNgQty);
        const oeeValue = calcOeeValue(availability, performance, quality);

        const dataToWrite = {
            availability: parseFloat(availability.toFixed(2)),
            performance: parseFloat(performance.toFixed(2)),
            ng_qty: finalNgQty,
            quality: parseFloat(quality.toFixed(2)),
            oee_value: parseFloat(oeeValue.toFixed(2)),
        };

        await prisma.tb_oee.upsert({
            where: { machine_name_date: { machine_name: machineName, date: targetDate } },
            update: dataToWrite,
            create: {
                date: targetDate,
                machine_name: machineName,
                ...dataToWrite
            },
        });

        console.log(`✅ [OEE Backfill Recalculation] ${machineName} on ${dateStr}: A=${dataToWrite.availability}%, P=${dataToWrite.performance}%`);

    } catch (err) {
        console.error(`❌ [OEE Backfill Recalculation] Failed for ${machineName} on ${targetDate}:`, err.message);
    }
}

module.exports = {
    EXCLUDED_STATUSES,
    RUNNING_STATUS,
    isExcludedStatus,
    calcMcStatusDurations,
    calcMcStatusDurationsPerHour,
    calcAvailability,
    calcPerformance,
    calcVisualQuality,
    calcOeeValue,
    calcManualNgMetrics,
    calcAutoOeeMetrics,
    calcRejectSummary,
    roundMetric,
    sumHourlyFields,
    sumHourlyRows,
    getMachineRunTimeMode,
    getCTCalcMode,
    getNgMode,
    getTargetDeductMode,
    getAvailabilityTargetConfig,
    recalculateAPQForDay
};
