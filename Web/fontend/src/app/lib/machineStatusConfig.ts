import axios from "axios";
import config from "@/app/config";

export interface StatusDefinition {
    key: string;
    label: string;
    color: string;
    group: "running" | "excluded" | "downtime" | "offline";
    reportGroup?: string;
}

interface MachineStatusConfig {
    machineTypes: Record<string, { statuses?: StatusDefinition[] }>;
    default: { statuses?: StatusDefinition[] };
}

let cachedConfig: MachineStatusConfig | null = null;
let fetchPromise: Promise<MachineStatusConfig | null> | null = null;

export async function fetchMachineStatusConfig() {
    if (cachedConfig) return cachedConfig;
    if (fetchPromise) return fetchPromise;

    fetchPromise = axios.get(`${config.apiServer}/api/config/machine-status`)
        .then(res => {
            if (res.data && res.data.success) {
                cachedConfig = res.data.data;
            }
            return cachedConfig;
        })
        .catch(err => {
            console.error("Failed to fetch machine status config", err);
            return null;
        });

    return fetchPromise;
}

export async function getStatusColors(machineType?: string): Promise<Record<string, { color: string; label: string }> | null> {
    const sysConfig = await fetchMachineStatusConfig();
    if (!sysConfig) return null;

    const targetTypeConfig = sysConfig.machineTypes[machineType || "default"] || sysConfig.default;
    const statuses: StatusDefinition[] = targetTypeConfig?.statuses || sysConfig.default.statuses || [];

    const colorMap: Record<string, { color: string; label: string }> = {};
    for (const st of statuses) {
        colorMap[st.key] = { color: st.color, label: st.label };
    }
    return colorMap;
}

export async function getDowntimeKeys(machineType?: string): Promise<string[]> {
    const sysConfig = await fetchMachineStatusConfig();
    if (!sysConfig) return [];

    const targetTypeConfig = sysConfig.machineTypes[machineType || "default"] || sysConfig.default;
    const statuses: StatusDefinition[] = targetTypeConfig?.statuses || sysConfig.default.statuses || [];

    const keys: string[] = [];
    for (const st of statuses) {
        if (st.group === "downtime" || st.group === "offline") {
            keys.push(st.key);
        }
    }
    return keys;
}
