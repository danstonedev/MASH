/**
 * GRF Visualization - Force Vector Arrows in 3D Scene
 * ====================================================
 * 
 * Renders real-time Ground Reaction Force vectors at the feet.
 * Shows force magnitude and direction as 3D arrows.
 */

import { useRef, useEffect } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useGRFStore } from '../../store/useGRFStore';

// ============================================================================
// TYPES
// ============================================================================

interface GRFVectorProps {
    visible?: boolean;
    scale?: number;  // Scaling factor for arrow length
    colorScheme?: 'force' | 'phase';
    showLabels?: boolean;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const ARROW_SCALE = 0.5;  // m per BW
const ARROW_HEAD_LENGTH = 0.05;
const ARROW_HEAD_WIDTH = 0.02;

// Colors for different force magnitudes
const FORCE_COLORS = {
    low: new THREE.Color(0x4ecdc4),    // Teal - <0.5 BW
    normal: new THREE.Color(0x45b7d1), // Blue - 0.5-1.5 BW
    high: new THREE.Color(0xf39c12),   // Orange - 1.5-2.5 BW
    peak: new THREE.Color(0xe74c3c),   // Red - >2.5 BW
};

// Colors for gait phases
const PHASE_COLORS = {
    loading_response: new THREE.Color(0xe74c3c),    // Red
    mid_stance: new THREE.Color(0x45b7d1),          // Blue
    terminal_stance: new THREE.Color(0x2ecc71),     // Green
    pre_swing: new THREE.Color(0xf39c12),           // Orange
    initial_swing: new THREE.Color(0x9b59b6),       // Purple
    mid_swing: new THREE.Color(0x9b59b6),
    terminal_swing: new THREE.Color(0x9b59b6),
    unknown: new THREE.Color(0x95a5a6),             // Gray
};

// ============================================================================
// COMPONENT
// ============================================================================

export function GRFVisualization({
    visible = true,
    scale = 1,
    colorScheme = 'force',
    showLabels: _showLabels = false
}: GRFVectorProps) {
    const groupRef = useRef<THREE.Group>(null);
    const leftArrowRef = useRef<THREE.ArrowHelper | null>(null);
    const rightArrowRef = useRef<THREE.ArrowHelper | null>(null);

    // Get GRF state
    const currentGRF = useGRFStore(state => state.currentGRF);
    const supportLeg = useGRFStore(state => state.supportLeg);
    const currentPhase = useGRFStore(state => state.currentPhase);

    // Initialize arrows
    useEffect(() => {
        if (!groupRef.current) return;

        // Clean up old arrows
        if (leftArrowRef.current) groupRef.current.remove(leftArrowRef.current);
        if (rightArrowRef.current) groupRef.current.remove(rightArrowRef.current);

        // Create arrows pointing up (GRF direction)
        const dir = new THREE.Vector3(0, 1, 0);
        const origin = new THREE.Vector3(0, 0, 0);

        leftArrowRef.current = new THREE.ArrowHelper(
            dir, origin, ARROW_SCALE, 0x4ecdc4, ARROW_HEAD_LENGTH, ARROW_HEAD_WIDTH
        );
        rightArrowRef.current = new THREE.ArrowHelper(
            dir, origin, ARROW_SCALE, 0x4ecdc4, ARROW_HEAD_LENGTH, ARROW_HEAD_WIDTH
        );

        groupRef.current.add(leftArrowRef.current);
        groupRef.current.add(rightArrowRef.current);

        return () => {
            if (leftArrowRef.current && groupRef.current) {
                groupRef.current.remove(leftArrowRef.current);
            }
            if (rightArrowRef.current && groupRef.current) {
                groupRef.current.remove(rightArrowRef.current);
            }
        };
    }, []);

    // Update arrows each frame
    useFrame(() => {
        if (!visible || !currentGRF || !leftArrowRef.current || !rightArrowRef.current) {
            return;
        }

        // Foot positions (approximate)
        const leftFootPos = new THREE.Vector3(-0.12, 0, 0);
        const rightFootPos = new THREE.Vector3(0.12, 0, 0);

        // Calculate arrow direction from normalized force
        const forceDir = new THREE.Vector3(
            currentGRF.normalizedForce.x,
            currentGRF.normalizedForce.y,
            currentGRF.normalizedForce.z
        );

        // Arrow length based on vertical force magnitude
        const verticalMag = Math.abs(currentGRF.normalizedForce.y);
        const arrowLength = verticalMag * ARROW_SCALE * scale;

        // Get color based on scheme
        const color = colorScheme === 'phase'
            ? getPhaseColor(currentPhase)
            : getForceColor(verticalMag);

        // Update left foot arrow
        if (supportLeg === 'left' || supportLeg === 'double') {
            leftArrowRef.current.visible = true;
            leftArrowRef.current.position.copy(leftFootPos);
            leftArrowRef.current.setDirection(forceDir.clone().normalize());
            leftArrowRef.current.setLength(
                supportLeg === 'double' ? arrowLength * 0.5 : arrowLength,
                ARROW_HEAD_LENGTH,
                ARROW_HEAD_WIDTH
            );
            leftArrowRef.current.setColor(color);
        } else {
            leftArrowRef.current.visible = false;
        }

        // Update right foot arrow
        if (supportLeg === 'right' || supportLeg === 'double') {
            rightArrowRef.current.visible = true;
            rightArrowRef.current.position.copy(rightFootPos);
            rightArrowRef.current.setDirection(forceDir.clone().normalize());
            rightArrowRef.current.setLength(
                supportLeg === 'double' ? arrowLength * 0.5 : arrowLength,
                ARROW_HEAD_LENGTH,
                ARROW_HEAD_WIDTH
            );
            rightArrowRef.current.setColor(color);
        } else {
            rightArrowRef.current.visible = false;
        }

        // Hide both during flight
        if (supportLeg === 'flight') {
            leftArrowRef.current.visible = false;
            rightArrowRef.current.visible = false;
        }
    });

    if (!visible) return null;

    return <group ref={groupRef} />;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function getForceColor(magnitude: number): THREE.Color {
    if (magnitude < 0.5) return FORCE_COLORS.low;
    if (magnitude < 1.5) return FORCE_COLORS.normal;
    if (magnitude < 2.5) return FORCE_COLORS.high;
    return FORCE_COLORS.peak;
}

function getPhaseColor(phase: string): THREE.Color {
    return PHASE_COLORS[phase as keyof typeof PHASE_COLORS] || PHASE_COLORS.unknown;
}

// ============================================================================
// GRF CHART COMPONENT
// ============================================================================

interface GRFChartProps {
    width?: number;
    height?: number;
}

/**
 * Simple GRF time-series chart for sidebar display.
 * Uses SVG for lightweight rendering.
 */
export function GRFChart({ width = 300, height = 100 }: GRFChartProps) {
    const grfHistory = useGRFStore(state => state.grfHistory);
    const peakVertical = useGRFStore(state => state.peakVertical);

    // Only show last 200 samples
    const recentHistory = grfHistory.slice(-200);

    if (recentHistory.length < 2) {
        return (
            <div
                className="bg-black/20 rounded-lg flex items-center justify-center text-white/30 text-xs"
                style={{ width, height }}
            >
                No GRF data
            </div>
        );
    }

    // Calculate path for vertical GRF
    const padding = 10;
    const chartWidth = width - padding * 2;
    const chartHeight = height - padding * 2;
    const maxY = Math.max(3, peakVertical * 1.2);  // At least 3 BW scale

    const points = recentHistory.map((d, i) => {
        const x = padding + (i / (recentHistory.length - 1)) * chartWidth;
        const y = height - padding - (d.vertical / maxY) * chartHeight;
        return `${x},${y}`;
    }).join(' ');

    return (
        <svg width={width} height={height} className="bg-black/20 rounded-lg">
            {/* Grid lines */}
            <line x1={padding} y1={height / 2} x2={width - padding} y2={height / 2}
                stroke="white" strokeOpacity={0.1} strokeDasharray="4,4" />
            <line x1={padding} y1={height - padding} x2={width - padding} y2={height - padding}
                stroke="white" strokeOpacity={0.1} />

            {/* 1 BW reference line */}
            <line
                x1={padding}
                y1={height - padding - (1 / maxY) * chartHeight}
                x2={width - padding}
                y2={height - padding - (1 / maxY) * chartHeight}
                stroke="white" strokeOpacity={0.2}
            />
            <text
                x={width - padding - 20}
                y={height - padding - (1 / maxY) * chartHeight - 3}
                fill="white" fillOpacity={0.3} fontSize={8}
            >
                1 BW
            </text>

            {/* GRF trace */}
            <polyline
                points={points}
                fill="none"
                stroke="#4ecdc4"
                strokeWidth={2}
                strokeLinejoin="round"
            />

            {/* Peak marker */}
            <text x={padding + 2} y={padding + 10} fill="white" fillOpacity={0.6} fontSize={9}>
                Peak: {peakVertical.toFixed(2)} BW
            </text>
        </svg>
    );
}
