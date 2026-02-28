/**
 * Production-safe logging utility
 *
 * - In development: All logs are visible
 * - In production: Only errors and warnings (no debug noise)
 *
 * Usage:
 *   import { log } from '@/lib/logger';
 *   log.debug('Detailed info', data);  // Silent in production
 *   log.info('Important info');        // Silent in production
 *   log.warn('Warning');               // Always visible
 *   log.error('Error', err);           // Always visible
 */

const isDev = import.meta.env.DEV;

type LogLevel = "debug" | "info" | "warn" | "error";

interface LogOptions {
  /** Force log even in production */
  force?: boolean;
  /** Add timestamp prefix */
  timestamp?: boolean;
}

function formatMessage(
  prefix: string,
  message: string,
  timestamp: boolean,
): string {
  const ts = timestamp ? `[${new Date().toISOString()}] ` : "";
  return `${ts}[${prefix}] ${message}`;
}

function createLogger(prefix: string) {
  return {
    /**
     * Debug-level logging (dev only)
     */
    debug(message: string, ...args: unknown[]) {
      if (isDev) {
        console.debug(formatMessage(prefix, message, false), ...args);
      }
    },

    /**
     * Info-level logging (dev only)
     */
    info(message: string, ...args: unknown[]) {
      if (isDev) {
        console.info(formatMessage(prefix, message, false), ...args);
      }
    },

    /**
     * Warning-level logging (always visible)
     */
    warn(message: string, ...args: unknown[]) {
      console.warn(formatMessage(prefix, message, false), ...args);
    },

    /**
     * Error-level logging (always visible)
     */
    error(message: string, ...args: unknown[]) {
      console.error(formatMessage(prefix, message, true), ...args);
    },

    /**
     * Conditional log based on options
     */
    log(
      level: LogLevel,
      message: string,
      data?: unknown,
      options?: LogOptions,
    ) {
      const shouldLog =
        options?.force || isDev || level === "warn" || level === "error";
      if (!shouldLog) return;

      const formatted = formatMessage(
        prefix,
        message,
        options?.timestamp ?? false,
      );

      switch (level) {
        case "debug":
          console.debug(formatted, data ?? "");
          break;
        case "info":
          console.info(formatted, data ?? "");
          break;
        case "warn":
          console.warn(formatted, data ?? "");
          break;
        case "error":
          console.error(formatted, data ?? "");
          break;
      }
    },

    /**
     * Create a sub-logger with extended prefix
     */
    child(subPrefix: string) {
      return createLogger(`${prefix}:${subPrefix}`);
    },
  };
}

// Pre-configured loggers for common modules
export const log = createLogger("App");
export const bleLog = createLogger("BLE");
export const vqfLog = createLogger("VQF");
export const tareLog = createLogger("Tare");
export const calibLog = createLogger("Calib");
export const pipelineLog = createLogger("Pipeline");
export const registryLog = createLogger("Registry");
export const recordingLog = createLogger("Recording");
export const playbackLog = createLogger("Playback");

// Factory for custom loggers
export { createLogger };

// Default export
export default log;
