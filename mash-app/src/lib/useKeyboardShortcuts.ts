import { useEffect } from 'react';
import { useCalibrationStore } from '../store/useCalibrationStore';
import { useRecordingStore } from '../store/useRecordingStore';
import { useDeviceStore } from '../store/useDeviceStore';
import { useNotificationStore } from '../store/useNotificationStore';

/**
 * Global keyboard shortcuts for the application.
 * 
 * Shortcuts:
 * - Space: Quick calibrate (when connected)
 * - R: Toggle recording
 * - Escape: Close modals
 * - C: Connect/Disconnect
 */
export function useKeyboardShortcuts() {
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            // Ignore if user is typing in an input
            if (
                e.target instanceof HTMLInputElement ||
                e.target instanceof HTMLTextAreaElement ||
                e.target instanceof HTMLSelectElement
            ) {
                return;
            }

            const { isConnected } = useDeviceStore.getState();
            const { showModal, setShowModal } = useCalibrationStore.getState();
            const { isRecording, startRecording, stopRecording } = useRecordingStore.getState();
            const { info } = useNotificationStore.getState();

            switch (e.key) {
                case ' ': // Space - Open calibration
                    e.preventDefault();
                    if (isConnected && !showModal) {
                        setShowModal(true);
                        info('Calibration', 'Use the Calibration Panel to start functional calibration');
                    }
                    break;

                case 'r':
                case 'R':
                    if (e.ctrlKey || e.metaKey) return; // Don't hijack Ctrl+R
                    e.preventDefault();
                    if (isConnected) {
                        if (isRecording) {
                            stopRecording();
                            info('Recording Stopped', 'Session data ready for export');
                        } else {
                            startRecording();
                            info('Recording Started', 'Capturing IMU data...');
                        }
                    }
                    break;

                case 'Escape':
                    if (showModal) {
                        setShowModal(false);
                    }
                    break;

                case 'c':
                case 'C':
                    if (e.ctrlKey || e.metaKey) return; // Don't hijack Ctrl+C
                    e.preventDefault();
                    const { connect, disconnect } = useDeviceStore.getState();
                    if (isConnected) {
                        disconnect();
                    } else {
                        connect();
                    }
                    break;

                case '?':
                    // Show keyboard shortcuts help
                    info('Keyboard Shortcuts', 'Space: Calibrate | R: Record | C: Connect | Esc: Close');
                    break;
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, []);
}
