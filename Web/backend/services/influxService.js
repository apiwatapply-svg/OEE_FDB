/**
 * InfluxDB 1.x Service
 * เชื่อมต่อ InfluxDB และ query ข้อมูลเครื่องจักร
 */
require("dotenv").config();
const Influx = require("influx");

let influxClient = null;

function deriveAhvMachineNameFromHost(host) {
    if (!host) return null;
    const text = String(host);
    const match = text.match(/AHV[-_ ]?0*(\d{1,3})/i);
    if (!match) return null;
    const num = parseInt(match[1], 10);
    if (!Number.isFinite(num) || num <= 0) return null;
    return `AHV-${String(num).padStart(3, "0")}`;
}

/**
 * Initialize InfluxDB 1.x client
 */
function initClient() {
    const host = process.env.INFLUX_HOST || "192.168.100.99";
    const port = parseInt(process.env.INFLUX_PORT || "5012", 10);
    const database = process.env.INFLUX_DATABASE || "machine_db";

    influxClient = new Influx.InfluxDB({
        host,
        port,
        database,
    });

    console.log(`✅ InfluxDB client initialized: ${host}:${port}/${database}`);
    return influxClient;
}

/**
 * Get the client instance
 */
function getClient() {
    if (!influxClient) {
        throw new Error("InfluxDB client not initialized. Call initClient() first.");
    }
    return influxClient;
}

/**
 * Test connection to InfluxDB
 */
async function testConnection() {
    try {
        const client = getClient();
        const names = await client.getDatabaseNames();
        console.log("✅ InfluxDB connected. Databases:", names);
        return true;
    } catch (err) {
        console.error("❌ InfluxDB connection failed:", err.message);
        return false;
    }
}

/**
 * Query all machines for a specific hour range
 * Returns: { "MACHINE_NAME": { output_count: N, avg_cycle_time: N } }
 */
async function queryAllMachinesForHour(startUTC, endUTC) {
    const client = getClient();
    const measurement = process.env.INFLUX_MEASUREMENT || "data_tb";

    const startISO = startUTC instanceof Date ? startUTC.toISOString() : startUTC;
    const endISO = endUTC instanceof Date ? endUTC.toISOString() : endUTC;

    const query = `
        SELECT COUNT("cycle_time") AS "output_count",
               MEAN("cycle_time") AS "avg_cycle_time"
        FROM "${measurement}"
        WHERE time >= '${startISO}' AND time < '${endISO}'
        GROUP BY "machine_type", "machine_name", "host", "Model"
    `;

    try {
        const results = await client.query(query);
        const machineData = {};

        for (const row of results) {
            const rawMachineName = row.machine_name || row.tags?.machine_name;
            const machineType = row.machine_type || row.tags?.machine_type;
            const host = row.host || row.tags?.host;
            const derivedAhv = machineType === "AHV" ? deriveAhvMachineNameFromHost(host) : null;
            const machineName = derivedAhv || rawMachineName;
            // 🔧 Fix: row.Model is a direct property when Model is a Tag (GROUP BY "Model")
            //   Empty string ("") = data written before Telegraf used Model as Tag → treat as "--"
            const rawModel = row.Model ?? row.tags?.Model;
            const modelName = (rawModel != null && rawModel !== "") ? rawModel : "--";
            
            if (machineName) {
                if (!machineData[machineName]) {
                    machineData[machineName] = {
                        output_count: 0,
                        sum_cycle_time: 0,
                        avg_cycle_time: 0,
                        models: {}
                    };
                }
                
                const count = row.output_count || 0;
                const ct = row.avg_cycle_time || 0;
                
                machineData[machineName].models[modelName] = {
                    output_count: count,
                    avg_cycle_time: ct
                };
                
                machineData[machineName].output_count += count;
                machineData[machineName].sum_cycle_time += (count * ct);
            }
        }
        
        // Calculate root average
        for (const m of Object.values(machineData)) {
            m.avg_cycle_time = m.output_count > 0 ? (m.sum_cycle_time / m.output_count) : 0;
        }

        return machineData;
    } catch (err) {
        console.error("❌ InfluxDB query error:", err.message);
        return {};
    }
}

/**
 * Query a single machine for a specific hour range
 */
async function queryMachineForHour(machineName, startUTC, endUTC) {
    const client = getClient();
    const measurement = process.env.INFLUX_MEASUREMENT || "data_tb";

    const startISO = startUTC instanceof Date ? startUTC.toISOString() : startUTC;
    const endISO = endUTC instanceof Date ? endUTC.toISOString() : endUTC;

    const ahvMatch = String(machineName || "").match(/^AHV-(\d{3})$/);
    const hostRegex = ahvMatch ? `/.*AHV[-_ ]?0*${ahvMatch[1]}.*/` : null;

    const whereClause = ahvMatch
        ? `(("machine_name" = '${machineName}') OR ("machine_type" = 'AHV' AND "host" =~ ${hostRegex}))`
        : `("machine_name" = '${machineName}')`;

    const query = `
        SELECT COUNT("cycle_time") AS "output_count",
               MEAN("cycle_time") AS "avg_cycle_time"
        FROM "${measurement}"
        WHERE ${whereClause}
        AND time >= '${startISO}' AND time < '${endISO}'
    `;

    try {
        const results = await client.query(query);
        if (results.length > 0) {
            return {
                output_count: results[0].output_count || 0,
                avg_cycle_time: results[0].avg_cycle_time || 0,
            };
        }
        return { output_count: 0, avg_cycle_time: 0 };
    } catch (err) {
        console.error(`❌ InfluxDB query error for ${machineName}:`, err.message);
        return { output_count: 0, avg_cycle_time: 0 };
    }
}

/**
 * Query multiple hours for late data detection
 * Returns: { "MACHINE_NAME": { "YYYY-MM-DDTHH": { output_count, avg_cycle_time } } }
 */
async function queryHoursRange(startUTC, endUTC) {
    const client = getClient();
    const measurement = process.env.INFLUX_MEASUREMENT || "data_tb";

    const startISO = startUTC instanceof Date ? startUTC.toISOString() : startUTC;
    const endISO = endUTC instanceof Date ? endUTC.toISOString() : endUTC;

    const query = `
        SELECT COUNT("cycle_time") AS "output_count",
               MEAN("cycle_time") AS "avg_cycle_time"
        FROM "${measurement}"
        WHERE time >= '${startISO}' AND time < '${endISO}'
        GROUP BY "machine_type", "machine_name", "host", "Model", time(1h)
    `;

    try {
        const results = await client.query(query);
        const machineHourData = {};

        for (const row of results) {
            const rawMachineName = row.machine_name || row.tags?.machine_name;
            const machineType = row.machine_type || row.tags?.machine_type;
            const host = row.host || row.tags?.host;
            const derivedAhv = machineType === "AHV" ? deriveAhvMachineNameFromHost(host) : null;
            const machineName = derivedAhv || rawMachineName;
            // 🔧 Fix: row.Model is a direct property when Model is a Tag (GROUP BY "Model")
            //   Empty string ("") = data written before Telegraf used Model as Tag → treat as "--"
            const rawModel = row.Model ?? row.tags?.Model;
            const modelName = (rawModel != null && rawModel !== "") ? rawModel : "--";
            if (!machineName) continue;

            if (!machineHourData[machineName]) machineHourData[machineName] = {};

            const hourKey = new Date(row.time).toISOString().slice(0, 13); // "YYYY-MM-DDTHH"
            
            if (!machineHourData[machineName][hourKey]) {
                machineHourData[machineName][hourKey] = {
                    output_count: 0,
                    avg_cycle_time: 0,
                    sum_cycle_time: 0,
                    models: {}
                };
            }
            
            const count = row.output_count || 0;
            const ct = row.avg_cycle_time || 0;
            
            machineHourData[machineName][hourKey].models[modelName] = {
                output_count: count,
                avg_cycle_time: ct
            };
            
            machineHourData[machineName][hourKey].output_count += count;
            machineHourData[machineName][hourKey].sum_cycle_time += (count * ct);
        }
        
        // Recalculate root averages
        for (const machineObj of Object.values(machineHourData)) {
            for (const hourObj of Object.values(machineObj)) {
                hourObj.avg_cycle_time = hourObj.output_count > 0 ? (hourObj.sum_cycle_time / hourObj.output_count) : 0;
            }
        }

        return machineHourData;
    } catch (err) {
        console.error("❌ InfluxDB range query error:", err.message);
        return {};
    }
}

/**
 * Count NG records for a single machine (judg_result contains "NG")
 */
async function queryNgCount(machineName, startUTC, endUTC) {
    const client = getClient();
    const measurement = process.env.INFLUX_MEASUREMENT || "data_tb";
    const startISO = startUTC instanceof Date ? startUTC.toISOString() : startUTC;
    const endISO = endUTC instanceof Date ? endUTC.toISOString() : endUTC;

    const query = `
        SELECT COUNT("cycle_time") AS "ng_count"
        FROM "${measurement}"
        WHERE "machine_name" = '${machineName}'
        AND "judg_result" =~ /NG/
        AND time >= '${startISO}' AND time < '${endISO}'
    `;
    try {
        const results = await client.query(query);
        return results.length > 0 ? (results[0].ng_count || 0) : 0;
    } catch (err) {
        console.error(`❌ InfluxDB NG query error for ${machineName}:`, err.message);
        return 0;
    }
}

/**
 * Count NG records for ALL machines (judg_result contains "NG")
 * Returns: { "MACHINE_NAME": ng_count }
 */
async function queryAllMachinesNgCount(startUTC, endUTC) {
    const client = getClient();
    const measurement = process.env.INFLUX_MEASUREMENT || "data_tb";
    const startISO = startUTC instanceof Date ? startUTC.toISOString() : startUTC;
    const endISO = endUTC instanceof Date ? endUTC.toISOString() : endUTC;

    const query = `
        SELECT COUNT("cycle_time") AS "ng_count"
        FROM "${measurement}"
        WHERE "judg_result" =~ /NG/
        AND time >= '${startISO}' AND time < '${endISO}'
        GROUP BY "machine_name"
    `;
    try {
        const results = await client.query(query);
        const data = {};
        for (const row of results) {
            const mn = row.machine_name || row.tags?.machine_name;
            if (mn) data[mn] = row.ng_count || 0;
        }
        return data;
    } catch (err) {
        console.error("❌ InfluxDB all-machines NG query error:", err.message);
        return {};
    }
}

/**
 * Query distinct actual Models for a machine in a time range
 * Note: "Model" is a FIELD (not tag) in InfluxDB, so we use DISTINCT()
 * Returns: [{ model_name: "Longspeak10D" }, ...]
 */
async function queryActualModels(machineName, startUTC, endUTC) {
    const client = getClient();
    const measurement = process.env.INFLUX_MEASUREMENT || "data_tb";
    const startISO = startUTC instanceof Date ? startUTC.toISOString() : startUTC;
    const endISO = endUTC instanceof Date ? endUTC.toISOString() : endUTC;

    const query = `
        SELECT DISTINCT("Model") AS "model_name"
        FROM "${measurement}"
        WHERE "machine_name" = '${machineName}'
        AND time >= '${startISO}' AND time < '${endISO}'
    `;

    try {
        const results = await client.query(query);
        const models = [];
        for (const row of results) {
            const modelName = row.distinct || row.model_name;
            if (modelName) {
                models.push({ model_name: modelName });
            }
        }
        return models;
    } catch (err) {
        console.error(`❌ InfluxDB queryActualModels error for ${machineName}:`, err.message);
        return [];
    }
}

/**
 * Query all machines' last Model for a specific hour range
 * Note: "Model" is a FIELD, "machine_name" is a TAG
 * Returns: { "MACHINE_NAME": "ModelName" } (last model per machine in range)
 */
async function queryAllMachinesModelsForHour(startUTC, endUTC) {
    const client = getClient();
    const measurement = process.env.INFLUX_MEASUREMENT || "data_tb";
    const startISO = startUTC instanceof Date ? startUTC.toISOString() : startUTC;
    const endISO = endUTC instanceof Date ? endUTC.toISOString() : endUTC;

    const query = `
        SELECT LAST("Model") AS "model_name"
        FROM "${measurement}"
        WHERE time >= '${startISO}' AND time < '${endISO}'
        GROUP BY "machine_name"
    `;

    try {
        const results = await client.query(query);
        const result = {};
        for (const row of results) {
            const machineName = row.machine_name || row.tags?.machine_name;
            const modelName = row.last || row.model_name;
            if (machineName && modelName) {
                result[machineName] = modelName;
            }
        }
        return result;
    } catch (err) {
        console.error("❌ InfluxDB queryAllMachinesModelsForHour error:", err.message);
        return {};
    }
}

/**
 * 🆕 Query and parse NG by station from judg_result string
 * judg_result is expected to be a comma-separated string, e.g., "OK,NG,OK,OK,NG"
 * We use ng_id (1-indexed) to find the position in the string.
 * station_number is used only for UI ordering, not for data parsing.
 */
async function queryNgByStationForHour(machineName, startUTC, endUTC, stationConfig) {
    const client = getClient();
    const measurement = process.env.INFLUX_MEASUREMENT || "data_tb";
    const startISO = startUTC instanceof Date ? startUTC.toISOString() : startUTC;
    const endISO = endUTC instanceof Date ? endUTC.toISOString() : endUTC;

    const query = `
        SELECT "judg_result"
        FROM "${measurement}"
        WHERE "machine_name" = '${machineName}'
        AND "judg_result" =~ /NG/
        AND time >= '${startISO}' AND time < '${endISO}'
    `;

    const stationCounts = {};
    for (const st of stationConfig) {
        stationCounts[st.station_name] = 0;
    }
    // 🆕 Add a special aggregate counter for "True NG Parts"
    stationCounts['True_NG'] = 0;

    try {
        const results = await client.query(query);
        for (const row of results) {
            if (!row.judg_result) continue;
            
            // "OK,NG,OK" -> ["OK", "NG", "OK"]
            const resultsArray = row.judg_result.split(",");
            let isPartNg = false; // 🆕 Track if this specific part is NG
            
            for (const st of stationConfig) {
                // ng_id is 1-indexed: position in judg_result string
                // station_number is for UI column ordering only
                const idx = st.ng_id - 1;
                
                if (idx >= 0 && idx < resultsArray.length) {
                    if (resultsArray[idx].trim().toUpperCase() === "NG") {
                         stationCounts[st.station_name] += 1;
                         isPartNg = true;
                    }
                }
            }

            // 🆕 If any configured station failed, it counts as exactly 1 NG Part
            if (isPartNg) {
                stationCounts['True_NG'] += 1;
            }
        }
        return stationCounts;
    } catch (err) {
        console.error(`❌ InfluxDB queryNgByStationForHour error for ${machineName}:`, err.message);
        return stationCounts;
    }
}

/**
 * Query status_tb for historical sync
 * Returns: Array of { machine_name, time, status }
 */
async function queryStatusRange(startUTC, endUTC) {
    const client = getClient();
    const measurement = "status_tb";
    const startISO = startUTC instanceof Date ? startUTC.toISOString() : startUTC;
    const endISO = endUTC instanceof Date ? endUTC.toISOString() : endUTC;

    const query = `
        SELECT "Status"
        FROM "${measurement}"
        WHERE time >= '${startISO}' AND time < '${endISO}'
    `;
    try {
        const results = await client.query(query);
        const data = [];
        for (const row of results) {
            const machineName = row.machine_name || row.tags?.machine_name;
            if (machineName && row.Status) {
                data.push({
                    machine_name: machineName,
                    time: new Date(row.time),
                    status: row.Status
                });
            }
        }
        return data;
    } catch (err) {
        // Just log and return empty array if the measurement doesn't exist yet
        console.error("❌ InfluxDB queryStatusRange error:", err.message);
        return [];
    }
}

/**
 * Query alarm_tb for historical sync
 * Returns: Array of { machine_name, time, alarm }
 */
async function queryAlarmRange(startUTC, endUTC) {
    const client = getClient();
    const measurement = "alarm_tb";
    const startISO = startUTC instanceof Date ? startUTC.toISOString() : startUTC;
    const endISO = endUTC instanceof Date ? endUTC.toISOString() : endUTC;

    const query = `
        SELECT "Alarm"
        FROM "${measurement}"
        WHERE time >= '${startISO}' AND time < '${endISO}'
    `;
    try {
        const results = await client.query(query);
        const data = [];
        for (const row of results) {
            const machineName = row.machine_name || row.tags?.machine_name;
            if (machineName && row.Alarm) {
                data.push({
                    machine_name: machineName,
                    time: new Date(row.time),
                    alarm: row.Alarm
                });
            }
        }
        return data;
    } catch (err) {
        console.error("❌ InfluxDB queryAlarmRange error:", err.message);
        return [];
    }
}

module.exports = {
    initClient,
    getClient,
    testConnection,
    queryAllMachinesForHour,
    queryMachineForHour,
    queryHoursRange,
    queryNgCount,
    queryAllMachinesNgCount,
    queryNgByStationForHour,
    queryActualModels,
    queryAllMachinesModelsForHour,
    queryStatusRange,
    queryAlarmRange,
};
