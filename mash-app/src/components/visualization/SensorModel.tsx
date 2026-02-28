import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useDeviceRegistry } from '../../store/useDeviceRegistry';

/**
 * Renders a 3D cube for each connected IMU device.
 * The cube orientation is driven by the device's quaternion data.
 */
export function SensorModel() {
    const devices = useDeviceRegistry(state => state.devices);
    const deviceList = Array.from(devices.values());

    // If no devices, show a single static cube
    if (deviceList.length === 0) {
        return <SingleCube />;
    }

    // Render a cube for each device, positioned in a grid
    return (
        <group>
            {deviceList.map((device, index) => (
                <DeviceCube
                    key={device.id}
                    deviceId={device.id}
                    position={getGridPosition(index, deviceList.length)}
                />
            ))}
        </group>
    );
}

/**
 * Single static cube (shown when no devices connected)
 */
function SingleCube() {
    const meshRef = useRef<THREE.Mesh>(null!);

    useFrame((_state, delta) => {
        if (meshRef.current) {
            meshRef.current.rotation.y += delta * 0.3;
        }
    });

    return (
        <mesh ref={meshRef}>
            <boxGeometry args={[1, 1, 1]} />
            <meshStandardMaterial color="#009A44" wireframe />
        </mesh>
    );
}

/**
 * A cube driven by a specific device's quaternion
 */
function DeviceCube({ deviceId, position }: { deviceId: string; position: [number, number, number] }) {
    const meshRef = useRef<THREE.Mesh>(null!);
    const device = useDeviceRegistry(state => state.devices.get(deviceId));

    useFrame(() => {
        if (meshRef.current && device) {
            const [w, x, y, z] = device.quaternion;
            meshRef.current.quaternion.set(x, y, z, w);
        }
    });

    // Color based on segment type
    const color = device?.segment?.includes('_l') ? '#009A44' :  // Green for left
        device?.segment?.includes('_r') ? '#EF4444' :  // Red for right
            '#A3A3A3';                                      // Gray for center

    return (
        <group position={position}>
            <mesh ref={meshRef}>
                <boxGeometry args={[0.8, 0.8, 0.8]} />
                <meshStandardMaterial color={color} />
            </mesh>
            {/* Axis helper */}
            <axesHelper args={[0.6]} />
        </group>
    );
}

/**
 * Calculate grid position for multiple devices
 */
function getGridPosition(index: number, total: number): [number, number, number] {
    const cols = Math.ceil(Math.sqrt(total));
    const row = Math.floor(index / cols);
    const col = index % cols;

    const spacing = 2;
    const offsetX = ((cols - 1) * spacing) / 2;
    const offsetZ = ((Math.ceil(total / cols) - 1) * spacing) / 2;

    return [
        col * spacing - offsetX,
        0,
        row * spacing - offsetZ
    ];
}
