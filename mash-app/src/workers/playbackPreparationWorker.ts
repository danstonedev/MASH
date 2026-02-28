/// <reference lib="webworker" />

import {
  preparePlaybackSession,
  type PreparePlaybackSessionInput,
} from "../lib/playback/preparePlaybackSession";

self.onmessage = (event: MessageEvent<PreparePlaybackSessionInput>) => {
  try {
    const result = preparePlaybackSession(event.data);

    const transferables: Transferable[] = [];
    for (const timeline of Object.values(result.packedTimelinesBySensor)) {
      transferables.push(
        timeline.timestamps.buffer,
        timeline.quaternions.buffer,
        timeline.accelerometer.buffer,
        timeline.gyro.buffer,
      );
      if (timeline.frameNumbers) {
        transferables.push(timeline.frameNumbers.buffer);
      }
    }

    self.postMessage({ ok: true, result }, transferables);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    self.postMessage({ ok: false, error: message });
  }
};

export {};
