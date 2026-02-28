import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';

/**
 * SkatingRink Component
 * 
 * Loads and renders the Speed Skating Rink GLB model.
 * Positioned and scaled to serve as the environment for the SpeedSkateModel.
 */
export function SkatingRink() {
    // Load the skating rink GLB model
    const { scene } = useGLTF('/models/Speed_Skating_Rink.glb');

    // Simplified traversal: Ensure shadows and visibility for all meshes
    scene.traverse((node) => {
        if ((node as THREE.Mesh).isMesh) {
            node.castShadow = true;
            node.receiveShadow = true;
            node.visible = true; // Ensure everything is visible

            // If it's a very large mesh (like the ice), ensure it uses DoubleSide just in case
            if ((node as THREE.Mesh).material) {
                const material = (node as THREE.Mesh).material as THREE.MeshStandardMaterial;
                material.side = THREE.DoubleSide;
            }
        }
    });

    return (
        <group position={[-52, -0.1, 0]} scale={[100, 100, 100]}>
            <primitive object={scene} />
        </group>
    );
}

// Preload the model for better performance
useGLTF.preload('/models/Speed_Skating_Rink.glb');
