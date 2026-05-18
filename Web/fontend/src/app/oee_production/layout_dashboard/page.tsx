'use client';

import { useState, useEffect } from 'react';
import axios from 'axios';
import { useRouter } from 'next/navigation';
import config from '@/app/config';
import { getSocket } from '@/app/lib/socketManager';
import { fetchMachineStatusConfig, StatusDefinition } from '@/app/lib/machineStatusConfig';

const apiServer = config.apiServer;



// Unified Grid: 21 columns × (1 header row + 15 machine rows = 16 rows)
const UNIFIED_COLS = 21;
const UNIFIED_MACHINE_ROWS = 15;

// Area Layout — กำหนด offset ของแต่ละ Area ใน unified grid (1-indexed)
// Row 1 = auto-height header row, Rows 2-16 = equal machine rows
const AREA_LAYOUT: { [area: string]: { colStart: number; colEnd: number; rowStart: number; rowEnd: number; title: string; labelRow: number; labelAlign: 'start' | 'end' } } = {
    DLC: { colStart: 1, colEnd: 4, rowStart: 1, rowEnd: 10, title: 'DLC Area', labelRow: 1, labelAlign: 'start' },
    ECM: { colStart: 4, colEnd: 7, rowStart: 1, rowEnd: 10, title: 'ECM Area', labelRow: 1, labelAlign: 'start' },
    CLASS1000: { colStart: 1, colEnd: 7, rowStart: 11, rowEnd: 16, title: 'Class 1000 Area', labelRow: 10, labelAlign: 'end' },
    CLASS100: { colStart: 7, colEnd: 22, rowStart: 1, rowEnd: 17, title: 'Class 100 Area', labelRow: 1, labelAlign: 'start' },
};

// Offset mapping: machine local (row,col) → unified grid (gridRow, gridCol)
// Row 1 is header, DLC/ECM/CLASS100 machines start at row 2, CLASS1000 at row 11 (gap at row 10)
const AREA_OFFSET: { [area: string]: { colOffset: number; rowOffset: number } } = {
    DLC: { colOffset: 1, rowOffset: 2 },
    ECM: { colOffset: 4, rowOffset: 2 },
    CLASS1000: { colOffset: 1, rowOffset: 11 },
    CLASS100: { colOffset: 7, rowOffset: 2 },
};

// ฟังก์ชันคำนวณธีมสีพื้นหลังของแต่ละโซน
const getAreaTheme = (areaKey: string) => {
    if (areaKey === 'DLC') return { headerBg: '#0284c7', bodyBg: '#f0f9ff', textColor: '#ffffff', borderColor: '#bae6fd' };
    if (areaKey === 'ECM') return { headerBg: '#9333ea', bodyBg: '#faf5ff', textColor: '#ffffff', borderColor: '#e9d5ff' };
    if (areaKey === 'CLASS1000') return { headerBg: '#ea580c', bodyBg: '#fff7ed', textColor: '#ffffff', borderColor: '#fed7aa' };
    if (areaKey === 'CLASS100') return { headerBg: '#0d9488', bodyBg: '#f0fdfa', textColor: '#ffffff', borderColor: '#99f6e4' };
    return { headerBg: '#475569', bodyBg: '#f1f5f9', textColor: '#ffffff', borderColor: '#e2e8f0' };
};

// Machine Position Map - กำหนดตำแหน่งเครื่องในแต่ละ Area (ชื่อตรงกับ database)
// Format: { [machineName]: { row: number, col: number } }
const MACHINE_POSITIONS: { [area: string]: { [machineName: string]: { row: number; col: number } } } = {
    DLC: {
        'Chydos1': { row: 0, col: 0 }, 'DLC-002': { row: 0, col: 1 }, 'DLC-009': { row: 0, col: 2 },
        'Chydos2': { row: 1, col: 0 }, 'DLC-003': { row: 1, col: 1 }, 'DLC-010': { row: 1, col: 2 },
        'DLC-004': { row: 2, col: 1 }, 'DLC-011': { row: 2, col: 2 },
        'DLC-005': { row: 3, col: 1 }, 'DLC-012': { row: 3, col: 2 },
        'DLC-006': { row: 4, col: 1 },
        'DLC-007': { row: 5, col: 1 },
        'DLC-008': { row: 6, col: 1 },
    },
    ECM: {
        'ACR-001': { row: 0, col: 0 }, 'AHV-001': { row: 0, col: 1 }, 'AQS-009': { row: 0, col: 2 },
        'ACR-002': { row: 1, col: 0 }, 'AHV-002': { row: 1, col: 1 },
        'ACR-003': { row: 2, col: 0 }, 'AHV-003': { row: 2, col: 1 }, 'AVE-001': { row: 2, col: 2 },
        'ACR-004': { row: 3, col: 0 }, 'AHV-004': { row: 3, col: 1 },
        'ACR-005': { row: 4, col: 0 }, 'AHV-005': { row: 4, col: 1 }, 'WTM-001': { row: 4, col: 2 },
        'ACR-006': { row: 5, col: 0 }, 'AHV-006': { row: 5, col: 1 }, 'WTM-002': { row: 5, col: 2 },
    },
    CLASS1000: {
        'ACI-001': { row: 0, col: 0 }, 'ASI-001': { row: 0, col: 1 }, 'LSM-003': { row: 0, col: 2 }, 'WSM-001': { row: 0, col: 3 }, 'VCM-001': { row: 0, col: 4 },
        'ACI-002': { row: 1, col: 0 }, 'ASI-002': { row: 1, col: 1 }, 'LSM-004': { row: 1, col: 2 }, 'WSM-002': { row: 1, col: 3 }, 'VCM-002': { row: 1, col: 4 },
        'ACI-003': { row: 2, col: 0 }, 'ASI-003': { row: 2, col: 1 }, 'LSM-006': { row: 2, col: 2 },
    },
    CLASS100: {
        // Col 0
        'ABR-001': { row: 0, col: 0 }, 'ABR-002': { row: 1, col: 0 }, 'ABR-003': { row: 2, col: 0 }, 'ABR-004': { row: 3, col: 0 }, 'ABR-005': { row: 4, col: 0 }, 'ABR-006': { row: 5, col: 0 },

        // Col 1
        'ACP-002': { row: 0, col: 1 }, 'ACP-003': { row: 1, col: 1 }, 'ACP-004': { row: 2, col: 1 }, 'ACP-005': { row: 3, col: 1 }, 'ACP-006': { row: 4, col: 1 }, 'ACP-007': { row: 5, col: 1 },
        'ACP-008': { row: 6, col: 1 }, 'ACP-009': { row: 7, col: 1 }, 'ACP-011': { row: 8, col: 1 }, 'ACP-012': { row: 9, col: 1 },
        'AFU-002': { row: 12, col: 1 }, 'AFU-003': { row: 13, col: 1 }, 'AFU-004': { row: 14, col: 1 },

        // Col 2
        'AIU-001': { row: 0, col: 2 }, 'AIU-002': { row: 1, col: 2 },
        'AOC-001': { row: 8, col: 2 }, 'AOC-002': { row: 9, col: 2 }, 'AOC-003': { row: 10, col: 2 }, 'AOC-004': { row: 11, col: 2 },
        'AOC-005': { row: 12, col: 2 }, 'AOC-006': { row: 13, col: 2 }, 'AOC-007': { row: 14, col: 2 },

        // Col 3
        'ARA-001': { row: 0, col: 3 }, 'ARA-002': { row: 1, col: 3 },
        'ART-004': { row: 2, col: 3 }, 'ART-006': { row: 3, col: 3 }, 'ART-009': { row: 4, col: 3 }, 'ART-010': { row: 5, col: 3 }, 'ART-011': { row: 6, col: 3 },
        'ART-013': { row: 7, col: 3 }, 'ART-015': { row: 8, col: 3 }, 'ART-016': { row: 9, col: 3 }, 'ART-018': { row: 10, col: 3 }, 'ART-019': { row: 11, col: 3 }, 'ART-021': { row: 12, col: 3 },

        // Col 4
        'ATX-001': { row: 0, col: 4 }, 'ATX-002': { row: 1, col: 4 }, 'ATX-003': { row: 2, col: 4 }, 'ATX-004': { row: 3, col: 4 },
        'FSPZ': { row: 14, col: 4 },

        // Col 5
        'GE2-001': { row: 0, col: 5 }, 'GE2-002': { row: 1, col: 5 }, 'GE2-003': { row: 2, col: 5 }, 'GE2-004': { row: 3, col: 5 }, 'GE2-005': { row: 4, col: 5 },
        'GE2-006': { row: 5, col: 5 }, 'GE2-007': { row: 6, col: 5 }, 'GE2-008': { row: 7, col: 5 }, 'GE2-009': { row: 8, col: 5 }, 'GE2-010': { row: 9, col: 5 },
        'GE2-011': { row: 10, col: 5 }, 'GE2-012': { row: 11, col: 5 }, 'GE2-013': { row: 12, col: 5 }, 'GE2-014': { row: 13, col: 5 }, 'GE2-015': { row: 14, col: 5 },

        // Col 6
        'GE2-016': { row: 0, col: 6 }, 'GE2-017': { row: 1, col: 6 }, 'GE2-018': { row: 2, col: 6 }, 'GE2-019': { row: 3, col: 6 }, 'GE2-020': { row: 4, col: 6 },
        'GE2-021': { row: 5, col: 6 }, 'GE2-022': { row: 6, col: 6 }, 'GE2-033': { row: 7, col: 6 }, 'GE2-034': { row: 8, col: 6 }, 'GE2-035': { row: 9, col: 6 },
        'GE2-036': { row: 10, col: 6 }, 'GE2-038': { row: 11, col: 6 }, 'GE2-039': { row: 12, col: 6 }, 'GE2-040': { row: 13, col: 6 },

        // Col 7
        'GE3-001': { row: 0, col: 7 }, 'GE3-003': { row: 1, col: 7 }, 'GE3-007': { row: 2, col: 7 }, 'GE3-008': { row: 3, col: 7 }, 'GE3-009': { row: 4, col: 7 }, 'GE3-010': { row: 5, col: 7 },

        // Col 8
        'HEL-001': { row: 0, col: 8 }, 'HEL-002': { row: 1, col: 8 }, 'HEL-003': { row: 2, col: 8 }, 'HEL-004': { row: 3, col: 8 }, 'HEL-005': { row: 4, col: 8 },
        'HEL-006': { row: 5, col: 8 }, 'HEL-007': { row: 6, col: 8 }, 'HEL-017': { row: 7, col: 8 }, 'HEL-018': { row: 8, col: 8 }, 'HEL-026': { row: 9, col: 8 },
        'HEL-028': { row: 10, col: 8 }, 'HEL-030': { row: 11, col: 8 }, 'HEL-032': { row: 12, col: 8 }, 'HEL-033': { row: 13, col: 8 }, 'HEL-036': { row: 14, col: 8 },

        // Col 9
        'HEL-040': { row: 0, col: 9 }, 'HEL-041': { row: 1, col: 9 }, 'HEL-043': { row: 2, col: 9 }, 'HEL-044': { row: 3, col: 9 }, 'HEL-046': { row: 4, col: 9 },
        'HEL-047': { row: 5, col: 9 }, 'HEL-048': { row: 6, col: 9 }, 'HEL-049': { row: 7, col: 9 }, 'HEL-050': { row: 8, col: 9 }, 'HEL-051': { row: 9, col: 9 },
        'HEL-052': { row: 10, col: 9 }, 'HEL-053': { row: 11, col: 9 }, 'HEL-055': { row: 12, col: 9 }, 'HEL-056': { row: 13, col: 9 }, 'HEL-057': { row: 14, col: 9 },

        // Col 10
        'LSM-001': { row: 0, col: 10 }, 'LSM-002': { row: 1, col: 10 }, 'LSM-005': { row: 2, col: 10 },

        // Col 11
        'LSW-001': { row: 0, col: 11 }, 'LSW-002': { row: 1, col: 11 }, 'LSW-003': { row: 2, col: 11 }, 'LSW-004': { row: 3, col: 11 }, 'LSW-005': { row: 4, col: 11 },
        'LSW-006': { row: 5, col: 11 }, 'LSW-009': { row: 6, col: 11 }, 'LSW-017': { row: 7, col: 11 }, 'LSW-019': { row: 8, col: 11 }, 'LSW-021': { row: 9, col: 11 },
        'LSW-024': { row: 10, col: 11 }, 'LSW-025': { row: 11, col: 11 }, 'LSW-026': { row: 12, col: 11 }, 'LSW-027': { row: 13, col: 11 },

        // Col 12
        'LSW-028': { row: 0, col: 12 }, 'LSW-029': { row: 1, col: 12 }, 'LSW-030': { row: 2, col: 12 }, 'LSW-031': { row: 3, col: 12 }, 'LSW-032': { row: 4, col: 12 },
        'LSW-033': { row: 5, col: 12 }, 'LSW-034': { row: 6, col: 12 }, 'LSW-035': { row: 7, col: 12 },

        // Col 13
        'VNS-001': { row: 0, col: 13 }, 'VNS-002': { row: 1, col: 13 }, 'VNS-003': { row: 2, col: 13 }, 'VNS-004': { row: 3, col: 13 }, 'VNS-005': { row: 4, col: 13 },
        'VNS-006': { row: 5, col: 13 }, 'VNS-007': { row: 6, col: 13 }, 'VNS-008': { row: 7, col: 13 }, 'VNS-009': { row: 8, col: 13 }, 'VNS-010': { row: 9, col: 13 },
        'VNS-011': { row: 10, col: 13 }, 'VNS-012': { row: 11, col: 13 }, 'VNS-013': { row: 12, col: 13 }, 'VNS-014': { row: 13, col: 13 }, 'VNS-015': { row: 14, col: 13 },

        // Col 14
        'VNS-016': { row: 0, col: 14 }, 'VNS-017': { row: 1, col: 14 }, 'VNS-018': { row: 2, col: 14 }, 'VNS-019': { row: 3, col: 14 }, 'VNS-020': { row: 4, col: 14 },
        'VNS-021': { row: 5, col: 14 }, 'VNS-022': { row: 6, col: 14 }, 'VNS-023': { row: 7, col: 14 }, 'VNS-024': { row: 8, col: 14 }, 'VNS-025': { row: 9, col: 14 },
        'VNS-026': { row: 10, col: 14 },
    }
};

interface MachineData {
    id: number;
    area: string;
    type: string;
    name: string;
    model: string;
    process: string;
    output: number | string;
    availability: number | string;  // Phase 10: เปลี่ยนจาก efficiency → availability (Backend Phase 9)
    cycleTime: number | string;
    performance?: number;
}

interface StatusVisual {
    bodyColor: string;
    borderColor: string;
    headerColor: string;
}

const hexToRgba = (hex: string, alpha: number) => {
    const clean = hex.replace('#', '');
    if (clean.length !== 6) return hex;
    const r = parseInt(clean.slice(0, 2), 16);
    const g = parseInt(clean.slice(2, 4), 16);
    const b = parseInt(clean.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

const getDefaultStatusVisual = (status?: string): StatusVisual => {
    if (status === 'Plan_Stop' || status === 'Break_Time') {
        return { bodyColor: '#d5d5d5', borderColor: '#424242', headerColor: '#424242' };
    }
    if (status === 'Run_Time') {
        return { bodyColor: '#e8f5e9', borderColor: '#2e7d32', headerColor: '#2e7d32' };
    }
    if (status) {
        return { bodyColor: '#ffebee', borderColor: '#c62828', headerColor: '#c62828' };
    }
    return { bodyColor: '#f5f5f5', borderColor: '#9e9e9e', headerColor: '#bdbdbd' };
};

export default function LayoutDashboard() {
    const router = useRouter();
    const [activeButton, setActiveButton] = useState<string>('OUTPUT');
    const [isMobile, setIsMobile] = useState(false);
    const [machinesData, setMachinesData] = useState<MachineData[]>([]);
    const [selectedMachine, setSelectedMachine] = useState<MachineData | null>(null);
    const [showPopup, setShowPopup] = useState(false);
    const [popoverPosition, setPopoverPosition] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
    const [serverTimeStr, setServerTimeStr] = useState('');
    const [machineStatuses, setMachineStatuses] = useState<Record<string, string>>({});
    const [machineAlarms, setMachineAlarms] = useState<Record<string, string>>({});
    const [statusConfigByType, setStatusConfigByType] = useState<Record<string, Record<string, StatusDefinition>>>({});
    const [countdown, setCountdown] = useState<number>(300); // 5 minutes refresh

    useEffect(() => {
        const checkMobile = () => setIsMobile(window.innerWidth < 768);
        checkMobile();
        window.addEventListener('resize', checkMobile);
        return () => window.removeEventListener('resize', checkMobile);
    }, []);

    useEffect(() => {
        let alive = true;
        fetchMachineStatusConfig().then((sysConfig) => {
            if (!alive || !sysConfig) return;

            const buildMap = (statuses: StatusDefinition[] = []) => {
                const map: Record<string, StatusDefinition> = {};
                for (const status of statuses) map[status.key] = status;
                return map;
            };

            const next: Record<string, Record<string, StatusDefinition>> = {
                default: buildMap(sysConfig.default?.statuses || []),
            };

            for (const [type, typeConfig] of Object.entries(sysConfig.machineTypes || {})) {
                next[type] = buildMap((typeConfig as { statuses?: StatusDefinition[] }).statuses || []);
            }

            setStatusConfigByType(next);
        });

        return () => {
            alive = false;
        };
    }, []);

    // ฟังก์ชันดึงข้อมูลเครื่องจักร
    const fetchMachines = async () => {
        try {
            const res = await axios.get(`${apiServer}/api/machine/getMachinesWithTodayData`);
            setMachinesData(res.data.results || []);
        } catch (error) {
            console.error('Error fetching machines:', error);
        }
    };

    // ดึงข้อมูลเครื่องจักรครั้งแรก + Socket.IO connection
    useEffect(() => {
        fetchMachines();

        // Socket.IO connection
        const socket = getSocket();

        // 🏠 Join dashboard room (ดูทุกเครื่อง)
        socket.emit("joinRoom", "dashboard");

        // Server time
        socket.on('server_time', (isoStr: string) => {
            const serverTime = new Date(isoStr);
            setServerTimeStr(serverTime.toLocaleTimeString('en-GB', { hour12: false, timeZone: 'Asia/Bangkok' }));
        });

        // Fast production update ทุก 2 วินาที — Output, Eff, CT
        // ✅ Fix #5: Delta merge — only update machines included in payload
        socket.on('realtime_output', (data: any) => {
            const socketMachines = data?.machines;
            if (!socketMachines) return;

            setMachinesData(prev => {
                if (prev.length === 0) return prev;
                return prev.map(machine => {
                    const rt = socketMachines[machine.name];
                    if (!rt || !rt.daily) return machine; // Not in delta → keep as-is
                    return {
                        ...machine,
                        output: rt.daily.totalOutput ?? machine.output,
                        // Phase 10: ใช้ daily.availability จาก fast loop (realtimeService Phase 7 ส่งมาใน daily payload)
                        // fallback ไป overallEfficiency ถ้ายังไม่มี availability
                        availability: rt.daily.availability ?? rt.daily.overallEfficiency ?? machine.availability,
                        cycleTime: rt.daily.avgCycleTime ?? machine.cycleTime,
                    };
                });
            });

            // ✅ Update machine statuses dynamically from fast loop payload
            setMachineStatuses(prev => {
                let changed = false;
                const newStatuses = { ...prev };
                for (const key in socketMachines) {
                    const rt = socketMachines[key];
                    if (rt && rt.currentHour && rt.currentHour.live_status) {
                        const newStatus = rt.currentHour.live_status;
                        if (newStatuses[key] !== newStatus) {
                            newStatuses[key] = newStatus;
                            changed = true;
                        }
                    }
                }
                return changed ? newStatuses : prev;
            });

            // ✅ Update machine alarms dynamically
            setMachineAlarms(prev => {
                let changed = false;
                const newAlarms = { ...prev };
                for (const key in socketMachines) {
                    const rt = socketMachines[key];
                    if (rt && rt.currentHour) {
                        const newAlarm = rt.currentHour.live_alarm || "";
                        if ((newAlarms[key] || "") !== newAlarm) {
                            if (newAlarm) {
                                newAlarms[key] = newAlarm;
                            } else {
                                delete newAlarms[key];
                            }
                            changed = true;
                        }
                    }
                }
                return changed ? newAlarms : prev;
            });
        });

        // Slow status update ทุก 5 นาที — Availability, Performance (จาก MCStatus)
        socket.on('realtime_update', (data: any) => {
            const socketMachines = data?.machines;
            if (!socketMachines) return;

            setMachinesData(prev => {
                if (prev.length === 0) return prev;
                return prev.map(machine => {
                    const rt = socketMachines[machine.name];
                    if (!rt || !rt.daily) return machine;
                    return {
                        ...machine,
                        availability: rt.daily.availability ?? machine.availability,
                        performance: rt.daily.performance ?? machine.performance,
                    };
                });
            });
        });

        return () => {
            socket.emit("leaveRoom", "dashboard");
            socket.off('server_time');
            socket.off('realtime_update');
            socket.off('realtime_output');
        };
    }, []);

    // Fetch MC Status for all machines & poll every 5 minutes
    useEffect(() => {
        const fetchMcStatuses = async () => {
            try {
                const res = await axios.get(`${apiServer}/api/mcstatus/latest-all`);
                setMachineStatuses(res.data.results || {});
                setCountdown(300); // Reset timer after fetch
            } catch (e) {
                console.error('Error fetching MC statuses:', e);
            }
        };
        fetchMcStatuses();

        const fetchInterval = setInterval(fetchMcStatuses, 5 * 60 * 1000);
        const tickInterval = setInterval(() => {
            setCountdown(prev => prev > 0 ? prev - 1 : 0);
        }, 1000);

        return () => {
            clearInterval(fetchInterval);
            clearInterval(tickInterval);
        };
    }, []);



    // หาข้อมูลเครื่องจักรตาม name และ area
    const getMachineByPosition = (area: string, row: number, col: number): MachineData | undefined => {
        const positions = MACHINE_POSITIONS[area];
        if (!positions) return undefined;

        const machineName = Object.keys(positions).find(name => {
            const pos = positions[name];
            return pos.row === row && pos.col === col;
        });

        if (!machineName) return undefined;
        return machinesData.find(m => m.name === machineName);
    };
    const LegendBox = ({ headerColor, bodyColor, label, borderColor }: { headerColor: string, bodyColor: string, label: string, borderColor?: string }) => (
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
            <div style={{
                width: '14px', height: '14px',
                border: `1px solid ${borderColor || headerColor}`,
                borderRadius: '2px',
                display: 'flex', flexDirection: 'column', overflow: 'hidden'
            }}>
                <div style={{ flex: '0 0 50%', backgroundColor: headerColor }}></div>
                <div style={{ flex: '1', backgroundColor: bodyColor }}></div>
            </div>
            <span style={{ fontSize: '0.75rem', fontWeight: 500 }}>{label}</span>
        </div>
    );

    // Machine Card Component - แสดงในช่อง grid ขนาดเล็ก
    const MachineCard = ({ machine }: { machine: MachineData }) => {
        const status = machineStatuses[machine.name];
        const statusMap = statusConfigByType[machine.type] || statusConfigByType.default || {};
        const statusInfo = status ? statusMap[status] : undefined;
        const statusVisual = statusInfo
            ? {
                bodyColor: hexToRgba(statusInfo.color, statusInfo.group === 'running' ? 0.12 : 0.16),
                borderColor: statusInfo.color,
                headerColor: statusInfo.color,
            }
            : getDefaultStatusVisual(status);

        const getValue = () => {
            switch (activeButton) {
                case 'OUTPUT': return machine.output !== '--' ? `${machine.output} pcs` : '--';
                // Phase 10: เปลี่ยนจาก EFFICIENCY → AVAILABILITY และ machine.efficiency → machine.availability
                case 'AVAILABILITY': return machine.availability !== '--' ? `${(machine.availability as number).toFixed(2)} %` : '--';
                case 'CYCLE_TIME': return machine.cycleTime !== '--' ? `${(machine.cycleTime as number).toFixed(2)} s` : '--';
                default: return '--';
            }
        };

        return (
            <div
                onClick={(e) => {
                    setSelectedMachine(machine);
                    setPopoverPosition({ x: e.clientX, y: e.clientY });
                    setShowPopup(true);
                }}
                style={{
                    backgroundColor: statusVisual.bodyColor,
                    border: `1px solid ${statusVisual.borderColor}`,
                    borderRadius: '4px',
                    cursor: 'pointer',
                    width: '100%',
                    height: '100%',
                    display: 'flex',
                    flexDirection: 'column',
                    overflow: 'hidden',
                    boxShadow: '0 1px 3px rgba(0,0,0,0.12)',
                    transition: 'transform 0.15s, box-shadow 0.15s',
                    fontSize: '6px',
                    lineHeight: 1.15,
                    boxSizing: 'border-box',
                    animation: 'none'
                }}
                onMouseEnter={(e) => {
                    e.currentTarget.style.transform = 'scale(1.05)';
                    e.currentTarget.style.boxShadow = '0 3px 8px rgba(0,0,0,0.3)';
                    e.currentTarget.style.zIndex = '10';
                }}
                onMouseLeave={(e) => {
                    e.currentTarget.style.transform = 'scale(1)';
                    e.currentTarget.style.boxShadow = '0 1px 3px rgba(0,0,0,0.12)';
                    e.currentTarget.style.zIndex = '1';
                }}
            >
                {/* Machine Name - Header */}
                <div style={{
                    fontWeight: 'bold',
                    backgroundColor: statusVisual.headerColor,
                    color: '#ffffff',
                    padding: '1px 2px',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    fontSize: 'clamp(6px, 0.55vw, 10px)',
                    textAlign: 'center',
                    flexShrink: 0,
                }}>
                    {machine.name}
                </div>
                {/* Content */}
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '0px 2px', gap: '0px', overflow: 'hidden', minHeight: 0 }}>
                    <div style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: '#212121', fontSize: 'clamp(5px, 0.45vw, 8px)', lineHeight: 1.1 }}>
                        {machine.model}
                    </div>
                    <div style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: '#212121', fontSize: 'clamp(5px, 0.45vw, 8px)', lineHeight: 1.1 }}>
                        {machine.process}
                    </div>
                    <div style={{ fontWeight: 700, color: '#212121', fontSize: 'clamp(6px, 0.5vw, 10px)', lineHeight: 1.2 }}>
                        {getValue()}
                    </div>
                </div>
            </div>
        );
    };

    // Render unified grid: area backgrounds + machine cards
    const renderUnifiedGrid = () => {
        const elements: React.ReactNode[] = [];

        // 1) Area backgrounds (no label inside)
        Object.entries(AREA_LAYOUT).forEach(([areaKey, layout]) => {
            const theme = getAreaTheme(areaKey);
            elements.push(
                <div
                    key={`area-bg-${areaKey}`}
                    style={{
                        gridColumn: `${layout.colStart} / ${layout.colEnd}`,
                        gridRow: `${layout.rowStart} / ${layout.rowEnd}`,
                        backgroundColor: theme.bodyBg,
                        border: `1px solid ${theme.borderColor}`,
                        borderRadius: '6px',
                        zIndex: 0,
                    }}
                />
            );

            // Area label as SEPARATE grid item (z-index: 2, above machine cards)
            elements.push(
                <div
                    key={`area-label-${areaKey}`}
                    style={{
                        gridColumn: `${layout.colStart} / ${layout.colEnd}`,
                        gridRow: layout.labelRow,
                        zIndex: 2,
                        pointerEvents: 'none',
                        alignSelf: layout.labelAlign,
                        backgroundColor: theme.headerBg,
                        color: theme.textColor,
                        fontWeight: 'bold',
                        fontSize: 'clamp(7px, 0.6vw, 12px)',
                        padding: '1px 6px',
                        borderTopLeftRadius: '6px',
                        borderTopRightRadius: '6px',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                    }}
                >
                    {layout.title}
                </div>
            );
        });

        // 2) Machine cards — placed directly in unified grid
        Object.entries(MACHINE_POSITIONS).forEach(([areaKey, positions]) => {
            const offset = AREA_OFFSET[areaKey];
            if (!offset) return;

            Object.entries(positions).forEach(([machineName, pos]) => {
                const machine = machinesData.find(m => m.name === machineName);
                const gridCol = pos.col + offset.colOffset;
                const gridRow = pos.row + offset.rowOffset;
                elements.push(
                    <div
                        key={`machine-${machineName}`}
                        style={{
                            gridColumn: gridCol,
                            gridRow: gridRow,
                            zIndex: 1,
                            padding: '1px',
                            overflow: 'hidden',
                        }}
                    >
                        {machine && <MachineCard machine={machine} />}
                    </div>
                );
            });
        });

        return elements;
    };

    // Popover Component - แสดงใกล้ตำแหน่งที่คลิก
    const Popover = () => {
        if (!showPopup || !selectedMachine) return null;

        // คำนวณตำแหน่ง popover ให้ไม่ล้นออกนอกหน้าจอ
        const popoverWidth = 160;
        const popoverHeight = 120;
        let left = popoverPosition.x + 10;
        let top = popoverPosition.y - 20;

        // ป้องกันล้นขวา
        if (left + popoverWidth > window.innerWidth) {
            left = popoverPosition.x - popoverWidth - 10;
        }
        // ป้องกันล้นล่าง
        if (top + popoverHeight > window.innerHeight) {
            top = window.innerHeight - popoverHeight - 10;
        }
        // ป้องกันล้นบน
        if (top < 10) {
            top = 10;
        }

        return (
            <>
                {/* Overlay เพื่อปิด popover เมื่อคลิกข้างนอก */}
                <div
                    style={{
                        position: 'fixed',
                        top: 0,
                        left: 0,
                        width: '100%',
                        height: '100%',
                        zIndex: 9998,
                    }}
                    onClick={() => setShowPopup(false)}
                />
                {/* Popover */}
                <div
                    style={{
                        position: 'fixed',
                        left: `${left}px`,
                        top: `${top}px`,
                        backgroundColor: '#fff',
                        borderRadius: '8px',
                        padding: '8px',
                        boxShadow: '0 44px 20px rgba(0,0,0,0.25)',
                        zIndex: 9999,
                    }}
                    onClick={(e) => e.stopPropagation()}
                >
                    <div style={{ fontWeight: 'bold', marginBottom: '8px', fontSize: '13px', borderBottom: '1px solid #eee', paddingBottom: '4px', textAlign: 'center' }}>
                        {selectedMachine.name}
                    </div>
                    <div style={{ display: 'flex', gap: '8px' }}>
                        <button
                            className="btn btn-primary btn-sm"
                            onClick={() => {
                                router.push(`/oee_production/daily_report?machine=${selectedMachine.name}`);
                                setShowPopup(false);
                            }}
                            style={{ flex: 1, fontSize: '12px' }}
                        >
                            Daily
                        </button>
                        <button
                            className="btn btn-success btn-sm"
                            onClick={() => {
                                router.push(`/oee_production/monthly_report?machine=${selectedMachine.name}`);
                                setShowPopup(false);
                            }}
                            style={{ flex: 1, fontSize: '12px' }}
                        >
                            Monthly
                        </button>
                    </div>
                </div>
            </>
        );
    };

    return (
        <div className="content" style={{ overflow: 'hidden', height: 'calc(100vh - 60px)', backgroundColor: '#e2e8f0' }}>
            <Popover />
            <div className="card mt-1" style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', backgroundColor: '#f1f5f9' }}>
                {/* Header */}
                <div
                    className="card-header d-flex flex-wrap align-items-center"
                    style={{
                        background: "linear-gradient(90deg, #f8f9fa 0%, #ffffff 100%)",
                        borderBottom: "1px solid #e0e0e0",
                        position: "sticky",
                        top: 0,
                        zIndex: 1020,
                        gap: isMobile ? '8px' : '0',
                        padding: '4px 12px',
                    }}
                >
                    <div
                        className="d-flex align-items-center"
                        style={{
                            fontSize: isMobile ? "1rem" : "1.25rem",
                            fontWeight: 600,
                            flex: isMobile ? '1 1 100%' : 'auto',
                        }}
                    >
                        <i className="fas fa-border-all me-2 text-primary"></i>
                        <span>Layout Dashboard</span>
                    </div>

                    {/* Legend */}
                    <div
                        className="d-flex align-items-center"
                        style={{
                            gap: isMobile ? '12px' : '32px',
                            margin: '0 24px',
                            flex: 1,
                            justifyContent: 'center',
                            flexWrap: 'wrap',
                        }}
                    >
                        <LegendBox headerColor="#2e7d32" bodyColor="#e8f5e9" label="Run Time" />
                        <LegendBox headerColor="#c62828" bodyColor="#ffebee" label="Down Time" />
                        <LegendBox headerColor="#424242" bodyColor="#d5d5d5" label="Plan Stop / Break" />
                        <LegendBox headerColor="#bdbdbd" bodyColor="#f5f5f5" label="No Data" />
                    </div>

                    <div
                        className="d-flex gap-2 align-items-center"
                        style={{
                            marginLeft: isMobile ? '0' : 'auto',
                            flexWrap: 'wrap',
                        }}
                    >
                        {/* Machine Status Countdown */}
                        <div
                            className="d-flex align-items-center gap-2"
                            style={{
                                backgroundColor: '#e2e8f0',
                                padding: '4px 10px',
                                borderRadius: '4px',
                                fontSize: isMobile ? '0.7rem' : '0.8rem',
                                color: '#475569',
                                fontWeight: 600,
                            }}
                        >
                            <span>Machine Status</span>
                            <span
                                className="badge rounded-pill"
                                style={{
                                    backgroundColor: '#64748b',
                                    fontSize: isMobile ? '0.65rem' : '0.75rem',
                                    padding: '3px 6px',
                                    minWidth: '40px'
                                }}
                            >
                                ⏱️ {Math.floor(countdown / 60)}:{String(countdown % 60).padStart(2, '0')}
                            </span>
                        </div>
                        {/* Real-time Badge Removed */}
                        <button
                            className={`btn btn-sm ${activeButton === 'OUTPUT' ? 'btn-primary' : 'btn-outline-secondary'}`}
                            onClick={() => setActiveButton('OUTPUT')}
                            style={{ minWidth: isMobile ? '60px' : '80px', fontSize: isMobile ? '0.7rem' : '0.875rem' }}
                        >
                            Output
                        </button>
                        {/* Phase 10: เปลี่ยนจาก 'EFFICIENCY'/'Efficiency' → 'AVAILABILITY'/'Availability' */}
                        <button
                            className={`btn btn-sm ${activeButton === 'AVAILABILITY' ? 'btn-success' : 'btn-outline-secondary'}`}
                            onClick={() => setActiveButton('AVAILABILITY')}
                            style={{ minWidth: isMobile ? '60px' : '80px', fontSize: isMobile ? '0.7rem' : '0.875rem' }}
                        >
                            Availability
                        </button>
                        <button
                            className={`btn btn-sm ${activeButton === 'CYCLE_TIME' ? 'btn-warning' : 'btn-outline-secondary'}`}
                            onClick={() => setActiveButton('CYCLE_TIME')}
                            style={{ minWidth: isMobile ? '70px' : '80px', fontSize: isMobile ? '0.7rem' : '0.875rem' }}
                        >
                            Cycle Time
                        </button>
                    </div>
                </div>

                {/* Body — Unified Grid */}
                <div
                    className="card-body p-1"
                    style={{
                        flex: 1,
                        height: '0',
                        minHeight: 0,
                        overflow: 'hidden',
                    }}
                >
                    <div
                        style={{
                            width: '100%',
                            height: '100%',
                            display: 'grid',
                            gridTemplateColumns: `repeat(${UNIFIED_COLS}, minmax(0, 1fr))`,
                            gridTemplateRows: `auto repeat(${UNIFIED_MACHINE_ROWS}, minmax(0, 1fr))`,
                            gap: '2px',
                        }}
                    >
                        {renderUnifiedGrid()}
                    </div>
                </div>
            </div>
        </div>
    );
}
