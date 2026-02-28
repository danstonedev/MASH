import type { IMUDataPacket } from "../ble/DeviceInterface";

/**
 * Jitter Buffer for IMU Data Stream.
 *
 * PURPOSE:
 * 1. Re-orders out-of-sequence packets (critical for Burst Mode).
 * 2. Smooths out "machine gun" arrival of deep-buffered packets.
 * 3. Ensures Monotonicity (Time never flows backwards).
 */
export class JitterBuffer {
  private buffer: { packet: IMUDataPacket; arrival: number }[] = [];
  private lastEmittedFrame: Map<number, number> = new Map(); // sensorId -> frameNumber

  // Config: How long to hold a packet to wait for stragglers?
  // 40ms = 2 BLE connection intervals. Enough to catch re-ordered notifications.
  private readonly BUFFER_DELAY_MS = 40;

  /**
   * Add raw packets from the parser to the buffer.
   * @param packets Array of parsed packets
   */
  add(packets: IMUDataPacket[]) {
    const now = performance.now();

    for (const p of packets) {
      // Sanity: Must have frameNumber
      if (p.frameNumber === undefined) {
        // Pass-through legacy packets immediately?
        // Or just treat as frame 0? Let's drop or handle special case.
        // For now, assume upgraded firmware.
        continue;
      }

      // 1. Drop Duplicates / Ancient History
      const lastFrame = this.lastEmittedFrame.get(p.sensorId || 0) ?? -1;

      // "Zombie Lockout" Fix:
      // If the packet is "old" (<= lastFrame), it's usually late/duplicate.
      // BUT, if it is *very* old (> 200 frames / 1s), it implies the sensor has Reset (rebooted).
      // In that case, we MUST accept it to avoid locking out the sensor until it catches up.
      const isLate = p.frameNumber <= lastFrame;
      const isReset = lastFrame - p.frameNumber > 200; // >1000ms "time travel" = Reset

      if (isLate && !isReset) {
        // Already emitted this frame (or newer), and it's not a reset. Drop it.
        continue;
      }

      this.buffer.push({ packet: p, arrival: now });
    }

    // 2. Sort buffer by Frame Number (Global Ordering)
    this.buffer.sort((a, b) => {
      const fA = a.packet.frameNumber!;
      const fB = b.packet.frameNumber!;
      return fA - fB;
    });
  }

  /**
   * Retrieve packets that are ready to be rendered.
   * @returns Ordered array of packets
   */
  pop(): IMUDataPacket[] {
    const now = performance.now();
    const output: IMUDataPacket[] = [];
    const remaining: { packet: IMUDataPacket; arrival: number }[] = [];

    // Strategy: Release packet if:
    // A) It has been in the buffer longer than BUFFER_DELAY_MS (Timeout release)
    // B) OR It is the EXACT next frame we expect (Contiguous release) - Optimization for low latency

    // Note: For simplicity and robustness against gaps, we primarily use Timeout Release.
    // This ensures smoothness effectively.

    for (const item of this.buffer) {
      const age = now - item.arrival;
      const sensorId = item.packet.sensorId || 0;
      const lastFrame = this.lastEmittedFrame.get(sensorId) ?? -1;

      // Valid if:
      // 1. It is the very next expected frame (last + 1)
      // 2. OR it is the CURRENT frame we are emitting (last) - for multi-sample packets
      const isSequential =
        item.packet.frameNumber === lastFrame + 1 ||
        item.packet.frameNumber === lastFrame;

      const isOldEnough = age >= this.BUFFER_DELAY_MS;

      if (isSequential || isOldEnough) {
        // Check monotonicity again just in case (e.g. multiple sensors interleaved)
        // Actually, duplicate check in add() handles this per-sensor.
        // Global sort handles inter-sensor if mostly aligned.

        output.push(item.packet);

        // Update Cursor
        // Note: If we have gaps, lastEmitted jumps.
        if (
          item.packet.frameNumber! > (this.lastEmittedFrame.get(sensorId) ?? -1)
        ) {
          this.lastEmittedFrame.set(sensorId, item.packet.frameNumber!);
        }
      } else {
        remaining.push(item);
      }
    }

    this.buffer = remaining;
    return output;
  }

  /**
   * Debugging / Stats
   */
  getStats() {
    return {
      bufferedPackets: this.buffer.length,
      // oldestFrame: this.buffer.length > 0 ? this.buffer[0].packet.frameNumber : -1
    };
  }

  /**
   * Reset buffer state. Call on disconnection.
   */
  reset() {
    this.buffer = [];
    this.lastEmittedFrame.clear();
  }
}
