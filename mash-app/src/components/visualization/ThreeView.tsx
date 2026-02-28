import { Suspense } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, PerspectiveCamera, Grid } from '@react-three/drei';
import { SkeletonModel } from './SkeletonModel';
import { SpeedSkateModel } from './models/SpeedSkateModel';
import { SkatingRink } from './models/SkatingRink';
import { AnimatedSkeleton } from './AnimatedSkeleton';
import { useAnimationStore } from '../../store/useAnimationStore';
import { useDeviceRegistry } from '../../store/useDeviceRegistry';
import { usePlaybackStore } from '../../store/usePlaybackStore';
import { useRecordingStore } from '../../store/useRecordingStore';
import { useSensorAssignmentStore } from '../../store/useSensorAssignmentStore';
import { TopologyType } from '../../biomech/topology/SensorRoles';
// import { ThreeSensorView } from './ThreeSensorView';
import * as THREE from 'three';

/**
 * Playback Ticker - Advances playback time each frame
 */
function PlaybackTicker() {
    const tick = usePlaybackStore(state => state.tick);
    useFrame((_, delta) => {
        tick(delta);
    });
    return null;
}

export function ThreeView() {
    const currentAnimation = useAnimationStore(state => state.currentAnimation);
    const devices = useDeviceRegistry(state => state.devices);
    const isSimulatorRunning = useDeviceRegistry(state => state.isSimulatorRunning);
    const viewMode = useDeviceRegistry(state => state.viewMode);

    // Use unified store for topology
    const activeTopology = useSensorAssignmentStore(state => state.activeTopology);

    // Playback mode - show skeleton when playing back a session
    const playbackSessionId = usePlaybackStore(state => state.sessionId);
    const isPlaybackMode = playbackSessionId !== null;

    // Recording State for Visual Indicator
    const isRecording = useRecordingStore(state => state.isRecording);

    // Show SkeletonModel if simulator is running OR if there are any connected devices OR in playback mode
    // This allows bone targets to appear for assignment before sensors are mapped
    const hasConnectedDevices = Array.from(devices.values()).some(d => d.isConnected);
    const hasActiveDevices = isSimulatorRunning || hasConnectedDevices || isPlaybackMode;

    // Prioritize animation playback if selected
    const showLiveModel = hasActiveDevices && !currentAnimation;

    // Use different background for skate mode (lighter to show off the model)
    // Use different background for skate mode (transparent or deep dark to let the rink shine)
    const bgColor = viewMode === 'skate' ? '#000000' : '#050505';

    // Determine if we should show the specialized 3-sensor view
    // LEGACY: Disabled in favor of SkeletonModel for all leg topologies
    const showLegIK = false; // (activeTopology === TopologyType.SPARSE_LEG || activeTopology === TopologyType.FULL_LEG) && !currentAnimation && viewMode !== 'skate';

    return (
        <div className="w-full h-full relative">
            <Canvas
                gl={{ alpha: false, antialias: true }}
                onCreated={({ gl }) => {
                    gl.setClearColor(new THREE.Color(bgColor));
                }}
                shadows
            >
                <PerspectiveCamera makeDefault position={[2, 1.5, 3]} />
                <OrbitControls makeDefault target={[0, 1, 0]} />

                {/* Enhanced Lighting for Skate Mode */}
                {viewMode === 'skate' ? (
                    <>
                        {/* Much stronger ambient for the large rink */}
                        <ambientLight intensity={1.2} />

                        {/* Broad Top Light - Like stadium lighting */}
                        <directionalLight
                            position={[0, 50, 0]}
                            intensity={1.5}
                            castShadow
                            shadow-mapSize={[2048, 2048]}
                        />

                        {/* Front-Right Key */}
                        <directionalLight
                            position={[10, 10, 10]}
                            intensity={1.2}
                            color="#fffaf0"
                        />

                        {/* Left Fill */}
                        <directionalLight
                            position={[-10, 8, 5]}
                            intensity={0.8}
                            color="#e0f0ff"
                        />

                        {/* Blade lights (local to origin where skate is) */}
                        <pointLight position={[2, 0.5, 2]} intensity={2} color="#ffffff" />
                        <pointLight position={[-2, 0.5, 2]} intensity={2} color="#ffffff" />
                    </>
                ) : (
                    <>
                        {/* Original lighting for full body mode */}
                        <ambientLight intensity={0.8} />
                        <hemisphereLight args={['#ffffff', '#444444', 1.2]} />
                        <directionalLight position={[5, 10, 5]} intensity={1.5} castShadow />
                        <directionalLight position={[-5, 5, -5]} intensity={0.8} />
                    </>
                )}

                {viewMode !== 'skate' && !showLegIK && (
                    <Grid
                        args={[100, 100]}
                        fadeDistance={50}
                        fadeStrength={1}
                        followCamera={false}
                        infiniteGrid={true}
                        cellColor="#1A1A1A"
                        sectionColor="#006633"
                        position={[0, -0.01, 0]}
                    />
                )}

                <Suspense fallback={null}>
                    {viewMode === 'skate' ? (
                        <>
                            <SkatingRink />
                            <SpeedSkateModel />
                        </>
                    ) : showLegIK ? (
                        <SkeletonModel /> // Fallback, ThreeSensorView removed
                    ) : showLiveModel ? (
                        <SkeletonModel />
                    ) : (
                        <AnimatedSkeleton animationFile={currentAnimation?.file || null} />
                    )}
                </Suspense>

                {/* Playback ticker - advances playback time each frame */}
                <PlaybackTicker />
            </Canvas>

            {/* Recording Indicator Overlay */}
            {isRecording && (
                <div className="absolute top-4 right-4 flex items-center gap-2 pointer-events-none z-10" aria-label="Recording in progress" role="status">
                    <div className="w-3 h-3 rounded-full bg-red-600 animate-pulse shadow-[0_0_10px_rgba(220,38,38,0.8)]" />
                    <span className="text-red-500 font-bold text-xs tracking-wider animate-pulse">REC</span>
                </div>
            )}

            {/* Interaction Hints Overlay */}
            <div className="absolute bottom-4 left-4 flex gap-3 text-[9px] text-white/60 font-medium pointer-events-none select-none" aria-hidden="true">
                <span className="flex items-center gap-1">
                    <kbd className="px-1.5 py-0.5 rounded bg-white/10 text-white/70">Left Drag</kbd>
                    Rotate
                </span>
                <span className="flex items-center gap-1">
                    <kbd className="px-1.5 py-0.5 rounded bg-white/10 text-white/70">Right Drag</kbd>
                    Pan
                </span>
                <span className="flex items-center gap-1">
                    <kbd className="px-1.5 py-0.5 rounded bg-white/10 text-white/70">Scroll</kbd>
                    Zoom
                </span>
            </div>
        </div>
    );
}
