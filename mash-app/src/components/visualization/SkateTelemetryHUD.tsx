import { useEffect, useState } from 'react';
import { useDeviceRegistry, deviceQuaternionCache, deviceAccelCache, deviceGyroCache } from '../../store/useDeviceRegistry';
import * as THREE from 'three';

/**
 * SkateTelemetryHUD: Displays real-time IMU data overlay for the skate view.
 * Shows: Euler Angles (Pitch, Roll, Yaw), Acceleration (X, Y, Z), Gyro (X, Y, Z)
 */
export function SkateTelemetryHUD() {
    const { devices, viewMode } = useDeviceRegistry();
    const [eulerAngles, setEulerAngles] = useState({ pitch: 0, roll: 0, yaw: 0 });
    const [accel, setAccel] = useState({ x: 0, y: 0, z: 0 });
    const [gyro, setGyro] = useState({ x: 0, y: 0, z: 0 });

    // Get the first connected sensor (compute before useEffect)
    const sensor = Array.from(devices.values())[0];

    // Update at ~30fps for display (reading from 120Hz caches)
    // This hook must be called unconditionally (Rules of Hooks)
    useEffect(() => {
        if (!sensor || viewMode !== 'skate') return;

        const interval = setInterval(() => {
            // Get quaternion from cache (high-frequency)
            const cachedQ = deviceQuaternionCache.get(sensor.id);
            const q = cachedQ || sensor.quaternion;

            if (q) {
                // Convert quaternion to Euler angles
                const [w, x, y, z] = q;
                const threeQuat = new THREE.Quaternion(x, y, z, w);
                const euler = new THREE.Euler().setFromQuaternion(threeQuat, 'YXZ');

                // Convert to degrees
                const toDeg = 180 / Math.PI;
                setEulerAngles({
                    pitch: euler.x * toDeg,
                    roll: euler.z * toDeg,
                    yaw: euler.y * toDeg,
                });
            }

            // Get accel from high-frequency cache
            const cachedAccel = deviceAccelCache.get(sensor.id);
            if (cachedAccel) {
                const [ax, ay, az] = cachedAccel;
                setAccel({ x: ax, y: ay, z: az });
            }

            // Get gyro from high-frequency cache
            const cachedGyro = deviceGyroCache.get(sensor.id);
            if (cachedGyro) {
                const [gx, gy, gz] = cachedGyro;
                setGyro({ x: gx, y: gy, z: gz });
            }

        }, 33); // ~30fps

        return () => clearInterval(interval);
    }, [sensor, viewMode]);

    // Only show in skate mode (AFTER all hooks)
    if (viewMode !== 'skate') return null;

    if (!sensor) {
        return (
            <div className="absolute top-4 right-4 bg-black/70 backdrop-blur-sm rounded-lg p-4 text-white font-mono text-xs border border-zinc-700">
                <div className="text-amber-400">⚠ No sensor connected</div>
                <div className="text-zinc-500 mt-1">Connect a device to see live data</div>
            </div>
        );
    }

    return (
        <div className="absolute top-4 right-4 bg-black/80 backdrop-blur-md rounded-xl p-4 text-white font-mono text-xs border border-zinc-700 shadow-2xl min-w-[200px]">
            {/* Header */}
            <div className="flex items-center gap-2 mb-3 pb-2 border-b border-zinc-700">
                <div className="h-2 w-2 rounded-full bg-accent animate-pulse"></div>
                <span className="text-zinc-300 font-bold uppercase tracking-wider">Live IMU Data</span>
            </div>

            {/* Euler Angles */}
            <div className="mb-3">
                <div className="text-zinc-500 text-[10px] uppercase tracking-wider mb-1">Orientation (°)</div>
                <div className="grid grid-cols-3 gap-2">
                    <div className="bg-zinc-900/50 rounded p-2 text-center">
                        <div className="text-[10px] text-red-400">Pitch</div>
                        <div className="text-sm font-bold">{eulerAngles.pitch.toFixed(1)}</div>
                    </div>
                    <div className="bg-zinc-900/50 rounded p-2 text-center">
                        <div className="text-[10px] text-accent">Roll</div>
                        <div className="text-sm font-bold">{eulerAngles.roll.toFixed(1)}</div>
                    </div>
                    <div className="bg-zinc-900/50 rounded p-2 text-center">
                        <div className="text-[10px] text-blue-400">Yaw</div>
                        <div className="text-sm font-bold">{eulerAngles.yaw.toFixed(1)}</div>
                    </div>
                </div>
            </div>

            {/* Acceleration */}
            <div className="mb-3">
                <div className="text-zinc-500 text-[10px] uppercase tracking-wider mb-1">Acceleration (m/s²)</div>
                <div className="grid grid-cols-3 gap-2">
                    <div className="bg-zinc-900/50 rounded p-1.5 text-center">
                        <div className="text-[9px] text-red-400">X</div>
                        <div className="text-xs">{accel.x.toFixed(2)}</div>
                    </div>
                    <div className="bg-zinc-900/50 rounded p-1.5 text-center">
                        <div className="text-[9px] text-accent">Y</div>
                        <div className="text-xs">{accel.y.toFixed(2)}</div>
                    </div>
                    <div className="bg-zinc-900/50 rounded p-1.5 text-center">
                        <div className="text-[9px] text-blue-400">Z</div>
                        <div className="text-xs">{accel.z.toFixed(2)}</div>
                    </div>
                </div>
            </div>

            {/* Gyro */}
            <div>
                <div className="text-zinc-500 text-[10px] uppercase tracking-wider mb-1">Gyroscope (°/s)</div>
                <div className="grid grid-cols-3 gap-2">
                    <div className="bg-zinc-900/50 rounded p-1.5 text-center">
                        <div className="text-[9px] text-red-400">X</div>
                        <div className="text-xs">{gyro.x.toFixed(1)}</div>
                    </div>
                    <div className="bg-zinc-900/50 rounded p-1.5 text-center">
                        <div className="text-[9px] text-accent">Y</div>
                        <div className="text-xs">{gyro.y.toFixed(1)}</div>
                    </div>
                    <div className="bg-zinc-900/50 rounded p-1.5 text-center">
                        <div className="text-[9px] text-blue-400">Z</div>
                        <div className="text-xs">{gyro.z.toFixed(1)}</div>
                    </div>
                </div>
            </div>
        </div>
    );
}
