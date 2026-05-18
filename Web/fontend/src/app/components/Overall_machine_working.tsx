"use client";

import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import axios from "axios";
import config from "@/app/config";
import { getSocket } from "@/app/lib/socketManager";
import {
    Chart as ChartJS,
    CategoryScale,
    LinearScale,
    BarElement,
    BarController,
    LineElement,
    LineController,
    PointElement,
    Title,
    Tooltip,
    Legend,
    ChartOptions,
} from "chart.js";
import { Chart } from "react-chartjs-2";
import ChartDataLabels from 'chartjs-plugin-datalabels';
import dayjs from "dayjs";
import { getStatusColors, getDowntimeKeys } from "@/app/lib/machineStatusConfig";

// Register Chart.js components
ChartJS.register(
    CategoryScale,
    LinearScale,
    BarElement,
    BarController,
    LineElement,
    LineController,
    PointElement,
    Title,
    Tooltip,
    Legend,
    ChartDataLabels
);

interface OverallMachineCardProps {
    machineName: string;
    date: string;
    scaleFactor?: number;

    refreshTrigger?: number;
    realtimeData?: any;
    activeView?: "output" | "status";
    mcStatusRefreshTrigger?: number;
    onLoginClick?: (machineName: string) => void; // ✅ Login button callback
    onLogoutClick?: (machineName: string, historyId: number, operatorCode: string) => void; // ✅ Remote logout callback
    isSingleView?: boolean; // ✅ For better layout when only 1 machine
}


export default function OverallMachineCard({
    machineName,
    date,
    scaleFactor = 1.0,
    refreshTrigger,
    realtimeData,
    activeView = "output",
    mcStatusRefreshTrigger,
    onLoginClick,
    onLogoutClick,
    isSingleView = false
}: OverallMachineCardProps) {
    // ================= State Management =================
    const [clientTime, setClientTime] = useState<string>("");
    const [tableData, setTableData] = useState({
        model: "-",
        achieve: 0,
        oee: 0,
        oeeDate: "-",
        operatorName: "-",
        operatorCode: "-",
        operatorPic: "",
        historyId: null as number | null, // ✅ Add historyId for logout
        outputActual: 0,
        outputTarget: 0,
        ctActual: 0,
        ctTarget: 0,
        effActual: 0,
        effTarget: 0,
        availabilityActual: 0,   // ✅ ค่า Availability จริงจาก memoryOeeService (realtime_update)
        availabilityTarget: 0,   // ✅ เป้าหมาย Availability (effTarget ใช้แทนชั่วคราว)
        liveStatus: "Offline", // 🆕
        liveAlarm: null as string | null, // 🆕
    });

    const [graph1Data, setGraph1Data] = useState<any>(null); // Output Graph
    const [graph2Data, setGraph2Data] = useState<any>(null); // CT & Eff Graph
    const [canShowLogout, setCanShowLogout] = useState(false);

    // 🆕 Config-driven Status Colors
    const [statusColors, setStatusColors] = useState<Record<string, { color: string; label: string }>>({});
    const [downtimeKeys, setDowntimeKeys] = useState<string[]>([]);

    useEffect(() => {
        const loadConfig = async () => {
            if (!machineName) return;
            const type = machineName.split("-")[0];
            const colors = await getStatusColors(type);
            const dKeys = await getDowntimeKeys(type);
            if (colors) setStatusColors(colors);
            if (dKeys) setDowntimeKeys(dKeys);
        };
        loadConfig();
    }, [machineName]);

    useEffect(() => {
        if (typeof window !== "undefined" && tableData.historyId) {
            const loginSource = localStorage.getItem(`loginSource_h${tableData.historyId}`);
            setCanShowLogout(loginSource === "overall_machine_working");
        } else {
            setCanShowLogout(false);
        }
    }, [tableData.historyId]);

    // MC Status state
    const [mcStatusData, setMcStatusData] = useState<any[]>([]);
    const mcStatusCanvasRef = useRef<HTMLCanvasElement>(null);
    const mcSegmentsRef = useRef<{ startMin: number; endMin: number; status: string; startTime: string; endTime: string }[]>([]);
    const [mcTooltip, setMcTooltip] = useState<{ visible: boolean; x: number; y: number; status: string; startTime: string; endTime: string; duration: string } | null>(null);
    const [downtimeChartData, setDowntimeChartData] = useState<any>(null);
    const [downtimeDurationMap, setDowntimeDurationMap] = useState<Record<string, number>>({});

    // Multi-Model Support
    const [modelsList, setModelsList] = useState<string[]>([]);
    const [selectedModel, setSelectedModel] = useState<string>("");

    // ✅ Calculate scaled dimensions
    const s = scaleFactor; // Shorthand
    const fontSize = {
        header: `${1.25 * s}rem`,   // 🔥 NEW: For Card Header so it's much bigger
        base: `${0.9 * s}rem`,      // Bumped slightly
        small: `${0.75 * s}rem`,    // Bumped from 0.6 to 0.75
        tiny: `${0.65 * s}rem`,     // Bumped from 0.5 to 0.65
        large: `${1.4 * s}rem`,     // Bumped from 1.1 to 1.4
    };
    const spacing = {
        cardPadding: `${8 * s}px`,
        cellPadding: `${4 * s}px`,
        graphHeight: `${80 * s}px`,
    };

    // Blink toggle for current-hour bar (toggles every 500ms)
    const [blinkOn, setBlinkOn] = useState(true);

    // ================= Effects =================

    // Clock Timer + Blink toggle
    useEffect(() => {
        const interval = setInterval(() => {
            const now = new Date();
            const todayStr = dayjs().format("YYYY-MM-DD");

            if (date === todayStr) {
                setClientTime(now.toLocaleTimeString("en-GB", { hour12: false }));
            } else {
                setClientTime(""); // Hide time if not today
            }
        }, 1000);

        // Blink interval for current-hour bar (only when viewing today)
        const blinkInterval = setInterval(() => {
            const todayStr = dayjs().format("YYYY-MM-DD");
            if (date === todayStr) {
                setBlinkOn(prev => !prev);
            }
        }, 700);

        return () => {
            clearInterval(interval);
            clearInterval(blinkInterval);
        };
    }, [date]);

    // REAL-TIME DATA HANDLING
    // REAL-TIME DATA HANDLING
    useEffect(() => {
        if (!realtimeData) {
            return;
        }

        // ✅ Guard: ถ้าดูย้อนหลัง (ไม่ใช่วันนี้) ให้ข้ามการอัปเดตจาก Socket ทั้งหมด
        // เพื่อไม่ให้ข้อมูล real-time ของวันนี้ไปทับข้อมูลประวัติที่ดึงจาก API
        const todayStr = new Date().toISOString().split("T")[0];
        if (date !== todayStr) {
            return;
        }

        const { daily, currentHour } = realtimeData;
        const { hourly } = daily;
        const serverCurrentHourStr = currentHour ? currentHour.hour : null;

        // 1. Update Table Data
        setTableData(prev => {
            const newOee = daily.oee > 0 ? daily.oee : prev.oee;
            // ✅ รับค่า availability จาก realtime_update (ผ่าน daily.availability)
            // ถ้ายังไม่มี (รอบ fast loop ที่ไม่ส่ง availability) ให้คงค่าเดิม
            const newAvailability = daily.availability !== undefined
                ? daily.availability
                : prev.availabilityActual;
            const newCtActual = daily.avgCycleTime > 0
                ? daily.avgCycleTime
                : prev.ctActual;

            if (
                prev.outputActual === daily.totalOutput &&
                prev.outputTarget === daily.accumTarget &&
                prev.achieve === daily.achieve &&
                prev.ctActual === newCtActual &&
                prev.effActual === daily.overallEfficiency &&
                prev.oee === newOee &&
                prev.availabilityActual === newAvailability
            ) {
                return prev;
            }

            return {
                ...prev,
                outputActual: daily.totalOutput,
                outputTarget: daily.accumTarget,
                achieve: daily.achieve,
                ctActual: newCtActual,
                effActual: daily.overallEfficiency,
                availabilityActual: newAvailability,   // ✅ อัปเดตค่า Availability จริง
                oee: newOee,
                liveStatus: currentHour.live_status || "Offline", // 🆕 Update from real-time
                liveAlarm: currentHour.live_alarm || null, // 🆕 Update from real-time
            };
        });

        // Helper to replicate filter logic using SERVER TIME
        const filterFutureDataInternal = (dataArray: number[], labels: any[], currentHourStr: string | null) => {
            if (!labels || !currentHourStr) return dataArray;

            // Parse server hour (e.g. "16")
            const currentHourInt = parseInt(currentHourStr);
            const currentIndex = labels.findIndex((h: string) => parseInt(h) === currentHourInt);

            if (currentIndex === -1) return dataArray;
            return dataArray.map((val, index) => index > currentIndex ? null : val);
        };

        // 2. Update Graph 1 — ✅ sync ทีละ index เหมือน machine_working
        setGraph1Data((prev: any) => {
            if (!prev) return prev;
            const newOutputActual = [...prev.datasets[0].data];
            const newOutputAccum = [...prev.datasets[2].data];
            const shiftIndex = currentHour.shiftIndex;

            // ✅ Sync ทุกแท่งที่ผ่านมาแล้ว + ปัจจุบัน จาก Backend hourly arrays
            if (hourly.output) {
                for (let i = 0; i <= shiftIndex && i < hourly.output.length; i++) {
                    newOutputActual[i] = hourly.output[i];
                }
            }

            // ✅ คำนวณ Accum ใหม่
            let runningAccum = 0;
            for (let i = 0; i < newOutputActual.length; i++) {
                const v = newOutputActual[i];
                if (v !== null && v !== undefined) runningAccum += v;
                newOutputAccum[i] = i <= shiftIndex ? runningAccum : prev.datasets[2].data[i];
            }

            // 🛑 Bail out
            let hasChanges = false;
            for (let i = 0; i < newOutputActual.length; i++) {
                if (newOutputActual[i] !== prev.datasets[0].data[i] || newOutputAccum[i] !== prev.datasets[2].data[i]) {
                    hasChanges = true;
                    break;
                }
            }
            if (!hasChanges) return prev;

            const newDatasets = prev.datasets.map((ds: any, idx: number) => {
                if (idx === 0) return { ...ds, data: newOutputActual };
                if (idx === 2) return { ...ds, data: newOutputAccum };
                return ds;
            });
            return { ...prev, datasets: newDatasets };
        });

        // 3. Update Graph 2 — ✅ sync ทีละ index เหมือน machine_working
        setGraph2Data((prev: any) => {
            if (!prev) return prev;
            const newCtActual = [...prev.datasets[0].data];
            const newEffActual = [...prev.datasets[2].data];
            const shiftIndex = currentHour.shiftIndex;

            // ✅ Sync ทุกแท่งที่ผ่านมาแล้ว + ปัจจุบัน
            // Phase 10: เปลี่ยนจาก hourly.efficiency → hourly.availability (Backend Phase 7)
            const serverCt = hourly?.cycleTime;
            const serverAvail = hourly?.availability;
            if (serverCt) {
                for (let i = 0; i <= shiftIndex && i < serverCt.length; i++) {
                    newCtActual[i] = serverCt[i];
                }
            } else if (currentHour?.cycleTime !== undefined) {
                newCtActual[shiftIndex] = currentHour.cycleTime;
            }
            if (serverAvail) {
                for (let i = 0; i <= shiftIndex && i < serverAvail.length; i++) {
                    newEffActual[i] = serverAvail[i];
                }
            } else if (currentHour?.availability !== undefined || currentHour?.efficiency !== undefined) {
                newEffActual[shiftIndex] = currentHour.availability ?? currentHour.efficiency;
            }

            // 🛑 Bail out
            let hasChanges = false;
            for (let i = 0; i < newCtActual.length; i++) {
                if (newCtActual[i] !== prev.datasets[0].data[i] || newEffActual[i] !== prev.datasets[2].data[i]) {
                    hasChanges = true;
                    break;
                }
            }
            if (!hasChanges) return prev;

            const newDatasets = prev.datasets.map((ds: any, idx: number) => {
                if (idx === 0) return { ...ds, data: newCtActual };
                if (idx === 2) return { ...ds, data: newEffActual };
                return ds;
            });
            return { ...prev, datasets: newDatasets };
        });

    }, [realtimeData, date]);

    // Fetch Data
    // Fetch Data
    useEffect(() => {
        fetchAllData();
    }, [machineName, date]); // Removed refreshTrigger to prevent socket-induced polling

    // ✅ Removed useEffect from here, moved down below fetchMcStatus

    const fetchAllData = async () => {
        try {
            const timestamp = Date.now();

            // ✅ Check if viewing "Today" first (to determine which API to call, matching machine_working UTC logic)
            const todayStr = new Date().toISOString().split("T")[0];
            const isToday = date === todayStr;

            // ✅ 1. Fetch models list first
            const resModels = await axios.get(`${config.apiServer}/api/oee/getModelsByDate`, {
                params: { machine_name: machineName, date: date, t: timestamp }
            });
            const models = resModels.data.results.map((m: any) => m.model_name);

            // ✅ 2. Determine target model
            const targetModel = selectedModel || (models.length > 0 ? models[0] : '');
            const modelParam = targetModel ? `&model_name=${targetModel}` : '';

            // ✅ 3. Update state
            setModelsList(models);
            if (!selectedModel && models.length > 0) {
                setSelectedModel(models[0]);
            }

            // ✅ 4. Call ALL APIs in parallel (including cross-day operator)
            // 🆕 เพิ่ม latest-all เพื่อดึง liveStatus จาก MSSQL ทันที (ไม่รอ MQTT)
            const [resOEE, resTable, resGraph1, resGraph2, resOperator, resCrossDay, resLatestStatus] = await Promise.all([
                axios.get(`${config.apiServer}/api/oee/getLastOEE?machine_name=${machineName}&date=${date}${modelParam}&t=${timestamp}`),
                axios.get(`${config.apiServer}/api/oee/getDataTable?machine_name=${machineName}&date=${date}${modelParam}&t=${timestamp}`),
                axios.get(`${config.apiServer}/api/oee/getGraph1?machine_name=${machineName}&date=${date}${modelParam}&t=${timestamp}`),
                axios.get(`${config.apiServer}/api/oee/getGraph2?machine_name=${machineName}&date=${date}${modelParam}&t=${timestamp}`),
                axios.get(`${config.apiServer}/api/historyWorking/getHistoryByDate?machine_name=${machineName}&date=${date}&t=${timestamp}`),
                // ✅ Fetch cross-day operator in parallel (conditional API based on date)
                isToday
                    ? axios.get(`${config.apiServer}/api/historyWorking/getOperatorIdWorking/${machineName}?t=${timestamp}`).catch(() => ({ data: { results: null } }))
                    : axios.get(`${config.apiServer}/api/historyWorking/getActiveCrossDayOperator?machine_name=${machineName}&date=${date}&t=${timestamp}`).catch(() => ({ data: { results: null } })),
                // 🆕 ดึง latest MCStatus จาก MSSQL โดยตรง (สำหรับ liveStatus ตอนโหลดหน้า)
                axios.get(`${config.apiServer}/api/mcstatus/latest-all`).catch(() => ({ data: { results: {} } }))
            ]);

            // 🆕 Extract liveStatus จาก MSSQL (ใช้เฉพาะวันนี้)
            const latestAllStatus: Record<string, string> = resLatestStatus.data?.results || {};

            // ✅ Extract cross-day operator from parallel result
            const activeCrossDayOp = resCrossDay.data?.results || null;

            // --- 1. Process Operator ---
            const historyList = resOperator.data?.results || [];
            let currentOpCode = "-";
            let currentOpName = "-";
            let opPicUrl = "";

            // Find active operator (end_time is null)
            const activeOp = historyList.find((h: any) => h.end_time === null);

            // ✅ Priority: Cross-Day Active -> Today's Active
            // (No fallback to lastOp — show empty when no one is logged in)
            const displayOp = activeCrossDayOp || activeOp;

            if (displayOp) {
                currentOpCode = displayOp.emp_no || "-";
                // ✅ Handle both flat (active) and nested (history) structures
                currentOpName = displayOp.operator_name || (displayOp.tbm_operator ? displayOp.tbm_operator.operator_name : "-");

                const picPath = displayOp.picture_path || (displayOp.tbm_operator ? displayOp.tbm_operator.picture_path : "");
                // Construct URL directly
                opPicUrl = picPath ? `${config.apiServer}/image/${picPath}` : "";
            }

            // --- 2. Process OEE & Table Data ---
            const oeeData = resOEE.data; // Note: machine_working uses resOEE.data directly, not .results for oee_value
            const tableDataRaw = resTable.data; // machine_working uses resTable.data directly

            // Update Table State with correct property names (matching machine_working)
            setTableData({
                model: tableDataRaw.model || "-",
                achieve: tableDataRaw.Achieve || 0, // Note: Capital A
                oee: oeeData.oee_value || 0,
                oeeDate: oeeData.date ? dayjs(oeeData.date).format("DD/MM/YYYY") : "-",
                operatorName: currentOpName,
                operatorCode: currentOpCode,
                operatorPic: opPicUrl,
                historyId: displayOp ? displayOp.id : null, // ✅ Save history ID for logout target
                outputActual: tableDataRaw.outputActual || 0,
                outputTarget: tableDataRaw.outputTarget || 0,
                ctActual: tableDataRaw.cycleTimeActual || 0,
                ctTarget: tableDataRaw.cycleTimeTarget || 0,
                effActual: tableDataRaw.availabilityActual || 0,       // Phase 10: Backend เปลี่ยน field เป็น availabilityActual
                effTarget: tableDataRaw.availabilityTarget || 0,       // Phase 10: Backend เปลี่ยน field เป็น availabilityTarget
                availabilityActual: tableDataRaw.availabilityActual || 0,   // ✅ รับ Availability จาก getDataTable โดยตรง
                availabilityTarget: tableDataRaw.availabilityTarget || 0,   // ✅ รับ Target จาก getDataTable โดยตรง
                liveStatus: isToday ? (latestAllStatus[machineName] || "Offline") : "Offline", // 🆕 อ่านจาก MSSQL ทันที
                liveAlarm: null,
            });



            // Helper for filtering future data (Moved to scope for re-use)
            const filterFutureData = (dataArray: number[], hoursArray: any[]) => {
                const todayStr = new Date().toISOString().split("T")[0]; // ✅ Use Shift Date, not local Midnight
                if (date !== todayStr) return dataArray; // Show all data if not today

                const currentHour = new Date().getHours();
                // Find index of current hour (e.g., "08:00" -> index 1)
                // Assume hoursArray are strings "08", "09" etc.
                const currentIndex = hoursArray.findIndex((h: string) => parseInt(h) === currentHour);

                if (currentIndex === -1) return dataArray; // Safety check or outside hours

                return dataArray.map((val, index) => {
                    return index > currentIndex ? null : val;
                });
            };

            // --- 3. Process Graph 1 (Output Monitor) ---
            const g1 = resGraph1.data;
            if (g1) {
                setGraph1Data({
                    labels: g1.hours,
                    datasets: [
                        {
                            type: "bar",
                            label: "Output Actual",
                            data: filterFutureData(g1.outputActual, g1.hours),
                            backgroundColor: "#00b050",
                            yAxisID: "y_qty",
                            order: 4,
                            datalabels: {
                                display: true,
                                align: 'end',
                                anchor: 'end',
                                rotation: -90,
                                color: '#222',
                                offset: 1,
                                font: (context: any) => {
                                    const cw = context.chart?.width || 300;
                                    return {
                                        weight: 'bold',
                                        // ลดขนาดลงอีกตามความกว้างของจอ (5px - 8px)
                                        size: Math.max(5, Math.min(8, Math.round(cw / 45)))
                                    };
                                },
                                formatter: (value: any) => value > 0 ? value : null
                            }
                        },
                        {
                            type: "line",
                            label: "Output Target",
                            data: g1.outputTarget,
                            borderColor: "#385723",
                            borderWidth: 3,
                            borderDash: [5, 5],
                            pointRadius: 0,
                            yAxisID: "y_qty",
                            order: 3,
                            datalabels: {
                                display: true,
                                align: 'left',
                                anchor: 'center',
                                backgroundColor: '#385723',
                                color: 'white',
                                borderRadius: 4,
                                font: { weight: 'bold', size: 10 },
                                padding: 4,
                                formatter: (value: any, context: any) => context.dataIndex === 0 ? `Target: ${value}` : null
                            }
                        },
                        {
                            type: "line",
                            label: "Output Accum",
                            data: filterFutureData(g1.outputActualAccum, g1.hours),
                            borderColor: "#c00000",
                            backgroundColor: "#c00000",
                            borderWidth: 2,
                            pointRadius: 3,
                            yAxisID: "y_accum",
                            order: 1
                        },
                        {
                            type: "line",
                            label: "Output Target Accum",
                            data: g1.outputTargetAccum,
                            borderColor: "#f062b0ff",
                            borderWidth: 3,
                            borderDash: [5, 5],
                            pointRadius: 0,
                            yAxisID: "y_accum",
                            order: 2
                        }
                    ]
                });
            }

            // --- 4. Process Graph 2 (CT & Eff Monitor) ---
            const g2 = resGraph2.data;
            if (g2) {
                setGraph2Data({
                    labels: g2.hours,
                    datasets: [
                        {
                            type: "bar",
                            label: "Cycle Time Actual",
                            data: filterFutureData(g2.cycleTimeActual, g2.hours),
                            backgroundColor: "#5b9bd5",
                            yAxisID: "y_ct",
                            order: 4
                        },
                        {
                            type: "line",
                            label: "Cycle Time Target",
                            data: g2.cycleTimeTarget,
                            borderColor: "#203864",
                            borderWidth: 3,
                            borderDash: [5, 5],
                            pointRadius: 0,
                            yAxisID: "y_ct",
                            order: 1,
                            datalabels: {
                                display: true,
                                align: 'left',
                                anchor: 'center',
                                backgroundColor: '#385723',
                                color: 'white',
                                borderRadius: 4,
                                font: { weight: 'bold', size: 10 },
                                padding: 4,
                                formatter: (value: any, context: any) => context.dataIndex === 0 ? `Target: ${value}` : null
                            }
                        },
                        {
                            type: "line",
                            label: "Availability Actual",
                            // Phase 10: เปลี่ยนจาก g2.efficiencyActual → g2.availabilityActual (Backend Phase 8)
                            data: filterFutureData(g2.availabilityActual, g2.hours),
                            borderColor: "#02630fff",
                            backgroundColor: "#02630fff",
                            borderWidth: 2,
                            pointRadius: 3,
                            yAxisID: "y_eff",
                            order: 3
                        },
                        {
                            type: "line",
                            label: "Availability Target",
                            // Phase 10: เปลี่ยนจาก g2.efficiencyTarget → g2.availabilityTarget (Backend Phase 8)
                            data: g2.availabilityTarget,
                            borderColor: "#ff6600ff",
                            borderWidth: 3,
                            borderDash: [5, 5],
                            pointRadius: 0,
                            yAxisID: "y_eff",
                            order: 2,
                            datalabels: {
                                display: true,
                                align: 'right',
                                anchor: 'center',
                                backgroundColor: '#385723',
                                color: 'white',
                                borderRadius: 4,
                                font: { weight: 'bold', size: 10 },
                                padding: 4,
                                formatter: (value: any, context: any) => {
                                    const dataArray = context.chart.data.datasets[context.datasetIndex].data;
                                    if (context.dataIndex === dataArray.length - 1) {
                                        return `Target: ${value}`;
                                    }
                                    return null;
                                }
                            }
                        }
                    ]
                });
            }

        } catch (error: any) {
            console.error("Fetch Error:", error);
        }
    };

    // ================= MC Status Logic =================

    const fetchMcStatus = useCallback(async () => {
        if (!machineName || !date) return;
        try {
            const res = await axios.get(`${config.apiServer}/api/mcstatus/timeline`, {
                params: { machine_name: machineName, date }
            });
            setMcStatusData(res.data.results || []);
        } catch (e) {
            console.error("MC Status fetch error:", e);
        }
    }, [machineName, date]);

    // ✅ Real-Time Operator Update via Socket.IO
    // Listens for "machine_updated" events emitted by backend on login/logout.
    // Triggers fetchAllData() to silently refresh operator details on this card.
    useEffect(() => {
        const socket = getSocket();

        const handleMachineUpdate = (data: any) => {
            if (data.machine_name === machineName) {
                const todayStr = new Date().toISOString().split("T")[0];
                if (date === todayStr) {
                    fetchAllData();
                }
            }
        };

        // ✅ Event-driven MC Status refresh (mc_status_updated)
        // Backend broadcasts เมื่อ MQTT status_tb หรือ alarm_tb มาถึง
        const handleMcStatusUpdated = (data: any) => {
            if (data.machine_name === machineName && activeView === "status") {
                const todayStr = new Date().toISOString().split("T")[0];
                if (date === todayStr) {
                    fetchMcStatus();
                }
            }
        };

        socket.on("machine_updated", handleMachineUpdate);
        socket.on("mc_status_updated", handleMcStatusUpdated);
        return () => {
            socket.off("machine_updated", handleMachineUpdate);
            socket.off("mc_status_updated", handleMcStatusUpdated);
        };
    }, [machineName, date, activeView, fetchMcStatus, fetchAllData]);

    // Fetch on view switch & when parent triggers refresh
    useEffect(() => {
        if (activeView !== "status") return;
        fetchMcStatus();
    }, [activeView, fetchMcStatus, mcStatusRefreshTrigger]);

    // Draw canvas when data changes
    useEffect(() => {
        if (activeView !== "status") return;
        const canvas = mcStatusCanvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        ctx.scale(dpr, dpr);
        const W = rect.width;
        const H = rect.height;
        ctx.clearRect(0, 0, W, H);

        const labelAreaW = 40;
        const chartX = labelAreaW;
        const chartW = W - labelAreaW - 6;
        const shiftRowY = 4;
        const shiftRowH = 16;
        const barY = shiftRowY + shiftRowH + 2;
        const barH = 28;
        const totalMinutes = 1440;
        const mShiftEnd = 720;

        // Helper: datetime → minutes on timeline (UTC ตรงๆ)
        // Prisma แปลง TH local → UTC ให้แล้ว: TH 07:00 = UTC 00:00Z = นาทีที่ 0
        const toMinSince0700 = (dtStr: string): number => {
            const d = new Date(dtStr);
            return d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60;
        };

        const minToTimeStr = (min: number): string => {
            let h = Math.floor(min / 60) + 7;
            if (h >= 24) h -= 24;
            const m = Math.floor(min % 60);
            return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
        };

        // Shift Row
        ctx.fillStyle = "#f8f9fa";
        ctx.fillRect(chartX, shiftRowY, chartW, shiftRowH);
        ctx.strokeStyle = "#dee2e6";
        ctx.strokeRect(chartX, shiftRowY, chartW, shiftRowH);

        const mEndX = chartX + (mShiftEnd / totalMinutes) * chartW;
        ctx.fillStyle = "#333";
        ctx.font = "bold 9px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("M Shift", chartX + (mEndX - chartX) / 2, shiftRowY + shiftRowH / 2);
        ctx.fillText("N Shift", mEndX + (chartX + chartW - mEndX) / 2, shiftRowY + shiftRowH / 2);

        // Divider
        ctx.strokeStyle = "#333";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(mEndX, shiftRowY);
        ctx.lineTo(mEndX, barY + barH);
        ctx.stroke();
        ctx.lineWidth = 1;

        // Left labels
        ctx.fillStyle = "#555";
        ctx.font = "bold 8px sans-serif";
        ctx.textAlign = "right";
        ctx.fillText("Shift", labelAreaW - 4, shiftRowY + shiftRowH / 2);
        ctx.fillText("Status", labelAreaW - 4, barY + barH / 2);

        // Build segments
        const segments: { startMin: number; endMin: number; status: string; startTime: string; endTime: string }[] = [];
        if (mcStatusData.length > 0) {
            for (let i = 0; i < mcStatusData.length; i++) {
                const startMin = toMinSince0700(mcStatusData[i].datetime);
                let endMin: number;
                let endTimeLabel: string;
                if (i + 1 < mcStatusData.length) {
                    endMin = toMinSince0700(mcStatusData[i + 1].datetime);
                    endTimeLabel = minToTimeStr(endMin);
                } else {
                    const todayStr = dayjs().format("YYYY-MM-DD");
                    if (date === todayStr) {
                        const now = new Date();
                        // ✅ Bug 3 Fix: cap endMin to totalMinutes to prevent overflow
                        endMin = Math.min(now.getUTCHours() * 60 + now.getUTCMinutes() + now.getUTCSeconds() / 60, totalMinutes);
                    } else {
                        endMin = totalMinutes;
                    }
                    endTimeLabel = minToTimeStr(endMin);
                }
                // ✅ Bug 2 Fix: Removed wrap-around (endMin += totalMinutes) — it incorrectly stretched the last segment full-width
                segments.push({
                    startMin, endMin: Math.min(endMin, totalMinutes),
                    status: mcStatusData[i].mc_status,
                    startTime: minToTimeStr(startMin), endTime: endTimeLabel,
                });
            }
        }
        mcSegmentsRef.current = segments;

        // ✅ Bug 1 Fix: Draw segments directly without pre-filling the bar gray.
        // Pre-filling with #e9ecef made empty time slots look like Machine Stop blocks.
        for (const seg of segments) {
            const x1 = chartX + (seg.startMin / totalMinutes) * chartW;
            const x2 = chartX + (seg.endMin / totalMinutes) * chartW;
            ctx.fillStyle = statusColors[seg.status]?.color || "#ccc";
            ctx.fillRect(x1, barY, x2 - x1, barH);
        }
        // Border only — no background fill
        ctx.strokeStyle = "#dee2e6";
        ctx.strokeRect(chartX, barY, chartW, barH);

        // --- Draw hour tick marks (matching machine_working) ---
        ctx.strokeStyle = "#aaa";
        ctx.fillStyle = "#666";
        ctx.font = "8px sans-serif";
        ctx.textAlign = "center";
        const hourLabels = ["07", "08", "09", "10", "11", "12", "13", "14", "15", "16", "17", "18", "19", "20", "21", "22", "23", "00", "01", "02", "03", "04", "05", "06"];
        for (let i = 0; i <= 24; i++) {
            const x = chartX + (i * 60 / totalMinutes) * chartW;
            ctx.beginPath();
            ctx.moveTo(x, barY + barH);
            ctx.lineTo(x, barY + barH + 4);
            ctx.stroke();
            if (i < 24) {
                ctx.fillText(hourLabels[i], x + (60 / totalMinutes * chartW) / 2, barY + barH + 12);
            }
        }

    }, [activeView, mcStatusData, date]);

    // ================= Downtime Breakdown Chart =================
    useEffect(() => {
        const segments = mcSegmentsRef.current;
        if (!segments || segments.length === 0) { setDowntimeChartData(null); return; }

        const durationMap: Record<string, number> = {};
        let totalElapsed = 0;
        for (const seg of segments) {
            const dur = Math.max(seg.endMin - seg.startMin, 0);
            durationMap[seg.status] = (durationMap[seg.status] || 0) + dur;
            totalElapsed += dur;
        }
        if (totalElapsed === 0 || downtimeKeys.length === 0) { setDowntimeChartData(null); return; }

        const labels: string[] = [];
        const values: number[] = [];
        const colors: string[] = [];
        for (const key of downtimeKeys) {
            labels.push(statusColors[key]?.label || key);
            values.push(parseFloat((((durationMap[key] || 0) / totalElapsed) * 100).toFixed(1)));
            colors.push(statusColors[key]?.color || "#ccc");
        }

        // เก็บ durationMap ใน state (Chart.js จะ strip custom props ออกจาก data)
        const durMap: Record<string, number> = {};
        for (const key of downtimeKeys) {
            durMap[statusColors[key]?.label || key] = durationMap[key] || 0;
        }
        setDowntimeDurationMap(durMap);

        setDowntimeChartData({
            labels,
            datasets: [{
                label: "Downtime %",
                data: values,
                backgroundColor: colors,
                borderRadius: 3,
            }],
        });
    }, [mcStatusData]);

    // Canvas mouse handlers for tooltip
    const handleCanvasMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
        const canvas = mcStatusCanvasRef.current;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const labelAreaW = 40;
        const chartX = labelAreaW;
        const chartW = rect.width - labelAreaW - 6;
        const totalMinutes = 1440;
        const barY = 22;
        const barH = 28;

        if (x < chartX || x > chartX + chartW || e.clientY - rect.top < barY || e.clientY - rect.top > barY + barH) {
            setMcTooltip(null);
            return;
        }

        const minAtMouse = ((x - chartX) / chartW) * totalMinutes;
        const seg = mcSegmentsRef.current.find(s => minAtMouse >= s.startMin && minAtMouse < s.endMin);
        if (seg) {
            const durMin = seg.endMin - seg.startMin;
            const hrs = Math.floor(durMin / 60);
            const mins = Math.floor(durMin % 60);
            setMcTooltip({
                visible: true, x: e.clientX - rect.left, y: barY - 6,
                status: seg.status, startTime: seg.startTime, endTime: seg.endTime,
                duration: hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`,
            });
        } else {
            setMcTooltip(null);
        }
    };

    const handleCanvasMouseLeave = () => setMcTooltip(null);

    // ================= Chart Options =================

    const legendFontSize = Math.max(7, Math.round(10 * scaleFactor));
    const legendBoxWidth = Math.max(8, Math.round(15 * scaleFactor));
    const legendPadding = Math.max(4, Math.round(10 * scaleFactor));

    const optionsGraph1: ChartOptions<"bar" | "line"> = {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
            legend: {
                position: 'top',
                labels: {
                    usePointStyle: false,
                    boxWidth: legendBoxWidth,
                    padding: legendPadding,
                    font: { size: legendFontSize }
                }
            },
            title: { display: false },
            datalabels: { display: false }
        },
        scales: {
            x: { grid: { display: false } },
            y_qty: {
                type: 'linear',
                display: true,
                position: 'left',
                title: { display: true, text: 'Output [pcs]', color: '#00b050' },
                beginAtZero: true,
            },
            y_accum: {
                type: 'linear',
                display: true,
                position: 'right',
                title: { display: true, text: 'Accum [pcs]', color: '#c00000' },
                beginAtZero: true,
                grid: { drawOnChartArea: false }
            }
        }
    };

    const optionsGraph2: ChartOptions<"bar" | "line"> = {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
            legend: {
                position: 'top',
                labels: {
                    usePointStyle: false,
                    boxWidth: legendBoxWidth,
                    padding: legendPadding,
                    font: { size: legendFontSize }
                }
            },
            title: { display: false },
            datalabels: { display: false }
        },
        scales: {
            x: { grid: { display: false } },
            y_ct: {
                type: 'linear',
                display: true,
                position: 'left',
                title: { display: true, text: 'CT [sec]', color: '#5b9bd5' },
                beginAtZero: true,
            },
            y_eff: {
                type: 'linear',
                display: true,
                position: 'right',
                title: { display: true, text: 'Eff [%]', color: '#ed7d31' },
                min: 0,
                max: 120,
                grid: { drawOnChartArea: false }
            },
        }
    };

    // === Blinking current-hour bar: compute modified graph1Data at render time ===
    const renderGraph1Data = useMemo(() => {
        if (!graph1Data) return null;
        const todayStr = dayjs().format("YYYY-MM-DD");
        if (date !== todayStr) return graph1Data; // No blinking if not today

        const labels = graph1Data.labels || [];
        const currentHour = new Date().getHours();
        const currentIndex = labels.findIndex((h: string) => parseInt(h) === currentHour);
        if (currentIndex === -1) return graph1Data;

        const newDatasets = graph1Data.datasets.map((ds: any, dsIdx: number) => {
            if (dsIdx !== 0) return ds; // Only modify the Output Actual bar (index 0)
            return {
                ...ds,
                backgroundColor: labels.map((_: any, i: number) =>
                    i === currentIndex ? (blinkOn ? "#00b050" : "#80ff80") : "#00b050"
                ),
            };
        });
        return { ...graph1Data, datasets: newDatasets };
    }, [graph1Data, blinkOn, date]);

    // === Blinking current-hour bar for Graph 2 (CT bar) ===
    const renderGraph2Data = useMemo(() => {
        if (!graph2Data) return null;
        const todayStr = dayjs().format("YYYY-MM-DD");
        if (date !== todayStr) return graph2Data; // No blinking if not today

        const labels = graph2Data.labels || [];
        const currentHour = new Date().getHours();
        const currentIndex = labels.findIndex((h: string) => parseInt(h) === currentHour);
        if (currentIndex === -1) return graph2Data;

        const newDatasets = graph2Data.datasets.map((ds: any, dsIdx: number) => {
            if (dsIdx !== 0) return ds; // Only modify the CT Actual bar (index 0)
            return {
                ...ds,
                backgroundColor: labels.map((_: any, i: number) =>
                    i === currentIndex ? (blinkOn ? "#5b9bd5" : "#b0d4f1") : "#5b9bd5"
                ),
            };
        });
        return { ...graph2Data, datasets: newDatasets };
    }, [graph2Data, blinkOn, date]);

    // ================= RENDER =================

    // Dynamic header styling based on liveStatus
    const isToday = typeof window !== "undefined" && date === new Date().toISOString().split("T")[0];
    let headerBgClass = "bg-primary";
    let headerStyle: React.CSSProperties = { flexShrink: 0, height: "32px", border: "none", position: "relative" };

    // ไม่มีการเปลี่ยนสีพื้นหลังเป็น statusColor หรือ Alarm แดงแล้ว เพื่อให้เป็นสีฟ้า (bg-primary) เสมอ

    return (
        <div className="card shadow-sm h-100 d-flex flex-column position-relative" style={{ minHeight: 0, overflow: "hidden" }}>
            <div className={`card-header d-flex justify-content-center align-items-center text-white p-2 ${headerBgClass}`} style={headerStyle}>
                <span className="fw-bold text-center" style={{ fontSize: fontSize.header, letterSpacing: "0.5px", lineHeight: "1", padding: 0, margin: 0 }}>
                    {machineName}
                </span>
                <div className="position-absolute end-0 me-2 d-flex flex-column align-items-end" style={{ fontSize: fontSize.tiny, lineHeight: "1" }}>
                    <span 
                        className="badge rounded-pill shadow-sm" 
                        style={{ 
                            backgroundColor: isToday && statusColors[tableData.liveStatus]?.color ? statusColors[tableData.liveStatus].color : '#6c757d',
                            color: '#fff',
                            fontSize: fontSize.tiny, // ขนาด badge 
                            padding: '3px 8px'
                        }}
                    >
                        {isToday ? (statusColors[tableData.liveStatus]?.label || tableData.liveStatus) : "Historical"}
                    </span>
                </div>
            </div>
            <div className="card-body p-1 d-flex flex-column" style={{ overflow: "hidden", minHeight: 0, flex: 1 }}>
                {/* --- TABLE HEADER — แสดงเสมอทั้ง Output และ MC Status --- */}
                <div className="table-responsive mb-1" style={{ flexShrink: 0 }}>
                    <table className="table table-bordered align-middle text-center m-0" style={{ fontSize: fontSize.small }}>
                        <thead className="table-primary">
                            <tr>
                                <th className="p-1 align-middle" style={{ width: "12%" }}>Date</th>
                                <th className="p-1 align-middle" style={{ width: "15%" }}>MC Name</th>
                                <th className="p-1 align-middle" style={{ width: "15%" }}>Model</th>
                                <th className="p-1 align-middle" style={{ width: "15%" }}>Achieve</th>
                                <th className="p-1 align-middle" style={{ width: "18%" }}>OEE</th>
                                <th className="p-1 align-middle" style={{ width: "25%" }}>Operator</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr>
                                <td rowSpan={2} className="p-1 fw-bold bg-white align-middle">
                                    <div style={{ fontSize: fontSize.small }}>{dayjs(date).format("DD/MM/YYYY")}</div>
                                    <div className="text-primary" style={{ fontSize: fontSize.tiny }}>{clientTime}</div>
                                </td>
                                <td className="p-1 fw-bold text-primary align-middle">{machineName}</td>
                                <td className="p-1 align-middle">
                                    {modelsList.length > 0 ? (
                                        <div style={{ wordBreak: "break-word", lineHeight: "1.2", fontSize: "0.65rem" }}>
                                            {modelsList.join(" | ")}
                                        </div>
                                    ) : (
                                        <span>{tableData.model}</span>
                                    )}
                                </td>
                                <td className="p-1 align-middle">
                                    <span className={`fw-bold ${tableData.achieve >= 100 ? "text-success" : "text-danger"}`}>
                                        {tableData.achieve.toFixed(2)}%
                                    </span>
                                </td>
                                <td rowSpan={4} className="p-1 align-middle bg-white">
                                    <div className="d-flex flex-column justify-content-center align-items-center h-100 w-100">
                                        <div className={`fw-bold ${tableData.oee >= 85 ? "text-success" : "text-danger"}`} style={{ fontSize: fontSize.large, lineHeight: 1.2 }}>
                                            {tableData.oee.toFixed(2)}%
                                        </div>
                                        <div className="text-muted" style={{ fontSize: fontSize.tiny }}>
                                            {tableData.oeeDate}
                                        </div>
                                    </div>
                                </td>
                                <td rowSpan={4} className="p-1 align-middle bg-white">
                                    <div className="d-flex flex-column align-items-center justify-content-center h-100 w-100">
                                        {tableData.operatorCode === "-" ? (
                                            // ✅ No operator logged in — show default picture and Login button
                                            <>
                                                <img
                                                    src="/dist/img/avg.png"
                                                    alt="No Op"
                                                    className="rounded border mb-1"
                                                    style={{ width: "35px", height: "35px", objectFit: "cover", opacity: 0.5 }}
                                                />
                                                <div className="fw-bold mt-1 text-muted" style={{ fontSize: fontSize.small, lineHeight: 1.2, opacity: 0.5 }}>(EMP ID)</div>
                                                <div className="text-muted text-truncate w-100" style={{ fontSize: fontSize.tiny, opacity: 0.5 }}>(Emp Name)</div>
                                                <button
                                                    className="btn btn-success btn-sm mt-1 fw-bold px-2 shadow-sm d-flex align-items-center justify-content-center"
                                                    style={{ fontSize: fontSize.tiny, padding: "2px", width: "fit-content", minWidth: "50px" }}
                                                    onClick={() => onLoginClick?.(machineName)}
                                                >
                                                    <i className="fas fa-sign-in-alt me-1"></i>Login
                                                </button>
                                            </>
                                        ) : (
                                            // ✅ Operator logged in — show picture and info
                                            <>
                                                <img
                                                    src={tableData.operatorPic || "/dist/img/avg.png"}
                                                    alt="Op"
                                                    className="rounded border mb-1"
                                                    style={{ width: "35px", height: "35px", objectFit: "cover" }}
                                                    onError={(e) => { (e.target as HTMLImageElement).src = "/dist/img/avg.png" }}
                                                />
                                                <div className="fw-bold text-dark mt-1" style={{ fontSize: fontSize.small, lineHeight: 1.2 }}>{tableData.operatorCode}</div>
                                                <div className="text-muted text-truncate w-100" style={{ fontSize: fontSize.tiny }}>{tableData.operatorName}</div>
                                                
                                                {/* ✅ Optional Logout Button if function is passed */}
                                                {onLogoutClick && tableData.historyId && canShowLogout && (
                                                    <button
                                                        onClick={(e) => { e.stopPropagation(); onLogoutClick(machineName, tableData.historyId!, tableData.operatorCode); }}
                                                        className="btn btn-danger btn-sm mt-1 px-2 fw-bold shadow-sm d-flex align-items-center justify-content-center"
                                                        style={{ fontSize: fontSize.tiny, padding: "2px", width: "fit-content", minWidth: "50px" }}
                                                    >
                                                        <i className="fa-solid fa-right-from-bracket me-1"></i>Logout
                                                    </button>
                                                )}
                                            </>
                                        )}
                                    </div>
                                </td>
                            </tr>
                            <tr className="bg-light text-secondary fw-bold">
                                <td className="p-1 align-middle">Output</td>
                                <td className="p-1 align-middle">Cycle Time</td>
                                <td className="p-1 align-middle">Availability</td>
                            </tr>
                            <tr>
                                <td className="p-1 fw-bold bg-light text-secondary align-middle">Actual</td>
                                <td className="p-1 fw-bold text-dark align-middle">
                                    {tableData.outputActual.toLocaleString()}
                                </td>
                                <td className={`p-1 fw-bold align-middle ${tableData.ctActual > tableData.ctTarget ? "text-danger" : "text-success"}`}>
                                    {tableData.ctActual.toFixed(2)}
                                </td>
                                <td className={`p-1 fw-bold align-middle ${tableData.availabilityActual < tableData.availabilityTarget ? "text-danger" : "text-success"}`}>
                                    {tableData.availabilityActual.toFixed(2)}%
                                </td>
                            </tr>
                            <tr>
                                <td className="p-1 fw-bold bg-light text-secondary align-middle">Target</td>
                                <td className="p-1 text-dark align-middle">
                                    {tableData.outputTarget.toLocaleString()}
                                </td>
                                <td className="p-1 text-muted align-middle">
                                    {tableData.ctTarget.toFixed(2)}
                                </td>
                                <td className="p-1 text-muted align-middle">
                                    {tableData.availabilityTarget.toFixed(2)}%
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>

                {/* --- CONTENT AREA — toggle เฉพาะส่วนนี้ --- */}
                {activeView === "output" ? (
                    /* --- GRAPH SECTION --- */
                    <div className={isSingleView ? "row g-3 flex-grow-1" : "d-flex flex-row flex-grow-1"} style={isSingleView ? { margin: 0 } : { minHeight: 0, gap: "4px" }}>
                        <div className={isSingleView ? "col-md-6 d-flex" : "flex-fill position-relative w-50 d-flex flex-column h-100"} style={isSingleView ? { minHeight: 0 } : { minHeight: 0 }}>
                            {isSingleView ? (
                                <div className="card w-100 shadow-sm border border-dark position-relative d-flex flex-column">
                                    <div className="card-header bg-white fw-bold text-center py-1 fs-5" style={{ flexShrink: 0 }}>Output Monitor</div>
                                    <div className="card-body p-2 position-relative flex-grow-1" style={{ minHeight: 0 }}>
                                        {renderGraph1Data ? <Chart type="bar" data={renderGraph1Data} options={optionsGraph1} /> : <div className="d-flex align-items-center justify-content-center h-100 text-muted small">Loading...</div>}
                                    </div>
                                </div>
                            ) : (
                                renderGraph1Data ? <Chart type="bar" data={renderGraph1Data} options={optionsGraph1} /> : <div className="d-flex align-items-center justify-content-center h-100 text-muted small">Loading...</div>
                            )}
                        </div>
                        <div className={isSingleView ? "col-md-6 d-flex" : "flex-fill position-relative w-50 d-flex flex-column h-100"} style={isSingleView ? { minHeight: 0 } : { minHeight: 0 }}>
                            {isSingleView ? (
                                <div className="card w-100 shadow-sm border border-dark position-relative d-flex flex-column">
                                    <div className="card-header bg-white fw-bold text-center py-1 fs-5" style={{ flexShrink: 0 }}>CT & Avail Monitor</div>
                                    <div className="card-body p-2 position-relative flex-grow-1" style={{ minHeight: 0 }}>
                                        {renderGraph2Data ? <Chart type="bar" data={renderGraph2Data} options={optionsGraph2} /> : <div className="d-flex align-items-center justify-content-center h-100 text-muted small">Loading...</div>}
                                    </div>
                                </div>
                            ) : (
                                renderGraph2Data ? <Chart type="bar" data={renderGraph2Data} options={optionsGraph2} /> : <div className="d-flex align-items-center justify-content-center h-100 text-muted small">Loading...</div>
                            )}
                        </div>
                    </div>
                ) : (
                    /* --- MC STATUS VIEW: Canvas Timeline --- */
                    <div className={isSingleView ? "card shadow-sm border border-dark flex-grow-1 d-flex flex-column position-relative" : "d-flex flex-column flex-grow-1 p-1"} style={isSingleView ? { minHeight: 0 } : {}}>
                        {isSingleView ? (
                            <div className="card-header bg-white fw-bold text-center py-1 fs-5" style={{ flexShrink: 0 }}>
                                Machine Status Timeline
                            </div>
                        ) : (
                            <div className="text-center mb-1">
                                <span className="fw-bold" style={{ fontSize: "0.7rem" }}>Machine Status Timeline</span>
                            </div>
                        )}
                        <div className={isSingleView ? "card-body p-2 position-relative flex-grow-1 d-flex flex-column" : "d-flex flex-column flex-grow-1"}>
                            {mcStatusData.length === 0 ? (
                                <div className="d-flex align-items-center justify-content-center flex-grow-1 text-muted">
                                    <div className="text-center">
                                        <i className="fas fa-info-circle fs-4 mb-1"></i>
                                        <div style={{ fontSize: "0.8rem" }}>No Status Data</div>
                                    </div>
                                </div>
                            ) : (
                                <>
                                    <div className="position-relative" style={{ flexShrink: 0 }}>
                                        <canvas
                                            ref={mcStatusCanvasRef}
                                            style={{ width: "100%", height: isSingleView ? "100px" : "70px", display: "block", cursor: "crosshair" }}
                                            onMouseMove={handleCanvasMouseMove}
                                            onMouseLeave={handleCanvasMouseLeave}
                                        />
                                        {mcTooltip && mcTooltip.visible && (
                                            <div
                                                className="position-absolute bg-dark text-white rounded shadow px-2 py-1"
                                                style={{
                                                    left: mcTooltip.x,
                                                    top: mcTooltip.y,
                                                    transform: "translateX(-50%) translateY(-100%)",
                                                    pointerEvents: "none",
                                                    zIndex: 100,
                                                    fontSize: "0.7rem",
                                                    whiteSpace: "nowrap",
                                                }}
                                            >
                                                <span className="badge px-3 py-2 text-white shadow-sm mb-1 d-block w-100"
                                                    style={{
                                                        backgroundColor: statusColors[mcTooltip.status]?.color || "#ccc",
                                                        fontSize: "1.1rem"
                                                    }}>
                                                <strong>{statusColors[mcTooltip.status]?.label || mcTooltip.status}</strong>
                                                </span>
                                                <div>{mcTooltip.startTime} → {mcTooltip.endTime} ({mcTooltip.duration})</div>
                                            </div>
                                        )}
                                    </div>

                                {downtimeChartData && (
                                    <div className={isSingleView ? "mt-2" : "mt-0"} style={{ flex: isSingleView ? "1 1 0" : 1, minHeight: isSingleView ? "220px" : "60px", maxHeight: isSingleView ? "none" : "150px", overflow: "visible" }}>
                                        <div className={isSingleView ? "text-center fw-bold text-dark mb-2" : "text-center fw-bold"} style={isSingleView ? { fontSize: "0.9rem" } : { fontSize: Math.max(7, Math.round(9 * scaleFactor)) + "px", color: "#333", marginBottom: 1 }}>{isSingleView ? "Downtime Breakdown (%)" : "Downtime (%)"}</div>
                                        <Chart type="bar" data={downtimeChartData} 
                                            plugins={isSingleView ? [{
                                                id: "coloredXLabels",
                                                afterDraw: (chart: any) => {
                                                    const { ctx, chartArea } = chart;
                                                    const xAxis = chart.scales.x;
                                                    const bgColors = chart.data.datasets[0]?.backgroundColor || [];
                                                    const labels = chart.data.labels || [];
                                                    const yBase = chartArea.bottom + 4;
                                                    const boxSize = 10;
        
                                                    const slotWidth = labels.length > 0 ? chartArea.width / labels.length : 9999;
                                                    let angleDeg = 0;
                                                    if (slotWidth < 45) angleDeg = 90;
                                                    else if (slotWidth < 80) angleDeg = 45;
                                                    const angleRad = (angleDeg * Math.PI) / 180;
        
                                                    ctx.save();
                                                    ctx.font = "9px sans-serif";
                                                    ctx.textBaseline = "middle";
        
                                                    labels.forEach((label: string, i: number) => {
                                                        const x = xAxis.getPixelForTick(i);
                                                        ctx.save();
        
                                                        if (angleDeg === 0) {
                                                            ctx.translate(x, yBase + boxSize / 2);
                                                            const textWidth = ctx.measureText(label).width;
                                                            const totalWidth = boxSize + 3 + textWidth;
                                                            const startX = -(totalWidth / 2);
        
                                                            ctx.fillStyle = bgColors[i] || "#ccc";
                                                            ctx.fillRect(startX, -boxSize / 2, boxSize, boxSize);
                                                            ctx.strokeStyle = "#bbb";
                                                            ctx.lineWidth = 0.5;
                                                            ctx.strokeRect(startX, -boxSize / 2, boxSize, boxSize);
        
                                                            ctx.fillStyle = "#333";
                                                            ctx.textAlign = "left";
                                                            ctx.fillText(label, startX + boxSize + 3, 0);
                                                        } else {
                                                            ctx.translate(x, yBase);
                                                            ctx.rotate(angleRad);
        
                                                            ctx.fillStyle = bgColors[i] || "#ccc";
                                                            ctx.fillRect(-boxSize / 2, -boxSize / 2, boxSize, boxSize);
                                                            ctx.strokeStyle = "#bbb";
                                                            ctx.lineWidth = 0.5;
                                                            ctx.strokeRect(-boxSize / 2, -boxSize / 2, boxSize, boxSize);
        
                                                            ctx.fillStyle = "#333";
                                                            ctx.textAlign = "left";
                                                            ctx.fillText(label, boxSize / 2 + 3, 0);
                                                        }
                                                        ctx.restore();
                                                    });
                                                    ctx.restore();
                                                }
                                            }] : []}
                                            options={{
                                            responsive: true,
                                            maintainAspectRatio: false,
                                            animation: false,
                                            plugins: {
                                                legend: { display: false },
                                                title: { display: false },
                                                tooltip: {
                                                    callbacks: {
                                                        label: (ctx: any) => {
                                                            const pct = ctx.parsed.y || 0;
                                                            const statusLabel = ctx.label || "";
                                                            const mins = downtimeDurationMap[statusLabel] || 0;
                                                            const hh = Math.floor(mins / 60);
                                                            const mm = Math.floor(mins % 60);
                                                            const ss = Math.round((mins % 1) * 60);
                                                            return `${pct}% — ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
                                                        }
                                                    }
                                                },
                                                datalabels: {
                                                    display: true,
                                                    anchor: "end",
                                                    align: "top",
                                                    offset: isSingleView ? 2 : 1,
                                                    color: "#333",
                                                    font: { weight: "bold", size: isSingleView ? 11 : Math.max(7, Math.round(9 * scaleFactor)) },
                                                    formatter: (val: number) => val > 0 ? (isSingleView ? `${val.toFixed(1)}%` : `${val}%`) : null,
                                                },
                                            },
                                            layout: { padding: { top: isSingleView ? 24 : 20, bottom: isSingleView ? 80 : 35 } },
                                            scales: {
                                                x: {
                                                    grid: { display: false }, 
                                                    ticks: { 
                                                        display: true, 
                                                        font: { size: isSingleView ? 11 : Math.max(6, Math.round(8 * scaleFactor)) }, 
                                                        maxRotation: 45, minRotation: 45 
                                                    } 
                                                },
                                                y: { 
                                                    beginAtZero: true, 
                                                    ticks: { 
                                                        callback: (val: any) => `${val}%`, 
                                                        font: { size: isSingleView ? 10 : Math.max(6, Math.round(8 * scaleFactor)) } 
                                                    }, 
                                                    grid: { color: "#eee" } 
                                                },
                                            },
                                        } as any} />
                                    </div>
                                )}

                                {/* Compact Legend — at the bottom */}
                                {!isSingleView && (
                                    <div className="d-flex flex-wrap gap-1 mt-1 pt-1 border-top" style={{ fontSize: "0.55rem", flexShrink: 0 }}>
                                        {Object.entries(statusColors).map(([key, val]) => (
                                            <div key={key} className="d-flex align-items-center mb-1">
                                                <div style={{ width: "12px", height: "12px", backgroundColor: val.color, marginRight: "4px", flexShrink: 0, borderRadius: "2px" }}></div>
                                                <span style={{ fontSize: "0.6rem", whiteSpace: "nowrap" }}>{val.label}</span>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </>
                        )}
                    </div>
                </div>
                )}
            </div>
        </div>
    );
}
