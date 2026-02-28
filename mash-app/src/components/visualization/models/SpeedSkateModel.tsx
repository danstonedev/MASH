import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { useDeviceRegistry, deviceQuaternionCache } from '../../../store/useDeviceRegistry';

/**
 * Optimized Speed Skate Model
 * 
 * Loads the optimized GLB file (907 KB, down from 41 MB)
 * with WebP texture compression and geometry optimization.
 */
export function SpeedSkateModel() {
    const groupRef = useRef<THREE.Group>(null);
    const { devices } = useDeviceRegistry();

    // Load the optimized GLB model
    const { scene } = useGLTF('/models/Left_Speed_Skate_optimized.glb');

    // Get the first available sensor to drive the model
    const sensor = Array.from(devices.values())[0];

    useFrame(() => {
        if (!groupRef.current) return;

        // Targeted cleanup: Only hide things that are clearly not part of the skate
        scene.traverse((node) => {
            if ((node as THREE.Mesh).isMesh) {
                const name = node.name.toLowerCase();
                if (name.includes('grid') || name.includes('debug_floor')) {
                    node.visible = false;
                }
            }
        });

        // Try to get real-time data from cache first (high-frequency)
        let q: [number, number, number, number] | null = null;

        if (sensor) {
            // Check cache for high-frequency updates
            const cached = deviceQuaternionCache.get(sensor.id);
            if (cached) {
                q = cached;
            } else {
                q = sensor.quaternion;
            }
        }

        if (q) {
            const [w, x, y, z] = q;
            groupRef.current.quaternion.set(x, y, z, w);
        }
    });

    return (
        <group ref={groupRef} position={[0, 0.3, 0]} scale={[1.2, 1.2, 1.2]}>
            <primitive object={scene} />
        </group>
    );
}

// Preload the optimized model
useGLTF.preload('/models/Left_Speed_Skate_optimized.glb');
