import { describe, it, expect, vi, beforeEach } from 'vitest';
import { usePlaybackStore } from '../store/usePlaybackStore';
import { useJointAnglesStore } from '../store/useJointAnglesStore';
import { KinematicsEngine } from '../biomech/KinematicsEngine';
import reproSession from './fixtures/repro_session.json';

// Mock dependencies
vi.mock('../../store/useDeviceRegistry', () => ({
    useDeviceRegistry: {
        getState: () => ({
            devices: new Map(), // Empty in playback mode usually
        })
    },
    deviceQuaternionCache: new Map(),
}));

describe('Playback Data Flow Reproduction', () => {
    beforeEach(() => {
        usePlaybackStore.getState().unloadSession();
        useJointAnglesStore.getState().resetMinMax();
        vi.clearAllMocks();
    });

    it('should successfully update JointAnglesStore in Playback Mode (Fixed Behavior)', async () => {
        const store = usePlaybackStore.getState();

        // 1. Load Session (via setState above)
        // 1. Load Session (via setState above)
        // We inject a second sensor (pelvis) to allow hip_r calculation
        const pelvisFrames = reproSession.frames.map(f => ({ ...f, sensorId: 2, quaternion: [1, 0, 0, 0] })); // Identity
        const combinedFrames = [...reproSession.frames, ...pelvisFrames];

        usePlaybackStore.setState({
            sessionId: reproSession.session.id,
            frames: combinedFrames as any,
            framesBySensor: new Map([
                [1, reproSession.frames as any],
                [2, pelvisFrames as any]
            ]),
            sensorMapping: { 1: 'thigh_r', 2: 'pelvis' },
            isPlaying: true,
            currentTime: 0,
            duration: 5000,
            // Important: We need sensorIds for the loop!
            sensorIds: [1, 2]
        });

        // 2. Start Kinematics Engine (in playback mode)
        console.error('TEST: Starting Engine');
        KinematicsEngine.start();
        KinematicsEngine.enablePlaybackMode();
        console.error('TEST: Engine Started');

        // 3. Tick Playback (Simulate 1 second advance)
        // This should trigger injectPlaybackData -> processFrame
        console.error('TEST: Ticking Store');
        store.tick(1.0);
        console.error('TEST: Store Ticked');

        // 4. Assert Success (Expectation: Angles UPDATED because pipeline is fixed)
        const angles = useJointAnglesStore.getState().getJointAngle('hip_r');

        // This confirms the FIX: KinematicsEngine now processes playback data
        expect(angles).not.toBeNull();
        if (angles) {
            expect(angles.current).toBeDefined();
        }

        KinematicsEngine.stop();
    });
});
