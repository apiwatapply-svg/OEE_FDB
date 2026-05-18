"use client";

import { Suspense, useEffect, useState, useRef, useCallback } from "react";
import {
    Chart as ChartJS,
    CategoryScale,
    LinearScale,
    BarElement,
    LineElement,
    PointElement,
    Legend,
    Tooltip,
    ChartOptions,
    BarController,
    LineController
} from "chart.js";
import { Chart } from "react-chartjs-2";
import ChartDataLabels from "chartjs-plugin-datalabels";
import Swal from "sweetalert2";
import { useRouter, useSearchParams } from "next/navigation";
import axios from "axios";
import dayjs from "dayjs";
import config from "@/app/config";
import { getSocket } from "@/app/lib/socketManager";
import type { Socket } from "socket.io-client";

// ✅ Extend Chart.js types for custom blinkOverlay plugin
declare module "chart.js" {
    interface PluginOptionsByType<TType extends import("chart.js").ChartType> {
        blinkOverlay?: {
            enabled: boolean;
            barIndex: number;
        };
    }
}

// ✅ Blink Overlay Plugin — lightweight alternative to cloning datasets every 600ms
// Uses requestAnimationFrame to pulse a semi-transparent overlay on the current hour bar
const blinkOverlayPlugin = {
    id: "blinkOverlay",
    afterDatasetsDraw(chart: any) {
        const blinkMeta = chart.options?.plugins?.blinkOverlay;
        if (!blinkMeta?.enabled || blinkMeta?.barIndex == null) return;

        const barIndex = blinkMeta.barIndex;
        const meta = chart.getDatasetMeta(0); // First dataset = bar
        if (!meta || meta.type !== "bar" || !meta.data[barIndex]) return;

        const bar = meta.data[barIndex];
        const ctx = chart.ctx;
        if (!ctx) return;

        // Smooth pulse using sine wave (0.0 ~ 0.45 opacity range)
        const t = (Date.now() % 1200) / 1200; // 1.2s cycle
        const alpha = 0.1 + Math.sin(t * Math.PI) * 0.35;

        ctx.save();
        ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
        ctx.fillRect(bar.x - bar.width / 2, bar.y, bar.width, bar.base - bar.y);
        ctx.restore();

        // ✅ Throttled redraw: 10fps instead of 60fps → smooth blink, low CPU
        if (!chart._blinkTimer) {
            chart._blinkTimer = setTimeout(() => {
                chart._blinkTimer = null;
                if (chart.ctx) chart.draw();
            }, 200); // 200ms = 5fps
        }
    }
};

// ✅ Register ChartJS components
ChartJS.register(CategoryScale, LinearScale, BarElement, LineElement, PointElement, Legend, Tooltip, ChartDataLabels, BarController, LineController, blinkOverlayPlugin)

export default function Page() {
    return (
        <Suspense fallback={<div className="p-4 text-center">Loading Machine Working...</div>}>
            <MachineWorkingInner />
        </Suspense>
    );
}

import { getStatusColors, getDowntimeKeys } from "@/app/lib/machineStatusConfig";

function MachineWorkingInner() {
    const router = useRouter();
    const searchParams = useSearchParams();

    // ================= State Management =================

    // 1. Basic Info & Timer
    const [machineName, setMachineName] = useState("");
    const [clientTime, setClientTime] = useState<string>("");
    const [serverTimeRef, setServerTimeRef] = useState<Date>(new Date());
    const [currentDateStr, setCurrentDateStr] = useState(""); // YYYY-MM-DD
    // blink state removed — now handled by blinkOverlayPlugin (CSS-like animation)
    const [socketRef, setSocketRef] = useState<Socket | null>(null);
    const [isViewingToday, setIsViewingToday] = useState(true);
    // 2. Table Data State
    const [tableData, setTableData] = useState({
        model: "-",
        achieve: 0,
        oee: 0,
        oeeDate: "-",
        operatorName: "-",
        operatorCode: "-",
        operatorPic: "",
        outputActual: 0,
        outputTarget: 0,
        ctActual: 0,
        ctTarget: 0,
        availabilityActual: 0,   // ✅ ค่า Availability จริง (status_based: จาก memoryOeeService หรือ tb_oee fallback)
        availabilityTarget: 0,   // ✅ เป้าหมาย
        operators: [] as any[], // ✅ Store list of operators
        liveStatus: "Offline", // 🆕
        liveAlarm: null as string | null, // 🆕
    });

    // 3. History / Logout State
    const [historyId, setHistoryId] = useState<number | null>(null);
    const [canLogout, setCanLogout] = useState(false);

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

    // 4. Multi-Model Support
    const [modelsList, setModelsList] = useState<string[]>([]);
    const [selectedModel, setSelectedModel] = useState<string>("");

    // 4. Graph Data State
    const [graph1Data, setGraph1Data] = useState<any>(null); // Output Graph
    const [graph2Data, setGraph2Data] = useState<any>(null); // CT & Eff Graph

    // 5. Machine Status Tab
    const [activeTab, setActiveTab] = useState<"output" | "status">(() => {
        if (typeof window !== "undefined") {
            const params = new URLSearchParams(window.location.search);
            const view = params.get("view");
            if (view === "output" || view === "status") return view;

            const saved = localStorage.getItem("machineWorkingTab");
            if (saved === "output" || saved === "status") return saved;
        }
        return "output";
    });
    const [mcStatusData, setMcStatusData] = useState<any[]>([]);
    const mcStatusCanvasRef = useRef<HTMLCanvasElement>(null);
    const mcSegmentsRef = useRef<{ startMin: number; endMin: number; status: string; startTime: string; endTime: string }[]>([]);
    const [mcTooltip, setMcTooltip] = useState<{ visible: boolean; x: number; y: number; status: string; startTime: string; endTime: string; duration: string } | null>(null);
    const [countdown, setCountdown] = useState(300); // 5 min in seconds
    const [downtimeChartData, setDowntimeChartData] = useState<any>(null);
    const [downtimeDurationMap, setDowntimeDurationMap] = useState<Record<string, number>>({});

    // ================= Effects =================
    // ✅ Blink effect is now handled by blinkOverlayPlugin (registered globally)
    // No more setInterval/useEffect cloning datasets every 600ms


    useEffect(() => {
        const view = searchParams.get("view");
        if (view !== "output" && view !== "status") return;
        setActiveTab(view);
        localStorage.setItem("machineWorkingTab", view);
    }, [searchParams]);

    useEffect(() => {
        // 1. Initialize Machine Name & Date
        const localMachine = localStorage.getItem("machineNameLocal");
        const localDate = localStorage.getItem("machineDateLocal"); // ✅ ดึงค่าจาก LocalStorage

        const paramMachine = searchParams.get("machine_name");
        const targetMachine = paramMachine || localMachine || "";

        if (!targetMachine) {
            Swal.fire({
                icon: "error",
                title: "Machine Not Found",
                text: "Please select a machine again.",
            }).then(() => {
                router.push("/oee_production/machine_area");
            });
            return;
        }

        setMachineName(targetMachine);

        // ✅ Logic: แยก Login Mode กับ History Mode
        let targetDateStr = "";
        const urlDate = searchParams.get("date");
        const isLoggedIn = !!localStorage.getItem("operatorLocal");

        if (urlDate) {
            // 🔵 History Mode: มี URL param → ใช้วันจาก URL
            targetDateStr = urlDate;
        } else if (isLoggedIn) {
            // 🟢 Login Mode: ใช้ UTC ปัจจุบันเสมอ
            targetDateStr = new Date().toISOString().split("T")[0];
            localStorage.setItem("machineDateLocal", targetDateStr);
        } else {
            // 🔵 History Mode (ไม่มี URL): ใช้ localStorage หรือ UTC
            targetDateStr = localDate || new Date().toISOString().split("T")[0];
        }

        setCurrentDateStr(targetDateStr);

        // 2. Initial Fetch (ส่งวันที่ที่ถูกต้องไป)
        fetchAllData(targetMachine, targetDateStr);

        // 3. Socket.IO connection
        const socket = getSocket();
        setSocketRef(socket);

        // 🏠 Join room ของเครื่องจักรที่กำลังดู
        socket.emit("joinRoom", `machine:${targetMachine}`);

        // ✅ Server Time — ใช้เวลา server แทน client
        socket.on("server_time", (isoStr: string) => {
            // console.log("⏱️ Server Time:", isoStr);
            const serverTime = new Date(isoStr);
            setServerTimeRef(serverTime);
            // แสดงเวลาที่ไทย (Asia/Bangkok) — ไม่ต้องบวก +7 เอง
            setClientTime(serverTime.toLocaleTimeString("en-GB", { hour12: false, timeZone: "Asia/Bangkok" }));
        });

        return () => {
            socket.emit("leaveRoom", `machine:${targetMachine}`);
            socket.off("server_time");
        };
    }, [searchParams]);

    // ✅ Socket.IO: Fast production update ทุก 2 วินาที (Output, CT, Eff, Target, Achieve, กราฟ)
    useEffect(() => {
        if (!socketRef || !machineName || !currentDateStr) return;

        const todayStr = serverTimeRef.toISOString().split("T")[0];
        const viewingToday = currentDateStr === todayStr;
        setIsViewingToday(viewingToday);

        if (!viewingToday) return;

        const fastHandler = (data: any) => {
            const machines = data.machines || {};
            const machineData = machines[machineName];
            if (!machineData) return;

            const { currentHour, daily } = machineData;
            const shiftIndex = currentHour.shiftIndex;

            // ✅ อัปเดต Table Data
            setTableData((prev) => {
                const newOutputTarget = daily.accumTarget || prev.outputTarget;
                const newAchieve = daily.achieve || 0;

                // 🛑 Bail out: ป้องกัน React Re-render หากค่าทุกอย่างเหมือนเดิม
                if (
                    prev.outputActual === daily.totalOutput &&
                    prev.outputTarget === newOutputTarget &&
                    prev.achieve === newAchieve &&
                    prev.ctActual === daily.avgCycleTime &&
                    (daily.availability === undefined || prev.availabilityActual === daily.availability)
                ) {
                    return prev;
                }

                return {
                    ...prev,
                    outputActual: daily.totalOutput,
                    outputTarget: newOutputTarget,
                    achieve: newAchieve,
                    ctActual: daily.avgCycleTime,
                    effActual: daily.overallEfficiency,
                    ...(daily.availability !== undefined && { availabilityActual: daily.availability }),
                    liveStatus: currentHour.live_status || "Offline", // 🆕 Update from real-time
                    liveAlarm: currentHour.live_alarm || null, // 🆕 Update from real-time
                };
            });

            // ✅ อัปเดต Graph 1 (Output + Accum) — sync ทุกชม.จาก Backend
            setGraph1Data((prev: any) => {
                if (!prev) return prev;
                const newOutputActual = [...prev.datasets[0].data];
                const newOutputAccum = [...prev.datasets[2].data];

                // ✅ Sync ทุกแท่งที่ผ่านมาแล้ว + ปัจจุบัน จาก Backend hourly arrays
                const serverOutput = daily.hourly?.output;
                if (serverOutput) {
                    for (let i = 0; i <= shiftIndex && i < serverOutput.length; i++) {
                        newOutputActual[i] = serverOutput[i];
                    }
                } else {
                    newOutputActual[shiftIndex] = currentHour.output;
                }

                let runningAccum = 0;
                for (let i = 0; i < newOutputActual.length; i++) {
                    const v = newOutputActual[i];
                    if (v !== null && v !== undefined) {
                        runningAccum += v;
                    }
                    newOutputAccum[i] = i <= shiftIndex ? runningAccum : (prev.datasets[2].data[i]);
                }

                // 🛑 Bail out: ถ้ายอดแต่ละแท่งไม่เปลี่ยนเลย ไม่ต้องสร้าง Object ใหม่ให้ Chart.js วาดใหม่
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

            // ✅ อัปเดต Graph 2 (CT & Eff) — sync ทุกชม.จาก Backend
            setGraph2Data((prev: any) => {
                if (!prev) return prev;
                const newCtActual = [...prev.datasets[0].data];
                const newEffActual = [...prev.datasets[2].data];

                // ✅ Sync ทุกแท่งที่ผ่านมาแล้ว + ปัจจุบัน
                const serverCt = daily.hourly?.cycleTime;
                const serverEff = daily.hourly?.availability;
                if (serverCt && serverEff) {
                    for (let i = 0; i <= shiftIndex && i < serverCt.length; i++) {
                        newCtActual[i] = serverCt[i];
                        newEffActual[i] = serverEff[i];
                    }
                } else {
                    newCtActual[shiftIndex] = currentHour.cycleTime;
                    // หาก serverEff ไม่มี (อัปเดตแบบเก่า) -> ให้ยึดจาก currentHour.availability (ถ้ามี) หรือ efficiency
                    newEffActual[shiftIndex] = currentHour.availability ?? currentHour.efficiency;
                }

                // 🛑 Bail out: ถ้ายอดแต่ละแท่งไม่เปลี่ยนเลย ไม่ต้องสร้าง Object ใหม่ให้ Chart.js วาดใหม่
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

            // ✅ Date rollover check — server shiftDate is the authority (00:00 UTC = 07:00 TH)
            const serverDate = data.shiftDate;
            if (serverDate && currentDateStr && currentDateStr !== serverDate) {
                const urlDate = searchParams.get("date");
                // Guard: only auto-advance if NOT in history mode (?date= param locks the view)
                if (!urlDate) {
                    console.log("Date Rollover: " + currentDateStr + " -> " + serverDate);
                    setCurrentDateStr(serverDate);
                    localStorage.setItem("machineDateLocal", serverDate);
                    fetchAllData(machineName, serverDate);
                }
            }
        };

        // ✅ Listen for Remote Logout (e.g. from Overall Machine Working)
        const updateHandler = (msgData: any) => {
            if (msgData.machine_name === machineName && msgData.status === "inactive") {
                // Check if we are currently logged in
                const localOperator = localStorage.getItem("operatorLocal");
                if (localOperator) {
                    localStorage.removeItem("operatorLocal");
                    localStorage.removeItem("machineDateLocal");
                    // Do not remove machineNameLocal, they might want to stay on the screen or redirect
                    // Wait, the user requested "เหมือน logout ที่หน้าของเครื่องจักรเองทุกอย่าง"
                    localStorage.removeItem("machineNameLocal");

                    Swal.fire({
                        icon: "info",
                        title: "Session Ended",
                        text: "You have been logged out remotely.",
                        timer: 3000,
                        showConfirmButton: false
                    }).then(() => {
                        router.push("/oee_production/machine_area");
                    });
                } else {
                    fetchAllData(machineName, currentDateStr); // just refresh data since operator left
                }
            } else if (msgData.machine_name === machineName && msgData.status === "active") {
                fetchAllData(machineName, currentDateStr); // refresh since someone logged in remotely
            }
        };

        socketRef.on("realtime_output", fastHandler);
        socketRef.on("machine_updated", updateHandler);

        return () => { 
            socketRef.off("realtime_output", fastHandler); 
            socketRef.off("machine_updated", updateHandler);
        };
    }, [socketRef, machineName, currentDateStr, searchParams]);

    // ================= Machine Status Fetch (declared early — used by Socket.IO effects below) =================

    const fetchMcStatus = useCallback(async () => {
        if (!machineName || !currentDateStr) return;
        try {
            const res = await axios.get(`${config.apiServer}/api/mcstatus/timeline`, {
                params: { machine_name: machineName, date: currentDateStr }
            });
            setMcStatusData(res.data.results || []);
        } catch (e) {
            console.error("MC Status fetch error:", e);
        }
    }, [machineName, currentDateStr]);

    // ✅ Socket.IO: Slow status update ทุก 5 นาที (เฉพาะ OEE จาก MCStatus)
    useEffect(() => {
        if (!socketRef || !machineName || !currentDateStr) return;

        const todayStr = serverTimeRef.toISOString().split("T")[0];
        if (currentDateStr !== todayStr) return;

        const statusHandler = (data: any) => {
            const machineData = data?.machines?.[machineName];
            if (!machineData?.daily) return;

            setTableData((prev) => {
                const updates: any = {};

                // ✅ Guard: ไม่ทับค่า OEE Last ถ้า Socket ส่ง 0 มา (Cron ยังไม่คำนวณ)
                if (machineData.daily.oee !== undefined && machineData.daily.oee > 0) {
                    updates.oee = machineData.daily.oee;
                }

                // ✅ อัปเดต Availability จาก realtime_update (Fast Loop ทุก 2 วิ)
                if (machineData.daily.availability !== undefined && machineData.daily.availability > 0) {
                    updates.availabilityActual = machineData.daily.availability;
                }

                // 🆕 Update liveStatus จาก MSSQL slow poll (ทุก 5 นาที)
                if (machineData.currentHour?.live_status !== undefined) {
                    updates.liveStatus = machineData.currentHour.live_status || "Offline";
                }

                return Object.keys(updates).length > 0 ? { ...prev, ...updates } : prev;
            });
        };

        socketRef.on("realtime_update", statusHandler);
        return () => { socketRef.off("realtime_update", statusHandler); };
    }, [socketRef, machineName, currentDateStr]);

    // ✅ Socket.IO: Event-driven MC Status refresh (mc_status_updated)
    // เรียก fetchMcStatus() ทันทีเมื่อ Backend แจ้งว่ามี status/alarm ใหม่จาก MQTT
    // ไม่ต้อง Throttle เพราะ event นี้ trigger เฉพาะเมื่อสถานะเปลี่ยนจริงๆ
    useEffect(() => {
        if (!socketRef || !machineName || !currentDateStr) return;

        const todayStr = serverTimeRef.toISOString().split("T")[0];
        if (currentDateStr !== todayStr) return; // ดูย้อนหลัง → ไม่ต้อง real-time

        const mcStatusHandler = () => {
            if (activeTab === "status") {
                fetchMcStatus();
            }
        };

        socketRef.on("mc_status_updated", mcStatusHandler);
        return () => { socketRef.off("mc_status_updated", mcStatusHandler); };
    }, [socketRef, machineName, currentDateStr, activeTab, fetchMcStatus]);

    // ================= Data Fetching =================

    const fetchAllData = async (machine: string, date: string) => {
        try {
            // เรียก API พร้อมกัน 5 ตัวเพื่อความเร็ว
            const timestamp = Date.now();

            // ✅ 1. Fetch Models List First
            const resModels = await axios.get(`${config.apiServer}/api/oee/getModelsByDate`, {
                params: { machine_name: machine, date: date, t: timestamp }
            });
            const models = resModels.data.results.map((m: any) => m.model_name);
            setModelsList(models);

            // Set default selected model if not already set
            let targetModel = selectedModel;
            if (!selectedModel && models.length > 0) {
                targetModel = models[0];
                setSelectedModel(targetModel);
            }

            // ✅ 2. Prepare model parameter
            const modelParam = targetModel ? `&model_name=${targetModel}` : '';

            // เรียก API พร้อมกัน (เพิ่ม &t=${timestamp} ต่อท้าย)
            // 🆕 เพิ่ม latest-all เพื่อดึง liveStatus จาก MSSQL ทันที (ไม่รอ MQTT)
            const [resOEE, resTable, resGraph1, resGraph2, resOperator, resLatestStatus] = await Promise.all([
                axios.get(`${config.apiServer}/api/oee/getLastOEE?machine_name=${machine}&date=${date}${modelParam}&t=${timestamp}`),
                axios.get(`${config.apiServer}/api/oee/getDataTable?machine_name=${machine}&date=${date}${modelParam}&t=${timestamp}`),
                axios.get(`${config.apiServer}/api/oee/getGraph1?machine_name=${machine}&date=${date}${modelParam}&t=${timestamp}`),
                axios.get(`${config.apiServer}/api/oee/getGraph2?machine_name=${machine}&date=${date}${modelParam}&t=${timestamp}`),
                // ✅ เปลี่ยนเป็นดึงประวัติทั้งหมดของวันนั้น
                axios.get(`${config.apiServer}/api/historyWorking/getHistoryByDate?machine_name=${machine}&date=${date}&t=${timestamp}`),
                // 🆕 ดึง latest MCStatus จาก MSSQL โดยตรง (สำหรับ liveStatus ตอนโหลดหน้า)
                axios.get(`${config.apiServer}/api/mcstatus/latest-all`).catch(() => ({ data: { results: {} } }))
            ]);
            // 🆕 Extract liveStatus จาก MSSQL (ใช้เฉพาะวันนี้)
            const latestAllStatus: Record<string, string> = resLatestStatus.data?.results || {};

            // ✅ Check if viewing "Today" (UTC date comparison)
            const todayStr = new Date().toISOString().split("T")[0];
            const isToday = date === todayStr;

            let activeCrossDayOp = null;

            // ✅ If today, fetch active operator (who might have started yesterday)
            if (isToday) {
                try {
                    const resActive = await axios.get(`${config.apiServer}/api/historyWorking/getOperatorIdWorking/${machine}?t=${timestamp}`);
                    if (resActive.data && resActive.data.results) {
                        activeCrossDayOp = resActive.data.results;
                    }
                } catch (e) {
                    console.error("Error fetching active operator:", e);
                }
            } else {
                // ✅ ADDED: For historical dates, check for cross-day operators
                try {
                    const resCrossDay = await axios.get(`${config.apiServer}/api/historyWorking/getActiveCrossDayOperator?machine_name=${machine}&date=${date}&t=${timestamp}`);
                    if (resCrossDay.data && resCrossDay.data.results) {
                        activeCrossDayOp = resCrossDay.data.results;
                    }
                } catch (e) {
                    console.error("Error fetching cross-day operator:", e);
                }
            }

            // --- 1. Process Operator & Logout Check ---
            const historyList = resOperator.data.results || [];

            // ✅ Combine activeCrossDayOp with historyList
            let finalOperatorList = [...historyList];
            if (activeCrossDayOp) {
                // Check for duplicates just in case
                const exists = finalOperatorList.find((h: any) => h.id === activeCrossDayOp.id);
                if (!exists) {
                    finalOperatorList.push(activeCrossDayOp);
                }
            }

            let currentOpCode = "-";
            let currentOpName = "-";
            let currentOpPic = "";
            let currentHistoryId = null;

            // หาคนล่าสุดที่ยังทำงานอยู่ (end_time is null) หรือคนสุดท้ายใน list
            const activeOp = finalOperatorList.find((h: any) => h.end_time === null);
            const lastOp = finalOperatorList.length > 0 ? finalOperatorList[finalOperatorList.length - 1] : null;

            // ✅ Priority: Cross-Day Active -> Today's Active -> Today's Last
            const displayOp = activeCrossDayOp || activeOp || lastOp;

            if (displayOp) {
                currentOpCode = displayOp.emp_no;
                // Handle both flattened (activeCrossDayOp) and nested (historyList) structures
                currentOpName = displayOp.operator_name || (displayOp.tbm_operator ? displayOp.tbm_operator.operator_name : "-");
                currentOpPic = displayOp.picture_path || (displayOp.tbm_operator ? displayOp.tbm_operator.picture_path : "");
                // Use ID from the displayed operator (whether cross-day or today's active)
                currentHistoryId = (activeCrossDayOp || activeOp) ? displayOp.id : null;
            }

            setHistoryId(currentHistoryId);

            // Check Logout Permission
            const localOperatorCode = localStorage.getItem("operatorLocal");
            if (activeOp && localOperatorCode && localOperatorCode === activeOp.emp_no) {
                // ✅ Prevent logout from different page/device
                const loginSource = localStorage.getItem(`loginSource_h${currentHistoryId}`);
                if (loginSource === "machine_working") {
                    setCanLogout(true);
                } else {
                    setCanLogout(false);
                }
            } else {
                setCanLogout(false);
            }

            // --- 2. Process OEE & Table Data ---
            const oeeData = resOEE.data;
            const tableDataRaw = resTable.data;
            console.log("🔥 [API] Table Data Raw:", tableDataRaw);

            setTableData({
                model: tableDataRaw.model || "-",
                achieve: tableDataRaw.Achieve || 0,
                oee: oeeData.oee_value || 0,
                oeeDate: oeeData.date ? dayjs(oeeData.date).format("DD/MM/YYYY") : "-",
                operatorCode: currentOpCode,
                operatorName: currentOpName,
                operatorPic: currentOpPic ? `${config.apiServer}/image/${currentOpPic}` : "",
                operators: displayOp ? [displayOp] : [],
                outputActual: tableDataRaw.outputActual || 0,
                outputTarget: tableDataRaw.outputTarget || 0,
                ctActual: tableDataRaw.cycleTimeActual || 0,
                ctTarget: tableDataRaw.cycleTimeTarget || 0,
                availabilityActual: tableDataRaw.availabilityActual || 0,
                availabilityTarget: tableDataRaw.availabilityTarget || 0,
                liveStatus: isToday ? (latestAllStatus[machine] || "Offline") : "Offline",
                liveAlarm: null,
            });
            const now = new Date();
            // เช็คว่าเป็น "วันนี้" หรือไม่ (เทียบวันที่จาก param กับวันที่ปัจจุบัน)
            // หมายเหตุ: ใช้ new Date().toISOString().split('T')[0] เพื่อให้ได้ YYYY-MM-DD

            const currentHour = now.getHours();

            // ฟังก์ชันช่วย map ข้อมูล: ถ้าเป็น index ในอนาคตของวันนี้ ให้ return null
            const filterFutureData = (dataArray: any[], hoursArray: string[]) => {
                if (!isToday) return dataArray; // ถ้าดูย้อนหลัง ให้แสดงทั้งหมด

                // หา index ของชั่วโมงปัจจุบันใน array labels (เช่น "08:00" -> index 1)
                const currentIndex = hoursArray.findIndex((h: string) => parseInt(h) === currentHour);

                if (currentIndex === -1) return dataArray; // กันพลาด

                return dataArray.map((val, index) => {
                    // ถ้า index มากกว่าปัจจุบัน = อนาคต -> ให้เป็น null
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
                            data: filterFutureData(g1.outputActual, g1.hours), // ✅ กรองชั่วโมงอนาคต
                            backgroundColor: "#00b050", // Green
                            yAxisID: "y_qty",
                            order: 4,
                            datalabels: {
                                display: true,        // บังคับให้แสดง (Override ค่า global)
                                align: 'end',         // จัดตำแหน่งให้อยู่ด้านบนแท่ง
                                anchor: 'end',        // ยึดจุดอ้างอิงที่ส่วนบนของแท่ง
                                rotation: (context: any) => {
                                    // จอแคบให้ตั้งฉาก ป้องกันข้อความทับกัน
                                    return typeof window !== "undefined" && window.innerWidth < 1400 ? -90 : 0;
                                },
                                color: '#222',        // สีตัวอักษรเข้มให้อ่านง่าย
                                offset: 2,
                                font: (context: any) => ({
                                    weight: 'bold',
                                    size: typeof window !== "undefined" ? Math.max(9, Math.round((window.innerWidth / 1920) * 14)) : 11
                                }),
                                // ✅ Logic: ถ้าค่า > 0 ให้แสดงค่า, ถ้าไม่ ให้ return null (ไม่แสดง)
                                formatter: (value: any) => {
                                    return value > 0 ? value : null;
                                }
                            }
                        },
                        {
                            type: "line",
                            label: "Output Target",
                            data: g1.outputTarget, // รายชั่วโมง
                            borderColor: "#385723", // Dark Green
                            borderWidth: 5,
                            borderDash: [5, 5], // เส้นประ
                            pointRadius: 0,
                            yAxisID: "y_qty",
                            order: 3,
                            datalabels: {
                                display: true,
                                align: 'left',      // ✅ แนะนำ 'right' หรือ 'end' เพื่อให้ข้อความไม่ตกขอบซ้าย (มันจะอยู่ขวาของจุดที่ 0)
                                anchor: 'center',    // ยึดที่จุดกึ่งกลาง
                                backgroundColor: '#385723',
                                color: 'white',
                                borderRadius: 4,
                                font: { weight: 'bold', size: 10 },
                                padding: 4,
                                formatter: (value: any, context: any) => {
                                    // ✅ Logic ใหม่: เช็คว่าเป็น index ที่ 0 (ซ้ายสุด) หรือไม่
                                    if (context.dataIndex === 0) {
                                        return `Target: ${value}`;
                                    }
                                    return null; // จุดอื่นไม่แสดง
                                }
                            }
                        },
                        {
                            type: "line",
                            label: "Output Accum",
                            // ✅ แก้ไขตรงนี้: เรียกใช้ filterFutureData
                            data: filterFutureData(g1.outputActualAccum, g1.hours),
                            // data: g1.outputActualAccum,
                            borderColor: "#c00000",
                            backgroundColor: "#c00000",
                            borderWidth: 3,
                            pointRadius: 4,
                            yAxisID: "y_accum",
                            order: 1
                        },
                        {
                            type: "line",
                            label: "Output Target Accum",
                            data: g1.outputTargetAccum, // สะสม
                            borderColor: "#f062b0ff", // Pink
                            borderWidth: 5,
                            borderDash: [5, 5], // เส้นประ
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
                            data: filterFutureData(g2.cycleTimeActual, g2.hours), // ✅ กรองชั่วโมงอนาคต
                            backgroundColor: "#5b9bd5", // Blue
                            yAxisID: "y_ct",
                            order: 4
                        },
                        {
                            type: "line",
                            label: "Cycle Time Target",
                            data: g2.cycleTimeTarget,
                            borderColor: "#203864", // Dark Blue
                            borderWidth: 5,
                            borderDash: [5, 5], // เส้นประ
                            pointRadius: 0,
                            yAxisID: "y_ct",
                            order: 1,
                            datalabels: {
                                display: true,
                                align: 'left',      // ✅ แนะนำ 'right' หรือ 'end' เพื่อให้ข้อความไม่ตกขอบซ้าย (มันจะอยู่ขวาของจุดที่ 0)
                                anchor: 'center',    // ยึดที่จุดกึ่งกลาง
                                backgroundColor: '#385723',
                                color: 'white',
                                borderRadius: 4,
                                font: { weight: 'bold', size: 10 },
                                padding: 4,
                                formatter: (value: any, context: any) => {
                                    // ✅ Logic ใหม่: เช็คว่าเป็น index ที่ 0 (ซ้ายสุด) หรือไม่
                                    if (context.dataIndex === 0) {
                                        return `Target: ${value}`;
                                    }
                                    return null; // จุดอื่นไม่แสดง
                                }
                            }
                        },
                        {
                            type: "line",
                            label: "Availability Actual",
                            // ✅ แก้ไขตรงนี้: เรียกใช้ filterFutureData
                            data: filterFutureData(g2.availabilityActual, g2.hours),
                            // data: g2.availabilityActual,
                            borderColor: "#02630fff",
                            backgroundColor: "#02630fff",
                            borderWidth: 3,
                            pointRadius: 4,
                            yAxisID: "y_eff",
                            order: 3
                        },
                        {
                            type: "line",
                            label: "Availability Target",
                            data: g2.availabilityTarget,
                            borderColor: "#ff6600ff", // Dark Orange
                            borderWidth: 5,
                            borderDash: [5, 5], // เส้นประ
                            pointRadius: 0,
                            yAxisID: "y_eff",
                            order: 2,
                            datalabels: {
                                display: true,
                                align: 'right',     // จัดตำแหน่งให้อยู่ขวา
                                anchor: 'center',
                                backgroundColor: '#385723', // พื้นหลังสีเดียวกับเส้น
                                color: 'white',     // ตัวหนังสือสีขาว
                                borderRadius: 4,
                                font: { weight: 'bold', size: 10 },
                                padding: 4,
                                // ✅ Logic: ให้แสดงค่าเฉพาะจุดข้อมูลตัวสุดท้ายของ array เพื่อไม่ให้เลขซ้ำๆ เต็มกราฟ
                                formatter: (value: any, context: any) => {
                                    const dataArray = context.chart.data.datasets[context.datasetIndex].data;
                                    // เช็คว่าเป็น index สุดท้ายของ array หรือไม่
                                    if (context.dataIndex === dataArray.length - 1) {
                                        return `Target: ${value}`; // แสดงคำว่า Target: 100
                                    }
                                    return null; // จุดอื่นไม่ต้องแสดง
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

    // ================= Machine Status =================
    // (fetchMcStatus is declared above near Socket.IO effects to avoid "used before declaration" error)

    // Fetch on tab switch & poll every 5 minutes + countdown
    useEffect(() => {
        if (activeTab !== "status") return;
        fetchMcStatus();
        setCountdown(300);
        const fetchId = setInterval(() => {
            fetchMcStatus();
            setCountdown(300);
        }, 5 * 60 * 1000);
        const tickId = setInterval(() => {
            setCountdown(prev => prev > 0 ? prev - 1 : 0);
        }, 1000);
        return () => { clearInterval(fetchId); clearInterval(tickId); };
    }, [activeTab, fetchMcStatus]);

    // Draw canvas when data changes
    useEffect(() => {
        if (activeTab !== "status") return;
        const canvas = mcStatusCanvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        // High-DPI support
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        ctx.scale(dpr, dpr);
        const W = rect.width;
        const H = rect.height;

        // Clear
        ctx.clearRect(0, 0, W, H);

        // Layout constants
        const labelAreaW = 50;   // "Shift" / "Status" labels
        const chartX = labelAreaW;
        const chartW = W - labelAreaW - 10;
        const shiftRowY = 10;
        const shiftRowH = 22;
        const barY = shiftRowY + shiftRowH + 4;
        const barH = 36;
        const totalMinutes = 1440; // 24 hours
        const mShiftEnd = 720;     // 12 hours = M shift ends

        // Helper: datetime → minutes on timeline (UTC ตรงๆ)
        // Prisma แปลง TH local → UTC ให้แล้ว: TH 07:00 = UTC 00:00Z = นาทีที่ 0
        const toMinSince0700 = (dtStr: string): number => {
            const d = new Date(dtStr);
            return d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60;
        };

        // --- Draw Shift Row ---
        ctx.fillStyle = "#f8f9fa";
        ctx.fillRect(chartX, shiftRowY, chartW, shiftRowH);
        ctx.strokeStyle = "#dee2e6";
        ctx.strokeRect(chartX, shiftRowY, chartW, shiftRowH);

        // M Shift label (left half)
        const mEndX = chartX + (mShiftEnd / totalMinutes) * chartW;
        ctx.fillStyle = "#333";
        ctx.font = "bold 12px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("M Shift", chartX + (mEndX - chartX) / 2, shiftRowY + shiftRowH / 2);

        // N Shift label (right half)
        ctx.fillText("N Shift", mEndX + (chartX + chartW - mEndX) / 2, shiftRowY + shiftRowH / 2);

        // Divider line between M and N
        ctx.strokeStyle = "#333";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(mEndX, shiftRowY);
        ctx.lineTo(mEndX, barY + barH);
        ctx.stroke();
        ctx.lineWidth = 1;

        // Left labels
        ctx.fillStyle = "#555";
        ctx.font = "bold 11px sans-serif";
        ctx.textAlign = "right";
        ctx.fillText("Shift", labelAreaW - 6, shiftRowY + shiftRowH / 2);
        ctx.fillText("Status", labelAreaW - 6, barY + barH / 2);

        // --- Helper: minutes since 07:00 → TH time string ---
        const minToTimeStr = (min: number): string => {
            let h = Math.floor(min / 60) + 7;
            if (h >= 24) h -= 24;
            const m = Math.floor(min % 60);
            return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
        };

        // --- Build segments from data ---
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
                    const now = new Date();
                    const currentMin = now.getUTCHours() * 60 + now.getUTCMinutes();
                    const todayStr = new Date().toISOString().split("T")[0]; // ✅ Use Shift Date (00:00 UTC rollover)
                    if (currentDateStr === todayStr) {
                        endMin = Math.min(currentMin, 1440);
                        endTimeLabel = "Now";
                    } else {
                        endMin = 1440;
                        endTimeLabel = "06:59";
                    }
                }
                segments.push({
                    startMin, endMin,
                    status: mcStatusData[i].mc_status,
                    startTime: minToTimeStr(startMin),
                    endTime: endTimeLabel,
                });
            }
        }

        // Store segments ref for tooltip
        mcSegmentsRef.current = segments;

        // --- Draw status bar segments ---
        ctx.strokeStyle = "#dee2e6";
        ctx.strokeRect(chartX, barY, chartW, barH);

        for (const seg of segments) {
            const x1 = chartX + (seg.startMin / totalMinutes) * chartW;
            const x2 = chartX + (seg.endMin / totalMinutes) * chartW;
            const w = Math.max(x2 - x1, 1);
            const statusInfo = statusColors[seg.status];
            ctx.fillStyle = statusInfo ? statusInfo.color : "#ccc";
            ctx.fillRect(x1, barY, w, barH);
        }

        // --- Draw hour tick marks ---
        ctx.strokeStyle = "#aaa";
        ctx.fillStyle = "#666";
        ctx.font = "10px sans-serif";
        ctx.textAlign = "center";
        const hourLabels = ["07", "08", "09", "10", "11", "12", "13", "14", "15", "16", "17", "18", "19", "20", "21", "22", "23", "00", "01", "02", "03", "04", "05", "06"];
        for (let i = 0; i <= 24; i++) {
            const x = chartX + (i * 60 / totalMinutes) * chartW;
            ctx.beginPath();
            ctx.moveTo(x, barY + barH);
            ctx.lineTo(x, barY + barH + 5);
            ctx.stroke();
            if (i < 24) {
                ctx.fillText(hourLabels[i], x + (60 / totalMinutes * chartW) / 2, barY + barH + 15);
            }
        }

    }, [activeTab, mcStatusData, currentDateStr]);

    // ================= Downtime Breakdown Chart =================
    useEffect(() => {
        const segments = mcSegmentsRef.current;
        if (!segments || segments.length === 0) { setDowntimeChartData(null); return; }

        // Aggregate duration per status
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
                borderRadius: 4,
            }],
        });
    }, [mcStatusData]);

    // ================= MC Status Tooltip Handlers =================

    const handleCanvasMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
        const canvas = mcStatusCanvasRef.current;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        // Chart layout constants (must match draw code)
        const labelAreaW = 50;
        const chartX = labelAreaW;
        const chartW = rect.width - labelAreaW - 10;
        const barY = 10 + 22 + 4; // shiftRowY + shiftRowH + 4
        const barH = 36;
        const totalMinutes = 1440;

        // Check if mouse is within the bar area
        if (mouseY < barY || mouseY > barY + barH || mouseX < chartX || mouseX > chartX + chartW) {
            setMcTooltip(null);
            return;
        }

        // Find which segment the mouse is over
        const minAtMouse = ((mouseX - chartX) / chartW) * totalMinutes;
        const seg = mcSegmentsRef.current.find(s => minAtMouse >= s.startMin && minAtMouse < s.endMin);
        if (seg) {
            const durMin = seg.endMin - seg.startMin;
            const durH = Math.floor(durMin / 60);
            const durM = Math.floor(durMin % 60);
            const duration = durH > 0 ? `${durH}h ${durM}m` : `${durM}m`;
            setMcTooltip({
                visible: true,
                x: e.clientX - rect.left,
                y: e.clientY - rect.top - 60,
                status: seg.status,
                startTime: seg.startTime,
                endTime: seg.endTime,
                duration,
            });
        } else {
            setMcTooltip(null);
        }
    };

    const handleCanvasMouseLeave = () => {
        setMcTooltip(null);
    };

    // ================= Handlers =================

    const handleDateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const newDate = e.target.value;
        if (!newDate) return;

        setCurrentDateStr(newDate);

        // Update LocalStorage
        localStorage.setItem("machineDateLocal", newDate);

        // Update URL
        const params = new URLSearchParams(searchParams.toString());
        params.set("date", newDate);
        router.replace(`?${params.toString()}`);

        // Fetch new data
        if (machineName) {
            fetchAllData(machineName, newDate);
        }
    };

    const handleLogout = async () => {
        if (!historyId) return;

        const result = await Swal.fire({
            title: "Sign out?",
            text: `Sign out: ${tableData.operatorCode}?`,
            icon: "warning",
            showCancelButton: true,
            confirmButtonColor: "#d33",
            confirmButtonText: "Logout",
            cancelButtonText: "Cancel",
        });

        if (result.isConfirmed) {
            try {
                await axios.put(`${config.apiServer}/api/historyWorking/updateEndTime/${historyId}`);

                localStorage.removeItem("operatorLocal");
                localStorage.removeItem("machineDateLocal");
                localStorage.removeItem("machineNameLocal");

                Swal.fire({
                    icon: "success",
                    title: "Logged out",
                    timer: 1000,
                    showConfirmButton: false
                }).then(() => {
                    router.push("/oee_production/machine_area");
                });

            } catch (e: any) {
                Swal.fire("Error", e.message, "error");
            }
        }
    };

    // ================= Chart Options =================

    // ✅ Compute current hour bar index for blink plugin
    const currentUtcHour = serverTimeRef.getUTCHours();
    const currentThHour = (currentUtcHour + 7) % 24;
    const todayStr = serverTimeRef.toISOString().split("T")[0];
    const blinkEnabled = isViewingToday && currentDateStr === todayStr;
    // Find bar index from graph labels (e.g., ["7","8",..."6"])
    const blinkBarIndex1 = graph1Data?.labels?.findIndex((h: string) => parseInt(h) === currentThHour) ?? -1;
    const blinkBarIndex2 = graph2Data?.labels?.findIndex((h: string) => parseInt(h) === currentThHour) ?? -1;

    // [Graph 1] Output Monitor Options (Dual Axis)
    const optionsGraph1: ChartOptions<"bar" | "line"> = {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
            legend: {
                position: 'top',
                labels: {
                    usePointStyle: false,
                    boxWidth: 25,
                    padding: 15,
                    font: {
                        size: 12
                    }
                }
            },
            title: { display: false },
            datalabels: { display: false },
            blinkOverlay: { enabled: blinkEnabled, barIndex: blinkBarIndex1 },
        },
        scales: {
            x: { grid: { display: false } },
            // แกนซ้าย: Qty/hour
            y_qty: {
                type: 'linear',
                display: true,
                position: 'left',
                title: { display: true, text: 'Output Actual [pcs/hour]', color: '#00b050' },
                beginAtZero: true,
            },
            // แกนขวา: Accum
            y_accum: {
                type: 'linear',
                display: true,
                position: 'right',
                title: { display: true, text: 'Output Accum [pcs]', color: '#c00000' },
                beginAtZero: true,
                grid: { drawOnChartArea: false }
            }
        }
    };

    // [Graph 2] CT & Availability Monitor Options
    const optionsGraph2: ChartOptions<"bar" | "line"> = {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
            legend: {
                position: 'top',
                labels: {
                    usePointStyle: false, // ✅ เปลี่ยนเป็น false: Bar=สี่เหลี่ยม, Line=เส้น
                    boxWidth: 25,         // ✅ ปรับความกว้างให้เห็นเส้นประชัดเจน
                    padding: 15
                }
            },
            title: { display: false },
            datalabels: { display: false },
            blinkOverlay: { enabled: blinkEnabled, barIndex: blinkBarIndex2 },
        },
        scales: {
            x: { grid: { display: false } },
            y_ct: {
                type: 'linear',
                display: true,
                position: 'left',
                title: { display: true, text: 'Cycle time [sec]', color: '#5b9bd5' },
                beginAtZero: true,
            },
            y_eff: {
                type: 'linear',
                display: true,
                position: 'right',
                title: { display: true, text: 'Availability [%]', color: '#ed7d31' },
                min: 0,
                max: 120,
                grid: { drawOnChartArea: false }
            },
        }
    };

    // ================= Render =================

    return (
        <div className="container-fluid vh-100 d-flex flex-column bg-light" style={{ overflow: "hidden" }}>
            <div className="row flex-grow-1 p-3">
                <div className="col-12 d-flex flex-column">

                    {/* --- TABLE SECTION --- */}
                    <div className="card shadow-sm border border-dark mb-3">
                        <div className="card-body p-0">
                            <div className="table-responsive">
                                <table className="table table-bordered align-middle text-center fs-5 m-0">
                                    <thead className="table-primary">
                                        <tr>
                                            <th style={{ width: "12%" }}>Date</th>
                                            <th style={{ width: "15%" }}>MC Name</th>
                                            <th style={{ width: "15%" }}>Model</th>
                                            <th style={{ width: "15%" }}>Achieve</th>
                                            <th style={{ width: "15%" }}>OEE (Last)</th>
                                            <th style={{ width: "18%" }}>Operator</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        <tr>
                                            {/* Date / Time */}
                                            <td rowSpan={2} className="fw-semibold">
                                                {/* ✅ Logic: If History Mode (has 'date' param), ALWAYS show Date Picker. */}
                                                {searchParams.get("date") ? (
                                                    <input
                                                        type="date"
                                                        className="form-control text-center fw-bold mx-auto"
                                                        style={{ maxWidth: "160px", cursor: "pointer" }}
                                                        value={currentDateStr}
                                                        onChange={handleDateChange}
                                                    />
                                                ) : (
                                                    <div>{dayjs(currentDateStr || new Date()).format("DD/MM/YYYY")}</div>
                                                )}

                                                {/* ✅ Logic: Show Time ONLY if it is Today */}
                                                {currentDateStr === new Date().toISOString().split("T")[0] && (
                                                    <div className="text-primary fw-bold fs-4">{clientTime}</div>
                                                )}
                                            </td>
                                            {/* Machine Info */}
                                            <td className="fw-bold">
                                                <div className="text-primary">{machineName}</div>
                                                <div className="d-flex flex-column align-items-center mt-1" style={{ fontSize: "0.75rem" }}>
                                                    {currentDateStr === new Date().toISOString().split("T")[0] ? (
                                                        <>
                                                            <span className="badge rounded-pill" style={{ 
                                                                backgroundColor: statusColors[tableData.liveStatus]?.color || "#6c757d"
                                                            }}>
                                                                {statusColors[tableData.liveStatus]?.label || tableData.liveStatus}
                                                            </span>
                                                        </>
                                                    ) : (
                                                        <span className="badge rounded-pill bg-secondary">Historical</span>
                                                    )}
                                                </div>
                                            </td>
                                            <td>
                                                {modelsList.length > 0 ? (
                                                    <div className="fw-bold text-dark mx-auto" style={{ wordBreak: "break-word", lineHeight: "1.2" }}>
                                                        {modelsList.join(" | ")}
                                                    </div>
                                                ) : (
                                                    <span>{tableData.model}</span>
                                                )}
                                            </td>
                                            {/* Achieve */}
                                            <td>
                                                <span className={`fw-bold ${tableData.achieve >= 100 ? "text-success" : "text-danger"}`}>
                                                    {tableData.achieve.toFixed(2)} %
                                                </span>
                                            </td>
                                            {/* OEE Gauge Value */}
                                            <td rowSpan={4} className="align-middle">
                                                <div className={`fs-1 fw-bold ${tableData.oee >= 85 ? "text-success" : "text-danger"}`}>
                                                    {tableData.oee.toFixed(2)} %
                                                </div>
                                                <small className="text-muted">Update: {tableData.oeeDate}</small>
                                            </td>
                                            {/* Operator Image & Name */}
                                            <td rowSpan={4} className="p-1 align-middle" style={{ verticalAlign: 'middle' }}>
                                                <div className="d-flex flex-column align-items-center justify-content-center h-100 w-100">
                                                    {tableData.operators && tableData.operators.length > 0 ? (
                                                        tableData.operators.map((op: any, index: number) => (
                                                            <div key={index} className="d-flex flex-column align-items-center w-100 p-2">
                                                                <img
                                                                    src={op.picture_path ? `${config.apiServer}/image/${op.picture_path}` : (op.tbm_operator?.picture_path ? `${config.apiServer}/image/${op.tbm_operator.picture_path}` : "/dist/img/avg.png")}
                                                                    alt="Operator"
                                                                    className="rounded border border-secondary bg-white mb-2"
                                                                    style={{ width: "80px", height: "80px", objectFit: "cover" }}
                                                                    onError={(e) => { (e.target as HTMLImageElement).src = "/dist/img/avg.png" }}
                                                                />
                                                                <div className="fw-bold text-dark fs-5">
                                                                    {op.emp_no}
                                                                </div>
                                                                <div className="text-muted" style={{ fontSize: "0.9rem" }}>
                                                                    {op.operator_name || op.tbm_operator?.operator_name || "-"}
                                                                </div>
                                                            </div>
                                                        ))
                                                    ) : (
                                                        <div className="text-muted mt-4">No Operator</div>
                                                    )}

                                                    {canLogout && (
                                                        <button
                                                            onClick={handleLogout}
                                                            className="btn btn-danger btn-sm mt-1 px-3 fw-bold shadow-sm w-auto"
                                                        >
                                                            <i className="fa-solid fa-right-from-bracket me-1"></i> Logout
                                                        </button>
                                                    )}
                                                </div>
                                            </td>
                                        </tr>
                                        {/* Row 2: Headers for Details */}
                                        <tr className="table-light fw-bold text-secondary" style={{ fontSize: "0.9rem" }}>
                                            <td>Output</td>
                                            <td>Cycle Time</td>
                                            <td>Availability</td>
                                        </tr>
                                        {/* Row 3: Actual Data */}
                                        <tr>
                                            <td className="fw-bold bg-light">Actual</td>

                                            {/* Output (ปกติ) */}
                                            <td className="fw-bold fs-5 text-dark">
                                                {tableData.outputActual.toLocaleString()} <small className="fs-6 fw-normal">pcs</small>
                                            </td>

                                            {/* ✅ แก้ไข Cycle Time: ถ้าเวลาจริง "มากกว่า" เป้าหมาย (ช้า) = สีแดง, ถ้าน้อยกว่าหรือเท่ากับ (เร็ว) = สีเขียว */}
                                            <td className={`fw-bold fs-5 ${tableData.ctActual > tableData.ctTarget ? "text-danger" : "text-success"}`}>
                                                {tableData.ctActual.toFixed(2)} <small className="fs-6 fw-normal">sec</small>
                                            </td>

                                            {/* ✅ แก้ไข Availability: ถ้าประสิทธิภาพจริง "น้อยกว่า" เป้าหมาย (แย่) = สีแดง, ถ้ามากกว่าหรือเท่ากับ (ดี) = สีเขียว */}
                                            <td className={`fw-bold fs-5 ${tableData.availabilityActual < tableData.availabilityTarget ? "text-danger" : "text-success"}`}>
                                                {tableData.availabilityActual.toFixed(2)} <small className="fs-6 fw-normal">%</small>
                                            </td>
                                        </tr>
                                        {/* Row 4: Target Data */}
                                        <tr>
                                            <td className="fw-bold bg-light text-secondary">Target</td>
                                            <td className="text-muted">{tableData.outputTarget.toLocaleString()} pcs</td>
                                            <td className="text-muted">{tableData.ctTarget.toFixed(2)} sec</td>
                                            <td className="text-muted">{tableData.availabilityTarget.toFixed(2)} %</td>
                                        </tr>
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </div>

                    {/* --- CONTENT AREA --- */}
                    {activeTab === "output" ? (
                        /* --- GRAPH SECTION (Split 2 Columns) --- */
                        <div className="row g-3 flex-grow-1">
                            {/* Graph 1: Output */}
                            <div className="col-md-6 d-flex">
                                <div className="card w-100 shadow-sm border border-dark position-relative">
                                    <div className="card-header bg-white fw-bold text-center py-1 fs-5">Output Monitor</div>
                                    <div className="card-body p-2 position-relative">
                                        {graph1Data ? (
                                            <Chart type="bar" data={graph1Data} options={optionsGraph1} />
                                        ) : (
                                            <div className="d-flex align-items-center justify-content-center h-100 text-muted">Loading Graph 1...</div>
                                        )}
                                    </div>
                                </div>
                            </div>

                            {/* Graph 2: CT & Eff — Tab buttons in top-right */}
                            <div className="col-md-6 d-flex">
                                <div className="card w-100 shadow-sm border border-dark position-relative">
                                    {/* Tab buttons + status badge in header */}
                                    <div className="card-header bg-white py-1 d-flex align-items-center" style={{ position: "relative" }}>
                                        <span className="fw-bold fs-5" style={{ position: "absolute", left: 0, right: 180, textAlign: "center", pointerEvents: "none" }}>CT & Avail Monitor</span>
                                        <div className="d-flex gap-1 ms-auto align-items-center">
                                            {isViewingToday ? (
                                                <span className="badge bg-success">📡 Real-time</span>
                                            ) : (
                                                <span className="badge bg-secondary">History</span>
                                            )}
                                            <button
                                                className="btn btn-sm btn-outline-primary fw-bold px-4 py-0"
                                                onClick={() => { setActiveTab("status"); localStorage.setItem("machineWorkingTab", "status"); }}
                                                title="Switch to Machine Status"
                                                style={{ minWidth: "120px" }}
                                            >
                                                <i className="fas fa-cogs me-2"></i>Status
                                            </button>
                                        </div>
                                    </div>
                                    <div className="card-body p-2">
                                        {graph2Data ? (
                                            <Chart type="bar" data={graph2Data} options={optionsGraph2} />
                                        ) : (
                                            <div className="d-flex align-items-center justify-content-center h-100 text-muted">Loading Graph 2...</div>
                                        )}
                                    </div>
                                </div>
                            </div>
                        </div>
                    ) : (
                        /* --- MACHINE STATUS TIMELINE --- */
                        <div className="card shadow-sm border border-dark flex-grow-1">
                            {/* Header with tab buttons + countdown */}
                            <div className="card-body p-3 d-flex flex-column justify-content-start align-items-center position-relative" style={{ overflow: "hidden" }}>
                                {/* Header Title (Perfectly Centered) */}
                                <div className="w-100 text-center fw-bold fs-5 py-2 border-bottom mb-3 relative">
                                    Machine Status Timeline
                                    {/* Right-aligned buttons (Absolute positioning to not affect centering) */}
                                    <div className="position-absolute end-0 top-0 mt-2 me-3 d-flex gap-1 align-items-center">
                                        <span className="badge bg-info">
                                            🔄 {Math.floor(countdown / 60)}:{String(countdown % 60).padStart(2, '0')}
                                        </span>
                                        <button
                                            className="btn btn-sm btn-outline-primary fw-bold px-2 py-0"
                                            onClick={() => { setActiveTab("output"); localStorage.setItem("machineWorkingTab", "output"); }}
                                            title="Switch to Output & CT & Eff"
                                        >
                                            <i className="fas fa-chart-bar me-1"></i>Output
                                        </button>
                                    </div>
                                </div>
                                {mcStatusData.length === 0 ? (
                                    <div className="d-flex align-items-center justify-content-center h-100 text-muted py-5">
                                        <div className="text-center">
                                            <i className="fas fa-info-circle fs-1 mb-2"></i>
                                            <div>No Status Data for this date</div>
                                        </div>
                                    </div>
                                ) : (
                                    <div className="w-100 d-flex flex-column" style={{ flex: 1, minHeight: 0 }}>
                                        <div className="position-relative" style={{ flexShrink: 0 }}>
                                            <canvas
                                                ref={mcStatusCanvasRef}
                                                style={{ width: "100%", height: "100px", display: "block", cursor: "crosshair" }}
                                                onMouseMove={handleCanvasMouseMove}
                                                onMouseLeave={handleCanvasMouseLeave}
                                            />
                                            {/* Tooltip */}
                                            {mcTooltip && mcTooltip.visible && (
                                                <div
                                                    className="position-absolute bg-dark text-white rounded shadow px-2 py-1"
                                                    style={{
                                                        left: mcTooltip.x,
                                                        top: mcTooltip.y,
                                                        transform: "translateX(-50%)",
                                                        pointerEvents: "none",
                                                        zIndex: 100,
                                                        fontSize: "0.8rem",
                                                        whiteSpace: "nowrap",
                                                    }}
                                                >
                                                    <div className="d-flex align-items-center gap-1">
                                                        <div style={{
                                                            width: 10, height: 10,
                                                            backgroundColor: statusColors[mcTooltip.status]?.color || "#ccc",
                                                            borderRadius: 2,
                                                        }}></div>
                                                        <strong>{statusColors[mcTooltip.status]?.label || mcTooltip.status}</strong>
                                                    </div>
                                                    <div>{mcTooltip.startTime} → {mcTooltip.endTime} ({mcTooltip.duration})</div>
                                                </div>
                                            )}
                                        </div>

                                        {/* Downtime Breakdown Chart — flex-grow to fill remaining space */}
                                        {downtimeChartData && (
                                            <div className="mt-0" style={{ flex: "1 1 0", minHeight: "220px", overflow: "visible" }}>
                                                <div className="text-center fw-bold" style={{ fontSize: "0.9rem", color: "#333", marginBottom: 2 }}>Downtime Breakdown (%)</div>
                                                <Chart type="bar" data={downtimeChartData}
                                                    plugins={[{
                                                        id: "coloredXLabels",
                                                        afterDraw: (chart: any) => {
                                                            const { ctx, chartArea } = chart;
                                                            const xAxis = chart.scales.x;
                                                            const bgColors = chart.data.datasets[0]?.backgroundColor || [];
                                                            const labels = chart.data.labels || [];
                                                            const yBase = chartArea.bottom + 4;
                                                            const boxSize = 10;

                                                            // คำนวณความกว้าง slot จริง
                                                            const slotWidth = labels.length > 0 ? chartArea.width / labels.length : 9999;
                                                            // 1. เลือกมุมตามพื้นที่
                                                            let angleDeg = 0;
                                                            if (slotWidth < 45) angleDeg = 90;       // กลายเป็นแนวตั้งตรงๆ (เมื่อจอเล็ก) ที 90 องศา
                                                            else if (slotWidth < 80) angleDeg = 45;  // 45 องศา สำหรับจอกลาง
                                                            const angleRad = (angleDeg * Math.PI) / 180;

                                                            ctx.save();
                                                            ctx.font = "9px sans-serif";
                                                            ctx.textBaseline = "middle"; // ✅ จัดตำแหน่งให้อยู่กึ่งกลางแนวตั้งแทนเพื่อให้ข้อความไม่เบี้ยวเมื่อหมุน

                                                            labels.forEach((label: string, i: number) => {
                                                                const x = xAxis.getPixelForTick(i);

                                                                ctx.save();

                                                                // ✅ 2. ถ้าเป็นแนวนอน (0 องศา) = จัดกึ่งกลางพอดีแทนการเริ่มกึ่งกลาง
                                                                if (angleDeg === 0) {
                                                                    ctx.translate(x, yBase + boxSize / 2); // ย้ายจุดหมุนมาที่กึ่งกลางของกล่องสี
                                                                    const textWidth = ctx.measureText(label).width;
                                                                    const totalWidth = boxSize + 3 + textWidth; // ความกว้างของก้อนออบเจ็กต์ภาพรวม
                                                                    const startX = -(totalWidth / 2);

                                                                    // สี่เหลี่ยมสี
                                                                    ctx.fillStyle = bgColors[i] || "#ccc";
                                                                    ctx.fillRect(startX, -boxSize / 2, boxSize, boxSize);
                                                                    ctx.strokeStyle = "#bbb";
                                                                    ctx.lineWidth = 0.5;
                                                                    ctx.strokeRect(startX, -boxSize / 2, boxSize, boxSize);

                                                                    // ข้อความ
                                                                    ctx.fillStyle = "#333";
                                                                    ctx.textAlign = "left";
                                                                    ctx.fillText(label, startX + boxSize + 3, 0);

                                                                } else {
                                                                    // ✅ กรณีหมุน (45 หรือ 90 องศา)
                                                                    ctx.translate(x, yBase);
                                                                    ctx.rotate(angleRad);

                                                                    // เลื่อนกล่องสีไปทางซ้ายครึ่งนึง และเลื่อนแกน Y ขึ้นครึ่งนึงเพื่อให้กึ่งกลางแนวตั้งตรงกับจุดหมุนแกนพอดี
                                                                    ctx.fillStyle = bgColors[i] || "#ccc";
                                                                    ctx.fillRect(-boxSize / 2, -boxSize / 2, boxSize, boxSize);
                                                                    ctx.strokeStyle = "#bbb";
                                                                    ctx.lineWidth = 0.5;
                                                                    ctx.strokeRect(-boxSize / 2, -boxSize / 2, boxSize, boxSize);

                                                                    // ข้อความชิดกล่องสี (Y=0 เพราะ textBaseline = "middle" แล้ว)
                                                                    ctx.fillStyle = "#333";
                                                                    ctx.textAlign = "left";
                                                                    ctx.fillText(label, boxSize / 2 + 3, 0);
                                                                }

                                                                ctx.restore();
                                                            });

                                                            ctx.restore();
                                                        },
                                                    }]}
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
                                                                offset: 1,
                                                                color: "#333",
                                                                font: { weight: "bold", size: 11 },
                                                                formatter: (val: number) => val > 0 ? `${val}%` : null,
                                                            },
                                                        },
                                                        layout: { padding: { top: 24, bottom: 80 } },
                                                        scales: {
                                                            x: {
                                                                grid: { display: false },
                                                                ticks: { display: false },
                                                            },
                                                            y: { beginAtZero: true, ticks: { callback: (val: any) => `${val}%`, font: { size: 10 } }, grid: { color: "#eee" } },
                                                        },
                                                    } as any} />
                                            </div>
                                        )}


                                    </div>
                                )}
                            </div>
                        </div>
                    )}

                </div>
            </div>

            {/* Custom Styles for Table Borders */}
            <style jsx>{`
                .table-bordered td, .table-bordered th {
                    border: 1px solid #dee2e6 !important;
                }
                .table-bordered thead th {
                    border-bottom-width: 2px;
                }
            `}</style>
        </div>
    );
}
