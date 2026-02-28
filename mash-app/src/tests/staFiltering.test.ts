
import * as THREE from 'three';
import { estimateFunctionalAxis } from '../calibration/calibrationMath';

describe('STA Filtering (Soft Tissue Artifact)', () => {
    // Helper to generate a clean signal (e.g., knee flexion)
    const generateSignal = (frequency: number, amplitude: number, samples: number, deltaTime: number) => {
        const signal: THREE.Vector3[] = [];
        for (let i = 0; i < samples; i++) {
            const t = i * deltaTime;
            // Primary rotation around X (flexion)
            const x = Math.sin(t * frequency * 2 * Math.PI) * amplitude;
            signal.push(new THREE.Vector3(x, 0, 0));
        }
        return signal;
    };

    // Helper to add high-frequency noise (STA)
    const addNoise = (signal: THREE.Vector3[], noiseFreq: number, noiseAmp: number, deltaTime: number) => {
        return signal.map((v, i) => {
            const t = i * deltaTime;
            // Add wobble to Y/Z (soft tissue shaking orthogonal to movement)
            const noiseY = Math.sin(t * noiseFreq * 2 * Math.PI) * noiseAmp;
            const noiseZ = Math.cos(t * noiseFreq * 2 * Math.PI) * noiseAmp;
            return new THREE.Vector3(v.x, v.y + noiseY, v.z + noiseZ);
        });
    };

    it('should correctly identify axis from clean signal', () => {
        const samples = generateSignal(1, 2.0, 100, 0.016); // 1Hz movement, 60fps
        const result = estimateFunctionalAxis(samples);

        expect(result.axis.x).toBeCloseTo(1, 1);
        expect(result.axis.y).toBeCloseTo(0, 1);
        expect(result.axis.z).toBeCloseTo(0, 1);
        expect(result.confidence).toBeGreaterThan(0.9);
    });

    it('should maintain axis detection with high-frequency noise (STA)', () => {
        // 1Hz clean movement (flexion)
        const clean = generateSignal(1, 2.0, 100, 0.016);
        // Add 15Hz wobble (typical STA) with significant amplitude (0.5 rad/s)
        const noisy = addNoise(clean, 15, 0.5, 0.016);

        const result = estimateFunctionalAxis(noisy);

        // Filter should suppress the Y/Z noise and keep X dominant
        expect(Math.abs(result.axis.x)).toBeGreaterThan(0.95);
        expect(Math.abs(result.axis.y)).toBeLessThan(0.3); // Noise reduced
        expect(Math.abs(result.axis.z)).toBeLessThan(0.3);

        // Confidence should remain relatively high despite noise
        expect(result.confidence).toBeGreaterThan(0.7);
    });

    it('should not filter out slow functional movements', () => {
        // 0.5Hz slow movement - filter should preserve this
        const samples = generateSignal(0.5, 2.0, 100, 0.016);
        const result = estimateFunctionalAxis(samples);

        expect(Math.abs(result.axis.x)).toBeCloseTo(1, 1);
    });
});
