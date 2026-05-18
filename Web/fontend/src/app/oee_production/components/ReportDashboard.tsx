'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import axios from 'axios';
import Swal from 'sweetalert2';
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
    downtime: Record<string, number | null>;
    downtimeCounts?: Record<string, number | null>;
    runtimeMinutes?: number | null;
    statusBaseMinutes?: number | null;
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
    statusReportGroups?: StatusReportGroup[];
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

type StatusReportGroup = {
    key: string;
    label: string;
    color: string;
};

type ChartContextLike = {
    dataset?: {
        data?: Array<number | null | undefined>;
    };
    dataIndex?: number;
};

const chartColors = {
    output: '#0284c7',
    outputTarget: '#f59e0b',
    efficiency: '#2563eb',
    efficiencyTarget: '#06b6d4',
    cycle: '#16a34a',
    cycleTarget: '#94a3b8',
    alarm: '#dc2626',
    mcError: '#991b1b',
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

const panelTitleStyle: React.CSSProperties = {
    flexShrink: 0,
    padding: '6px 10px 0',
    color: '#334155',
    fontSize: '14px',
    fontWeight: 700,
    lineHeight: 1.2,
};

const STORAGE_KEYS = {
    mode: 'oeeReportDashboard.mode',
    dailyPeriod: 'oeeReportDashboard.dailyPeriod',
    monthlyPeriod: 'oeeReportDashboard.monthlyPeriod',
    filters: 'oeeReportDashboard.filters',
    area: 'oeeReportDashboard.area',
    type: 'oeeReportDashboard.type',
    machine: 'oeeReportDashboard.machine',
    model: 'oeeReportDashboard.model',
};

type FilterKey = 'area' | 'type' | 'machine' | 'model';

const LEGACY_FILTER_STORAGE_KEYS: Record<FilterKey, string> = {
    area: STORAGE_KEYS.area,
    type: STORAGE_KEYS.type,
    machine: STORAGE_KEYS.machine,
    model: STORAGE_KEYS.model,
};

const MONTH_OPTIONS = [
    { value: '01', label: 'January' },
    { value: '02', label: 'February' },
    { value: '03', label: 'March' },
    { value: '04', label: 'April' },
    { value: '05', label: 'May' },
    { value: '06', label: 'June' },
    { value: '07', label: 'July' },
    { value: '08', label: 'August' },
    { value: '09', label: 'September' },
    { value: '10', label: 'October' },
    { value: '11', label: 'November' },
    { value: '12', label: 'December' },
];

const YEAR_OPTIONS = Array.from({ length: 11 }, (_, index) => String(2025 + index));

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

function filterStorageKey(mode: ReportMode, key: FilterKey) {
    return `${STORAGE_KEYS.filters}.${mode}.${key}`;
}

function readStoredFilter(mode: ReportMode, key: FilterKey, fallback = '', allowAll = false) {
    const scopedValue = readStoredValue(filterStorageKey(mode, key), '', allowAll);
    if (scopedValue) return scopedValue;
    return readStoredValue(LEGACY_FILTER_STORAGE_KEYS[key], fallback, allowAll);
}

function storeFilter(mode: ReportMode, key: FilterKey, value: string, allowAll = false) {
    storeValue(filterStorageKey(mode, key), value, allowAll);
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
        interaction: {
            mode: 'index',
            intersect: false,
            axis: 'x',
        },
        layout: { padding: { top: 4, right: 8, bottom: 0, left: 4 } },
        plugins: {
            legend: {
                position: 'top',
                labels: {
                    boxWidth: 14,
                    usePointStyle: false,
                    font: { size: 11 },
                    filter: (item) => !String(item.text || '').startsWith('Total Output'),
                },
            },
            title: {
                display: false,
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
            title: { display: false, text: title, align: 'start', color: '#334155', font: { size: 14, weight: 'bold' } },
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

function chartDataValue(ctx: unknown) {
    const context = ctx as ChartContextLike;
    const index = typeof context.dataIndex === 'number' ? context.dataIndex : -1;
    return Number(context.dataset?.data?.[index]);
}

function hexToRgba(hex: string, alpha: number) {
    const normalized = hex.replace('#', '');
    if (normalized.length !== 6) return hex;
    const value = parseInt(normalized, 16);
    const red = (value >> 16) & 255;
    const green = (value >> 8) & 255;
    const blue = value & 255;
    return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function downtimeBarDatalabels(minPercent: number, formatter: (value: number) => string) {
    return {
        display: (ctx: unknown) => chartDataValue(ctx) >= minPercent,
        color: '#ffffff',
        textStrokeColor: 'rgba(15, 23, 42, 0.55)',
        textStrokeWidth: 2,
        font: { size: 10, weight: 'bold' as const },
        formatter,
    };
}

function safeNumber(value: number | null | undefined) {
    if (value == null) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function targetDatalabels(color: string, formatFn: (v: number) => string) {
    return {
        display: (ctx: unknown) => {
            const val = chartDataValue(ctx);
            if (!val || val <= 0) return false;
            let prevVal = null;
            const context = ctx as ChartContextLike;
            const data = context.dataset?.data || [];
            const currentIndex = typeof context.dataIndex === 'number' ? context.dataIndex : 0;
            for (let i = currentIndex - 1; i >= 0; i--) {
                const p = Number(data[i]);
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

function ReportPanel({ children, title, style }: { children: React.ReactNode; title?: string; style?: React.CSSProperties }) {
    return (
        <section style={{ ...panelStyle, ...style }}>
            {title && <div style={panelTitleStyle}>{title}</div>}
            <div style={{ flex: 1, minHeight: 0 }}>{children}</div>
        </section>
    );
}

type ReportDashboardProps = {
    mode: ReportMode;
    initialArea?: string;
    initialType?: string;
    initialMachine: string;
    initialModel?: string;
};

export default function ReportDashboard({ mode, initialArea = '', initialType = '', initialMachine, initialModel = '' }: ReportDashboardProps) {
    const router = useRouter();
    const initialMachineIsAll = initialMachine.toLowerCase() === 'all';
    const initialMachineValue = initialMachine && initialMachine.toLowerCase() !== 'all' ? initialMachine : '';
    const initialMachineFilterValue = initialMachineValue || (initialMachineIsAll ? 'ALL' : '');
    const initialModelValue = initialModel || '';
    const modeStorageKey = `${STORAGE_KEYS.mode}.${mode}`;
    const initialReportMode = (() => {
        const storedMode = readStoredValue(modeStorageKey, mode);
        return storedMode === 'monthly' ? 'monthly' : 'daily';
    })();
    const [reportMode, setReportMode] = useState<ReportMode>(initialReportMode);
    const [activeInitialMachine, setActiveInitialMachine] = useState(initialMachineValue);
    const [dailyPeriod, setDailyPeriod] = useState(() => readStoredValue(STORAGE_KEYS.dailyPeriod, currentMonth()));
    const [monthlyPeriod, setMonthlyPeriod] = useState(() => readStoredValue(STORAGE_KEYS.monthlyPeriod, currentYear()));
    const [area, setArea] = useState(() => initialArea || (initialMachineValue ? '' : readStoredFilter(initialReportMode, 'area')));
    const [type, setType] = useState(() => initialType || (initialMachineValue ? '' : readStoredFilter(initialReportMode, 'type')));
    const [machine, setMachine] = useState(() => initialMachineFilterValue || readStoredFilter(initialReportMode, 'machine', 'ALL', true));
    const [model, setModel] = useState(() => initialModelValue || readStoredFilter(initialReportMode, 'model', 'all', true));
    const [areaOptions, setAreaOptions] = useState<OptionItem[]>([]);
    const [typeOptions, setTypeOptions] = useState<OptionItem[]>([]);
    const [machineOptions, setMachineOptions] = useState<OptionItem[]>([]);
    const [data, setData] = useState<ReportResults | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const storedTypeRef = useRef(initialType || (initialMachineValue ? '' : readStoredFilter(initialReportMode, 'type')));
    const storedMachineRef = useRef(initialMachineFilterValue || readStoredFilter(initialReportMode, 'machine', 'ALL', true));
    const storedModelRef = useRef(initialModelValue || readStoredFilter(initialReportMode, 'model', 'all', true));
    const reportRequestRef = useRef(0);
    const initialMachineSyncRef = useRef('');

    const period = reportMode === 'daily' ? dailyPeriod : monthlyPeriod;
    const dailyYear = dailyPeriod.slice(0, 4) || currentYear();
    const dailyMonth = dailyPeriod.slice(5, 7) || '01';
    const buckets = useMemo(() => reportMode === 'daily' ? (data?.days || []) : (data?.months || []), [data, reportMode]);
    const statusReportGroups = useMemo(() => data?.statusReportGroups || [], [data]);
    const statusReportGroupKeyByLabel = useMemo(() => {
        return Object.fromEntries(statusReportGroups.map((group) => [group.label, group.key]));
    }, [statusReportGroups]);
    const setDailyPeriodPart = useCallback((part: 'year' | 'month', value: string) => {
        const nextYear = part === 'year' ? value : dailyYear;
        const nextMonth = part === 'month' ? value : dailyMonth;
        setDailyPeriod(`${nextYear}-${nextMonth}`);
    }, [dailyMonth, dailyYear]);

    const changeReportMode = useCallback((nextMode: ReportMode) => {
        if (nextMode === reportMode) return;

        if (!activeInitialMachine) {
            const nextArea = readStoredFilter(nextMode, 'area');
            const nextType = readStoredFilter(nextMode, 'type');
            const nextMachine = readStoredFilter(nextMode, 'machine', 'ALL', true);
            const nextModel = readStoredFilter(nextMode, 'model', 'all', true);

            storedTypeRef.current = nextType;
            storedMachineRef.current = nextMachine;
            storedModelRef.current = nextModel;
            setArea(nextArea);
            setType(nextType);
            setMachine(nextMachine);
            setModel(nextModel);
        } else {
            storedMachineRef.current = activeInitialMachine;
            storedModelRef.current = 'all';
        }

        setReportMode(nextMode);
    }, [activeInitialMachine, reportMode]);

    useEffect(() => {
        if (initialArea) setArea(initialArea);
        if (initialType) {
            storedTypeRef.current = initialType;
            setType(initialType);
        }
        if (initialMachineIsAll) {
            setActiveInitialMachine('');
            storedMachineRef.current = 'ALL';
            setMachine('ALL');
            initialMachineSyncRef.current = '';
        } else {
            setActiveInitialMachine(initialMachineValue);
            initialMachineSyncRef.current = '';
        }
        if (initialModelValue) {
            storedModelRef.current = initialModelValue;
            setModel(initialModelValue);
        }
    }, [initialArea, initialType, initialMachineIsAll, initialMachineValue, initialModelValue]);

    useEffect(() => {
        setActiveInitialMachine(initialMachineValue);
        initialMachineSyncRef.current = '';
    }, [initialMachineValue]);

    useEffect(() => {
        axios.get<ApiListResponse>(`${apiServer}/api/machine/listArea`).then((res) => {
            const areas = withoutAllOptions((res.data.results || []).map((item) => optionFromApiItem(item, ['machine_area', 'area'])));
            setAreaOptions(areas);
            setArea((current) => {
                if (current && areas.some((item) => item.value === current)) return current;
                if (activeInitialMachine) return current || '';
                return areas[0]?.value || '';
            });
        }).catch(() => undefined);
    }, [activeInitialMachine]);

    useEffect(() => {
        if (!activeInitialMachine) return;
        if (initialMachineSyncRef.current === activeInitialMachine) return;
        initialMachineSyncRef.current = activeInitialMachine;

        axios.get<MachinesByAreaResponse>(`${apiServer}/api/machine/listAllMachinesByArea`).then((res) => {
            const raw = (res.data && typeof res.data === 'object') ? (res.data as MachinesByAreaResponse).results : undefined;
            const groups = Array.isArray(raw) ? raw : [];
            let foundArea = '';
            let foundType = '';
            for (const group of groups) {
                for (const m of group.machines || []) {
                    if (m?.name === activeInitialMachine) {
                        foundArea = group.area || '';
                        foundType = m.type || '';
                        break;
                    }
                }
                if (foundArea) break;
            }

            storedMachineRef.current = activeInitialMachine;
            storedModelRef.current = 'all';
            setModel('all');
            setMachine(activeInitialMachine);

            if (foundArea) {
                storedTypeRef.current = foundType;
                setArea(foundArea);
                setType(foundType);
            }
        }).catch(() => {
            storedMachineRef.current = activeInitialMachine;
            storedModelRef.current = 'all';
            setModel('all');
            setMachine(activeInitialMachine);
        });
    }, [activeInitialMachine]);

    useEffect(() => {
        setType('');
        if (!activeInitialMachine) setMachine('ALL');
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
    }, [area, activeInitialMachine]);

    useEffect(() => {
        if (!area || !type) {
            setMachineOptions([{ value: 'ALL', label: 'All' }]);
            return;
        }
        axios.get<ApiListResponse>(`${apiServer}/api/machine/listMachines/${area}/${type}`).then((res) => {
            const machines = withAllOption((res.data.results || []).map((item) => optionFromApiItem(item, ['machine_name', 'name'])), 'ALL');
            setMachineOptions(machines);
            setMachine((current) => {
                if (activeInitialMachine) return activeInitialMachine;
                if (current && machines.some((item) => item.value === current)) return current;
                const storedMachine = storedMachineRef.current;
                if (storedMachine && machines.some((item) => item.value === storedMachine)) return storedMachine;
                return machines[0]?.value || 'ALL';
            });
        }).catch(() => undefined);
    }, [area, type, activeInitialMachine]);

    useEffect(() => {
        storeValue(modeStorageKey, reportMode);
    }, [modeStorageKey, reportMode]);

    useEffect(() => {
        storeValue(STORAGE_KEYS.dailyPeriod, dailyPeriod);
    }, [dailyPeriod]);

    useEffect(() => {
        storeValue(STORAGE_KEYS.monthlyPeriod, monthlyPeriod);
    }, [monthlyPeriod]);

    useEffect(() => {
        storeFilter(reportMode, 'area', area);
    }, [area, reportMode]);

    useEffect(() => {
        storeFilter(reportMode, 'type', type);
    }, [type, reportMode]);

    useEffect(() => {
        storeFilter(reportMode, 'machine', machine, true);
    }, [machine, reportMode]);

    useEffect(() => {
        storeFilter(reportMode, 'model', model, true);
    }, [model, reportMode]);

    const clearInitialMachineSelection = useCallback(() => {
        setActiveInitialMachine('');
        initialMachineSyncRef.current = '';
        if (initialMachineValue) {
            const path = reportMode === 'daily' ? '/oee_production/daily_report' : '/oee_production/monthly_report';
            router.replace(path, { scroll: false });
        }
    }, [initialMachineValue, reportMode, router]);

    const fetchReport = useCallback(async () => {
        const requestId = reportRequestRef.current + 1;
        reportRequestRef.current = requestId;
        if (activeInitialMachine && (!area || !type || machine !== activeInitialMachine)) {
            setLoading(false);
            return;
        }
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
    }, [reportMode, period, area, type, machine, model, activeInitialMachine]);

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
    const isAllMachineSelection = !machine || machine === 'ALL' || machine.toLowerCase() === 'all';
    const navigationMachine = useMemo(() => {
        if (machine && machine !== 'ALL' && machine.toLowerCase() !== 'all') return machine;
        return '';
    }, [machine]);

    const preserveCurrentReportLocation = useCallback(() => {
        if (typeof window === 'undefined') return;
        const reportPath = reportMode === 'daily' ? '/oee_production/daily_report' : '/oee_production/monthly_report';
        const params = new URLSearchParams();
        if (area) params.set('area', area);
        if (type) params.set('type', type);
        params.set('machine', isAllMachineSelection ? 'ALL' : machine);
        if (model) params.set('model', model);
        const query = params.toString();
        window.history.replaceState(window.history.state, '', `${reportPath}${query ? `?${query}` : ''}`);
    }, [area, isAllMachineSelection, machine, model, reportMode, type]);

    const confirmDailyChartNavigation = useCallback(async (view: 'output' | 'status', bucketIndex: number | undefined) => {
        if (reportMode !== 'daily') return;
        if (bucketIndex == null || bucketIndex < 0) return;

        const bucket = buckets[bucketIndex];
        if (!bucket) return;

        const hasDowntime = Object.values(bucket.downtime || {}).some((value) => Number(value || 0) > 0);
        const hasOutput = Number(bucket.output || 0) > 0
            || Number(bucket.outputA || 0) > 0
            || Number(bucket.outputB || 0) > 0
            || Number(bucket.outputC || 0) > 0;
        const hasDailyData = hasOutput || hasDowntime || bucket.availability != null || bucket.runtimeMinutes != null;
        if (!hasDailyData) return;

        if (isAllMachineSelection) {
            if (!area || !type) {
                await Swal.fire({
                    title: 'Select area and type',
                    text: 'Please select area and type before opening the overall machine view.',
                    icon: 'info',
                });
                return;
            }

            const params = new URLSearchParams({
                area,
                type,
                date: bucket.key,
                view,
            });

            const result = await Swal.fire({
                title: 'Open overall machine view?',
                text: `All ${type} machines on ${bucket.key} (${view === 'status' ? 'MC Status' : 'Output'})`,
                icon: 'question',
                showCancelButton: true,
                confirmButtonText: 'Open',
                cancelButtonText: 'Cancel',
            });

            if (!result.isConfirmed) return;
            preserveCurrentReportLocation();
            localStorage.setItem('overallMachineActiveView', view);
            router.push(`/overall_machine_working?${params.toString()}`);
            return;
        }

        if (!navigationMachine) {
            await Swal.fire({
                title: 'Select one machine',
                text: 'Please select a specific machine before opening the machine view.',
                icon: 'info',
            });
            return;
        }

        const params = new URLSearchParams({
            machine_name: navigationMachine,
            date: bucket.key,
            view,
        });

        const result = await Swal.fire({
            title: 'Open machine view?',
            text: `Machine ${navigationMachine} on ${bucket.key} (${view === 'status' ? 'MC Status' : 'Output'})`,
            icon: 'question',
            showCancelButton: true,
            confirmButtonText: 'Open',
            cancelButtonText: 'Cancel',
        });

        if (!result.isConfirmed) return;
        preserveCurrentReportLocation();
        localStorage.setItem('machineWorkingTab', view);
        localStorage.setItem('machineNameLocal', navigationMachine);
        localStorage.setItem('machineDateLocal', bucket.key);
        router.push(`/machine_working?${params.toString()}`);
    }, [area, buckets, isAllMachineSelection, navigationMachine, preserveCurrentReportLocation, reportMode, router, type]);

    const downtimeMeta = useMemo(() => {
        const minutes: Record<string, Array<number | null>> = {};
        const counts: Record<string, Array<number | null>> = {};
        const runtimeMinutes: Array<number | null> = [];
        const denomMinutes: Array<number | null> = [];
        const pct: Record<string, Array<number | null>> = {};

        statusReportGroups.forEach((group) => {
            minutes[group.key] = [];
            counts[group.key] = [];
            pct[group.key] = [];
        });

        buckets.forEach((bucket) => {
            const rtMin = safeNumber(bucket.runtimeMinutes);
            const groupMinutes = statusReportGroups.map((group) => ({
                key: group.key,
                value: safeNumber(bucket.downtime?.[group.key]),
            }));

            groupMinutes.forEach(({ key, value }) => {
                minutes[key].push(value);
                counts[key].push(safeNumber(bucket.downtimeCounts?.[key]) ?? (value == null ? null : 0));
            });

            runtimeMinutes.push(rtMin);

            if (rtMin == null || groupMinutes.some(({ value }) => value == null)) {
                denomMinutes.push(null);
                statusReportGroups.forEach((group) => pct[group.key].push(null));
                return;
            }

            const downtimeTotal = groupMinutes.reduce((sum, item) => sum + (item.value || 0), 0);
            const statusBaseMin = safeNumber(bucket.statusBaseMinutes);
            const denom = reportMode === 'daily' && statusBaseMin != null
                ? statusBaseMin
                : rtMin + downtimeTotal;
            denomMinutes.push(denom > 0 ? denom : 0);

            if (denom <= 0) {
                statusReportGroups.forEach((group) => pct[group.key].push(null));
                return;
            }

            groupMinutes.forEach(({ key, value }) => {
                pct[key].push(toFixedNumber(((value || 0) / denom) * 100, 2));
            });
        });

        return { minutes, counts, runtimeMinutes, denomMinutes, pct };
    }, [buckets, statusReportGroups, reportMode]);

    const downtimeEfficiencyData = {
        labels,
        datasets: [
            ...statusReportGroups.map((group) => ({
                type: 'bar' as const,
                label: group.label,
                data: downtimeMeta.pct[group.key] || [],
                backgroundColor: hexToRgba(group.color, 0.88),
                borderColor: group.color,
                borderWidth: 1,
                stack: 'downtime',
                yAxisID: 'y',
                order: 2,
                datalabels: downtimeBarDatalabels(6, (v: number) => Math.round(v) + '%'),
            })),
            { type: 'line' as const, label: 'Availability', data: buckets.map((item) => item.availability && item.availability > 0 ? item.availability : null), borderColor: chartColors.efficiency, backgroundColor: chartColors.efficiency, tension: 0.25, yAxisID: 'y1', order: 1, pointRadius: 3, pointHoverRadius: 5, spanGaps: false, datalabels: { display: (ctx: unknown) => chartDataValue(ctx) > 0, align: 'bottom' as const, anchor: 'end' as const, offset: 6, font: { size: 9, weight: 'bold' as const }, color: chartColors.efficiency, backgroundColor: 'rgba(255,255,255,0.88)', borderRadius: 4, padding: { top: 1, bottom: 1, left: 3, right: 3 }, formatter: (v: number) => Math.round(v) + '%' } },
        ],
    };

    const outputData = {
        labels,
        datasets: [
            { type: 'bar' as const, label: 'Shift A (07:00-15:00)', data: buckets.map((item) => item.outputA), backgroundColor: '#3b82f6', stack: 'output', yAxisID: 'y', order: 2, datalabels: { display: (ctx: unknown) => chartDataValue(ctx) > 0, align: 'center' as const, anchor: 'center' as const, color: '#ffffff', font: { size: 10, weight: 'bold' as const }, formatter: (v: number) => { const n = Math.round(v); return n >= 1000 ? (n/1000).toFixed(1).replace(/\.0$/, '') + 'k' : n.toString(); } } },
            { type: 'bar' as const, label: 'Shift B (15:00-23:00)', data: buckets.map((item) => item.outputB), backgroundColor: '#14b8a6', stack: 'output', yAxisID: 'y', order: 2, datalabels: { display: (ctx: unknown) => chartDataValue(ctx) > 0, align: 'center' as const, anchor: 'center' as const, color: '#ffffff', font: { size: 10, weight: 'bold' as const }, formatter: (v: number) => { const n = Math.round(v); return n >= 1000 ? (n/1000).toFixed(1).replace(/\.0$/, '') + 'k' : n.toString(); } } },
            { type: 'bar' as const, label: 'Shift C (23:00-07:00)', data: buckets.map((item) => item.outputC), backgroundColor: '#8b5cf6', stack: 'output', yAxisID: 'y', order: 2, datalabels: { display: (ctx: unknown) => chartDataValue(ctx) > 0, align: 'center' as const, anchor: 'center' as const, color: '#ffffff', font: { size: 10, weight: 'bold' as const }, formatter: (v: number) => { const n = Math.round(v); return n >= 1000 ? (n/1000).toFixed(1).replace(/\.0$/, '') + 'k' : n.toString(); } } },
            { type: 'line' as const, label: 'Total Output', data: buckets.map((item) => item.output), borderColor: 'transparent', backgroundColor: 'transparent', pointRadius: 0, pointHoverRadius: 0, tension: 0, stack: 'total_line', yAxisID: 'y', order: 3, datalabels: { display: (ctx: unknown) => chartDataValue(ctx) > 0, align: 'top' as const, anchor: 'end' as const, offset: 4, color: '#334155', font: { size: 11, weight: 'bold' as const }, formatter: (v: number) => { const n = Math.round(v); return n >= 1000 ? (n/1000).toFixed(1).replace(/\.0$/, '') + 'k' : n.toString(); } } },
            { type: 'line' as const, label: 'Output Target', data: buckets.map((item) => item.outputTarget), borderColor: chartColors.outputTarget, borderDash: [8, 5], backgroundColor: chartColors.outputTarget, tension: 0.2, yAxisID: 'y', order: 1, pointRadius: 3, pointHoverRadius: 5, datalabels: targetDatalabels(chartColors.outputTarget, (v: number) => { const n = Math.round(v); return 'T: ' + (n >= 1000 ? (n/1000).toFixed(1).replace(/\.0$/, '') + 'k' : n.toString()); }) },
        ],
    };

    const cycleData = {
        labels,
        datasets: [
            { type: 'bar' as const, label: 'Cycle Time', data: buckets.map((item) => item.cycleTime), borderColor: chartColors.cycle, backgroundColor: chartColors.cycle, order: 2, datalabels: { display: (ctx: unknown) => chartDataValue(ctx) > 0, align: 'top' as const, anchor: 'end' as const, offset: 4, font: { size: 9, weight: 'normal' as const }, formatter: (v: number) => Number(v).toFixed(1) } },
            { type: 'line' as const, label: 'Cycle Target', data: buckets.map((item) => item.cycleTimeTarget), borderColor: chartColors.cycleTarget, borderDash: [8, 5], backgroundColor: chartColors.cycleTarget, tension: 0.2, order: 1, pointRadius: 3, pointHoverRadius: 5, datalabels: targetDatalabels(chartColors.cycleTarget, (v: number) => 'T: ' + Number(v).toFixed(1)) },
        ],
    };

    const monthlyStatusData = {
        labels,
        datasets: [
            { type: 'bar' as const, label: 'Shift A/day (07:00-15:00)', data: buckets.map((item) => item.outputPerDayA ?? item.outputA), backgroundColor: '#3b82f6', stack: 'output', yAxisID: 'y', order: 2, datalabels: { display: (ctx: unknown) => chartDataValue(ctx) > 0, align: 'center' as const, anchor: 'center' as const, color: '#ffffff', font: { size: 9, weight: 'bold' as const }, formatter: (v: number) => { const n = Math.round(v); return n >= 1000 ? (n/1000).toFixed(1).replace(/\.0$/, '') + 'k' : n.toString(); } } },
            { type: 'bar' as const, label: 'Shift B/day (15:00-23:00)', data: buckets.map((item) => item.outputPerDayB ?? item.outputB), backgroundColor: '#14b8a6', stack: 'output', yAxisID: 'y', order: 2, datalabels: { display: (ctx: unknown) => chartDataValue(ctx) > 0, align: 'center' as const, anchor: 'center' as const, color: '#ffffff', font: { size: 9, weight: 'bold' as const }, formatter: (v: number) => { const n = Math.round(v); return n >= 1000 ? (n/1000).toFixed(1).replace(/\.0$/, '') + 'k' : n.toString(); } } },
            { type: 'bar' as const, label: 'Shift C/day (23:00-07:00)', data: buckets.map((item) => item.outputPerDayC ?? item.outputC), backgroundColor: '#8b5cf6', stack: 'output', yAxisID: 'y', order: 2, datalabels: { display: (ctx: unknown) => chartDataValue(ctx) > 0, align: 'center' as const, anchor: 'center' as const, color: '#ffffff', font: { size: 9, weight: 'bold' as const }, formatter: (v: number) => { const n = Math.round(v); return n >= 1000 ? (n/1000).toFixed(1).replace(/\.0$/, '') + 'k' : n.toString(); } } },
            { type: 'line' as const, label: 'Total Output/day', data: buckets.map((item) => item.outputPerDay ?? item.output), borderColor: 'transparent', backgroundColor: 'transparent', pointRadius: 0, pointHoverRadius: 0, tension: 0, stack: 'total_line', yAxisID: 'y', order: 3, datalabels: { display: (ctx: unknown) => chartDataValue(ctx) > 0, align: 'top' as const, anchor: 'end' as const, offset: 4, color: '#334155', font: { size: 10, weight: 'bold' as const }, formatter: (v: number) => { const n = Math.round(v); return n >= 1000 ? (n/1000).toFixed(1).replace(/\.0$/, '') + 'k' : n.toString(); } } },
            { type: 'line' as const, label: 'Output Target/day', data: buckets.map((item) => item.outputTargetPerDay ?? item.outputTarget), borderColor: chartColors.outputTarget, borderDash: [8, 5], backgroundColor: chartColors.outputTarget, tension: 0.2, yAxisID: 'y', order: 1, pointRadius: 3, pointHoverRadius: 5, datalabels: targetDatalabels(chartColors.outputTarget, (v: number) => { const n = Math.round(v); return 'T: ' + (n >= 1000 ? (n/1000).toFixed(1).replace(/\.0$/, '') + 'k' : n.toString()); }) },
            { type: 'line' as const, label: 'Availability', data: buckets.map((item) => item.availability && item.availability > 0 ? item.availability : null), borderColor: chartColors.efficiency, backgroundColor: chartColors.efficiency, tension: 0.25, yAxisID: 'y1', order: 1, pointRadius: 3, pointHoverRadius: 5, spanGaps: false, datalabels: { display: (ctx: unknown) => chartDataValue(ctx) > 0, align: 'bottom' as const, anchor: 'end' as const, offset: 6, font: { size: 9, weight: 'normal' as const }, color: chartColors.efficiency, backgroundColor: 'rgba(255,255,255,0.7)', borderRadius: 4, formatter: (v: number) => Math.round(v) + '%' } },
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
            ...statusReportGroups.map((group) => ({
                label: group.label,
                data: downtimeMeta.pct[group.key] || [],
                backgroundColor: hexToRgba(group.color, 0.88),
                borderColor: group.color,
                borderWidth: 1,
                stack: 'downtime',
                order: 2,
                datalabels: downtimeBarDatalabels(3, (v: number) => v.toFixed(1) + '%'),
            })),
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
                        <button className={`btn ${reportMode === 'daily' ? 'btn-primary' : 'btn-outline-primary'}`} type="button" onClick={() => changeReportMode('daily')}>
                            Daily
                        </button>
                        <button className={`btn ${reportMode === 'monthly' ? 'btn-primary' : 'btn-outline-primary'}`} type="button" onClick={() => changeReportMode('monthly')}>
                            Monthly
                        </button>
                    </div>
                    <label className="form-label m-0 small" style={{ minWidth: '140px' }}>
                        {reportMode === 'daily' ? 'Month' : 'Fiscal Year'}
                        {reportMode === 'daily' ? (
                            <div style={{ display: 'flex', gap: '6px' }}>
                                <select
                                    className="form-select form-select-sm"
                                    value={dailyMonth}
                                    onChange={(e) => setDailyPeriodPart('month', e.target.value)}
                                    aria-label="Report month"
                                    style={{ minWidth: '105px' }}
                                >
                                    {MONTH_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                                </select>
                                <select
                                    className="form-select form-select-sm"
                                    value={dailyYear}
                                    onChange={(e) => setDailyPeriodPart('year', e.target.value)}
                                    aria-label="Report year"
                                    style={{ minWidth: '78px' }}
                                >
                                    {YEAR_OPTIONS.map((year) => <option key={year} value={year}>{year}</option>)}
                                </select>
                            </div>
                        ) : (
                            <input
                                className="form-control form-control-sm"
                                type="number"
                                value={period}
                                min="2025"
                                max="2035"
                                onChange={(e) => setMonthlyPeriod(e.target.value)}
                            />
                        )}
                    </label>
                    <label className="form-label m-0 small" style={{ minWidth: '130px' }}>
                        Area
                        <select className="form-select form-select-sm" value={area} onChange={(e) => {
                            clearInitialMachineSelection();
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
                            clearInitialMachineSelection();
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
                            clearInitialMachineSelection();
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
                            <ReportPanel title="Efficiency & Downtime (Daily)">
                                <Chart key="daily-chart-1" type="bar" data={downtimeEfficiencyData} options={chartOptions('Efficiency & Downtime (Daily)', 'Downtime [%]', {
                                    onClick: (_event, elements) => {
                                        void confirmDailyChartNavigation('status', elements[0]?.index);
                                    },
                                    plugins: {
                                        tooltip: {
                                            callbacks: {
                                                label: (ctx) => {
                                                    if (ctx.dataset.type === 'line') {
                                                        const v = ctx.parsed.y;
                                                        return `${ctx.dataset.label}: ${toFixedNumber(Number(v), 1) ?? '-'}%`;
                                                    }

                                                    const label = String(ctx.dataset.label || '');
                                                    const key = statusReportGroupKeyByLabel[label] || '';
                                                    if (!key) return `${label}: ${ctx.formattedValue}%`;

                                                    const i = ctx.dataIndex;
                                                    const pct = safeNumber(ctx.parsed.y);
                                                    const min = downtimeMeta.minutes[key][i];
                                                    const count = downtimeMeta.counts[key][i];
                                                    if (pct == null || min == null) return `${label}: -`;
                                                    const minText = `${Math.round(min)} min`;
                                                    const countText = count == null ? '-' : `${Math.round(count)} time(s)`;
                                                    return `${label}: ${toFixedNumber(pct, 1)}% (${countText}, ${minText})`;
                                                },
                                            },
                                        },
                                    },
                                    scales: {
                                        x: { stacked: true, grid: { color: '#e2e8f0' }, ticks: { color: '#64748b', autoSkip: false } },
                                        y: { stacked: true, beginAtZero: true, max: 100, title: { display: true, text: 'Downtime [%]' } },
                                        y1: { type: 'linear', axis: 'y', position: 'right', beginAtZero: true, max: 100, grid: { drawOnChartArea: false }, title: { display: true, text: 'Availability [%]' } },
                                    },
                                })} />
                            </ReportPanel>
                            <ReportPanel title="Alarm downtime (minutes)">
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
                                                        `Time: ${Math.round(minutes)} min`,
                                                        `Count: ${count} time(s)`,
                                                    ];
                                                },
                                            },
                                        },
                                        datalabels: {
                                            display: true,
                                            anchor: 'center',
                                            align: 'center',
                                            offset: 0,
                                            clamp: true,
                                            color: '#ffffff',
                                            textStrokeColor: 'rgba(15, 23, 42, 0.65)',
                                            textStrokeWidth: 2,
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
                                                if (percent < 8) return '';
                                                return `${toFixedNumber(percent, 0)}%`;
                                            },
                                        },
                                    },
                                }} />
                            </ReportPanel>
                            <ReportPanel title="Output (Daily)">
                                <Chart key="daily-chart-3" type="bar" data={outputData} options={chartOptions('Output (Daily)', 'Output [pcs]', {
                                    onClick: (_event, elements) => {
                                        void confirmDailyChartNavigation('output', elements[0]?.index);
                                    },
                                    scales: {
                                        x: { stacked: true },
                                        y: { stacked: true },
                                    }
                                })} />
                            </ReportPanel>
                            <ReportPanel title="Cycle time (Daily)">
                                <Chart key="daily-chart-4" type="line" data={cycleData} options={chartOptions('Cycle time (Daily)', 'Cycle time [sec]')} />
                            </ReportPanel>
                        </>
                    ) : (
                        <>
                            <ReportPanel title="Status of machine" style={{ gridRow: '1 / 3' }}>
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
                            </ReportPanel>
                            <ReportPanel title="Downtime">
                                <Chart key="monthly-chart-2" type="bar" data={downtimeOnlyData} options={chartOptions('Downtime', 'Downtime [%]', {
                                    plugins: {
                                        tooltip: {
                                            callbacks: {
                                                label: (ctx) => {
                                                    const label = String(ctx.dataset.label || '');
                                                    const key = statusReportGroupKeyByLabel[label] || '';
                                                    if (!key) return `${label}: ${ctx.formattedValue}%`;
                                                    const i = ctx.dataIndex;
                                                    const pct = safeNumber(ctx.parsed.y);
                                                    const min = downtimeMeta.minutes[key][i];
                                                    const count = downtimeMeta.counts[key][i];
                                                    if (pct == null || min == null) return `${label}: -`;
                                                    const minText = `${Math.round(min)} min`;
                                                    const countText = count == null ? '-' : `${Math.round(count)} time(s)`;
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
                            <ReportPanel title="Cycle Time by process">
                                <Chart key="monthly-chart-3" type="bar" data={cycleData} options={chartOptions('Cycle Time by process', 'Cycle time [sec]')} />
                            </ReportPanel>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}
