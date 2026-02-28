/**
 * VisualizationThrottler - Adaptive frame rate control for 200Hz data streams
 *
 * ARCHITECTURE:
 * - Recording: Always captures full 200Hz (never throttled)
 * - Visualization: Adaptive 30-120Hz based on device performance
 *
 * The key insight is that 200Hz sensor data is overkill for human perception
 * (60Hz is plenty for smooth motion), but essential for research-grade recording
 * and post-hoc analysis (biomechanics, contact detection, etc.)
 *
 * PERFORMANCE MONITORING:
 * - Tracks actual frame times over a sliding window
 * - Automatically reduces target FPS if frames consistently exceed budget
 * - Gradually increases FPS when performance headroom exists
 * - Respects display refresh rate as upper bound
 */

// ============================================================================
// TYPES
// ============================================================================

export interface ThrottlerConfig {
  /** Target FPS for visualization (default: 60) */
  targetFPS: number;
  /** Minimum FPS before showing warning (default: 30) */
  minFPS: number;
  /** Maximum FPS cap (default: 120, limited by display) */
  maxFPS: number;
  /** Frame time threshold to trigger downgrade (percentage over budget) */
  downgradeThreshold: number;
  /** Frame time threshold to trigger upgrade (percentage under budget) */
  upgradeThreshold: number;
  /** Number of frames to average for performance decisions */
  windowSize: number;
  /** Cooldown frames after FPS change before next adjustment */
  adjustmentCooldown: number;
}

export interface ThrottlerStats {
  /** Current target FPS */
  targetFPS: number;
  /** Actual achieved FPS (rolling average) */
  actualFPS: number;
  /** Average frame time in ms */
  avgFrameTime: number;
  /** Frame budget in ms (1000 / targetFPS) */
  frameBudget: number;
  /** Percentage of budget used (avgFrameTime / frameBudget * 100) */
  budgetUsage: number;
  /** Display refresh rate (if detected) */
  displayRefreshRate: number | null;
  /** Whether throttler is actively limiting frames */
  isThrottling: boolean;
  /** Frames dropped this second due to throttling */
  droppedFrames: number;
  /** Total visualization frames rendered */
  totalFrames: number;
  /** Total data frames received (should be ~200Hz × sensors) */
  totalDataFrames: number;
}

// ============================================================================
// DEFAULT CONFIG
// ============================================================================

const DEFAULT_CONFIG: ThrottlerConfig = {
  targetFPS: 60,
  minFPS: 30,
  maxFPS: 120,
  downgradeThreshold: 1.2, // Downgrade if frame takes >120% of budget
  upgradeThreshold: 0.6, // Upgrade if frame takes <60% of budget
  windowSize: 60, // 1 second at 60fps
  adjustmentCooldown: 120, // 2 seconds at 60fps
};

// ============================================================================
// VISUALIZATION THROTTLER
// ============================================================================

class VisualizationThrottler {
  private config: ThrottlerConfig;
  private frameTimes: number[] = [];
  private lastFrameTime: number = 0;
  private lastRenderTime: number = 0;
  private framesSinceAdjustment: number = 0;
  private displayRefreshRate: number | null = null;

  // Stats tracking
  private droppedFrames: number = 0;
  private totalFrames: number = 0;
  private totalDataFrames: number = 0;

  // Callbacks
  private onFPSChange: ((fps: number) => void) | null = null;

  constructor(config: Partial<ThrottlerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.detectDisplayRefreshRate();
  }

  /**
   * Detect display refresh rate using requestAnimationFrame timing
   */
  private async detectDisplayRefreshRate(): Promise<void> {
    // Use the Screen API if available (Chrome 110+)
    if ("screen" in window && "orientation" in screen) {
      // Experimental Screen Details API
      type ScreenDetailsWindow = {
        getScreenDetails?: () => Promise<{
          currentScreen?: { refreshRate?: number };
        }>;
      };
      const screenDetails = await (window as unknown as ScreenDetailsWindow)
        .getScreenDetails?.()
        .catch(() => null);
      if (screenDetails?.currentScreen?.refreshRate) {
        this.displayRefreshRate = screenDetails.currentScreen.refreshRate;
        console.debug(
          `[Throttler] Display refresh rate detected: ${this.displayRefreshRate}Hz`,
        );
        return;
      }
    }

    // Fallback: measure via rAF
    let frames = 0;
    const startTime = performance.now();
    const measureFrames = () => {
      frames++;
      if (frames < 60) {
        requestAnimationFrame(measureFrames);
      } else {
        const elapsed = performance.now() - startTime;
        this.displayRefreshRate = Math.round(frames / (elapsed / 1000));
        console.debug(
          `[Throttler] Display refresh rate measured: ${this.displayRefreshRate}Hz`,
        );
      }
    };
    requestAnimationFrame(measureFrames);
  }

  /**
   * Record that a data frame was received (for stats)
   * Call this for every incoming 200Hz sample
   */
  recordDataFrame(): void {
    this.totalDataFrames++;
  }

  /**
   * Record that a render frame was executed (for stats when using external loop)
   * Call this from react-three-fiber's useFrame or similar external render loop
   * that already handles its own timing (unlike shouldRender() which gates rendering)
   */
  recordRenderFrame(): void {
    const now = performance.now();

    // Record frame timing for performance monitoring
    if (this.lastFrameTime > 0) {
      const actualFrameTime = now - this.lastFrameTime;
      this.recordFrameTime(actualFrameTime);
    }
    this.lastFrameTime = now;
    this.totalFrames++;
  }

  /**
   * Check if we should render this visualization frame
   * Returns true if enough time has passed since last render
   * NOTE: Use this only when YOU control the render loop.
   * For react-three-fiber useFrame, use recordRenderFrame() instead.
   */
  shouldRender(): boolean {
    const now = performance.now();
    const frameInterval = 1000 / this.config.targetFPS;
    const elapsed = now - this.lastRenderTime;

    if (elapsed >= frameInterval) {
      // Record frame timing for performance monitoring
      if (this.lastFrameTime > 0) {
        const actualFrameTime = now - this.lastFrameTime;
        this.recordFrameTime(actualFrameTime);
      }
      this.lastFrameTime = now;
      this.lastRenderTime = now;
      this.totalFrames++;
      return true;
    }

    this.droppedFrames++;
    return false;
  }

  /**
   * Record a frame time for performance monitoring
   */
  private recordFrameTime(frameTime: number): void {
    this.frameTimes.push(frameTime);

    // Keep window size bounded
    if (this.frameTimes.length > this.config.windowSize) {
      this.frameTimes.shift();
    }

    this.framesSinceAdjustment++;

    // Check if we should adjust FPS
    if (
      this.framesSinceAdjustment >= this.config.adjustmentCooldown &&
      this.frameTimes.length >= this.config.windowSize
    ) {
      this.maybeAdjustFPS();
    }
  }

  /**
   * Analyze recent performance and adjust target FPS if needed
   */
  private maybeAdjustFPS(): void {
    const avgFrameTime = this.getAverageFrameTime();
    const frameBudget = 1000 / this.config.targetFPS;
    const budgetRatio = avgFrameTime / frameBudget;

    const oldFPS = this.config.targetFPS;

    if (budgetRatio > this.config.downgradeThreshold) {
      // Performance is struggling - reduce FPS
      const newFPS = Math.max(
        this.config.minFPS,
        Math.floor(this.config.targetFPS * 0.75),
      );
      if (newFPS !== this.config.targetFPS) {
        this.config.targetFPS = newFPS;
        this.framesSinceAdjustment = 0;
        console.debug(
          `[Throttler] ⚠️ Performance degraded (${avgFrameTime.toFixed(1)}ms > ${frameBudget.toFixed(1)}ms budget). ` +
            `Reducing to ${newFPS}Hz`,
        );
      }
    } else if (budgetRatio < this.config.upgradeThreshold) {
      // Performance has headroom - try increasing FPS
      const maxAllowed = this.displayRefreshRate
        ? Math.min(this.config.maxFPS, this.displayRefreshRate)
        : this.config.maxFPS;

      const newFPS = Math.min(
        maxAllowed,
        Math.ceil(this.config.targetFPS * 1.25),
      );
      if (newFPS !== this.config.targetFPS && newFPS <= maxAllowed) {
        this.config.targetFPS = newFPS;
        this.framesSinceAdjustment = 0;
        console.debug(
          `[Throttler] ✓ Performance excellent (${avgFrameTime.toFixed(1)}ms << ${frameBudget.toFixed(1)}ms budget). ` +
            `Increasing to ${newFPS}Hz`,
        );
      }
    }

    if (oldFPS !== this.config.targetFPS && this.onFPSChange) {
      this.onFPSChange(this.config.targetFPS);
    }
  }

  /**
   * Get average frame time over the window
   */
  private getAverageFrameTime(): number {
    if (this.frameTimes.length === 0) return 0;
    return this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
  }

  /**
   * Get current throttler statistics
   */
  getStats(): ThrottlerStats {
    const avgFrameTime = this.getAverageFrameTime();
    const frameBudget = 1000 / this.config.targetFPS;
    const actualFPS = avgFrameTime > 0 ? 1000 / avgFrameTime : 0;

    return {
      targetFPS: this.config.targetFPS,
      actualFPS: Math.round(actualFPS * 10) / 10,
      avgFrameTime: Math.round(avgFrameTime * 100) / 100,
      frameBudget: Math.round(frameBudget * 100) / 100,
      budgetUsage:
        avgFrameTime > 0 ? Math.round((avgFrameTime / frameBudget) * 100) : 0,
      displayRefreshRate: this.displayRefreshRate,
      isThrottling: this.droppedFrames > 0,
      droppedFrames: this.droppedFrames,
      totalFrames: this.totalFrames,
      totalDataFrames: this.totalDataFrames,
    };
  }

  /**
   * Reset stats counters (call periodically, e.g., every second)
   */
  resetDroppedFrameCounter(): void {
    this.droppedFrames = 0;
  }

  /**
   * Set callback for FPS changes
   */
  setOnFPSChange(callback: (fps: number) => void): void {
    this.onFPSChange = callback;
  }

  /**
   * Manually set target FPS (for user override)
   */
  setTargetFPS(fps: number): void {
    const clamped = Math.max(
      this.config.minFPS,
      Math.min(this.config.maxFPS, fps),
    );
    this.config.targetFPS = clamped;
    this.framesSinceAdjustment = 0;
    console.debug(`[Throttler] Target FPS manually set to ${clamped}Hz`);
    if (this.onFPSChange) {
      this.onFPSChange(clamped);
    }
  }

  /**
   * Get current target FPS
   */
  getTargetFPS(): number {
    return this.config.targetFPS;
  }

  /**
   * Reset throttler state (e.g., on reconnect)
   */
  reset(): void {
    this.frameTimes = [];
    this.lastFrameTime = 0;
    this.lastRenderTime = 0;
    this.framesSinceAdjustment = 0;
    this.droppedFrames = 0;
    this.totalFrames = 0;
    this.totalDataFrames = 0;
    this.config.targetFPS = DEFAULT_CONFIG.targetFPS;
    console.debug("[Throttler] Reset to default 60Hz");
  }
}

// ============================================================================
// SINGLETON EXPORT
// ============================================================================

/** Global visualization throttler instance */
export const visualizationThrottler = new VisualizationThrottler();

// Debug: Expose to window for console testing
if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__vizThrottler =
    visualizationThrottler;
}
