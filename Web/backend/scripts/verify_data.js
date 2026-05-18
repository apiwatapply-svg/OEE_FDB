require("dotenv").config();
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const influxService = require("../services/influxService");

const SHIFT_HOURS = [
  "07", "08", "09", "10", "11", "12", "13", "14", "15", "16", "17", "18",
  "19", "20", "21", "22", "23", "00", "01", "02", "03", "04", "05", "06",
];

async function main() {
  console.log("Starting data verification...");
  influxService.initClient();

  const now = new Date();
  
  // Last 4 days (not counting today, or counting today? Let's do past 4 days including today)
  for (let i = 4; i >= 0; i--) {
    const targetDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    const targetDateISO = targetDate.toISOString().split("T")[0];
    
    const startUTC = `${targetDateISO}T00:00:00.000Z`;
    const endUTC = new Date(targetDate.getTime() + 86400000).toISOString().split("T")[0] + "T00:00:00.000Z";

    console.log(`\n================================`);
    console.log(`Verifying Date: ${targetDateISO}`);
    console.log(`================================`);

    // Fetch MSSQL
    const [outputs, cycleTimes, ngs, availabilities, efficiencies, oees] = await Promise.all([
      prisma.tb_output_actual.findMany({ where: { date: targetDate } }),
      prisma.tb_cycle_time_actual.findMany({ where: { date: targetDate } }),
      prisma.tb_machine_ng.findMany({ where: { date: targetDate } }),
      prisma.tb_availability_actual.findMany({ where: { date: targetDate } }),
      prisma.tb_efficiency_actual.findMany({ where: { date: targetDate } }),
      prisma.tb_oee.findMany({ where: { date: targetDate } })
    ]);

    // Aggregate MSSQL Output & Cycle Time
    const mssqlData = {};
    for (const o of outputs) {
      let totalOutput = 0;
      for (const h of SHIFT_HOURS) {
         totalOutput += (o[`actual_${h}`] || 0);
      }
      if (!mssqlData[o.machine_name]) mssqlData[o.machine_name] = { output: 0, cycle: 0, ng: 0, avail: 0, perf: 0, qual: 0, oee: 0, fromMssql: true };
      mssqlData[o.machine_name].output += totalOutput;
    }
    for (const c of cycleTimes) {
      if (!mssqlData[c.machine_name]) mssqlData[c.machine_name] = { output: 0, cycle: 0, ng: 0, avail: 0, perf: 0, qual: 0, oee: 0, fromMssql: true };
      mssqlData[c.machine_name].cycle = Number(c.cycle_time || 0).toFixed(2);
    }
    for (const ng of ngs) {
       if (ng.station_id !== 0) continue; // Skip individual stations to only count "True NG Parts"
       if (!mssqlData[ng.machine_name]) mssqlData[ng.machine_name] = { output: 0, cycle: 0, ng: 0, avail: 0, perf: 0, qual: 0, oee: 0, fromMssql: true };
       let totalNg = 0;
       for (const h of SHIFT_HOURS) totalNg += (ng[`ng_${h}`] || 0);
       mssqlData[ng.machine_name].ng += totalNg;
    }
    for (const a of availabilities) {
      if (!mssqlData[a.machine_name]) mssqlData[a.machine_name] = { output: 0, cycle: 0, ng: 0, avail: 0, perf: 0, qual: 0, oee: 0, fromMssql: true };
      mssqlData[a.machine_name].avail = Number(a.avail_actual || 0).toFixed(2);
    }
    for (const oee of oees) {
      if (!mssqlData[oee.machine_name]) mssqlData[oee.machine_name] = { output: 0, cycle: 0, ng: 0, avail: 0, perf: 0, qual: 0, oee: 0, fromMssql: true };
      mssqlData[oee.machine_name].perf = Number(oee.performance || 0).toFixed(2);
      mssqlData[oee.machine_name].qual = Number(oee.quality || 0).toFixed(2);
      mssqlData[oee.machine_name].oee = Number(oee.oee_value || 0).toFixed(2);
    }

    // Fetch InfluxDB
    const influxStats = await influxService.queryAllMachinesForHour(startUTC, endUTC);
    const influxNg = await influxService.queryAllMachinesNgCount(startUTC, endUTC);

    // Get Status & Alarm for Availability calculation (Simplified check)
    // Note: Accurate A, P, Q, OEE requires full state snapshot playback, 
    // Here we just pull what is in MSSQL to see if there are zeroed/missing values.
    
    // Merge & Compare
    let discrepancies = 0;
    const allMachines = new Set([...Object.keys(mssqlData), ...Object.keys(influxStats), ...Object.keys(influxNg)]);

    for (const mn of allMachines) {
      const msQ = mssqlData[mn] || { output: 0, cycle: 0, ng: 0, avail: 0, perf: 0, qual: 0, oee: 0, fromMssql: false };
      const inxOutput = influxStats[mn]?.output_count || 0;
      const inxCycle = Number(influxStats[mn]?.avg_cycle_time || 0).toFixed(2);
      const inxNg = influxNg[mn] || 0;

      // Ensure zero fallback
      const mQOut = Number(msQ.output);
      const mQCycle = Number(msQ.cycle);
      const mQNg = Number(msQ.ng);
      const mQAvail = Number(msQ.avail);
      const mQPerf = Number(msQ.perf);
      const mQQual = Number(msQ.qual);
      const mQOee = Number(msQ.oee);
      
      const inOut = Number(inxOutput);
      const inCycle = Number(inxCycle);
      const inNg = Number(inxNg);

      let machineDiff = false;
      let logs = [];

      if (mQOut !== inOut) { machineDiff = true; logs.push(`       Output -> MSSQL: ${mQOut}, Influx: ${inOut}`); }
      if (mQNg !== inNg) { machineDiff = true; logs.push(`       NG     -> MSSQL: ${mQNg}, Influx: ${inNg}`); }
      if (Math.abs(mQCycle - inCycle) > 2.0) { machineDiff = true; logs.push(`       CT     -> MSSQL: ${mQCycle}, Influx: ${inCycle}`); }
      
      // OEE values from MSSQL (We can't easily calculate exact Influx OEE here without heavy logic, so we flag missing data)
      if (mQAvail === 0 && mQOut > 0) { machineDiff = true; logs.push(`       A      -> MSSQL is 0% but Output > 0`); }
      if (mQPerf === 0 && mQOut > 0) { machineDiff = true; logs.push(`       P      -> MSSQL is 0% but Output > 0`); }
      if (mQQual === 0 && mQOut > 0) { machineDiff = true; logs.push(`       Q      -> MSSQL is 0% but Output > 0`); }
      if (mQOee === 0 && mQOut > 0) { machineDiff = true; logs.push(`       OEE    -> MSSQL is 0% but Output > 0`); }

      if (machineDiff) {
        console.log(`[Diff] Machine: ${mn}`);
        logs.forEach(l => console.log(l));
        discrepancies++;
      }
    }

    if (discrepancies === 0) {
      console.log(`✅ All output and NG counts match perfectly between MSSQL and InfluxDB!`);
    } else {
      console.log(`⚠️ Found ${discrepancies} machines with mismatched data.`);
    }
  }

  process.exit(0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
