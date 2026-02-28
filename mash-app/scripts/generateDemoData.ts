/**
 * Pre-Generate Demo Data Script
 * ==============================
 * 
 * Run this script with: npx tsx scripts/generateDemoData.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// ESM-compatible __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// CONFIGURATION
// ============================================================================

const SAMPLE_RATE = 50;
const OUTPUT_DIR = path.join(__dirname, '../public/demo-data');

type AnimationType = 'walk' | 'stand' | 'sit' | 'limp' | 'kick' | 'swim' | 'skate';

interface DemoSession {
    id: string;
    name: string;
    durationMs: number;
    segments: { type: AnimationType; startMs: number; endMs: number }[];
    sensorCount: number;
}

interface RecordedSession {
    id: string;
    name: string;
    startTime: number;
    endTime: number;
    sensorIds: number[];
    frameCount: number;
    metadata: Record<string, unknown>;
}

interface RecordedFrame {
    sessionId: string;
    sensorId: number;
    timestamp: number;
    quaternion: [number, number, number, number];
    accelerometer: [number, number, number];
    gyroscope: [number, number, number];
    magnetometer: [number, number, number];
    linearAcceleration: [number, number, number];
    pressure: number;
    temperature: number;
}

// ============================================================================
// NOISE
// ============================================================================

function gaussianNoise(mean: number, stdDev: number): number {
    const u1 = Math.random();
    const u2 = Math.random();
    const z0 = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return mean + z0 * stdDev;
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

// ============================================================================
// FRAME GENERATORS
// ============================================================================

function generateStandFrame(timeMs: number): Partial<RecordedFrame> {
    return {
        quaternion: [clamp(gaussianNoise(1, 0.005), 0.99, 1.01), gaussianNoise(0, 0.01), gaussianNoise(0, 0.01), gaussianNoise(0, 0.01)] as [number, number, number, number],
        accelerometer: [gaussianNoise(0, 0.1), gaussianNoise(9.81, 0.15), gaussianNoise(0, 0.1)] as [number, number, number],
        gyroscope: [gaussianNoise(0, 1), gaussianNoise(0, 1), gaussianNoise(0, 1)] as [number, number, number]
    };
}

function generateWalkFrame(timeMs: number): Partial<RecordedFrame> {
    const phase = (timeMs / 1000) * Math.PI * 4;
    const stepPhase = Math.sin(phase);
    const heelStrike = Math.abs(stepPhase) > 0.9 ? 6 : 0;
    return {
        quaternion: [clamp(gaussianNoise(1, 0.02), 0.95, 1.05), gaussianNoise(Math.sin(phase * 0.5) * 0.08, 0.02), gaussianNoise(0, 0.03), gaussianNoise(Math.cos(phase * 0.5) * 0.04, 0.02)] as [number, number, number, number],
        accelerometer: [gaussianNoise(stepPhase * 1.5, 0.3), gaussianNoise(9.81 + heelStrike + Math.abs(stepPhase) * 2, 0.4), gaussianNoise(Math.cos(phase) * 1, 0.2)] as [number, number, number],
        gyroscope: [gaussianNoise(Math.cos(phase) * 40, 5), gaussianNoise(0, 8), gaussianNoise(Math.sin(phase) * 25, 4)] as [number, number, number]
    };
}

function generateLimpFrame(timeMs: number): Partial<RecordedFrame> {
    const phase = (timeMs / 1000) * Math.PI * 3;
    const leftPhase = Math.sin(phase);
    const rightPhase = Math.sin(phase + Math.PI) * 0.6;
    const heelStrike = Math.abs(leftPhase) > 0.9 ? 8 : 0;
    return {
        quaternion: [clamp(gaussianNoise(1, 0.03), 0.92, 1.08), gaussianNoise(leftPhase * 0.12, 0.03), gaussianNoise(0.05, 0.04), gaussianNoise(rightPhase * 0.08, 0.03)] as [number, number, number, number],
        accelerometer: [gaussianNoise((leftPhase + rightPhase * 0.6) * 1.8, 0.4), gaussianNoise(9.81 + heelStrike + Math.abs(leftPhase) * 2.5, 0.5), gaussianNoise(Math.cos(phase) * 1.5, 0.3)] as [number, number, number],
        gyroscope: [gaussianNoise(Math.cos(phase) * 50, 8), gaussianNoise(leftPhase * 15, 10), gaussianNoise(Math.sin(phase) * 35, 6)] as [number, number, number]
    };
}

function generateKickFrame(timeMs: number): Partial<RecordedFrame> {
    const cyclePhase = (timeMs % 2000) / 2000;
    let accelMag = cyclePhase < 0.3 ? cyclePhase * 10 : cyclePhase < 0.5 ? 15 : 2;
    let gyroMag = cyclePhase < 0.5 ? 100 : 10;
    return {
        quaternion: [clamp(gaussianNoise(1, 0.05), 0.85, 1.15), gaussianNoise(cyclePhase < 0.5 ? -0.2 : 0.1, 0.05), gaussianNoise(0, 0.08), gaussianNoise(0, 0.05)] as [number, number, number, number],
        accelerometer: [gaussianNoise(accelMag * 0.5, 1), gaussianNoise(9.81 + accelMag, 1.5), gaussianNoise(accelMag * 0.3, 0.8)] as [number, number, number],
        gyroscope: [gaussianNoise(gyroMag, 20), gaussianNoise(gyroMag * 0.3, 15), gaussianNoise(gyroMag * 0.5, 10)] as [number, number, number]
    };
}

function generateSwimFrame(timeMs: number): Partial<RecordedFrame> {
    const strokePhase = (timeMs / 1000) * Math.PI * 1.6;
    const bodyRoll = Math.sin(strokePhase * 0.5) * 0.15;
    return {
        quaternion: [clamp(gaussianNoise(0.85, 0.03), 0.8, 0.9), gaussianNoise(bodyRoll, 0.03), gaussianNoise(0.4, 0.04), gaussianNoise(0, 0.03)] as [number, number, number, number],
        accelerometer: [gaussianNoise(Math.sin(strokePhase) * 3, 0.5), gaussianNoise(2, 0.4), gaussianNoise(Math.cos(strokePhase) * 4, 0.5)] as [number, number, number],
        gyroscope: [gaussianNoise(Math.sin(strokePhase) * 80, 10), gaussianNoise(bodyRoll * 100, 15), gaussianNoise(Math.cos(strokePhase) * 60, 8)] as [number, number, number]
    };
}

function generateSkateFrame(timeMs: number): Partial<RecordedFrame> {
    const stridePhase = (timeMs / 1000) * Math.PI * 2;
    const lateralShift = Math.sin(stridePhase) * 0.2;
    return {
        quaternion: [clamp(gaussianNoise(0.95, 0.02), 0.92, 0.98), gaussianNoise(lateralShift, 0.03), gaussianNoise(0.15, 0.02), gaussianNoise(0, 0.02)] as [number, number, number, number],
        accelerometer: [gaussianNoise(lateralShift * 15, 0.6), gaussianNoise(9.81 + Math.abs(Math.sin(stridePhase)) * 4, 0.5), gaussianNoise(2, 0.4)] as [number, number, number],
        gyroscope: [gaussianNoise(lateralShift * 100, 12), gaussianNoise(Math.sin(stridePhase) * 40, 8), gaussianNoise(30, 5)] as [number, number, number]
    };
}

function generateFrameForType(type: AnimationType, timeMs: number): Partial<RecordedFrame> {
    switch (type) {
        case 'walk': return generateWalkFrame(timeMs);
        case 'limp': return generateLimpFrame(timeMs);
        case 'kick': return generateKickFrame(timeMs);
        case 'swim': return generateSwimFrame(timeMs);
        case 'skate': return generateSkateFrame(timeMs);
        default: return generateStandFrame(timeMs);
    }
}

function getTypeAtTime(segments: DemoSession['segments'], timeMs: number): AnimationType {
    for (const seg of segments) {
        if (timeMs >= seg.startMs && timeMs < seg.endMs) return seg.type;
    }
    return 'stand';
}

// ============================================================================
// DEMO SESSIONS
// ============================================================================

const DEMO_SESSIONS: DemoSession[] = [
    { id: 'demo-walk-001', name: '🚶 Walk Demo', durationMs: 60000, sensorCount: 2, segments: [{ type: 'stand', startMs: 0, endMs: 3000 }, { type: 'walk', startMs: 3000, endMs: 50000 }, { type: 'stand', startMs: 50000, endMs: 60000 }] },
    { id: 'demo-limp-001', name: '🦵 Limp Gait Demo', durationMs: 45000, sensorCount: 2, segments: [{ type: 'stand', startMs: 0, endMs: 3000 }, { type: 'limp', startMs: 3000, endMs: 40000 }, { type: 'stand', startMs: 40000, endMs: 45000 }] },
    { id: 'demo-kick-001', name: '⚽ Kick Training Demo', durationMs: 30000, sensorCount: 2, segments: [{ type: 'stand', startMs: 0, endMs: 2000 }, { type: 'kick', startMs: 2000, endMs: 28000 }, { type: 'stand', startMs: 28000, endMs: 30000 }] },
    { id: 'demo-swim-001', name: '🏊 Swim Demo', durationMs: 40000, sensorCount: 2, segments: [{ type: 'stand', startMs: 0, endMs: 3000 }, { type: 'swim', startMs: 3000, endMs: 37000 }, { type: 'stand', startMs: 37000, endMs: 40000 }] },
    { id: 'demo-skate-001', name: '⛸️ Speed Skate Demo', durationMs: 50000, sensorCount: 2, segments: [{ type: 'stand', startMs: 0, endMs: 3000 }, { type: 'skate', startMs: 3000, endMs: 47000 }, { type: 'stand', startMs: 47000, endMs: 50000 }] }
];

// ============================================================================
// GENERATE
// ============================================================================

function generateSession(config: DemoSession): { session: RecordedSession; frames: RecordedFrame[] } {
    const baseTime = Date.now() - config.durationMs;
    const frameInterval = 1000 / SAMPLE_RATE;
    const frames: RecordedFrame[] = [];

    for (let sensorId = 1; sensorId <= config.sensorCount; sensorId++) {
        for (let frameTime = 0; frameTime < config.durationMs; frameTime += frameInterval) {
            const animType = getTypeAtTime(config.segments, frameTime);
            const frameData = generateFrameForType(animType, frameTime);
            frames.push({
                sessionId: config.id, sensorId, timestamp: baseTime + frameTime,
                quaternion: frameData.quaternion!, accelerometer: frameData.accelerometer!, gyroscope: frameData.gyroscope!,
                magnetometer: [0, 0, 0], linearAcceleration: frameData.accelerometer!,
                pressure: 101325 + gaussianNoise(0, 50), temperature: 25 + gaussianNoise(0, 0.5)
            });
        }
    }

    return {
        session: { id: config.id, name: config.name, startTime: baseTime, endTime: baseTime + config.durationMs, sensorIds: [1, 2], frameCount: frames.length, metadata: { sampleRate: SAMPLE_RATE, isDemo: true } },
        frames
    };
}

// ============================================================================
// MAIN
// ============================================================================

console.log('🎬 Generating pre-computed demo data...\n');

if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

const allSessions: RecordedSession[] = [];

for (const config of DEMO_SESSIONS) {
    console.log(`  Generating: ${config.name}...`);
    const { session, frames } = generateSession(config);
    fs.writeFileSync(path.join(OUTPUT_DIR, `${config.id}-frames.json`), JSON.stringify(frames));
    console.log(`    ✓ ${frames.length} frames`);
    allSessions.push(session);
}

fs.writeFileSync(path.join(OUTPUT_DIR, 'sessions.json'), JSON.stringify(allSessions, null, 2));
console.log(`\n✅ Saved ${allSessions.length} sessions to public/demo-data/`);

let totalSize = 0;
for (const file of fs.readdirSync(OUTPUT_DIR)) {
    totalSize += fs.statSync(path.join(OUTPUT_DIR, file)).size;
}
console.log(`📦 Total size: ${(totalSize / 1024 / 1024).toFixed(2)} MB`);
