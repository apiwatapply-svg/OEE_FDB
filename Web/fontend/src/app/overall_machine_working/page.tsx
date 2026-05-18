"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useSearchParams, useRouter } from "next/navigation";
import { useEffect, useState, useRef, useCallback } from "react";
import axios from "axios";
import config from "@/app/config";
import OverallMachineCard from "../components/Overall_machine_working";
import Swal from "sweetalert2";
import { getSocket } from "@/app/lib/socketManager";
import type { Socket } from "socket.io-client";

import { Suspense } from "react";
import LoadingSpinner from "@/app/components/LoadingSpinner";
// ─────────────────────────────────────────────
// Helper: localStorage keys scoped by area+type
// ─────────────────────────────────────────────
const filterKey = (area: string | null, type: string | null) =>
    `overallMachineFilter_${area}_${type}`;
const itemsPerPageKey = "overallMachineItemsPerPage";

function OverallMachineContent() {
    const searchParams = useSearchParams();
    const router = useRouter();

    const area = searchParams.get("area");
    const type = searchParams.get("type");
    const date = searchParams.get("date");
    const targetMachine = searchParams.get("machine");
    const viewParam = searchParams.get("view");
    const queryView = viewParam === "status" || viewParam === "output" ? viewParam : null;

    // ─── Machine list & filter ───────────────────
    const [machines, setMachines] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);

    // selectedMachineIds: Set of machine IDs the user wants shown; null = "all" (not loaded yet)
    const [selectedMachineIds, setSelectedMachineIds] = useState<Set<number> | null>(null);
    const [showFilterDropdown, setShowFilterDropdown] = useState(false);
    const filterDropdownRef = useRef<HTMLDivElement>(null);

    // ─── Type list for type-switching dropdown ───
    const [availableTypes, setAvailableTypes] = useState<{type: string, fullName: string}[]>([]);

    // ─── Area list for area-switching dropdown ───
    const [availableAreas, setAvailableAreas] = useState<string[]>([]);

    // ─── Items per page ──────────────────────────
    const [itemsPerPage, setItemsPerPage] = useState<number>(() => {
        if (typeof window !== "undefined") {
            const saved = localStorage.getItem(itemsPerPageKey);
            if (saved) return Math.min(6, Math.max(1, parseInt(saved)));
        }
        return 6;
    });

    // ─── Other state ─────────────────────────────
    const [refreshTrigger, setRefreshTrigger] = useState(0);
    const [serverTimeStr, setServerTimeStr] = useState("");
    const [socketRef, setSocketRef] = useState<Socket | null>(null);
    const [realtimeData, setRealtimeData] = useState<any>(null);

    const [activeView, setActiveViewState] = useState<"output" | "status">(() => {
        if (viewParam === "output" || viewParam === "status") return viewParam;
        if (typeof window !== "undefined") {
            const saved = localStorage.getItem("overallMachineActiveView");
            if (saved === "output" || saved === "status") return saved;
        }
        return "output";
    });

    const setActiveView = (view: "output" | "status") => {
        setActiveViewState(view);
        localStorage.setItem("overallMachineActiveView", view);
    };

    useEffect(() => {
        return () => {
            localStorage.removeItem("overallMachineActiveView");
        };
    }, []);

    useEffect(() => {
        if (!queryView) return;
        setActiveViewState(queryView);
        localStorage.setItem("overallMachineActiveView", queryView);
    }, [queryView]);

    // ─── MC Status countdown ─────────────────────
    const [countdown, setCountdown] = useState(300);
    const [mcStatusRefreshTrigger, setMcStatusRefreshTrigger] = useState(0);
    useEffect(() => {
        if (activeView !== "status") {
            setCountdown(300);
            return;
        }
        setCountdown(300);
        const tickId = setInterval(() => {
            setCountdown(prev => {
                if (prev <= 1) {
                    setMcStatusRefreshTrigger(t => t + 1);
                    return 300;
                }
                return prev - 1;
            });
        }, 1000);
        return () => clearInterval(tickId);
    }, [activeView]);

    const formatCountdown = (sec: number) => {
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        return `${m}:${String(s).padStart(2, "0")}`;
    };

    // ─── Pagination ──────────────────────────────
    const [currentPage, setCurrentPage] = useState(1);

    // Machines that are shown (after filter)
    const filteredMachines = selectedMachineIds === null
        ? machines
        : machines.filter(m => selectedMachineIds.has(m.id));

    const totalPages = Math.max(1, Math.ceil(filteredMachines.length / itemsPerPage));
    const startIndex = (currentPage - 1) * itemsPerPage;
    const displayedMachines = filteredMachines.slice(startIndex, startIndex + itemsPerPage);

    // ─── Close filter dropdown on outside click ──
    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (filterDropdownRef.current && !filterDropdownRef.current.contains(e.target as Node)) {
                setShowFilterDropdown(false);
            }
        };
        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, []);

    // ─── Fetch machines & types, init socket ────
    useEffect(() => {
        if (!area || !type || !date) {
            Swal.fire({
                title: "Missing Parameters",
                text: "Please select area, type and date from the previous page.",
                icon: "warning",
            }).then(() => {
                router.push("/oee_production/machine_area");
            });
            return;
        }

        fetchMachines();
        fetchAvailableTypes();
        fetchAvailableAreas();

        const socket = getSocket();
        socket.emit("joinRoom", "dashboard");
        socket.on("server_time", (isoStr: string) => {
            const serverTime = new Date(isoStr);
            setServerTimeStr(serverTime.toLocaleTimeString("en-GB", { hour12: false, timeZone: "Asia/Bangkok" }));
        });
        setSocketRef(socket);

        return () => {
            socket.emit("leaveRoom", "dashboard");
            socket.off("server_time");
        };
    }, [area, type, date]);

    // ─── Save current type to localStorage for the current area ──
    useEffect(() => {
        if (area && type) {
            localStorage.setItem(`overallMachine_lastTypeFor_${area}`, type);
        }
    }, [area, type]);

    // ─── Load saved filter from localStorage after machines loaded ──
    useEffect(() => {
        if (machines.length === 0 || !area || !type) return;
        if (targetMachine) {
            const found = machines.find((m: any) => m.machine_name === targetMachine);
            if (found?.id != null) {
                setSelectedMachineIds(new Set([found.id]));
                setCurrentPage(1);
                return;
            }
        }
        const saved = localStorage.getItem(filterKey(area, type));
        if (saved) {
            try {
                const ids: number[] = JSON.parse(saved);
                setSelectedMachineIds(new Set(ids));
            } catch {
                setSelectedMachineIds(new Set(machines.map((m: any) => m.id)));
            }
        } else {
            // Default: all machines selected
            setSelectedMachineIds(new Set(machines.map((m: any) => m.id)));
        }
    }, [machines, area, type, targetMachine]);

    // ─── Socket: realtime_output ─────────────────
    useEffect(() => {
        if (!socketRef) return;

        const fastHandler = (data: any) => {
            setRealtimeData((prev: any) => {
                if (!prev) return data;
                const merged = { ...data };
                if (prev.machines) {
                    const mergedMachines = data.isDelta
                        ? { ...prev.machines, ...data.machines }
                        : { ...data.machines };
                    for (const [name, machineData] of Object.entries(mergedMachines)) {
                        const prevMachine = prev.machines?.[name];
                        if (prevMachine?.daily?.availability !== undefined) {
                            (machineData as any).daily = {
                                availability: prevMachine.daily.availability,
                                performance: prevMachine.daily.performance,
                                quality: prevMachine.daily.quality,
                                oee: prevMachine.daily.oee,
                                ...(machineData as any).daily,
                            };
                        }
                    }
                    merged.machines = mergedMachines;
                }
                return merged;
            });

            // ✅ Date rollover — Redirect ONLY when the server shiftDate actually rolls over while connected (00:00 UTC = 07:00 TH)
            const currentServerDate = data.shiftDate;
            const prevServerDate = (socketRef as any)._lastServerDate;
            
            if (prevServerDate && currentServerDate && prevServerDate !== currentServerDate) {
                // The server just crossed into a new shift day!
                // If viewing the previous logic day (prevServerDate), auto-advance them:
                if (date === prevServerDate) {
                    router.replace(`/overall_machine_working?area=${area}&type=${type}&date=${currentServerDate}`);
                }
            }
            
            // Keep track of the last seen server date on the socket object to survive renders without triggering dependencies
            if (currentServerDate) {
                (socketRef as any)._lastServerDate = currentServerDate;
            }
        };

        socketRef.on("realtime_output", fastHandler);
        return () => { socketRef.off("realtime_output", fastHandler); };
    }, [socketRef, area, type, date, router]);

    // ─── Socket: realtime_update (slow, status) ──
    useEffect(() => {
        if (!socketRef) return;
        const statusHandler = (data: any) => {
            setRealtimeData((prev: any) => {
                if (!prev) return prev;
                const merged = { ...prev };
                if (data.machines && prev.machines) {
                    const mergedMachines = { ...prev.machines };
                    for (const [name, statusData] of Object.entries(data.machines)) {
                        if (mergedMachines[name]) {
                            mergedMachines[name] = {
                                ...mergedMachines[name],
                                daily: {
                                    ...mergedMachines[name].daily,
                                    ...(statusData as any).daily,
                                },
                                // 🆕 Merge currentHour เพื่อให้ liveStatus update จาก slow poll ด้วย
                                currentHour: {
                                    ...mergedMachines[name].currentHour,
                                    ...(statusData as any).currentHour,
                                },
                            };
                        }
                    }
                    merged.machines = mergedMachines;
                }
                return merged;
            });
        };
        socketRef.on("realtime_update", statusHandler);
        return () => { socketRef.off("realtime_update", statusHandler); };
    }, [socketRef]);

    // ─── fetchMachines ───────────────────────────
    const fetchMachines = async () => {
        setLoading(true);
        try {
            const res = await axios.get(`${config.apiServer}/api/machine/listMachines/${area}/${type}`);
            if (res.data?.results) {
                setMachines(res.data.results);
            }
        } catch (error) {
            console.error("Error fetching machines:", error);
        } finally {
            setLoading(false);
        }
    };

    // ─── fetchAvailableTypes ─────────────────────
    const fetchAvailableTypes = async () => {
        try {
            const res = await axios.get(`${config.apiServer}/api/machine/listTypeWithMachines/${area}`);
            if (res.data?.results) {
                setAvailableTypes(res.data.results.map((t: any) => ({ type: t.machine_type, fullName: t.full_machine_type })));
            }
        } catch (error) {
            console.error("Error fetching types:", error);
        }
    };

    // ─── fetchAvailableAreas ─────────────────────
    const fetchAvailableAreas = async () => {
        try {
            const res = await axios.get(`${config.apiServer}/api/machine/listArea`);
            if (res.data?.results) {
                setAvailableAreas(res.data.results.map((r: any) => r.machine_area));
            }
        } catch (error) {
            console.error("Error fetching areas:", error);
        }
    };

    // ─── Filter helpers ──────────────────────────
    const saveFilter = (newIds: Set<number>) => {
        localStorage.setItem(filterKey(area, type), JSON.stringify([...newIds]));
        setSelectedMachineIds(newIds);
    };

    const toggleMachine = (id: number) => {
        const current = selectedMachineIds ?? new Set(machines.map((m: any) => m.id));
        const next = new Set(current);
        if (next.has(id)) { next.delete(id); } else { next.add(id); }
        saveFilter(next);
        setCurrentPage(1);
    };

    const selectAll = () => {
        saveFilter(new Set(machines.map((m: any) => m.id)));
        setCurrentPage(1);
    };

    const deselectAll = () => {
        saveFilter(new Set());
        setCurrentPage(1);
    };

    // ─── Items-per-page save ─────────────────────
    const handleItemsPerPageChange = (n: number) => {
        setItemsPerPage(n);
        localStorage.setItem(itemsPerPageKey, String(n));
        setCurrentPage(1);
    };

    // ─── Type switching ──────────────────────────
    const handleTypeChange = (newType: string) => {
        // Reset filter when type changes
        if (area && type) {
            localStorage.removeItem(filterKey(area, type));
            localStorage.setItem(`overallMachine_lastTypeFor_${area}`, newType);
        }
        setSelectedMachineIds(null);
        setCurrentPage(1);
        router.replace(`/overall_machine_working?area=${area}&type=${newType}&date=${date}`);
    };

    // ─── Area switching ──────────────────────────
    const handleAreaChange = async (newArea: string) => {
        try {
            const res = await axios.get(`${config.apiServer}/api/machine/listTypeWithMachines/${newArea}`);
            const types = res.data?.results || [];
            if (types.length === 0) {
                router.replace(`/overall_machine_working?area=${newArea}&type=&date=${date}`);
                return;
            }
            const storedType = localStorage.getItem(`overallMachine_lastTypeFor_${newArea}`);
            let nextType = types[0].machine_type;
            if (storedType && types.some((t: any) => t.machine_type === storedType)) {
                nextType = storedType;
            }
            router.replace(`/overall_machine_working?area=${newArea}&type=${nextType}&date=${date}`);
        } catch (error) {
            console.error("Error fetching types for new area:", error);
        }
    };

    // ─── Multi-machine Login (SweetAlert2) ───────
    const handleLoginClick = useCallback(async (clickedMachineName: string) => {
        // 1. Fetch all machines in this type that are currently logged out
        let loggedOutMachines: any[] = [];
        try {
            const res = await axios.get(`${config.apiServer}/api/machine/listMachines/${area}/${type}`);
            const allMachines: any[] = res.data?.results || [];
            // Check each machine's operator status
            const checks = await Promise.all(
                allMachines.map(async (m: any) => {
                    try {
                        const r = await axios.get(`${config.apiServer}/api/historyWorking/getOperatorIdWorking/${m.machine_name}`);
                        return { machine: m, hasOperator: !!r.data?.results };
                    } catch {
                        return { machine: m, hasOperator: false };
                    }
                })
            );
            loggedOutMachines = checks.filter(c => !c.hasOperator).map(c => c.machine);
        } catch {
            Swal.fire("Error", "Failed to load machine list.", "error");
            return;
        }

        if (loggedOutMachines.length === 0) {
            Swal.fire("Info", "All machines in this type are currently active.", "info");
            return;
        }

        // 2. Determine auto-selected shift based on hour
        const hour = new Date().getHours();
        const autoShift = (hour >= 7 && hour < 19) ? "M" : "N";
        const todayUtc = new Date().toISOString().split("T")[0];

        // 3. Build SweetAlert2 HTML form
        const machineCheckboxes = loggedOutMachines
            .map(m => `
                <label style="display:flex;align-items:center;gap:8px;margin:4px 0;cursor:pointer;">
                    <input type="checkbox" id="mc_${m.id}" value="${m.machine_name}" class="swal-mc-checkbox"
                        ${m.machine_name === clickedMachineName ? "checked" : ""}
                        style="width:16px;height:16px;cursor:pointer;" />
                    <span style="font-size:0.9rem;font-weight:500;">${m.machine_name}</span>
                </label>
            `).join("");

        const { value: formValues } = await Swal.fire({
            title: "🔑 Login to Machines",
            html: `
                <div style="text-align:left;">
                    <label style="font-weight:600;font-size:0.85rem;color:#555;">Employee ID (Emp No):</label>
                    <input id="swal_emp" class="swal2-input" style="margin:6px 0 12px;font-size:1rem;text-transform:uppercase;" placeholder="Scan or type employee ID...">

                    <label style="font-weight:600;font-size:0.85rem;color:#555;">Shift:</label>
                    <select id="swal_shift" class="swal2-select" style="margin:6px 0 12px;width:100%;">
                        <option value="M" ${autoShift === "M" ? "selected" : ""}>M (Morning)</option>
                        <option value="N" ${autoShift === "N" ? "selected" : ""}>N (Night)</option>
                        <option value="A">A</option>
                        <option value="B">B</option>
                        <option value="C">C</option>
                    </select>

                    <div style="display:flex; justify-content:space-between; align-items:flex-end;">
                        <label style="font-weight:600;font-size:0.85rem;color:#555;margin:0;">Select Machines to Login:</label>
                        <button type="button" id="swal_select_all" class="btn btn-sm btn-outline-primary" style="font-size:0.75rem; padding:2px 8px;">Select All</button>
                    </div>
                    <div style="max-height:160px;overflow-y:auto;border:1px solid #dee2e6;border-radius:6px;padding:8px;margin-top:6px;">
                        ${machineCheckboxes}
                    </div>
                </div>
            `,
            focusConfirm: false,
            showCancelButton: true,
            confirmButtonText: "Login",
            cancelButtonText: "Cancel",
            didOpen: () => {
                const empInput = document.getElementById("swal_emp") as HTMLInputElement;
                if (empInput) {
                    empInput.focus();
                    empInput.addEventListener("input", () => {
                        empInput.value = empInput.value.toUpperCase();
                    });
                    empInput.addEventListener("keydown", (e) => {
                        if (e.key === "Enter") {
                            Swal.clickConfirm();
                        }
                    });
                }

                // --- เพิ่มลอจิก Select All ---
                const selectAllBtn = document.getElementById("swal_select_all");
                const checkboxes = document.querySelectorAll('.swal-mc-checkbox') as NodeListOf<HTMLInputElement>;

                if (selectAllBtn) {
                    selectAllBtn.addEventListener("click", () => {
                        checkboxes.forEach((cb) => cb.checked = true);
                    });
                }

                // --- ป้องกันการ Unselect ทั้งหมด (ต้องเหลืออย่างน้อย 1 เครื่อง) ---
                checkboxes.forEach(cb => {
                    cb.addEventListener("change", (e) => {
                        const target = e.target as HTMLInputElement;
                        const anyChecked = Array.from(checkboxes).some(checkbox => checkbox.checked);
                        if (!anyChecked) {
                            // ถ้าเอาอันสุดท้ายออก ให้ตั้งค่ากลับให้ยังถูกเลือกเหมือนเดิม
                            target.checked = true;
                            // แจ้งเตือนสั้นๆ ให้ผู้ใช้รู้ตัวตัวหนังสือกะพริบจังหวะนึงเป็นสีแดง
                            const label = target.closest('label');
                            if (label) {
                                label.style.color = "#dc3545"; // เด้งเป็นสีแดง 
                                setTimeout(() => { label.style.color = ""; }, 300);
                            }
                        }
                    });
                });
            },
            preConfirm: () => {
                const empNo = (document.getElementById("swal_emp") as HTMLInputElement)?.value?.trim()?.toUpperCase();
                const shift = (document.getElementById("swal_shift") as HTMLSelectElement)?.value;
                const checkedMachines: string[] = [];
                loggedOutMachines.forEach(m => {
                    const cb = document.getElementById(`mc_${m.id}`) as HTMLInputElement;
                    if (cb?.checked) checkedMachines.push(m.machine_name);
                });
                if (!empNo) {
                    Swal.showValidationMessage("Employee ID is required.");
                    return false;
                }
                if (checkedMachines.length === 0) {
                    Swal.showValidationMessage("Please select at least one machine.");
                    return false;
                }
                return { empNo, shift, checkedMachines };
            },
        });

        if (!formValues) return;

        const { empNo, shift, checkedMachines } = formValues as any;

        // 4. Submit login for each machine
        const results = await Promise.allSettled(
            checkedMachines.map((machineName: string) =>
                axios.post(`${config.apiServer}/api/historyWorking/createStartTime`, {
                    machine_name: machineName,
                    emp_no: empNo,
                    date: todayUtc,
                    shift,
                })
            )
        );

        const succeeded = results.filter(r => r.status === "fulfilled").length;
        const failed = results.length - succeeded;

        if (succeeded > 0) {
            // ✅ Record checkout device & page context for each successful login
            checkedMachines.forEach((machineName: string, i: number) => {
                const res = results[i];
                if (res.status === "fulfilled") {
                    const historyWorking = res.value.data?.data || res.value.data?.results;
                    if (historyWorking && historyWorking.id) {
                        localStorage.setItem(`loginSource_h${historyWorking.id}`, "overall_machine_working");
                        localStorage.setItem(`loginMeta_h${historyWorking.id}`, JSON.stringify({
                            machineName: machineName,
                            operatorCode: empNo
                        }));
                    }
                }
            });

            Swal.fire({
                icon: "success",
                title: `Logged in to ${succeeded} machine${succeeded > 1 ? "s" : ""}`,
                text: failed > 0 ? `${failed} machine(s) failed (may already be active).` : undefined,
                timer: 2000,
                showConfirmButton: false,
            });
            // Socket event is already emitted by backend; cards will auto-refresh
        } else {
            Swal.fire("Error", "Login failed for all selected machines. Please check the employee ID.", "error");
        }
    }, [area, type]);

    // ─── Remote Logout (SweetAlert2) ─────────────
    const handleLogoutClick = useCallback(async (machineName: string, historyId: number, operatorCode: string) => {
        // Find all active machines for this operator logged in from this browser
        const activeMachines: { id: number; name: string }[] = [];
        
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith('loginMeta_h')) {
                const idStr = key.replace('loginMeta_h', '');
                try {
                    const meta = JSON.parse(localStorage.getItem(key) || '{}');
                    // Check if it's the exact same operator and logged in from overall_machine_working
                    const source = localStorage.getItem(`loginSource_h${idStr}`);
                    if (meta.operatorCode === operatorCode && source === "overall_machine_working") {
                        activeMachines.push({ id: parseInt(idStr), name: meta.machineName });
                    }
                } catch (e) {}
            }
        }

        // Always include the current machine just in case it's not in localStorage yet
        if (!activeMachines.find(m => m.id === historyId)) {
            activeMachines.push({ id: historyId, name: machineName });
            localStorage.setItem(`loginSource_h${historyId}`, "overall_machine_working");
            localStorage.setItem(`loginMeta_h${historyId}`, JSON.stringify({ machineName, operatorCode }));
        }

        activeMachines.sort((a, b) => a.name.localeCompare(b.name));

        const machineCheckboxes = activeMachines
            .map(m => `
                <label style="display:flex;align-items:center;gap:8px;margin:4px 0;cursor:pointer;">
                    <input type="checkbox" id="logout_mc_${m.id}" value="${m.id}" class="swal-logout-checkbox" checked
                        style="width:16px;height:16px;cursor:pointer;" />
                    <span style="font-size:0.9rem;font-weight:500;">${m.name}</span>
                </label>
            `).join("");

        const { value: selectedIds, isConfirmed } = await Swal.fire({
            title: "🔑 Sign out Machine(s)",
            html: `
                <div style="text-align:left;">
                    <p style="font-size:0.9rem; color:#555; margin-bottom:12px;">Sign out operator <strong>${operatorCode}</strong> from:</p>
                    
                    <div style="display:flex; justify-content:space-between; align-items:flex-end;">
                        <label style="font-weight:600;font-size:0.85rem;color:#555;margin:0;">Select Machines:</label>
                        <button type="button" id="swal_logout_select_all" class="btn btn-sm btn-outline-primary" style="font-size:0.75rem; padding:2px 8px;">Select All</button>
                    </div>
                    <div style="max-height:160px;overflow-y:auto;border:1px solid #dee2e6;border-radius:6px;padding:8px;margin-top:6px;">
                        ${machineCheckboxes}
                    </div>
                </div>
            `,
            focusConfirm: false,
            showCancelButton: true,
            confirmButtonColor: "#d33",
            confirmButtonText: "Logout",
            cancelButtonText: "Cancel",
            didOpen: () => {
                const selectAllBtn = document.getElementById("swal_logout_select_all");
                const checkboxes = document.querySelectorAll(".swal-logout-checkbox") as NodeListOf<HTMLInputElement>;
                
                if (selectAllBtn) {
                    selectAllBtn.addEventListener("click", () => {
                        checkboxes.forEach(cb => cb.checked = true);
                    });
                }
                
                checkboxes.forEach(cb => {
                    cb.addEventListener("change", (e: any) => {
                        const anyChecked = Array.from(checkboxes).some(c => c.checked);
                        if (!anyChecked) {
                            e.target.checked = true;
                        }
                    });
                });
            },
            preConfirm: () => {
                const checkedIds: number[] = [];
                activeMachines.forEach(m => {
                    const cb = document.getElementById(`logout_mc_${m.id}`) as HTMLInputElement;
                    if (cb?.checked) checkedIds.push(m.id);
                });
                if (checkedIds.length === 0) {
                    Swal.showValidationMessage("Please select at least one machine to logout.");
                    return false;
                }
                return checkedIds;
            }
        });

        if (isConfirmed && selectedIds && selectedIds.length > 0) {
            try {
                const results = await Promise.allSettled(
                    selectedIds.map((id: number) => axios.put(`${config.apiServer}/api/historyWorking/updateEndTime/${id}`))
                );

                let succeededCount = 0;
                results.forEach((r, idx) => {
                    if (r.status === "fulfilled") {
                        succeededCount++;
                        const idStr = selectedIds[idx];
                        localStorage.removeItem(`loginSource_h${idStr}`);
                        localStorage.removeItem(`loginMeta_h${idStr}`);
                    }
                });

                if (succeededCount > 0) {
                    Swal.fire({
                        icon: "success",
                        title: "Logged out",
                        text: `Successfully signed out from ${succeededCount} machine(s).`,
                        timer: 2000,
                        showConfirmButton: false
                    });
                } else {
                    Swal.fire("Error", "Failed to logout from selected machines.", "error");
                }
            } catch (e: any) {
                Swal.fire("Error", e.message || "Failed to process logout.", "error");
            }
        }
    }, []);

    // ─── Reset page on type/area change ─────────
    useEffect(() => { setCurrentPage(1); }, [type, area]);

    // ─── Clamp page if machines shrink ──────────
    useEffect(() => {
        if (currentPage > totalPages) setCurrentPage(totalPages);
    }, [totalPages, currentPage]);

    // ─── Grid layout (Feature 5) ─────────────────
    // Strategy: use 2x2 grid for 1–4 cards, 3x2 for 5–6.
    // For counts that don't fill a row, leave the remaining cells empty.
    // This preserves the card aspect ratio as if viewing the same number
    // of slots on screen at all times per grid size.
    const viewCount = displayedMachines.length;

    let cols = 1;
    let rows = 1;
    if (viewCount <= 1) { cols = 1; rows = 1; }
    else if (viewCount <= 4) { cols = 2; rows = 2; }   // 2,3,4 → 2x2 grid, empty slots kept
    else { cols = 3; rows = 2; }                        // 5,6   → 3x2 grid, empty slot kept

    const scaleFactor = viewCount === 1 ? 1.0 : viewCount <= 4 ? 0.85 : 0.72;

    const gridStyle = {
        "--grid-cols": cols,
        "--grid-rows": rows,
    } as React.CSSProperties;

    return (
        <div className="container-fluid p-2 d-flex flex-column dashboard-container" style={{ backgroundColor: "#f4f6f9" }}>
            {/* ── Top Bar ── */}
            <div className="d-flex align-items-center justify-content-between mb-2 flex-wrap gap-2" style={{ minHeight: "50px", flexShrink: 0 }}>
                {/* Left: Title with Type Dropdown */}
                <div className="d-flex align-items-center gap-2">
                    {/* ✅ Moved Area to Top Left */}
                    <h4 className="fw-bold text-dark m-0 d-flex align-items-center">Area:</h4>
                    {availableAreas.length > 1 ? (
                        <div className="d-flex align-items-center me-2">
                            <select
                                className="form-select form-select-sm fw-bold text-primary border-primary"
                                style={{ width: "auto", minWidth: "100px" }}
                                value={area || ""}
                                onChange={(e) => handleAreaChange(e.target.value)}
                            >
                                {availableAreas.map(a => (
                                    <option key={a} value={a}>{a}</option>
                                ))}
                            </select>
                        </div>
                    ) : (
                        <span className="text-primary fw-bold fs-5 me-2 d-flex align-items-center">{area}</span>
                    )}
                    
                    <h4 className="fw-bold text-dark m-0 d-flex align-items-center">Machine Type:</h4>
                    {availableTypes.length > 1 ? (
                        <div className="d-flex align-items-center">
                            <select
                                className="form-select form-select-sm fw-bold text-primary border-primary"
                                style={{ width: "auto", minWidth: "100px" }}
                                value={type || ""}
                                onChange={(e) => handleTypeChange(e.target.value)}
                            >
                                {availableTypes.map(t => (
                                    <option key={t.type} value={t.type}>{t.type} {t.fullName ? `- ${t.fullName}` : ''}</option>
                                ))}
                            </select>
                        </div>
                    ) : (
                        <span className="text-primary fw-bold fs-5 d-flex align-items-center">
                            {type} {availableTypes.length === 1 && availableTypes[0].fullName ? `- ${availableTypes[0].fullName}` : ''}
                        </span>
                    )}
                </div>

                {/* Right: Controls */}
                <div className="fs-6 text-muted d-flex align-items-center gap-2 flex-wrap">
                    {/* Date */}
                    <div className="d-flex align-items-center gap-1">
                        <span className="fw-bold">Date:</span>
                        <input
                            type="date"
                            className="form-control form-control-sm border-primary fw-bold text-primary"
                            style={{ width: "140px" }}
                            value={date || ""}
                            onChange={(e) => {
                                if (e.target.value) {
                                    router.replace(`/overall_machine_working?area=${area}&type=${type}&date=${e.target.value}`);
                                }
                            }}
                        />
                    </div>

                    {/* Area moved from here */}

                    {/* Filter Machines Dropdown */}
                    <div className="position-relative" ref={filterDropdownRef}>
                        <button
                            className="btn btn-sm btn-outline-secondary fw-bold"
                            onClick={() => setShowFilterDropdown(v => !v)}
                        >
                            <i className="fas fa-filter me-1"></i>
                            Machines ({selectedMachineIds ? selectedMachineIds.size : machines.length}/{machines.length})
                        </button>
                        {showFilterDropdown && (
                            <div
                                className="position-absolute bg-white border rounded shadow"
                                style={{ zIndex: 1000, top: "calc(100% + 4px)", right: 0, minWidth: "220px", maxHeight: "300px", overflowY: "auto", padding: "8px" }}
                            >
                                <div className="d-flex gap-2 mb-2">
                                    <button className="btn btn-xs btn-outline-primary flex-fill" style={{ fontSize: "0.75rem" }} onClick={selectAll}>All</button>
                                    <button className="btn btn-xs btn-outline-secondary flex-fill" style={{ fontSize: "0.75rem" }} onClick={deselectAll}>None</button>
                                </div>
                                {machines.map((m: any) => (
                                    <label key={m.id} className="d-flex align-items-center gap-2 py-1" style={{ cursor: "pointer", fontSize: "0.85rem" }}>
                                        <input
                                            type="checkbox"
                                            checked={selectedMachineIds?.has(m.id) ?? true}
                                            onChange={() => toggleMachine(m.id)}
                                        />
                                        <span className="fw-semibold">{m.machine_name}</span>
                                    </label>
                                ))}
                            </div>
                        )}
                    </div>

                    {/* View toggle */}
                    <div className="btn-group btn-group-sm" role="group">
                        <button
                            className={`btn ${activeView === "output" ? "btn-primary" : "btn-outline-primary"} fw-bold px-3`}
                            onClick={() => setActiveView("output")}
                        >
                            <i className="fas fa-chart-bar me-1"></i>Output
                        </button>
                        <button
                            className={`btn ${activeView === "status" ? "btn-primary" : "btn-outline-primary"} fw-bold px-3`}
                            onClick={() => setActiveView("status")}
                        >
                            <i className="fas fa-cogs me-1"></i>MC Status
                        </button>
                    </div>

                    {activeView === "status" ? (
                        <span className="badge bg-warning text-dark">
                            <i className="fas fa-sync-alt me-1"></i>{formatCountdown(countdown)}
                        </span>
                    ) : (
                        <span className="badge bg-success">📡 Real-time</span>
                    )}

                    {serverTimeStr && <span className="badge bg-info text-dark">{serverTimeStr}</span>}

                    <button
                        className="btn btn-sm btn-outline-secondary"
                        onClick={() => {
                            localStorage.removeItem("overallMachineActiveView");
                            router.back();
                        }}
                    >
                        <i className="fas fa-arrow-left me-2"></i>Back
                    </button>
                </div>
            </div>

            {/* ── Main Grid ── */}
            {loading ? (
                <div className="d-flex justify-content-center flex-grow-1 h-100" style={{ minHeight: "400px" }}>
                    <LoadingSpinner />
                </div>
            ) : (
                <>
                    <div className="dashboard-grid" style={gridStyle}>
                        {/* Render actual cards */}
                        {displayedMachines.map((machine) => (
                            <div key={machine.id} className="h-100 d-flex flex-column dashboard-grid-item">
                                <OverallMachineCard
                                    machineName={machine.machine_name}
                                    date={date || ""}
                                    refreshTrigger={refreshTrigger}
                                    realtimeData={realtimeData?.machines ? realtimeData.machines[machine.machine_name] : null}
                                    activeView={activeView}
                                    mcStatusRefreshTrigger={mcStatusRefreshTrigger}
                                    scaleFactor={scaleFactor}
                                    onLoginClick={handleLoginClick}
                                    onLogoutClick={handleLogoutClick}
                                    isSingleView={displayedMachines.length === 1}
                                />
                            </div>
                        ))}
                        {/* Empty placeholder cells to maintain grid aspect ratio */}
                        {Array.from({ length: cols * rows - displayedMachines.length }).map((_, i) => (
                            <div key={`empty-${i}`} className="empty-placeholder dashboard-grid-item" style={{ backgroundColor: "transparent" }} />
                        ))}
                        {/* No machines message */}
                        {filteredMachines.length === 0 && (
                            <div className="d-flex justify-content-center align-items-center w-100 h-100" style={{ gridColumn: `1 / -1` }}>
                                <h4 className="text-muted">No machines selected. Use the Filter button to select machines.</h4>
                            </div>
                        )}
                    </div>

                    {/* ── Bottom Bar: Pagination + Items/page ── */}
                    <div className="d-flex justify-content-center align-items-center gap-3 py-1" style={{ flexShrink: 0 }}>
                        {totalPages > 1 && (
                            <>
                                <button
                                    className="btn btn-sm btn-outline-primary fw-bold px-3"
                                    disabled={currentPage === 1}
                                    onClick={() => setCurrentPage(p => p - 1)}
                                >
                                    <i className="fas fa-chevron-left me-1"></i>Prev
                                </button>
                                <span className="fw-bold text-secondary" style={{ fontSize: "0.85rem" }}>
                                    Page {currentPage} / {totalPages}
                                    <span className="text-muted ms-2">({filteredMachines.length} machines)</span>
                                </span>
                                <button
                                    className="btn btn-sm btn-outline-primary fw-bold px-3"
                                    disabled={currentPage === totalPages}
                                    onClick={() => setCurrentPage(p => p + 1)}
                                >
                                    Next <i className="fas fa-chevron-right ms-1"></i>
                                </button>
                            </>
                        )}

                        {/* Show N per page */}
                        <div className="d-flex align-items-center gap-1 ms-2" style={{ fontSize: "0.8rem" }}>
                            <span className="text-muted fw-semibold">Show:</span>
                            <select
                                className="form-select form-select-sm"
                                style={{ width: "65px" }}
                                value={itemsPerPage}
                                onChange={(e) => handleItemsPerPageChange(Number(e.target.value))}
                            >
                                {[1, 2, 3, 4, 5, 6].map(n => (
                                    <option key={n} value={n}>{n}</option>
                                ))}
                            </select>
                            <span className="text-muted">/ page</span>
                        </div>
                    </div>
                </>
            )}

            <style jsx>{`
                .dashboard-container { 
                    height: 100vh; 
                    overflow: hidden; 
                }
                .dashboard-grid {
                    display: grid;
                    grid-template-columns: repeat(var(--grid-cols, 1), 1fr);
                    grid-template-rows: repeat(var(--grid-rows, 1), 1fr);
                    gap: 8px;
                    flex: 1;
                    min-height: 0;
                }
                .dashboard-grid > div {
                    min-width: 0;
                    min-height: 0;
                }
                @media (max-width: 991px) {
                    .dashboard-container {
                        height: auto !important;
                        min-height: 100vh;
                        overflow-y: auto !important;
                    }
                    .dashboard-grid {
                        display: flex;
                        flex-direction: column;
                    }
                    .dashboard-grid > div {
                        min-height: 500px !important;
                        height: 500px;
                    }
                    .empty-placeholder {
                        display: none;
                    }
                }
            `}</style>
        </div>
    );
}

export default function OverallMachineWorkingPage() {
    return (
        <Suspense fallback={<LoadingSpinner message="Loading..." />}>
            <OverallMachineContent />
        </Suspense>
    );
}
