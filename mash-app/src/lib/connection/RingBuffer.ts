/**
 * RingBuffer - Pre-allocated circular buffer for zero-copy stream reassembly.
 *
 * Eliminates O(n) Uint8Array allocation+copy on every incoming chunk.
 * Used by both SerialConnection (USB CDC) and BLEConnection (GATT notifications)
 * for efficient binary stream buffering.
 *
 * At 200Hz × 130 bytes/frame = 26KB/s, a 32KB ring provides ~250 frames of headroom
 * without any allocation after construction.
 */

const DEFAULT_RING_BUFFER_SIZE = 32768; // 32KB

export class RingBuffer {
  private buf: Uint8Array;
  private capacity: number;
  private head = 0; // write position
  private tail = 0; // read position
  private _size = 0;
  private overflowEvents = 0;
  private overflowBytes = 0;

  constructor(size: number = DEFAULT_RING_BUFFER_SIZE) {
    this.capacity = size;
    this.buf = new Uint8Array(size);
  }

  get length(): number {
    return this._size;
  }

  /** Append data — zero-copy for most cases */
  write(data: Uint8Array): void {
    const len = data.length;
    if (len > this.capacity - this._size) {
      // Overflow: discard oldest data to make room
      const discard = len - (this.capacity - this._size);
      this.overflowEvents++;
      this.overflowBytes += discard;
      this.tail = (this.tail + discard) % this.capacity;
      this._size -= discard;
    }

    // Write in up to 2 segments (wrap around)
    const firstLen = Math.min(len, this.capacity - this.head);
    this.buf.set(data.subarray(0, firstLen), this.head);
    if (firstLen < len) {
      this.buf.set(data.subarray(firstLen), 0);
    }
    this.head = (this.head + len) % this.capacity;
    this._size += len;
  }

  /** Peek at byte at offset from tail (no copy) */
  peekByte(offset: number): number {
    return this.buf[(this.tail + offset) % this.capacity];
  }

  /** Extract a contiguous slice (copy — used only for complete frames) */
  read(len: number): Uint8Array {
    const result = new Uint8Array(len);
    const firstLen = Math.min(len, this.capacity - this.tail);
    result.set(this.buf.subarray(this.tail, this.tail + firstLen));
    if (firstLen < len) {
      result.set(this.buf.subarray(0, len - firstLen), firstLen);
    }
    this.tail = (this.tail + len) % this.capacity;
    this._size -= len;
    return result;
  }

  /** Skip bytes without copying */
  skip(len: number): void {
    const skipLen = Math.min(len, this._size);
    this.tail = (this.tail + skipLen) % this.capacity;
    this._size -= skipLen;
  }

  /** Reset to empty */
  clear(): void {
    this.head = 0;
    this.tail = 0;
    this._size = 0;
  }

  /** Return and reset overflow counters */
  drainOverflowStats(): { events: number; bytes: number } {
    const stats = { events: this.overflowEvents, bytes: this.overflowBytes };
    this.overflowEvents = 0;
    this.overflowBytes = 0;
    return stats;
  }
}
