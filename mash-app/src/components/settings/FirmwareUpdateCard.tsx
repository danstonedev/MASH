/**
 * Firmware Update Card
 * ====================
 * 
 * Standalone component for OTA firmware updates.
 * Supports WiFi OTA, SoftAP mode, and version checking.
 */

import { useState, useRef, useEffect } from 'react';
import { CheckCircle, AlertCircle, RefreshCw, Wifi, Upload, Download } from 'lucide-react';
import { useDeviceStore } from '../../store/useDeviceStore';
import { useFirmwareStore } from '../../store/useFirmwareStore';
import { cn } from '../../lib/utils';
import { Button } from '../ui/Button';

interface WifiScanResult {
    ssid: string;
    rssi: number;
    auth: boolean;
}

export function FirmwareUpdateCard() {
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [selectedFile, setSelectedFile] = useState<File | null>(null);
    const {
        isUpdating, otaProgress, startUpdate, setProgress, failUpdate, completeUpdate,
        gatewayFirmware, latestRelease, updateAvailable, initialize, setGatewayFirmware, checkStatus
    } = useFirmwareStore();
    const { isConnected, wifiIP } = useDeviceStore();

    // WiFi connection state
    const [wifiSSID, setWifiSSID] = useState('');
    const [wifiPassword, setWifiPassword] = useState('');
    const [wifiConnecting, setWifiConnecting] = useState(false);
    const [wifiError, setWifiError] = useState<string | null>(null);

    // Scanning state
    const [isScanning, setIsScanning] = useState(false);
    const [scanResults, setScanResults] = useState<WifiScanResult[]>([]);

    // SoftAP state
    const [isSoftAPMode, setIsSoftAPMode] = useState(false);
    const [softAPError, setSoftAPError] = useState<string | null>(null);

    // Initialize version check on mount or connection
    useEffect(() => {
        initialize();
        if (isConnected) {
            checkVersion();
        }
    }, [isConnected, initialize]);

    const checkVersion = async () => {
        try {
            const { connectionManager } = await import('../../lib/connection/ConnectionManager');
            const ble = connectionManager.getBLE();
            const resp = await ble.sendQuery(
                'GET_VERSION',
                (p) => p.type === 'version',
                3000
            );
            if (resp?.version) {
                setGatewayFirmware({
                    version: resp.version,
                    major: resp.major,
                    minor: resp.minor,
                    patch: resp.patch,
                    role: resp.role as any
                });
            }
        } catch (e) {
            console.warn("Version check failed:", e);
        }
    };

    const handleDownloadUpdate = () => {
        if (latestRelease?.gatewayUrl) {
            window.open(latestRelease.gatewayUrl, '_blank');
        }
    };

    const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file?.name.endsWith('.bin')) {
            setSelectedFile(file);
        } else {
            alert('Please select a .bin firmware file');
        }
    };

    const handleScanNetworks = async () => {
        if (!isConnected) return;
        setIsScanning(true);
        setScanResults([]);
        try {
            const { connectionManager } = await import('../../lib/connection/ConnectionManager');
            const ble = connectionManager.getBLE();
            const response = await ble.sendQuery(
                'SCAN_WIFI',
                (packet) => packet.type === 'wifi_scan',
                10000
            );
            if (response?.networks && Array.isArray(response.networks)) {
                setScanResults(response.networks);
            } else {
                setWifiError("No networks found");
            }
        } catch (e) {
            setWifiError("Scan failed");
        } finally {
            setIsScanning(false);
        }
    };

    const handleSoftAPToggle = async () => {
        const newMode = !isSoftAPMode;
        setSoftAPError(null);
        try {
            const { connectionManager } = await import('../../lib/connection/ConnectionManager');
            const ble = connectionManager.getBLE();
            if (newMode) {
                const resp = await ble.sendQuery(
                    'START_SOFTAP',
                    (p) => p.success === true || p.success === false,
                    5000,
                    { ssid: 'IMU-Connect-Setup', password: '' }
                );
                if (resp.success) {
                    setIsSoftAPMode(true);
                    useDeviceStore.getState().setWifiIP('192.168.4.1');
                } else {
                    throw new Error(resp.error || "Failed");
                }
            } else {
                await ble.sendCommand('STOP_SOFTAP');
                setIsSoftAPMode(false);
                if (useDeviceStore.getState().wifiIP === '192.168.4.1') {
                    useDeviceStore.getState().setWifiIP(null);
                }
            }
        } catch (e) {
            setSoftAPError(e instanceof Error ? e.message : "Command failed");
        }
    };

    const handleConnectWiFi = async () => {
        if (!wifiSSID || !isConnected) return;
        setWifiConnecting(true);
        setWifiError(null);

        try {
            const { connectionManager } = await import('../../lib/connection/ConnectionManager');
            const ble = connectionManager.getBLE();

            await ble.sendCommand('SET_WIFI', { ssid: wifiSSID, password: wifiPassword });
            await new Promise(r => setTimeout(r, 500));
            await ble.sendCommand('CONNECT_WIFI');

            let retries = 15;
            while (retries > 0) {
                await new Promise(r => setTimeout(r, 1000));
                await ble.sendCommand('GET_WIFI_STATUS');
                if (useDeviceStore.getState().wifiIP) {
                    setWifiError(null);
                    break;
                }
                retries--;
                if (retries === 0) {
                    setWifiError('WiFi connection timed out');
                }
            }
        } catch (error) {
            setWifiError(error instanceof Error ? error.message : 'WiFi setup failed');
        } finally {
            setWifiConnecting(false);
        }
    };

    const handleWiFiOTA = async () => {
        if (!selectedFile || !wifiIP) return;
        try {
            startUpdate('gateway');
            const { loadFirmwareFromFile, performWiFiOTA } = await import('../../lib/ota');
            const firmware = await loadFirmwareFromFile(selectedFile);

            await performWiFiOTA(wifiIP, firmware, (progress) => {
                setProgress({
                    phase: progress.phase === 'uploading' ? 'transferring' : progress.phase,
                    percent: progress.percent,
                    message: progress.message,
                    bytesTransferred: 0,
                    totalBytes: firmware.byteLength
                });

                if (progress.phase === 'complete') {
                    completeUpdate();
                    setSelectedFile(null);
                } else if (progress.phase === 'error') {
                    failUpdate(progress.message);
                }
            });
        } catch (error) {
            failUpdate(error instanceof Error ? error.message : 'WiFi OTA failed');
        }
    };

    return (
        <div className="space-y-4">
            {/* Version Status */}
            <div className="p-3 bg-bg-elevated rounded-lg border border-border">
                <div className="flex justify-between items-start mb-2">
                    <div>
                        <div className="text-xs text-text-secondary">Current Version</div>
                        <div className="text-sm font-mono font-bold text-text-primary">
                            {gatewayFirmware ? `v${gatewayFirmware.version}` : 'Unknown'}
                        </div>
                    </div>
                    <StatusBadge status={checkStatus} updateAvailable={updateAvailable} />
                </div>

                {updateAvailable && latestRelease && checkStatus === 'success' && (
                    <div className="p-2 bg-accent/10 rounded border border-accent/20">
                        <div className="flex justify-between items-center mb-1">
                            <span className="text-xs font-bold text-accent">New: {latestRelease.version}</span>
                            <span className="text-[9px] text-text-secondary">
                                {(latestRelease.gatewaySize / 1024).toFixed(0)} KB
                            </span>
                        </div>
                        <p className="text-[10px] text-text-secondary line-clamp-2">{latestRelease.releaseNotes}</p>
                        <button
                            onClick={handleDownloadUpdate}
                            className="mt-2 w-full py-1 bg-accent hover:bg-accent/90 text-white text-[10px] font-bold rounded flex items-center justify-center gap-1"
                        >
                            <Download className="h-3 w-3" />
                            DOWNLOAD UPDATE
                        </button>
                    </div>
                )}
            </div>

            {/* WiFi Configuration */}
            <div className="p-3 bg-bg-elevated rounded-lg space-y-3">
                <div className="text-xs font-medium text-text-secondary flex justify-between items-center">
                    <span>WiFi Configuration</span>
                    {wifiIP && <span className="text-accent">{wifiIP}</span>}
                </div>

                {!wifiIP ? (
                    <>
                        <div className="flex gap-2">
                            {scanResults.length > 0 ? (
                                <select
                                    className="flex-1 bg-bg-primary border border-border rounded-lg text-sm px-2 py-2"
                                    value={wifiSSID}
                                    onChange={(e) => setWifiSSID(e.target.value)}
                                >
                                    <option value="">Select Network...</option>
                                    {scanResults.map((n, i) => (
                                        <option key={i} value={n.ssid}>{n.ssid} ({n.rssi}dBm)</option>
                                    ))}
                                </select>
                            ) : (
                                <input
                                    type="text"
                                    placeholder="WiFi SSID"
                                    value={wifiSSID}
                                    onChange={(e) => setWifiSSID(e.target.value)}
                                    className="flex-1 px-3 py-2 bg-bg-primary border border-border rounded-lg text-sm"
                                />
                            )}
                            <Button size="sm" variant="outline" onClick={handleScanNetworks} disabled={isScanning || !isConnected}>
                                {isScanning ? <RefreshCw className="h-3 w-3 animate-spin" /> : 'Scan'}
                            </Button>
                        </div>
                        <input
                            type="password"
                            placeholder="WiFi Password"
                            value={wifiPassword}
                            onChange={(e) => setWifiPassword(e.target.value)}
                            className="w-full px-3 py-2 bg-bg-primary border border-border rounded-lg text-sm"
                        />
                        <Button size="sm" variant="outline" className="w-full" onClick={handleConnectWiFi} disabled={!wifiSSID || !isConnected || wifiConnecting}>
                            {wifiConnecting ? 'Connecting...' : 'Connect WiFi'}
                        </Button>
                    </>
                ) : (
                    <div className="text-xs text-accent flex items-center gap-1">
                        <CheckCircle className="h-3 w-3" />
                        Ready to Update
                    </div>
                )}
                {wifiError && (
                    <div className="text-xs text-red-400 flex items-center gap-1">
                        <AlertCircle className="h-3 w-3" />{wifiError}
                    </div>
                )}
            </div>

            {/* SoftAP Mode */}
            <div className="p-3 bg-bg-elevated rounded-lg border border-border/50">
                <div className="flex justify-between items-center">
                    <span className="text-xs font-medium text-text-secondary">Direct Connect (Field Mode)</span>
                    <button
                        onClick={handleSoftAPToggle}
                        className={cn(
                            "w-8 h-4 rounded-full transition-colors relative",
                            isSoftAPMode ? "bg-accent" : "bg-bg-primary border border-text-tertiary"
                        )}
                    >
                        <div className={cn(
                            "absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform",
                            isSoftAPMode ? "left-4.5" : "left-0.5"
                        )} />
                    </button>
                </div>
                {isSoftAPMode && (
                    <div className="mt-2 text-[10px] text-text-secondary p-2 bg-bg-primary rounded">
                        <p className="font-bold text-accent">1. Connect your PC WiFi to:</p>
                        <p className="font-mono bg-black/20 p-1 rounded">IMU-Connect-Setup</p>
                        <p>2. Then use the file upload below.</p>
                    </div>
                )}
                {softAPError && <p className="text-[10px] text-red-400 mt-1">{softAPError}</p>}
            </div>

            {/* File Upload & Update */}
            <div className="space-y-3">
                <input ref={fileInputRef} type="file" accept=".bin" onChange={handleFileSelect} className="hidden" />
                <button
                    onClick={() => fileInputRef.current?.click()}
                    className={cn(
                        "w-full flex items-center justify-center gap-2 py-3 rounded-lg border-2 border-dashed transition-all",
                        selectedFile ? "border-accent/50 bg-accent/5 text-accent" : "border-border hover:border-accent/30 text-text-secondary"
                    )}
                >
                    <Upload className="h-4 w-4" />
                    {selectedFile ? selectedFile.name : 'Select .bin file'}
                </button>

                {selectedFile && (
                    <div className="text-xs text-text-secondary text-center">
                        Size: {(selectedFile.size / 1024).toFixed(1)} KB
                    </div>
                )}

                {isUpdating && otaProgress && (
                    <div className="space-y-2">
                        <div className="h-2 bg-bg-elevated rounded-full overflow-hidden">
                            <div className="h-full bg-accent transition-all" style={{ width: `${otaProgress.percent}%` }} />
                        </div>
                        <div className="flex justify-between text-xs">
                            <span className="text-accent font-bold">{otaProgress.percent}%</span>
                            <span className="text-text-secondary">{otaProgress.message}</span>
                        </div>
                    </div>
                )}

                <Button size="sm" variant="gradient" className="w-full" onClick={handleWiFiOTA} disabled={!selectedFile || !wifiIP || isUpdating}>
                    {isUpdating ? 'UPDATING...' : 'START WIFI UPDATE'}
                </Button>
            </div>
        </div>
    );
}

// Status Badge Sub-component
function StatusBadge({ status, updateAvailable }: { status: string; updateAvailable: boolean }) {
    if (status === 'checking') {
        return <div className="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-bg-elevated text-text-secondary border border-border">CHECKING...</div>;
    }
    if (status === 'error' || status === 'not_found') {
        return <div className="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-warning/10 text-warning border border-warning/20">STATUS UNKNOWN</div>;
    }
    return (
        <div className={cn(
            "px-2 py-0.5 rounded text-[10px] font-bold uppercase",
            updateAvailable ? "bg-accent text-white" : "bg-success/10 text-success"
        )}>
            {updateAvailable ? 'UPDATE AVAILABLE' : 'UP TO DATE'}
        </div>
    );
}
