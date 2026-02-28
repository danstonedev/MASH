/**
 * Playback Panel
 * ==============
 * 
 * Session browser with breadcrumb navigation:
 * - List View: Compact table of all sessions
 * - Detail View: Selected session with export/delete options
 * 
 * Playback controls are now in PlaybackOverlay (bottom of 3D viewport)
 */

import { Database } from 'lucide-react';
import { SessionManager } from '../../ui/SessionManager';

export function PlaybackPanel() {
    return (
        <div className="flex flex-col h-full overflow-hidden">
            {/* Header */}
            <div className="flex items-center gap-2 px-3 py-2 border-b border-glass shrink-0">
                <Database className="w-4 h-4 text-accent" />
                <h2 className="text-sm font-bold">Sessions</h2>
            </div>

            {/* Session Manager (handles both list and detail views) */}
            <div className="flex-1 min-h-0 overflow-hidden">
                <SessionManager />
            </div>
        </div>
    );
}
