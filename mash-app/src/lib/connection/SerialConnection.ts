import type {
  IConnection,
  ConnectionStatus,
  ConnectionData,
} from "./IConnection";
import { IMUParser } from "./IMUParser";
import { RingBuffer } from "./RingBuffer";
import { reportSerialLoss } from "./SyncedSampleStats";
import { useOptionalSensorsStore } from "../../store/useOptionalSensorsStore";
import { useNetworkStore } from "../../store/useNetworkStore";

// Espressif VID — the USB Serial/JTAG hardware controller (ARDUINO_USB_MODE=1)
// always uses Espressif's VID regardless of the board manufacturer.
const ESPRESSIF_VID = 0x303a;

// ============================================================================
// USB CDC Baud Rate
// ============================================================================
// The ESP32-S3 uses Hardware CDC (USB Serial/JTAG controller), NOT a UART
// bridge. On native USB, the baud rate is ceremonial — data transfers at USB
// Full-Speed (12 Mbit/s) regardless. We match firmware's Serial.begin(921600)
// for consistency, but any value works identically.
// ============================================================================
const USB_CDC_BAUD_RATE = 921600;

const SERIAL_RING_HIGH_WATERMARK = 98304; // 96KB (allow larger burst absorption before PAUSE)
const SERIAL_RING_LOW_WATERMARK = 32768; // 32KB
const FLOW_CONTROL_COOLDOWN_MS = 500;
const PARSE_TIME_BUDGET_MS = 10;
const PARSE_MAX_FRAMES_PER_TICK = 256;
const MAX_PENDING_PARSE_FRAMES = 4096;
const PENDING_PARSE_COMPACT_THRESHOLD = 1024;

export class SerialConnection implements IConnection {
  type: "serial" = "serial";
  status: ConnectionStatus = "disconnected";

  private port: SerialPort | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private deviceName: string | undefined;

  private ringBuffer = new RingBuffer(65536);

  private worker: Worker | null = null;
  private workerRingLength = 0;

  private pendingFrames: Uint8Array[] = [];
  private pendingFrameStart = 0;
  private parseScheduled = false;
  private flowPaused = false;
  private lastFlowControlMs = 0;

  private stopReadLoop = false;
  private isDisconnecting = false;
  private isConnecting = false;
  private readLoopPromise: Promise<void> | null = null;

  private _onData: ((data: ConnectionData) => void) | null = null;
  private _onStatus: ((status: ConnectionStatus) => void) | null = null;

  private writeMutex = Promise.resolve();
  private debugStats = {
    chunks: 0,
    chunkBytes: 0,
    framesExtracted: 0,
    packetsDispatched: 0,
    lastChunkMs: 0,
    lastFrameMs: 0,
    lastPacketMs: 0,
    lastAsciiPreview: "",
  };
  private lastAsciiPreviewLogMs = 0;
  private lastSyncMetaLogMs = 0;

  constructor() {
    // If the OS/device disconnects (e.g., gateway resets during firmware upload),
    // we must close the port to release the COM handle.
    if (typeof navigator !== "undefined" && (navigator as any).serial) {
      try {
        (navigator as any).serial.addEventListener(
          "disconnect",
          (event: any) => {
            if (event?.port && this.port && event.port === this.port) {
              // Ignore disconnect events during connect() — the ESP32-S3
              // may momentarily drop USB on port open.
              if (this.isConnecting) {
                console.warn(
                  "[SerialConnection] Ignoring disconnect event during connect",
                );
                return;
              }
              void this.disconnect();
            }
          },
        );
      } catch {
        // Ignore listener failures (browser differences)
      }
    }
  }

  onData(callback: (data: ConnectionData) => void) {
    this._onData = callback;
  }

  onStatus(callback: (status: ConnectionStatus) => void) {
    this._onStatus = callback;
  }

  getDeviceName(): string | undefined {
    return this.deviceName;
  }

  private setStatus(status: ConnectionStatus) {
    this.status = status;
    if (this._onStatus) this._onStatus(status);
  }

  async connect(params?: { baudRate?: number }) {
    if (!navigator.serial) {
      console.error("Web Serial not supported");
      this.setStatus("error");
      return;
    }

    try {
      // Ensure we never keep a stale port open across reconnects.
      if (this.port || this.reader || this.writer) {
        await this.disconnect();
      }

      this.stopReadLoop = false;
      this.isDisconnecting = false;
      this.isConnecting = true;
      this.debugStats = {
        chunks: 0,
        chunkBytes: 0,
        framesExtracted: 0,
        packetsDispatched: 0,
        lastChunkMs: 0,
        lastFrameMs: 0,
        lastPacketMs: 0,
        lastAsciiPreview: "",
      };
      this.lastAsciiPreviewLogMs = 0;
      this.lastSyncMetaLogMs = 0;

      this.setStatus("connecting");

      // Always show the unfiltered chooser.
      //
      // We previously attempted a strict Espressif VID filter first, but on many
      // Windows setups the Gateway enumerates as a USB-UART bridge (CP210x/CH340/FTDI)
      // or a vendor-specific VID, which makes the filtered chooser appear empty.
      // That flow also caused two dialogs: an empty filtered chooser, then a second
      // chooser after the user closes/cancels the first.
      this.port = await navigator.serial.requestPort();
      const baudRate = params?.baudRate ?? USB_CDC_BAUD_RATE;

      const portInfo = this.port.getInfo();
      console.log(
        `[SerialConnection] Port selected: VID=0x${(portInfo.usbVendorId ?? 0).toString(16)}, ` +
          `PID=0x${(portInfo.usbProductId ?? 0).toString(16)}`,
      );

      console.log(
        `[SerialConnection] Opening port at ${baudRate} baud, bufferSize=65536...`,
      );
      await this.port.open({ baudRate, bufferSize: 65536 });
      console.log(
        `[SerialConnection] Port opened. readable=${!!this.port.readable}, writable=${!!this.port.writable}`,
      );

      // Assert DTR/RTS. With Hardware CDC mode (ARDUINO_USB_MODE=1), the USB
      // Serial/JTAG controller doesn't re-enumerate on boot, so a single
      // assertion is sufficient — no periodic reassertion needed.
      try {
        await this.port.setSignals({
          dataTerminalReady: true,
          requestToSend: true,
        });
        console.log("[SerialConnection] DTR/RTS signals set OK");
      } catch (e) {
        console.warn("Failed to set DTR/RTS signals:", e);
      }

      this.writer = this.port.writable?.getWriter() || null;
      console.log(`[SerialConnection] Writer acquired: ${!!this.writer}`);

      this.setupWorker();
      console.log(
        `[SerialConnection] Worker setup: ${this.worker ? "active" : "fallback (main thread)"}`,
      );

      const info = this.port.getInfo();
      if (info.usbVendorId === ESPRESSIF_VID) {
        // All USB Serial connections to an ESP32-S3 are to the Gateway
        // (Nodes communicate wirelessly via ESP-NOW, not direct USB)
        this.deviceName = "MASH Gateway";
      } else if (info.usbVendorId && info.usbProductId) {
        this.deviceName = `USB ${info.usbVendorId.toString(16)}:${info.usbProductId.toString(16)}`;
      } else {
        this.deviceName = "USB Serial";
      }

      this.readLoopPromise = this.startReadLoop();
      this.isConnecting = false;
      console.log(
        "[SerialConnection] Read loop started, setting status to connected",
      );
      this.setStatus("connected");
    } catch (error) {
      this.isConnecting = false;
      console.error("Serial Connection Error:", error);
      this.setStatus("error");
      await this.disconnect();
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  async disconnect() {
    if (this.isDisconnecting) return;
    this.isDisconnecting = true;
    this.stopReadLoop = true;

    if (this.reader) {
      try {
        await this.reader.cancel();
      } catch (e) {
        console.warn("Serial reader cancel error:", e);
      }
    }

    // Wait for the read loop to unwind and release stream locks before
    // closing the underlying port.
    try {
      await this.readLoopPromise;
    } catch {
      // ignore
    } finally {
      this.readLoopPromise = null;
    }

    if (this.reader) {
      try {
        this.reader.releaseLock();
      } catch (e) {
        console.warn("Serial reader release error:", e);
      }
      this.reader = null;
    }

    if (this.writer) {
      try {
        await this.writer.close();
      } catch (e) {
        console.warn("Serial writer close error:", e);
      }
      this.writer.releaseLock();
      this.writer = null;
    }

    if (this.port) {
      try {
        await this.port.close();
      } catch (e) {
        console.warn("Serial port close error:", e);
      }
      this.port = null;
    }

    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }

    this.ringBuffer.clear();
    this.pendingFrames = [];
    this.pendingFrameStart = 0;
    this.deviceName = undefined;
    this.isDisconnecting = false;

    this.setStatus("disconnected");
  }

  private async startReadLoop() {
    if (!this.port?.readable) {
      console.error(
        "[SerialConnection] startReadLoop: port.readable is falsy!",
        {
          port: !!this.port,
          readable: !!this.port?.readable,
        },
      );
      return;
    }

    this.reader = this.port.readable.getReader();
    const reader = this.reader;
    console.log(
      "[SerialConnection] Read loop: reader acquired, entering loop...",
    );
    let readCount = 0;
    const readLoopStartMs = Date.now();

    // Watchdog: if no data arrives within 10 seconds, log diagnostic.
    const noDataTimer = setTimeout(() => {
      if (readCount === 0) {
        console.error(
          `[SerialConnection] WATCHDOG: No data received in 10s! ` +
            `port=${!!this.port}, readable=${!!this.port?.readable}, ` +
            `reader=${!!this.reader}, stopReadLoop=${this.stopReadLoop}, ` +
            `isDisconnecting=${this.isDisconnecting}, isConnecting=${this.isConnecting}`,
        );
      }
    }, 10_000);

    try {
      while (!this.stopReadLoop) {
        const { value, done } = await reader.read();
        readCount++;
        if (readCount <= 10) {
          const elapsed = Date.now() - readLoopStartMs;
          const preview = value
            ? Array.from(value.slice(0, 20))
                .map((b) => b.toString(16).padStart(2, "0"))
                .join(" ")
            : "(null)";
          console.log(
            `[SerialConnection] Read #${readCount} @+${elapsed}ms: done=${done}, bytes=${value?.length ?? 0}, hex=[${preview}]`,
          );
        }
        if (done) {
          console.warn("[SerialConnection] Read loop: reader signaled done");
          break;
        }
        if (!value || value.length === 0) continue;
        this.handleChunk(value);
      }
    } catch (error) {
      if (!this.stopReadLoop && !this.isDisconnecting) {
        console.error("Serial Read Error:", error);
      }
    } finally {
      clearTimeout(noDataTimer);
      console.log(
        `[SerialConnection] Read loop ended after ${readCount} reads (${Date.now() - readLoopStartMs}ms)`,
      );
      try {
        reader.releaseLock();
      } catch {
        // Ignore release errors during teardown
      }
      if (this.reader === reader) {
        this.reader = null;
      }

      // If the read loop ended unexpectedly (device reset/unplug), release the COM port.
      if (!this.stopReadLoop && !this.isDisconnecting) {
        await this.disconnect();
      }
    }
  }

  private handleChunk(chunk: Uint8Array) {
    this.debugStats.chunks++;
    this.debugStats.chunkBytes += chunk.length;
    this.debugStats.lastChunkMs = Date.now();

    if (this.worker) {
      this.worker.postMessage({ type: "chunk", chunk }, [chunk.buffer]);
      return;
    }

    const deviceName = this.deviceName || "USB Serial";

    // Zero-copy append to ring buffer (no allocation)
    this.ringBuffer.write(chunk);

    const overflow = this.ringBuffer.drainOverflowStats();
    if (overflow.events > 0 || overflow.bytes > 0) {
      this.maybeAdjustFlowControl(true);
    }

    const frames: Uint8Array[] = [];
    const MAX_FRAME_LEN = 4096;
    const MIN_FRAME_LEN = 3;
    let resyncAttempts = 0;
    const MAX_RESYNC_ATTEMPTS = 64;

    while (this.ringBuffer.length >= 2) {
      const lenLo = this.ringBuffer.peekByte(0);
      const lenHi = this.ringBuffer.peekByte(1);
      const frameLen = lenLo | (lenHi << 8);

      if (frameLen < MIN_FRAME_LEN || frameLen > MAX_FRAME_LEN) {
        resyncAttempts++;
        if (resyncAttempts > MAX_RESYNC_ATTEMPTS) {
          // Keep last 512 bytes for resync
          const discard = Math.max(0, this.ringBuffer.length - 512);
          if (discard > 0) this.ringBuffer.skip(discard);
          break;
        }
        this.ringBuffer.skip(1);
        continue;
      }

      if (this.ringBuffer.length < 2 + frameLen) break; // incomplete frame

      // Validate packet type before extracting (peek at byte after length prefix)
      const packetType = this.ringBuffer.peekByte(2);
      if (
        packetType !== 0x04 &&
        packetType !== 0x05 &&
        packetType !== 0x06 &&
        packetType !== 0x25
      ) {
        // Unknown type is usually serial log/noise while discovering framing;
        // advance one byte to re-sync on the next possible length prefix.
        resyncAttempts++;
        if (resyncAttempts > MAX_RESYNC_ATTEMPTS) {
          const discard = Math.max(0, this.ringBuffer.length - 512);
          if (discard > 0) this.ringBuffer.skip(discard);
          break;
        }
        this.ringBuffer.skip(1);
        continue;
      }

      // Valid frame — skip length prefix, extract frame data
      this.ringBuffer.skip(2);
      const frame = this.ringBuffer.read(frameLen);
      frames.push(frame);
      resyncAttempts = 0;
    }

    if (!this._onData || frames.length === 0) return;

    this.debugStats.framesExtracted += frames.length;
    this.debugStats.lastFrameMs = Date.now();

    this.enqueueFrames(frames);
    this.scheduleParse(deviceName);
    this.maybeAdjustFlowControl(false);
  }

  private getPendingFrameCount(): number {
    return this.pendingFrames.length - this.pendingFrameStart;
  }

  private enqueueFrames(frames: Uint8Array[]) {
    if (frames.length === 0) return;

    this.pendingFrames.push(...frames);
    const pending = this.getPendingFrameCount();
    if (pending <= MAX_PENDING_PARSE_FRAMES) return;

    const overflow = pending - MAX_PENDING_PARSE_FRAMES;
    this.pendingFrameStart += overflow;
    if (this.pendingFrameStart > PENDING_PARSE_COMPACT_THRESHOLD) {
      this.pendingFrames = this.pendingFrames.slice(this.pendingFrameStart);
      this.pendingFrameStart = 0;
    }

    console.warn(
      `[SerialConnection] Pending parse queue overflow (${pending}). Dropped ${overflow} oldest frame(s).`,
    );
    this.maybeAdjustFlowControl(true);
  }

  private setupWorker() {
    if (typeof Worker === "undefined") return;
    if (this.worker) return;

    try {
      this.worker = new Worker(new URL("./serialWorker.ts", import.meta.url), {
        type: "module",
      });

      this.worker.onmessage = (event: MessageEvent<any>) => {
        const data = event.data;
        if (!data || data.type !== "parsed") return;

        this.handleSerialStats(data.stats || {});

        const extracted = Number(data.stats?.framesExtracted ?? 0) || 0;
        if (extracted > 0) {
          this.debugStats.framesExtracted += extracted;
          this.debugStats.lastFrameMs = Date.now();
        }

        const packets = Array.isArray(data.packets) ? data.packets : [];
        const syncFrames = Array.isArray(data.syncFrames)
          ? data.syncFrames
          : [];
        if (syncFrames.length > 0) {
          const now = Date.now();
          if (now - this.lastSyncMetaLogMs > 2000) {
            this.lastSyncMetaLogMs = now;
            const first = syncFrames[0];
            const last = syncFrames[syncFrames.length - 1];
            const union = new Set<number>();
            let advertised = 0;
            let minValid = Number.MAX_SAFE_INTEGER;
            let maxValid = 0;
            for (const frame of syncFrames) {
              advertised = Math.max(advertised, Number(frame.sensorCount || 0));
              const validCount = Array.isArray(frame.validSensorIds)
                ? frame.validSensorIds.length
                : 0;
              minValid = Math.min(minValid, validCount);
              maxValid = Math.max(maxValid, validCount);
              if (Array.isArray(frame.validSensorIds)) {
                for (const id of frame.validSensorIds) union.add(id);
              }
            }
            const minValidOut =
              minValid === Number.MAX_SAFE_INTEGER ? 0 : minValid;
            const ids = Array.from(union).sort((a, b) => a - b);
            console.info(
              `[SerialConnection] SyncMeta frames=${syncFrames.length} frameRange=${first?.frameNumber ?? "?"}-${last?.frameNumber ?? "?"} advertised=${advertised} validPerFrame=${minValidOut}-${maxValid} union=[${ids.join(",") || "none"}]`,
            );

            const network = useNetworkStore.getState();
            const sensorByNode = new Map<number, number[]>();
            for (const id of ids) {
              const nodeId = network.getNodeForSensor(id);
              const arr = sensorByNode.get(nodeId) || [];
              arr.push(id);
              sensorByNode.set(nodeId, arr);
            }

            const nodeIds = Array.from(sensorByNode.keys()).sort(
              (a, b) => a - b,
            );
            if (nodeIds.length > 0) {
              const stats = new Map<
                number,
                { min: number; max: number; framesWithData: number }
              >();
              for (const nodeId of nodeIds) {
                stats.set(nodeId, {
                  min: Number.MAX_SAFE_INTEGER,
                  max: 0,
                  framesWithData: 0,
                });
              }

              for (const frame of syncFrames) {
                const perNodeCount = new Map<number, number>();
                if (Array.isArray(frame.validSensorIds)) {
                  for (const id of frame.validSensorIds) {
                    const nodeId = network.getNodeForSensor(id);
                    perNodeCount.set(
                      nodeId,
                      (perNodeCount.get(nodeId) || 0) + 1,
                    );
                  }
                }

                for (const nodeId of nodeIds) {
                  const count = perNodeCount.get(nodeId) || 0;
                  const stat = stats.get(nodeId);
                  if (!stat) continue;
                  stat.min = Math.min(stat.min, count);
                  stat.max = Math.max(stat.max, count);
                  if (count > 0) stat.framesWithData++;
                }
              }

              const bucketSummary = nodeIds
                .map((nodeId) => {
                  const sensors = (sensorByNode.get(nodeId) || []).join(",");
                  const stat = stats.get(nodeId);
                  const minOut =
                    stat && stat.min !== Number.MAX_SAFE_INTEGER ? stat.min : 0;
                  const maxOut = stat ? stat.max : 0;
                  const present = stat
                    ? `${stat.framesWithData}/${syncFrames.length}`
                    : `0/${syncFrames.length}`;
                  return `n${nodeId}[${sensors}]:perFrame=${minOut}-${maxOut},present=${present}`;
                })
                .join(" | ");

              console.info(
                `[SerialConnection] SyncNodeBuckets ${bucketSummary}`,
              );
            }
          }
        }
        if (packets.length > 0) {
          const deviceName = this.deviceName || "USB Serial";
          this.dispatchParsedPackets(packets, deviceName);
        }
      };

      this.worker.onerror = (err) => {
        console.error("Serial worker error:", err);
        this.worker?.terminate();
        this.worker = null;
      };
    } catch (err) {
      console.warn("Failed to initialize serial worker, falling back.", err);
      this.worker = null;
    }
  }

  private handleSerialStats(stats: {
    chunkBytes?: number;
    framesExtracted?: number;
    resyncEvents?: number;
    overflowEvents?: number;
    overflowBytes?: number;
    ringLength?: number;
    rawAsciiPreview?: string;
  }) {
    // Report serial-layer losses to the pipeline loss aggregator
    const overflowBytes = stats.overflowBytes ?? 0;
    const resyncEvents = stats.resyncEvents ?? 0;
    if (overflowBytes > 0 || resyncEvents > 0) {
      reportSerialLoss(overflowBytes, resyncEvents);
      this.maybeAdjustFlowControl(true);
    }

    if (typeof stats.ringLength === "number") {
      this.workerRingLength = stats.ringLength;
      this.maybeAdjustFlowControl(false);
    }

    if (
      typeof stats.rawAsciiPreview === "string" &&
      stats.rawAsciiPreview.length > 0
    ) {
      this.debugStats.lastAsciiPreview = stats.rawAsciiPreview;
      const now = Date.now();
      if (now - this.lastAsciiPreviewLogMs > 2000) {
        this.lastAsciiPreviewLogMs = now;
        console.debug(`[Serial RAW] ${stats.rawAsciiPreview}`);
      }
    }
  }

  private scheduleParse(deviceName: string) {
    if (this.parseScheduled) return;
    this.parseScheduled = true;
    queueMicrotask(() => {
      this.parseScheduled = false;
      this.processPendingFrames(deviceName);
    });
  }

  private processPendingFrames(deviceName: string) {
    if (!this._onData) return;

    const packets: any[] = [];
    const start = performance.now();
    let processed = 0;

    while (this.pendingFrameStart < this.pendingFrames.length) {
      const frame = this.pendingFrames[this.pendingFrameStart++];
      if (!frame) break;

      const parsed = IMUParser.parseSingleFrame(
        new DataView(frame.buffer, frame.byteOffset, frame.byteLength),
      );
      if (parsed.length > 0) packets.push(...parsed);

      processed++;
      if (processed >= PARSE_MAX_FRAMES_PER_TICK) break;
      if (performance.now() - start >= PARSE_TIME_BUDGET_MS) break;
    }

    if (packets.length > 0) {
      this.dispatchParsedPackets(packets, deviceName);
    }

    if (this.pendingFrameStart > 0) {
      if (
        this.pendingFrameStart >= this.pendingFrames.length ||
        this.pendingFrameStart > PENDING_PARSE_COMPACT_THRESHOLD
      ) {
        this.pendingFrames = this.pendingFrames.slice(this.pendingFrameStart);
        this.pendingFrameStart = 0;
      }
    }

    if (this.getPendingFrameCount() > 0) {
      this.scheduleParse(deviceName);
    }
  }

  private dispatchParsedPackets(packets: any[], deviceName: string) {
    this.debugStats.packetsDispatched += packets.length;
    this.debugStats.lastPacketMs = Date.now();

    const imuPackets: any[] = [];
    for (const packet of packets) {
      if ("barometer" in packet || "magnetometer" in packet) {
        const env = packet as any;
        useOptionalSensorsStore.getState().updateFromStatus({
          hasMagnetometer: !!env.magnetometer,
          hasBarometer: !!env.barometer,
          magnetometer: env.magnetometer,
          barometer: env.barometer,
        });
        this._onData?.(env);
        continue;
      }

      if ("type" in packet || "success" in packet || "error" in packet) {
        const typedPacket = packet as { type?: string };
        if (
          typedPacket.type === "usb_boot" ||
          typedPacket.type === "usb_keepalive"
        ) {
          console.log("[SerialConnection] Transport keepalive packet:", packet);
        } else if (typedPacket.type === "gateway_pipeline_diag") {
          const diag = packet as {
            uptime_ms?: number;
            isStreaming?: boolean;
            tdmaRunning?: boolean;
            nodeCount?: number;
            espNowRxProcessed?: number;
            espNowRxDropped?: number;
            syncFramesEmitted?: number;
            beacons?: number;
          };
          console.log(
            `[SerialConnection] Gateway pipeline: uptime=${diag.uptime_ms ?? "?"}ms tdma=${diag.tdmaRunning ? "running" : "not-running"} streaming=${diag.isStreaming ? "on" : "off"} nodes=${diag.nodeCount ?? 0} rxProcessed=${diag.espNowRxProcessed ?? 0} rxDropped=${diag.espNowRxDropped ?? 0} syncFrames=${diag.syncFramesEmitted ?? 0} beacons=${diag.beacons ?? 0}`,
          );
        } else if (typedPacket.type === "gateway_ingest_diag") {
          const diag = packet as {
            window_ms?: number;
            nodes?: Array<{
              nodeId?: number;
              packets?: number;
              samplesAdded?: number;
              sampleAddFails?: number;
            }>;
          };
          const windowMs = diag.window_ms ?? 0;
          const nodeParts = Array.isArray(diag.nodes)
            ? diag.nodes.map(
                (n) =>
                  `n${n.nodeId ?? "?"}:pkts=${n.packets ?? 0},added=${n.samplesAdded ?? 0},fails=${n.sampleAddFails ?? 0}`,
              )
            : [];
          console.log(
            `[SerialConnection] Gateway ingest (${windowMs}ms): ${nodeParts.join(" | ") || "no-node-data"}`,
          );
        }
        window.dispatchEvent(
          new CustomEvent("ble-json-packet", { detail: packet }),
        );
        this._onData?.(packet as any);
        continue;
      }

      if ("nodeName" in packet) {
        const enhancedInfo = { ...packet, gatewayName: deviceName };
        this._onData?.(enhancedInfo as any);
        continue;
      }

      imuPackets.push(packet);
    }

    if (imuPackets.length > 0) {
      const prefixedPackets = imuPackets.map((p) => ({
        ...p,
        deviceId: `sensor_${p.sensorId ?? 0}`,
        sourceGateway: deviceName,
      }));
      this._onData?.(prefixedPackets);
    }
  }

  private maybeAdjustFlowControl(forcePause: boolean) {
    const now = performance.now();
    if (now - this.lastFlowControlMs < FLOW_CONTROL_COOLDOWN_MS) return;

    const ringLength = this.worker
      ? this.workerRingLength
      : this.ringBuffer.length;

    if (forcePause || ringLength >= SERIAL_RING_HIGH_WATERMARK) {
      if (!this.flowPaused) {
        this.flowPaused = true;
        this.lastFlowControlMs = now;
        void this.pauseDataFlow();
      }
      return;
    }

    if (this.flowPaused && ringLength <= SERIAL_RING_LOW_WATERMARK) {
      this.flowPaused = false;
      this.lastFlowControlMs = now;
      void this.resumeDataFlow();
    }
  }

  async sendCommand(cmd: string, params?: any) {
    if (!this.writer) return;

    const payload = params ? { cmd, ...params } : { cmd };
    const json = `${JSON.stringify(payload)}\n`;
    const data = new TextEncoder().encode(json);

    const operation = async () => {
      if (!this.writer) return;
      await this.writer.write(data);
    };

    const next = this.writeMutex.then(operation, operation);
    this.writeMutex = next.then(
      () => {},
      () => {},
    );

    return next;
  }

  getDebugStats() {
    return {
      ...this.debugStats,
      status: this.status,
      hasReader: !!this.reader,
      hasWriter: !!this.writer,
      ringLength: this.ringBuffer.length,
      workerRingLength: this.workerRingLength,
      pendingFrames: this.getPendingFrameCount(),
      flowPaused: this.flowPaused,
      lastAsciiPreview: this.debugStats.lastAsciiPreview,
    };
  }

  // ===========================================================================
  // OPP-7: USB Serial Flow Control
  // ===========================================================================
  // Sends PAUSE/RESUME commands to Gateway to control data flow.
  // Gateway stops enqueuing IMU data frames when paused (command responses
  // still flow). Use when the app can't process data fast enough.
  // ===========================================================================

  /** Pause Gateway IMU data transmission */
  async pauseDataFlow(): Promise<void> {
    await this.sendCommand("PAUSE");
    console.debug("[SerialConnection] Sent PAUSE to Gateway");
  }

  /** Resume Gateway IMU data transmission */
  async resumeDataFlow(): Promise<void> {
    await this.sendCommand("RESUME");
    console.debug("[SerialConnection] Sent RESUME to Gateway");
  }
}
