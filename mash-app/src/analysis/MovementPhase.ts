/**
 * MovementPhase
 * =============
 * 
 * Definitions for movement phases across different activity types.
 * 
 * @module analysis/MovementPhase
 */

// ============================================================================
// GAIT PHASES
// ============================================================================

export type GaitPhaseType =
    | 'stance'        // Foot on ground
    | 'push_off'      // Toe-off initiation
    | 'swing'         // Foot in air, moving forward
    | 'heel_strike'   // Impact
    | 'unknown';

export interface GaitPhaseState {
    phase: GaitPhaseType;
    confidence: number;
    progress: number; // 0-1 within the phase (if estimable)
    timestamp: number;
}

// ============================================================================
// REPETITION PHASES (Squat, Lunge, Pushup)
// ============================================================================

export type RepetitionPhaseType =
    | 'start'         // Standing / Locked out
    | 'eccentric'     // Lowering / Loading (Gravity assisted usually)
    | 'amortization'  // Bottom / Transition point
    | 'concentric'    // Lifting / Exploding (Against gravity)
    | 'end'           // Repetition complete
    | 'none';

export interface RepetitionPhaseState {
    phase: RepetitionPhaseType;
    confidence: number;
    depth: number;     // e.g., 0-1 where 1 is max depth
    timestamp: number;
}
