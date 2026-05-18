'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import {
    Chart as ChartJS,
    CategoryScale,
    LinearScale,
    BarController,
    LineController,
    PieController,
    BarElement,
    LineElement,
    PointElement,
    ArcElement,
    Legend,
    Tooltip,
    ChartOptions,
} from 'chart.js';
import { Chart } from 'react-chartjs-2';
import ChartDataLabels from 'chartjs-plugin-datalabels';
import config from '@/app/config';

ChartJS.register(
    CategoryScale,
    LinearScale,
    BarController,
    LineController,
    PieController,
    BarElement,
    LineElement,
    PointElement,
    ArcElement,
    Legend,
    Tooltip,
    ChartDataLabels
);

const apiServer = config.apiServer;

type ReportMode = 'daily' | 'monthly';

type Bucket = {
    key: string;
    label: string;
    output: number | null;
    outputA?: number | null;
    outputB?: number | null;
    outputC?: number | null;
    outputTarget: number | null;
    outputPerDay?: number | null;
    outputPerDayA?: number | null;
    outputPerDayB?: number | null;
    outputPerDayC?: number | null;
    outputTargetPerDay?: number | null;
    availability: number | null;
    efficiencyTarget: number | null;
    cycleTime: number | null;
    cycleTimeTarget: number | null;
    downtime: {
        alarm: number | null;
        maintenance: number | null;
        adjust: number | null;
    };
    downtimeCounts?: {
        alarm: number | null;
        maintenance: number | null;
        adjust: number | null;
    };
    runtimeMinutes?: number | null;
};

type Machine = {
    machine_name: string;
    machine_area?: string;
    machine_type?: string;
};

type ReportResults = {
    filters: Record<string, string>;
    machines: Machine[];
    modelNames: string[];
    days?: Bucket[];
    months?: Bucket[];
    alarmSummary: { alarm: string; count: number; minutes: number }[];
};

type OptionItem = { value: string; label: string };
type ApiOptionItem = string | Record<string, unknown> | null | undefined;
type ApiListResponse = { results?: ApiOptionItem[] };
type ApiReportResponse = { results: ReportResults };

type MachinesByAreaResponse = {
    results?: Array<{
        area?: string;
        machines?: Array<{ type?: string; name?: string }>;
    }>;
};

const chartColors = {
    output: '#0284c7',
    outputTarget: '#f59e0b',
    efficiency: '#2563eb',
    efficiencyTarget: '#06b6d4',
    cycle: '#16a34a',
    cycleTarget: '#94a3b8',
    alarm: '#dc2626',
    maintenance: '#64748b',
    adjust: '#fbbf24',
    orange: '#f97316',
};

const panelStyle: React.CSSProperties = {
    backgroundColor: '#ffffff',
    border: '1px solid #cbd5e1',
    borderRadius: '6px',
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
};

const STORAGE_KEYS = {
    mode: 'oeeReportDashboard.mode',
    dailyPeriod: 'oeeReportDashboard.dailyPeriod',
    monthlyPeriod: 'oeeReportDashboard.monthlyPeriod',
    area: 'oeeReportDashboard.area',
    type: 'oeeReportDashboard.type',
    machine: 'oeeReportDashboard.machine',
    model: 'oeeReportDashboard.model',
};

function readStoredValue(key: string, fallback = '', allowAll = false) {
    if (typeof window === 'undefined') return fallback;
    const value = window.localStorage.getItem(key);
    if (!value || (!allowAll && value.toLowerCase() === 'all')) return fallback;
    return value;
}

function storeValue(key: string, value: string, allowAll = false) {
    if (typeof window === 'undefined') return;
    if (value && (allowAll || value.toLowerCase() !== 'all')) {
        window.localStorage.setItem(key, value);
    } else {
        window.localStorage.removeItem(key);
    }
}

function withoutAllOptions(options: OptionItem[]) {
    return options.filter((item) => item.value.toLowerCase() !== 'all');
}

function withAllOption(options: OptionItem[], value = 'all') {
    const allOption = { value, label: 'All' };
    return [allOption, ...withoutAllOptions(options)];
}

function currentMonth() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function currentYear() {
    return String(new Date().getFullYear());
}

function buildQuery(params: Record<string, string>) {
    const query = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
        if (value) query.set(key, value);
    });
    return query.toString();
}

function optionFromApiItem(item: ApiOptionItem, keys: string[]): OptionItem {
    if (typeof item === 'string') return { value: item, label: item };
    for (const key of keys) {
        if (item && typeof item === 'object' && item[key]) return { value: String(item[key]), label: String(item[key]) };
    }
    const fallback = String(item ?? '');
    return { value: fallback, label: fallback };
}

function getErrorMessage(err: unknown) {
    if (axios.isAxiosError<{ message?: string }>(err)) {
        return err.response?.data?.message || err.message;
    }
    if (err instanceof Error) return err.message;
    return 'Failed to load report';
}

function chartOptions(title: string | string[], yTitle: string, extra?: ChartOptions<'bar' | 'line'>): ChartOptions<'bar' | 'line'> {
    const base: ChartOptions<'bar' | 'line'> = {
        responsive: true,
        maintainAspectRatio: false,
        layout: { padding: { top: 4, right: 8, bottom: 0, left: 4 } },
        plugins: {
            legend: {
                position: 'top',
                labels: { boxWidth: 14, usePointStyle: false, font: { size: 11 } },
            },
            title: {
                display: true,
                text: title,
                align: 'start',
                color: '#334155',
                font: { size: 14, weight: 'bold' },
                padding: { bottom: 4 },
            },
            tooltip: { enabled: true },
            datalabels: {
                display: false,
                color: '#334155',
                font: { size: 10, weight: 'bold' },
            },
        },
        scales: {
            x: {
                type: 'category',
                grid: { color: '#e2e8f0' },
                ticks: { color: '#64748b', maxRotation: 0, autoSkip: false },
            },
            y: {
                type: 'linear',
                axis: 'y',
                beginAtZero: true,
                title: { display: true, text: yTitle, color: '#475569', font: { size: 11 } },
                grid: { color: '#e2e8f0' },
                ticks: { color: '#64748b' },
            },
            y1: {
                type: 'linear',
                axis: 'y',
                position: 'right',
                beginAtZero: true,
                display: false,
                grid: { drawOnChartArea: false },
            },
            y2: {
                type: 'linear',
                axis: 'y',
                position: 'right',
                beginAtZero: true,
                display: false,
                grid: { drawOnChartArea: false },
            },
        },
    };

    if (!extra) return base;

    return {
        ...base,
        ...extra,
        plugins: {
            ...base.plugins,
            ...extra.plugins,
            datalabels: {
                ...base.plugins?.datalabels,
                ...(extra.plugins?.datalabels || {}),
            }
        },
        scales: {
            ...base.scales,
            ...extra.scales,
        },
    };
}

function pieOptions(title: string): ChartOptions<'pie'> {
    const base: ChartOptions<'pie'> = {
        responsive: true,
        maintainAspectRatio: false,
        layout: { padding: 8 },
        plugins: {
            legend: { position: 'right', labels: { boxWidth: 12, font: { size: 11 } } },
            title: { display: true, text: title, align: 'start', color: '#334155', font: { size: 14, weight: 'bold' } },
            tooltip: { enabled: true },
            datalabels: { display: false },
        },
    };

    return base;
}

function toFixedNumber(value: number | null | undefined, digits = 1) {
    if (value == null || Number.isNaN(Number(value))) return null;
    return Number(Number(value).toFixed(digits));
}

function safeNumber(value: number | null | undefined) {
    if (value == null) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function targetDatalabels(color: string, formatFn: (v: number) => string) {
    return {
        display: (ctx: any) => {
            const val = Number(ctx.dataset.data[ctx.dataIndex]);
            if (!val || val <= 0) return false;
            let prevVal = null;
            for (let i = ctx.dataIndex - 1; i >= 0; i--) {
                const p = Number(ctx.dataset.data[i]);
                if (p > 0) { prevVal = p; break; }
            }
            return prevVal !== val;
        },
        align: 'top' as const,
        anchor: 'center' as const,
        backgroundColor: color,
        color: '#ffffff',
        borderRadius: 4,
        font: { size: 9, weight: 'bold' as const },
        padding: { top: 2, bottom: 2, left: 4, right: 4 },
        offset: 8,
        formatter: formatFn,
    };
}

type DowntimeKey = 'alarm' | 'maintenance' | 'adjust';

function ReportPanel({ children }: { children: React.ReactNode }) {
    return <section style={panelStyle}>{children}</section>;
}

export default function ReportDashboard({ mode, initialMachine }: { mode: ReportMode; initialMachine: string }) {
    const initialMachineValue = initialMachine && initialMachine.toLowerCase() !== 'all' ? initialMachine : '';
    const [reportMode, setReportMode] = useState<ReportMode>(() => {
        const storedMode = readStoredValue(STORAGE_KEYS.mode, mode);
        return storedMode === 'monthly' ? 'monthly' : 'daily';
    });
    const [dailyPeriod, setDailyPeriod] = useState(() => readStoredValue(STORAGE_KEYS.dailyPeriod, currentMonth()));
    const [monthlyPeriod, setMonthlyPeriod] = useState(() => readStoredValue(STORAGE_KEYS.monthlyPeriod, currentYear()));
    const [area, setArea] = useState(() => readStoredValue(STORAGE_KEYS.area));
    const [type, setType] = useState(() => readStoredValue(STORAGE_KEYS.type));
    const [machine, setMachine] = useState(() => initialMachineValue || readStoredValue(STORAGE_KEYS.machine, 'ALL', true));
    const [model, setModel] = useState(() => readStoredValue(STORAGE_KEYS.model, 'all', true));
    const [areaOptions, setAreaOptions] = useState<OptionItem[]>([]);
    const [typeOptions, setTypeOptions] = useState<OptionItem[]>([]);
    const [machineOptions, setMachineOptions] = useState<OptionItem[]>([]);
    const [data, setData] = useState<ReportResults | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const storedTypeRef = useRef(readStoredValue(STORAGE_KEYS.type));
    const storedMachineRef = useRef(initialMachineValue || readStoredValue(STORAGE_KEYS.machine, 'ALL', true));
    const storedModelRef = useRef(readStoredValue(STORAGE_KEYS.model, 'all', true));
    const reportRequestRef = useRef(0);
    const initialMachineSyncRef = useRef('');

    const period = reportMode === 'daily' ? dailyPeriod : monthlyPeriod;
    const buckets = reportMode === 'daily' ? (data?.days || []) : (data?.months || []);

    useEffect(() => {
        axios.get<ApiListResponse>(`${apiServer}/api/machine/listArea`).then((res) => {
            const areas = withoutAllOptions((res.data.results || []).map((item) => optionFromApiItem(item, ['machine_area', 'area'])));
            setAreaOptions(areas);
            setArea((current) => {
                if (current && areas.some((item) => item.value === current)) return current;
                return areas[0]?.value || '';
            });
        }).catch(() => undefined);
    }, []);

    useEffect(() => {
        if (!initialMachineValue) return;
        if (initialMachineSyncRef.current === initialMachineValue) return;
        initialMachineSyncRef.current = initialMachineValue;

        axios.get<MachinesByAreaResponse>(`${apiServer}/api/machine/listAllMachinesByArea`).then((res) => {
            const raw = (res.data && typeof res.data === 'object') ? (res.data as MachinesByAreaResponse).results : undefined;
            const groups = Array.isArray(raw) ? raw : [];
            let foundArea = '';
            let foundType = '';
            for (const group of groups) {
                for (const m of group.machines || []) {
                    if (m?.name === initialMachineValue) {
                        foundArea = group.area || '';
                        foundType = m.type || '';
                        break;
                    }
                }
                if (foundArea) break;
            }

            storedMachineRef.current = initialMachineValue;
            storedModelRef.current = 'all';
            setModel('all');
            setMachine(initialMachineValue);

            if (foundArea) {
                storedTypeRef.current = foundType;
                setArea(foundArea);
                setType(foundType);
            }
        }).catch(() => {
            storedMachineRef.current = initialMachineValue;
            storedModelRef.current = 'all';
            setModel('all');
            setMachine(initialMachineValue);
        });
    }, [initialMachineValue]);

    useEffect(() => {
        setType('');
        if (!initialMachineValue) setMachine('ALL');
        if (!area) {
            setTypeOptions([]);
            setMachineOptions([{ value: 'ALL', label: 'All' }]);
            return;
        }
        axios.get<ApiListResponse>(`${apiServer}/api/machine/listType/${area}`).then((res) => {
            const types = withoutAllOptions((res.data.results || []).map((item) => optionFromApiItem(item, ['machine_type', 'type'])));
            setTypeOptions(types);
            setType((current) => {
                if (current && types.some((item) => item.value === current)) return current;
                const storedType = storedTypeRef.current;
                if (storedType && types.some((item) => item.value === storedType)) return storedType;
                return types[0]?.value || '';
            });
        }).catch(() => undefined);
    }, [area, initialMachineValue]);

    useEffect(() => {
        if (!initialMachineValue) setMachine('ALL');
        if (!area || !type) {
            setMachineOptions([{ value: 'ALL', label: 'All' }]);
            return;
        }
        axios.get<ApiListResponse>(`${apiServer}/api/machine/listMachines/${area}/${type}`).then((res) => {
            const machines = withAllOption((res.data.results || []).map((item) => optionFromApiItem(item, ['machine_name', 'name'])), 'ALL');
            setMachineOptions(machines);
            setMachine((current) => {
                if (initialMachineValue) return initialMachineValue;
                if (current && machines.some((item) => item.value === current)) return current;
                const storedMachine = storedMachineRef.current;
                if (storedMachine && machines.some((item) => item.value === storedMachine)) return storedMachine;
                return machines[0]?.value || 'ALL';
            });
        }).catch(() => undefined);
    }, [area, type, initialMachineValue]);

    useEffect(() => {
        storeValue(STORAGE_KEYS.mode, reportMode);
    }, [reportMode]);

    useEffect(() => {
        storeValue(STORAGE_KEYS.dailyPeriod, dailyPeriod);
    }, [dailyPeriod]);

    useEffect(() => {
        storeValue(STORAGE_KEYS.monthlyPeriod, monthlyPeriod);
    }, [monthlyPeriod]);

    useEffect(() => {
        storeValue(STORAGE_KEYS.area, area);
    }, [area]);

    useEffect(() => {
        storeValue(STORAGE_KEYS.type, type);
    }, [type]);

    useEffect(() => {
        storeValue(STORAGE_KEYS.machine, machine, true);
    }, [machine]);

    useEffect(() => {
        storeValue(STORAGE_KEYS.model, model, true);
    }, [model]);

    const fetchReport = useCallback(async () => {
        const requestId = reportRequestRef.current + 1;
        reportRequestRef.current = requestId;
        setLoading(true);
        setError('');
        try {
            const endpoint = reportMode === 'daily' ? '/api/report/daily-dashboard' : '/api/report/monthly-dashboard';
            const periodParam: Record<string, string> = reportMode === 'daily' ? { month: period } : { year: period };
            const query = buildQuery({ ...periodParam, area, type, machine, model });
            const res = await axios.get<ApiReportResponse>(`${apiServer}${endpoint}?${query}`);
            if (requestId !== reportRequestRef.current) return;
            setData(res.data.results);
        } catch (err: unknown) {
            if (requestId !== reportRequestRef.current) return;
            setError(getErrorMessage(err));
        } finally {
            if (requestId === reportRequestRef.current) setLoading(false);
        }
    }, [reportMode, period, area, type, machine, model]);

    useEffect(() => {
        fetchReport();
    }, [fetchReport]);

    const modelOptions = useMemo(() => {
        return withAllOption((data?.modelNames || []).map((item) => ({ value: item, label: item })));
    }, [data]);

    useEffect(() => {
        setModel((current) => {
            if (current && modelOptions.some((item) => item.value === current)) return current;
            const storedModel = storedModelRef.current;
            if (storedModel && modelOptions.some((item) => item.value === storedModel)) return storedModel;
            return modelOptions[0]?.value || 'all';
        });
    }, [modelOptions]);

    const labels = buckets.map((item) => item.label);

    const downtimeMeta = useMemo(() => {
        const minutes: Record<DowntimeKey, Array<number | null>> = {
            alarm: [],
            maintenance: [],
            adjust: [],
        };
        const counts: Record<DowntimeKey, Array<number | null>> = {
            alarm: [],
            maintenance: [],
            adjust: [],
        };
        const runtimeMinutes: Array<number | null> = [];
        const denomMinutes: Array<number | null> = [];
        const pct: Record<DowntimeKey, Array<number | null>> = {
            alarm: [],
            maintenance: [],
            adjust: [],
        };

        buckets.forEach((bucket) => {
            const alarmMin = safeNumber(bucket.downtime?.alarm);
            const maintMin = safeNumber(bucket.downtime?.maintenance);
            const adjustMin = safeNumber(bucket.downtime?.adjust);
            const rtMin = safeNumber(bucket.runtimeMinutes);

            minutes.alarm.push(alarmMin);
            minutes.maintenance.push(maintMin);
            minutes.adjust.push(adjustMin);

            counts.alarm.push(safeNumber(bucket.downtimeCounts?.alarm) ?? (alarmMin == null ? null : 0));
            counts.maintenance.push(safeNumber(bucket.downtimeCounts?.maintenance) ?? (maintMin == null ? null : 0));
            counts.adjust.push(safeNumber(bucket.downtimeCounts?.adjust) ?? (adjustMin == null ? null : 0));

            runtimeMinutes.push(rtMin);

            if (alarmMin == null || maintMin == null || adjustMin == null || rtMin == null) {
                denomMinutes.push(null);
                pct.alarm.push(null);
                pct.maintenance.push(null);
                pct.adjust.push(null);
                return;
            }

            const downtimeTotal = alarmMin + maintMin + adjustMin;
            const denom = rtMin + downtimeTotal;
            denomMinutes.push(denom > 0 ? denom : 0);

            if (denom <= 0) {
                pct.alarm.push(null);
                pct.maintenance.push(null);
                pct.adjust.push(null);
                return;
            }

            pct.alarm.push(toFixedNumber((alarmMin / denom) * 100, 2));
            pct.maintenance.push(toFixedNumber((maintMin / denom) * 100, 2));
            pct.adjust.push(toFixedNumber((adjustMin / denom) * 100, 2));
        });

        return { minutes, counts, runtimeMinutes, denomMinutes, pct };
    }, [buckets]);

    const downtimeEfficiencyData = {
        labels,
        datasets: [
            { type: 'bar' as const, label: 'Alarm', data: downtimeMeta.pct.alarm, backgroundColor: chartColors.alarm, stack: 'downtime', yAxisID: 'y', order: 2, datalabels: { display: (ctx: any) => Number(ctx.dataset.data[ctx.dataIndex]) > 5, formatter: (v: number) => Math.round(v) + '%' } },
            { type: 'bar' as const, label: 'Maintenance', data: downtimeMeta.pct.maintenance, backgroundColor: chartColors.maintenance, stack: 'downtime', yAxisID: 'y', order: 2, datalabels: { display: (ctx: any) => Number(ctx.dataset.data[ctx.dataIndex]) > 5, formatter: (v: number) => Math.round(v) + '%' } },
            { type: 'bar' as const, label: 'Adjust machine', data: downtimeMeta.pct.adjust, backgroundColor: chartColors.adjust, stack: 'downtime', yAxisID: 'y', order: 2, datalabels: { display: (ctx: any) => Number(ctx.dataset.data[ctx.dataIndex]) > 5, formatter: (v: number) => Math.round(v) + '%' } },
            { type: 'line' as const, label: 'Availability', data: buckets.map((item) => item.availability), borderColor: chartColors.efficiency, backgroundColor: chartColors.efficiency, tension: 0.25, yAxisID: 'y1', order: 1, pointRadius: 3, pointHoverRadius: 5, datalabels: { display: (ctx: any) => Number(ctx.dataset.data[ctx.dataIndex]) > 0, align: 'bottom' as const, anchor: 'end' as const, offset: 6, font: { size: 9, weight: 'normal' as const }, color: chartColors.efficiency, backgroundColor: 'rgba(255,255,255,0.7)', borderRadius: 4, formatter: (v: number) => Math.round(v) + '%' } },
        ],
    };

    const outputData = {
        labels,
        datasets: [
            { type: 'bar' as const, label: 'Shift A (07:00-15:00)', data: buckets.map((item) => item.outputA), backgroundColor: '#3b82f6', stack: 'output', yAxisID: 'y', order: 2, datalabels: { display: (ctx: any) => Number(ctx.dataset.data[ctx.dataIndex]) > 0, align: 'center' as const, anchor: 'center' as const, color: '#ffffff', font: { size: 10, weight: 'bold' as const }, formatter: (v: number) => { const n = Math.round(v); return n >= 1000 ? (n/1000).toFixed(1).replace(/\.0$/, '') + 'k' : n.toString(); } } },
            { type: 'bar' as const, label: 'Shift B (15:00-23:00)', data: buckets.map((item) => item.outputB), backgroundColor: '#14b8a6', stack: 'output', yAxisID: 'y', order: 2, datalabels: { display: (ctx: any) => Number(ctx.dataset.data[ctx.dataIndex]) > 0, align: 'center' as const, anchor: 'center' as const, color: '#ffffff', font: { size: 10, weight: 'bold' as const }, formatter: (v: number) => { const n = Math.round(v); return n >= 1000 ? (n/1000).toFixed(1).replace(/\.0$/, '') + 'k' : n.toString(); } } },
            { type: 'bar' as const, label: 'Shift C (23:00-07:00)', data: buckets.map((item) => item.outputC), backgroundColor: '#8b5cf6', stack: 'output', yAxisID: 'y', order: 2, datalabels: { display: (ctx: any) => Number(ctx.dataset.data[ctx.dataIndex]) > 0, align: 'center' as const, anchor: 'center' as const, color: '#ffffff', font: { size: 10, weight: 'bold' as const }, formatter: (v: number) => { const n = Math.round(v); return n >= 1000 ? (n/1000).toFixed(1).replace(/\.0$/, '') + 'k' : n.toString(); } } },
            { type: 'line' as const, label: 'Total Output', data: buckets.map((item) => item.output), borderColor: 'transparent', backgroundColor: 'transparent', pointRadius: 0, pointHoverRadius: 0, tension: 0, stack: 'total_line', yAxisID: 'y', order: 3, hidden: true, datalabels: { display: (ctx: any) => Number(ctx.dataset.data[ctx.dataIndex]) > 0, align: 'top' as const, anchor: 'end' as const, offset: 4, color: '#334155', font: { size: 11, weight: 'bold' as const }, formatter: (v: number) => { const n = Math.round(v); return n >= 1000 ? (n/1000).toFixed(1).replace(/\.0$/, '') + 'k' : n.toString(); } } },
            { type: 'line' as const, label: 'Output Target', data: buckets.map((item) => item.outputTarget), borderColor: chartColors.outputTarget, borderDash: [8, 5], backgroundColor: chartColors.outputTarget, tension: 0.2, yAxisID: 'y', order: 1, pointRadius: 3, pointHoverRadius: 5, datalabels: targetDatalabels(chartColors.outputTarget, (v: number) => { const n = Math.round(v); return 'T: ' + (n >= 1000 ? (n/1000).toFixed(1).replace(/\.0$/, '') + 'k' : n.toString()); }) },
        ],
    };

    const cycleData = {
        labels,
        datasets: [
            { type: 'bar' as const, label: 'Cycle Time', data: buckets.map((item) => item.cycleTime), borderColor: chartColors.cycle, backgroundColor: chartColors.cycle, order: 2, datalabels: { display: (ctx: any) => Number(ctx.dataset.data[ctx.dataIndex]) > 0, align: 'top' as const, anchor: 'end' as const, offset: 4, font: { size: 9, weight: 'normal' as const }, formatter: (v: number) => Number(v).toFixed(1) } },
            { type: 'line' as const, label: 'Cycle Target', data: buckets.map((item) => item.cycleTimeTarget), borderColor: chartColors.cycleTarget, borderDash: [8, 5], backgroundColor: chartColors.cycleTarget, tension: 0.2, order: 1, pointRadius: 3, pointHoverRadius: 5, datalabels: targetDatalabels(chartColors.cycleTarget, (v: number) => 'T: ' + Number(v).toFixed(1)) },
        ],
    };

    const monthlyStatusData = {
        labels,
        datasets: [
            { type: 'bar' as const, label: 'Shift A/day (07:00-15:00)', data: buckets.map((item) => item.outputPerDayA ?? item.outputA), backgroundColor: '#3b82f6', stack: 'output', yAxisID: 'y', order: 2, datalabels: { display: (ctx: any) => Number(ctx.dataset.data[ctx.dataIndex]) > 0, align: 'center' as const, anchor: 'center' as const, color: '#ffffff', font: { size: 9, weight: 'bold' as const }, formatter: (v: number) => { const n = Math.round(v); return n >= 1000 ? (n/1000).toFixed(1).replace(/\.0$/, '') + 'k' : n.toString(); } } },
            { type: 'bar' as const, label: 'Shift B/day (15:00-23:00)', data: buckets.map((item) => item.outputPerDayB ?? item.outputB), backgroundColor: '#14b8a6', stack: 'output', yAxisID: 'y', order: 2, datalabels: { display: (ctx: any) => Number(ctx.dataset.data[ctx.dataIndex]) > 0, align: 'center' as const, anchor: 'center' as const, color: '#ffffff', font: { size: 9, weight: 'bold' as const }, formatter: (v: number) => { const n = Math.round(v); return n >= 1000 ? (n/1000).toFixed(1).replace(/\.0$/, '') + 'k' : n.toString(); } } },
            { type: 'bar' as const, label: 'Shift C/day (23:00-07:00)', data: buckets.map((item) => item.outputPerDayC ?? item.outputC), backgroundColor: '#8b5cf6', stack: 'output', yAxisID: 'y', order: 2, datalabels: { display: (ctx: any) => Number(ctx.dataset.data[ctx.dataIndex]) > 0, align: 'center' as const, anchor: 'center' as const, color: '#ffffff', font: { size: 9, weight: 'bold' as const }, formatter: (v: number) => { const n = Math.round(v); return n >= 1000 ? (n/1000).toFixed(1).replace(/\.0$/, '') + 'k' : n.toString(); } } },
            { type: 'line' as const, label: 'Total Output/day', data: buckets.map((item) => item.outputPerDay ?? item.output), borderColor: 'transparent', backgroundColor: 'transparent', pointRadius: 0, pointHoverRadius: 0, tension: 0, stack: 'total_line', yAxisID: 'y', order: 3, hidden: true, datalabels: { display: (ctx: any) => Number(ctx.dataset.data[ctx.dataIndex]) > 0, align: 'top' as const, anchor: 'end' as const, offset: 4, color: '#334155', font: { size: 10, weight: 'bold' as const }, formatter: (v: number) => { const n = Math.round(v); return n >= 1000 ? (n/1000).toFixed(1).replace(/\.0$/, '') + 'k' : n.toString(); } } },
            { type: 'line' as const, label: 'Output Target/day', data: buckets.map((item) => item.outputTargetPerDay ?? item.outputTarget), borderColor: chartColors.outputTarget, borderDash: [8, 5], backgroundColor: chartColors.outputTarget, tension: 0.2, yAxisID: 'y', order: 1, pointRadius: 3, pointHoverRadius: 5, datalabels: targetDatalabels(chartColors.outputTarget, (v: number) => { const n = Math.round(v); return 'T: ' + (n >= 1000 ? (n/1000).toFixed(1).replace(/\.0$/, '') + 'k' : n.toString()); }) },
            { type: 'line' as const, label: 'Availability', data: buckets.map((item) => item.availability), borderColor: chartColors.efficiency, backgroundColor: chartColors.efficiency, tension: 0.25, yAxisID: 'y1', order: 1, pointRadius: 3, pointHoverRadius: 5, datalabels: { display: (ctx: any) => Number(ctx.dataset.data[ctx.dataIndex]) > 0, align: 'bottom' as const, anchor: 'end' as const, offset: 6, font: { size: 9, weight: 'normal' as const }, color: chartColors.efficiency, backgroundColor: 'rgba(255,255,255,0.7)', borderRadius: 4, formatter: (v: number) => Math.round(v) + '%' } },
            { type: 'line' as const, label: 'Availability Target', data: buckets.map((item) => item.efficiencyTarget), borderColor: chartColors.efficiencyTarget, borderDash: [8, 5], backgroundColor: chartColors.efficiencyTarget, tension: 0.2, yAxisID: 'y1', order: 1, pointRadius: 3, pointHoverRadius: 5, datalabels: targetDatalabels(chartColors.efficiencyTarget, (v: number) => 'T: ' + Math.round(v) + '%') },
            { type: 'line' as const, label: 'Cycle Time', data: buckets.map((item) => item.cycleTime), borderColor: chartColors.cycle, backgroundColor: chartColors.cycle, tension: 0.2, yAxisID: 'y2', order: 1, pointRadius: 3, pointHoverRadius: 5, datalabels: { display: false } },
            { type: 'line' as const, label: 'Cycle Target', data: buckets.map((item) => item.cycleTimeTarget), borderColor: chartColors.cycleTarget, borderDash: [8, 5], backgroundColor: chartColors.cycleTarget, tension: 0.2, yAxisID: 'y2', order: 1, pointRadius: 3, pointHoverRadius: 5, datalabels: { display: false } },
        ],
    };

    const alarmData = {
        labels: (data?.alarmSummary || []).map((item) => item.alarm),
        datasets: [{
            label: 'Alarm downtime [min]',
            data: (data?.alarmSummary || []).map((item) => item.minutes),
            backgroundColor: ['#5b9bd5', '#ed7d31', '#a5a5a5', '#ffc000', '#4472c4', '#70ad47', '#7030a0', '#c00000'],
            borderColor: '#ffffff',
            borderWidth: 2,
        }],
    };

    const downtimeOnlyData = {
        labels,
        datasets: [
            { label: 'Alarm', data: downtimeMeta.pct.alarm, backgroundColor: chartColors.alarm, stack: 'downtime', order: 2, datalabels: { display: (ctx: any) => Number(ctx.dataset.data[ctx.dataIndex]) > 2, formatter: (v: number) => v.toFixed(1) + '%' } },
            { label: 'Maintenance', data: downtimeMeta.pct.maintenance, backgroundColor: chartColors.maintenance, stack: 'downtime', order: 2, datalabels: { display: (ctx: any) => Number(ctx.dataset.data[ctx.dataIndex]) > 2, formatter: (v: number) => v.toFixed(1) + '%' } },
            { label: 'Adjust machine', data: downtimeMeta.pct.adjust, backgroundColor: chartColors.adjust, stack: 'downtime', order: 2, datalabels: { display: (ctx: any) => Number(ctx.dataset.data[ctx.dataIndex]) > 2, formatter: (v: number) => v.toFixed(1) + '%' } },
        ],
    };

    const selectedTitle = machine.toLowerCase() === 'all' ? 'All' : machine || '-';
    const modelTitle = model.toLowerCase() === 'all' ? 'All' : model || '-';
    const areaTitle = area || '-';

    return (
        <div className="content" style={{ height: 'calc(100vh - 60px)', backgroundColor: '#e2e8f0', padding: '8px', overflow: 'hidden' }}>
            <div style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div style={{ backgroundColor: '#f8fafc', border: '1px solid #cbd5e1', borderRadius: '6px', padding: '6px 10px', display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', flexShrink: 0 }}>
                    <div style={{ fontSize: 'clamp(15px, 1.4vw, 22px)', fontWeight: 600, color: '#1e293b', marginRight: 'auto' }}>
                        Machine : {areaTitle}
                    </div>
                    <div style={{ fontSize: 'clamp(15px, 1.4vw, 22px)', fontWeight: 600, color: '#1e293b' }}>
                        Machine No : {selectedTitle}
                    </div>
                    <div style={{ fontSize: 'clamp(15px, 1.4vw, 22px)', fontWeight: 600, color: '#1e293b' }}>
                        Model : {modelTitle}
                    </div>
                </div>

                <div style={{ backgroundColor: '#ffffff', border: '1px solid #cbd5e1', borderRadius: '6px', padding: '6px 8px', display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'end', flexShrink: 0 }}>
                    <div className="btn-group btn-group-sm" role="group" aria-label="Report mode">
                        <button className={`btn ${reportMode === 'daily' ? 'btn-primary' : 'btn-outline-primary'}`} type="button" onClick={() => setReportMode('daily')}>
                            Daily
                        </button>
                        <button className={`btn ${reportMode === 'monthly' ? 'btn-primary' : 'btn-outline-primary'}`} type="button" onClick={() => setReportMode('monthly')}>
                            Monthly
                        </button>
                    </div>
                    <label className="form-label m-0 small" style={{ minWidth: '140px' }}>
                        {reportMode === 'daily' ? 'Month' : 'Fiscal Year'}
                        <input
                            className="form-control form-control-sm"
                            type={reportMode === 'daily' ? 'month' : 'number'}
                            value={period}
                            min="2025"
                            max="2035"
                            onChange={(e) => reportMode === 'daily' ? setDailyPeriod(e.target.value) : setMonthlyPeriod(e.target.value)}
                        />
                    </label>
                    <label className="form-label m-0 small" style={{ minWidth: '130px' }}>
                        Area
                        <select className="form-select form-select-sm" value={area} onChange={(e) => {
                            storedTypeRef.current = '';
                            storedMachineRef.current = 'ALL';
                            storedModelRef.current = 'all';
                            setArea(e.target.value);
                            setType('');
                            setMachine('ALL');
                            setModel('all');
                        }}>
                            {areaOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                        </select>
                    </label>
                    <label className="form-label m-0 small" style={{ minWidth: '130px' }}>
                        Type
                        <select className="form-select form-select-sm" value={type} onChange={(e) => {
                            storedTypeRef.current = e.target.value;
                            storedMachineRef.current = 'ALL';
                            storedModelRef.current = 'all';
                            setType(e.target.value);
                            setMachine('ALL');
                            setModel('all');
                        }} disabled={!area || typeOptions.length === 0}>
                            {typeOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                        </select>
                    </label>
                    <label className="form-label m-0 small" style={{ minWidth: '150px' }}>
                        Machine
                        <select className="form-select form-select-sm" value={machine} onChange={(e) => {
                            storedMachineRef.current = e.target.value;
                            storedModelRef.current = 'all';
                            setMachine(e.target.value);
                            setModel('all');
                        }} disabled={!type || machineOptions.length === 0}>
                            {machineOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                        </select>
                    </label>
                    <label className="form-label m-0 small" style={{ minWidth: '180px' }}>
                        Model
                        <select className="form-select form-select-sm" value={model} onChange={(e) => {
                            storedModelRef.current = e.target.value;
                            setModel(e.target.value);
                        }} disabled={modelOptions.length === 0}>
                            {modelOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                        </select>
                    </label>
                    <button className="btn btn-sm btn-primary" type="button" onClick={fetchReport} disabled={loading}>
                        {loading ? 'Loading...' : 'Refresh'}
                    </button>
                    {error && <span className="text-danger small">{error}</span>}
                </div>

                <div style={{
                    flex: 1,
                    minHeight: 0,
                    display: 'grid',
                    gap: '8px',
                    gridTemplateColumns: reportMode === 'daily' ? '2fr 1.15fr' : '1.05fr 1fr',
                    gridTemplateRows: 'minmax(0, 1fr) minmax(0, 1fr)',
                    overflow: 'hidden',
                }}>
                    {reportMode === 'daily' ? (
                        <>
                            <ReportPanel>
                                <Chart key="daily-chart-1" type="bar" data={downtimeEfficiencyData} options={chartOptions('Efficiency & Downtime (Daily)', 'Downtime [%]', {
                                    plugins: {
                                        tooltip: {
                                            callbacks: {
                                                label: (ctx) => {
                                                    if (ctx.dataset.type === 'line') {
                                                        const v = ctx.parsed.y;
                                                        return `${ctx.dataset.label}: ${toFixedNumber(Number(v), 1) ?? '-'}%`;
                                                    }

                                                    const label = String(ctx.dataset.label || '');
                                                    const key: DowntimeKey | null = label === 'Alarm'
                                                        ? 'alarm'
                                                        : label === 'Maintenance'
                                                            ? 'maintenance'
                                                            : label === 'Adjust machine'
                                                                ? 'adjust'
                                                                : null;
                                                    if (!key) return `${label}: ${ctx.formattedValue}%`;

                                                    const i = ctx.dataIndex;
                                                    const pct = safeNumber(ctx.parsed.y);
                                                    const min = downtimeMeta.minutes[key][i];
                                                    const count = downtimeMeta.counts[key][i];
                                                    if (pct == null || min == null) return `${label}: -`;
                                                    const minText = `${Math.round(min)} นาที`;
                                                    const countText = count == null ? '-' : `${Math.round(count)} ครั้ง`;
                                                    return `${label}: ${toFixedNumber(pct, 1)}% (${countText}, ${minText})`;
                                                },
                                            },
                                        },
                                    },
                                    scales: {
                                        x: { stacked: true, grid: { color: '#e2e8f0' }, ticks: { color: '#64748b', autoSkip: false } },
                                        y: { stacked: true, beginAtZero: true, max: 100, title: { display: true, text: 'Downtime [%]' } },
                                        y1: { type: 'linear', axis: 'y', position: 'right', beginAtZero: true, max: 100, grid: { drawOnChartArea: false }, title: { display: true, text: 'Efficiency [%]' } },
                                    },
                                })} />
                            </ReportPanel>
                            <ReportPanel>
                                <Chart key="daily-chart-2" type="pie" data={alarmData} options={{
                                    ...pieOptions('Alarm downtime (minutes)'),
                                    plugins: {
                                        ...pieOptions('Alarm downtime (minutes)').plugins,
                                        tooltip: {
                                            callbacks: {
                                                label: (ctx) => {
                                                    const label = ctx.label || '';
                                                    const minutes = safeNumber(ctx.parsed as unknown as number) ?? 0;
                                                    const dataset = ctx.dataset?.data || [];
                                                    const totalMinutes = (dataset as Array<number | null | undefined>).reduce<number>(
                                                        (sum, v) => sum + (safeNumber(v) ?? 0),
                                                        0
                                                    );
                                                    const percent = totalMinutes > 0 ? (minutes / totalMinutes) * 100 : 0;
                                                    const match = (data?.alarmSummary || []).find((item) => item.alarm === label);
                                                    const count = match?.count ?? 0;
                                                    return [
                                                        `${label}: ${toFixedNumber(percent, 1)}%`,
                                                        `เวลา: ${Math.round(minutes)} นาที`,
                                                        `จำนวน: ${count} ครั้ง`,
                                                    ];
                                                },
                                            },
                                        },
                                        datalabels: {
                                            display: true,
                                            anchor: 'end',
                                            align: 'end',
                                            offset: 10,
                                            clamp: true,
                                            color: '#0f172a',
                                            font: { size: 11, weight: 'bold' },
                                            formatter: (value, ctx) => {
                                                const minutes = safeNumber(value as unknown as number) ?? 0;
                                                const dataset = ctx.chart.data.datasets?.[0]?.data || [];
                                                const totalMinutes = (dataset as Array<number | null | undefined>).reduce<number>(
                                                    (sum, v) => sum + (safeNumber(v) ?? 0),
                                                    0
                                                );
                                                if (totalMinutes <= 0) return '';
                                                const percent = (minutes / totalMinutes) * 100;
                                                if (percent < 3) return '';
                                                return `${toFixedNumber(percent, 0)}%`;
                                            },
                                        },
                                    },
                                }} />
                            </ReportPanel>
                            <ReportPanel>
                                <Chart key="daily-chart-3" type="bar" data={outputData} options={chartOptions('Output (Daily)', 'Output [pcs]', {
                                    scales: {
                                        x: { stacked: true },
                                        y: { stacked: true },
                                    }
                                })} />
                            </ReportPanel>
                            <ReportPanel>
                                <Chart key="daily-chart-4" type="line" data={cycleData} options={chartOptions('Cycle time (Daily)', 'Cycle time [sec]')} />
                            </ReportPanel>
                        </>
                    ) : (
                        <>
                            <div style={{ gridRow: '1 / 3', ...panelStyle }}>
                                <Chart key="monthly-chart-1" type="bar" data={monthlyStatusData} options={chartOptions('Status of machine', 'Output/day [pcs]', {
                                    interaction: {
                                        mode: 'index',
                                        intersect: false,
                                        axis: 'x',
                                    },
                                    scales: {
                                        x: { stacked: true, grid: { color: '#e2e8f0' }, ticks: { color: '#64748b' } },
                                        y: { stacked: true, beginAtZero: true, title: { display: true, text: 'Output/day [pcs]' } },
                                        y1: { type: 'linear', axis: 'y', position: 'right', beginAtZero: true, max: 100, grid: { drawOnChartArea: false }, title: { display: true, text: 'Availability [%]' } },
                                        y2: { type: 'linear', axis: 'y', position: 'right', beginAtZero: true, grid: { drawOnChartArea: false }, display: false },
                                    },
                                })} />
                            </div>
                            <ReportPanel>
                                <Chart key="monthly-chart-2" type="bar" data={downtimeOnlyData} options={chartOptions('Downtime', 'Downtime [%]', {
                                    plugins: {
                                        tooltip: {
                                            callbacks: {
                                                label: (ctx) => {
                                                    const label = String(ctx.dataset.label || '');
                                                    const key: DowntimeKey | null = label === 'Alarm'
                                                        ? 'alarm'
                                                        : label === 'Maintenance'
                                                            ? 'maintenance'
                                                            : label === 'Adjust machine'
                                                                ? 'adjust'
                                                                : null;
                                                    if (!key) return `${label}: ${ctx.formattedValue}%`;
                                                    const i = ctx.dataIndex;
                                                    const pct = safeNumber(ctx.parsed.y);
                                                    const min = downtimeMeta.minutes[key][i];
                                                    const count = downtimeMeta.counts[key][i];
                                                    if (pct == null || min == null) return `${label}: -`;
                                                    const minText = `${Math.round(min)} นาที`;
                                                    const countText = count == null ? '-' : `${Math.round(count)} ครั้ง`;
                                                    return `${label}: ${toFixedNumber(pct, 1)}% (${countText}, ${minText})`;
                                                },
                                            },
                                        },
                                    },
                                    scales: {
                                        x: { stacked: true, grid: { color: '#e2e8f0' }, ticks: { color: '#64748b' } },
                                        y: { stacked: true, beginAtZero: true, max: 100, title: { display: true, text: 'Downtime [%]' } },
                                    },
                                })} />
                            </ReportPanel>
                            <ReportPanel>
                                <Chart key="monthly-chart-3" type="bar" data={cycleData} options={chartOptions('Cycle Time by process', 'Cycle time [sec]')} />
                            </ReportPanel>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}
