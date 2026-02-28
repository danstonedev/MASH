/**
 * GaitPhaseDetector
 * =================
 *
 * Detects running/walking phases using the KineticChain data.
 * Replaces the legacy GaitAnalyzer with a cleaner, chain-based approach.
 *
 * @module analysis/GaitPhaseDetector
 */

import { KineticChain } from "./KineticChain";
import type { GaitPhaseState, GaitPhaseType } from "./MovementPhase";

export class GaitPhaseDetector {
  private currentPhase: GaitPhaseType = "unknown";
  private lastPhaseChange: number = 0;

  constructor() {}

  /**
   * Update gait phase based on leg chain state
   */
  update(legChain: KineticChain, timestamp: number): GaitPhaseState {
    const { isContact, contactConfidence } = legChain.getMetrics();

    let newPhase: GaitPhaseType = this.currentPhase;

    // 1. Basic State Machine based on Contact
    if (isContact) {
      // If we were swinging, this is heel strike -> stance
      if (this.currentPhase === "swing" || this.currentPhase === "unknown") {
        newPhase = "heel_strike";
      } else if (this.currentPhase === "heel_strike") {
        // Decay into normal stance after brief impact
        if (timestamp - this.lastPhaseChange > 100) {
          newPhase = "stance";
        }
      } else {
        newPhase = "stance";
      }
    } else {
      // Not in contact - Swing or Push-off
      if (
        this.currentPhase === "stance" ||
        this.currentPhase === "heel_strike"
      ) {
        newPhase = "push_off";
      } else if (this.currentPhase === "push_off") {
        if (timestamp - this.lastPhaseChange > 100) {
          newPhase = "swing";
        }
      } else {
        newPhase = "swing";
      }
    }

    // 2. Stationary Check (if energy is very low, we aren't "gaiting")
    // But for "Standing", we are technically in Stance phase.
    // We leave it as 'stance' but the Activity Classifier will override to 'Standing' based on energy.

    if (newPhase !== this.currentPhase) {
      this.currentPhase = newPhase;
      this.lastPhaseChange = timestamp;
    }

    return {
      phase: this.currentPhase,
      confidence: contactConfidence,
      progress: 0, // TODO: Estimate progress based on stride time history
      timestamp,
    };
  }

  reset() {
    this.currentPhase = "unknown";
    this.lastPhaseChange = 0;
  }
}
