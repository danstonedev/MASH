import { useState, useEffect, lazy, Suspense } from "react";
import { Header } from "./components/layout/Header";
import { Sidebar } from "./components/layout/Sidebar";
import { SuccessToast } from "./components/ui/SuccessToast";
import { ToastContainer } from "./components/ui/ToastContainer";
import { useCalibrationStore } from "./store/useCalibrationStore";
import { useDeviceRegistry } from "./store/useDeviceRegistry";
import { useSensorAssignmentStore } from "./store/useSensorAssignmentStore";
import { usePlaybackStore } from "./store/usePlaybackStore";
import { useRecordingStore } from "./store/useRecordingStore";
import { useKeyboardShortcuts } from "./lib/useKeyboardShortcuts";

import { PlaybackOverlay } from "./components/ui/PlaybackOverlay";
import { DisconnectionAlert } from "./components/ui/DisconnectionAlert";
import { SyncStartupStatusCard } from "./components/ui/SyncStartupStatusCard";

import { KinematicsEngine } from "./biomech/KinematicsEngine";
import { db } from "./lib/db";
import { useTareStore } from "./store/useTareStore";

// Lazy load heavy components (Three.js ~1MB)
const ThreeView = lazy(() =>
  import("./components/visualization/ThreeView").then((m) => ({
    default: m.ThreeView,
  })),
);

// Loading fallback for 3D viewport
function ViewportLoader() {
  return (
    <div className="flex-1 flex items-center justify-center bg-bg-elevated">
      <div className="text-center">
        <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin mx-auto mb-3" />
        <p className="text-text-secondary text-sm">Loading 3D Viewport...</p>
      </div>
    </div>
  );
}

function App() {
  // Toast state
  const [showSuccessToast, setShowSuccessToast] = useState(false);
  const [hasShownToast, setHasShownToast] = useState(false);

  // Keyboard shortcuts
  useKeyboardShortcuts();

  // Start Kinematics Engine
  useEffect(() => {
    KinematicsEngine.start();
    return () => KinematicsEngine.stop();
  }, []);

  // CLEANUP: Purge legacy demo data from IndexedDB
  useEffect(() => {
    const purgeDemos = async () => {
      try {
        const demoCount = await db.sessions
          .filter((s) => s.id.startsWith("demo-"))
          .count();
        if (demoCount > 0) {
          console.debug(
            `[App] Found ${demoCount} legacy demo sessions - purging...`,
          );
          // Delete frames first (referential integrity usually handled by logic, not strict DB)
          const demoSessions = await db.sessions
            .filter((s) => s.id.startsWith("demo-"))
            .toArray();
          for (const s of demoSessions) {
            await db.imuFrames.where("sessionId").equals(s.id).delete();
          }
          // Delete sessions
          await db.sessions.filter((s) => s.id.startsWith("demo-")).delete();
          console.debug("[App] Legacy demo sessions purged.");
        }
      } catch (e) {
        console.warn("[App] Failed to purge demo data:", e);
      }
    };
    purgeDemos();
  }, []);

  // RESET STALE TARE/CALIBRATION DATA ON APP MOUNT
  // This prevents persisted tare states from previous sessions causing drift
  useEffect(() => {
    console.debug("[App] Resetting tare states for fresh session...");
    useTareStore.getState().resetAll();
    useCalibrationStore.getState().reset();
    console.debug(
      "[App] Session reset complete - tares and calibration cleared",
    );
  }, []);

  // Calibration state (for success toast only)
  const calibrationStep = useCalibrationStore((state) => state.calibrationStep);
  const devices = useDeviceRegistry((state) => state.devices);

  // Check if we actually have connected + assigned sensors
  // We need the assignment store to check for segments
  const { getSegmentForSensor } = useSensorAssignmentStore();
  const hasConnectedSensors = Array.from(devices.values()).some(
    (d) => d.isConnected && getSegmentForSensor(d.id),
  );

  // Playback state for view mode determination
  const isPlaybackMode = usePlaybackStore((state) => !!state.sessionId);
  const isRecording = useRecordingStore((state) => state.isRecording);

  // "Healthy Live View" Condition:
  // 1. Not in playback mode
  // 2. Sensors are connected & assigned
  // 3. System is calibrated
  const cervicalStep = useCalibrationStore((state) => state.cervicalStep);
  const isSystemHealthy =
    !isPlaybackMode &&
    hasConnectedSensors &&
    (calibrationStep === "calibrated" || cervicalStep === "verification");

  // Show success toast when calibration completes (only once AND only if sensors connected)
  useEffect(() => {
    // CRITICAL: Only show toast if we have connected sensors
    // This prevents stale toast on page refresh when calibration persisted but devices disconnected
    if (
      calibrationStep === "calibrated" &&
      !hasShownToast &&
      hasConnectedSensors
    ) {
      // Small delay to allow modal to start fading
      const timer = setTimeout(() => {
        setShowSuccessToast(true);
        setHasShownToast(true);
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [calibrationStep, hasShownToast, hasConnectedSensors]);

  return (
    <div className="h-screen w-screen bg-linear-to-br from-bg-elevated to-bg-primary text-text-primary overflow-hidden font-sans flex flex-col">
      <Header />

      <div className="flex-1 flex overflow-hidden">
        {/* Left Sidebar */}
        <Sidebar />

        {/* Main Content Area */}
        <main className="flex-1 flex overflow-hidden relative">
          {/* Center 3D Viewport with Playback Overlay */}
          <div className="flex-1 relative min-w-0 flex flex-col">
            <div className="flex-1 relative">
              <Suspense fallback={<ViewportLoader />}>
                <ThreeView />
              </Suspense>

              {/* Live View Healthy/Recording State Indicator (Glow Overlay) */}
              <div
                className={`absolute inset-0 pointer-events-none transition-all duration-700 z-10 ${
                  isRecording
                    ? "opacity-100 shadow-[inset_0_0_100px_rgba(239,68,68,0.35)] border-2 border-red-500/30 animate-pulse"
                    : isSystemHealthy
                      ? "opacity-100 shadow-[inset_0_0_100px_rgba(16,185,129,0.25)] border-2 border-emerald-500/20"
                      : "opacity-0"
                }`}
              />

              {/* Playback controls overlay at bottom of viewport */}
              <PlaybackOverlay />
            </div>
          </div>
        </main>
      </div>

      {/* CalibrationModal removed - calibration is now inline in sidebar */}

      {/* Success Toast */}
      <SuccessToast
        message="Calibration Complete!"
        isVisible={showSuccessToast}
        onHide={() => setShowSuccessToast(false)}
        duration={3000}
      />

      {/* Toast Notifications */}
      <ToastContainer />

      {/* Debug Overlay Removed */}

      {/* Global Disconnection Alert */}
      <DisconnectionAlert />

      {/* Startup Sync Readiness Card (stays visible until sync is ready) */}
      <SyncStartupStatusCard />
    </div>
  );
}

// Lazy load debug component
// Lazy load debug component
// const FilterComparisonOverlay = lazy(() => ... removed

export default App;
