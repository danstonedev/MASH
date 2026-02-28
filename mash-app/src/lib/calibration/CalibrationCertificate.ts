/**
 * Calibration Certificate Module
 * ==============================
 * 
 * Generates and manages calibration certificates for research traceability.
 * Each certificate documents the conditions and parameters of a sensor calibration.
 * 
 * Requirements for publication:
 * - Calibration timestamp
 * - Device identification
 * - Gyro bias values
 * - Environmental conditions (if available)
 * - Firmware version
 * 
 * @module CalibrationCertificate
 */

// ============================================================================
// TYPES
// ============================================================================

export interface CalibrationCertificate {
    /** Unique certificate ID */
    id: string;

    /** Device/sensor ID */
    deviceId: string;

    /** Device name (user-assigned) */
    deviceName: string;

    /** Calibration timestamp (ISO 8601) */
    timestamp: string;

    /** Unix epoch timestamp (ms) */
    epochMs: number;

    /** Firmware version at calibration */
    firmwareVersion: string;

    /** Gyroscope bias [x, y, z] in rad/s */
    gyroBias: [number, number, number];

    /** Accelerometer offset [x, y, z] in g */
    accelOffset: [number, number, number];

    /** Chip temperature at calibration (°C), if available */
    temperature: number | null;

    /** Calibration type */
    calibrationType: 't_pose' | 'n_pose' | 'functional' | 'auto' | 'full';

    /** Quality score (0-100) */
    qualityScore: number;

    /** Duration of calibration process (ms) */
    calibrationDurationMs: number;

    /** Number of samples used */
    sampleCount: number;

    /** Additional metadata */
    metadata: Record<string, string | number | boolean>;
}

export interface CertificateStore {
    certificates: CalibrationCertificate[];
    lastUpdated: number;
}

// ============================================================================
// CERTIFICATE GENERATION
// ============================================================================

/**
 * Generate a unique certificate ID.
 */
function generateCertificateId(): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 8);
    return `CAL-${timestamp}-${random}`.toUpperCase();
}

/**
 * Create a calibration certificate from current calibration state.
 */
export function createCalibrationCertificate(params: {
    deviceId: string;
    deviceName: string;
    gyroBias: [number, number, number];
    accelOffset?: [number, number, number];
    calibrationType: CalibrationCertificate['calibrationType'];
    qualityScore: number;
    sampleCount: number;
    calibrationDurationMs: number;
    temperature?: number;
    firmwareVersion?: string;
    metadata?: Record<string, string | number | boolean>;
}): CalibrationCertificate {
    const now = new Date();

    return {
        id: generateCertificateId(),
        deviceId: params.deviceId,
        deviceName: params.deviceName,
        timestamp: now.toISOString(),
        epochMs: now.getTime(),
        firmwareVersion: params.firmwareVersion || 'unknown',
        gyroBias: params.gyroBias,
        accelOffset: params.accelOffset || [0, 0, 0],
        temperature: params.temperature || null,
        calibrationType: params.calibrationType,
        qualityScore: params.qualityScore,
        calibrationDurationMs: params.calibrationDurationMs,
        sampleCount: params.sampleCount,
        metadata: params.metadata || {},
    };
}

// ============================================================================
// STORAGE
// ============================================================================

const STORAGE_KEY = 'imu_connect_calibration_certificates';

/**
 * Save certificate to local storage.
 */
export function saveCertificate(certificate: CalibrationCertificate): void {
    const store = loadCertificateStore();

    // Update or add certificate
    const existingIdx = store.certificates.findIndex(c => c.deviceId === certificate.deviceId);
    if (existingIdx >= 0) {
        store.certificates[existingIdx] = certificate;
    } else {
        store.certificates.push(certificate);
    }

    store.lastUpdated = Date.now();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}

/**
 * Load all certificates from storage.
 */
export function loadCertificateStore(): CertificateStore {
    try {
        const data = localStorage.getItem(STORAGE_KEY);
        if (data) {
            return JSON.parse(data);
        }
    } catch (e) {
        console.warn('[CalibrationCertificate] Failed to load certificates:', e);
    }

    return { certificates: [], lastUpdated: 0 };
}

/**
 * Get certificate for a specific device.
 */
export function getCertificateForDevice(deviceId: string): CalibrationCertificate | null {
    const store = loadCertificateStore();
    return store.certificates.find(c => c.deviceId === deviceId) || null;
}

/**
 * Delete certificate for a device.
 */
export function deleteCertificate(deviceId: string): void {
    const store = loadCertificateStore();
    store.certificates = store.certificates.filter(c => c.deviceId !== deviceId);
    store.lastUpdated = Date.now();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}

// ============================================================================
// EXPORT FORMATS
// ============================================================================

/**
 * Export certificate as JSON string.
 */
export function exportCertificateJSON(certificate: CalibrationCertificate): string {
    return JSON.stringify(certificate, null, 2);
}

/**
 * Export certificate as human-readable text.
 */
export function exportCertificateText(certificate: CalibrationCertificate): string {
    const lines = [
        '═══════════════════════════════════════════════════════════',
        '              IMU CONNECT CALIBRATION CERTIFICATE          ',
        '═══════════════════════════════════════════════════════════',
        '',
        `Certificate ID:    ${certificate.id}`,
        `Device ID:         ${certificate.deviceId}`,
        `Device Name:       ${certificate.deviceName}`,
        '',
        '───────────────────────────────────────────────────────────',
        '                    CALIBRATION DETAILS                    ',
        '───────────────────────────────────────────────────────────',
        '',
        `Date:              ${certificate.timestamp}`,
        `Type:              ${certificate.calibrationType.toUpperCase()}`,
        `Quality Score:     ${certificate.qualityScore}%`,
        `Duration:          ${(certificate.calibrationDurationMs / 1000).toFixed(1)}s`,
        `Samples Used:      ${certificate.sampleCount}`,
        '',
        '───────────────────────────────────────────────────────────',
        '                    SENSOR PARAMETERS                      ',
        '───────────────────────────────────────────────────────────',
        '',
        `Gyro Bias (rad/s): [${certificate.gyroBias.map(v => v.toFixed(6)).join(', ')}]`,
        `Accel Offset (g):  [${certificate.accelOffset.map(v => v.toFixed(6)).join(', ')}]`,
        `Temperature:       ${certificate.temperature !== null ? `${certificate.temperature.toFixed(1)}°C` : 'N/A'}`,
        '',
        '───────────────────────────────────────────────────────────',
        '                    SYSTEM INFORMATION                     ',
        '───────────────────────────────────────────────────────────',
        '',
        `Firmware Version:  ${certificate.firmwareVersion}`,
        '',
    ];

    if (Object.keys(certificate.metadata).length > 0) {
        lines.push('───────────────────────────────────────────────────────────');
        lines.push('                    ADDITIONAL METADATA                    ');
        lines.push('───────────────────────────────────────────────────────────');
        lines.push('');
        for (const [key, value] of Object.entries(certificate.metadata)) {
            lines.push(`${key}: ${value}`);
        }
        lines.push('');
    }

    lines.push('═══════════════════════════════════════════════════════════');
    lines.push('  This certificate documents sensor calibration parameters ');
    lines.push('   for research reproducibility and quality assurance.     ');
    lines.push('═══════════════════════════════════════════════════════════');

    return lines.join('\n');
}

/**
 * Export certificate as CSV row (for batch analysis).
 */
export function exportCertificateCSVRow(certificate: CalibrationCertificate): string {
    return [
        certificate.id,
        certificate.deviceId,
        certificate.deviceName,
        certificate.timestamp,
        certificate.calibrationType,
        certificate.qualityScore,
        certificate.gyroBias[0],
        certificate.gyroBias[1],
        certificate.gyroBias[2],
        certificate.accelOffset[0],
        certificate.accelOffset[1],
        certificate.accelOffset[2],
        certificate.temperature || '',
        certificate.firmwareVersion,
        certificate.calibrationDurationMs,
        certificate.sampleCount,
    ].join(',');
}

/**
 * Get CSV header for certificate export.
 */
export function getCertificateCSVHeader(): string {
    return [
        'certificate_id',
        'device_id',
        'device_name',
        'timestamp',
        'calibration_type',
        'quality_score',
        'gyro_bias_x',
        'gyro_bias_y',
        'gyro_bias_z',
        'accel_offset_x',
        'accel_offset_y',
        'accel_offset_z',
        'temperature',
        'firmware_version',
        'duration_ms',
        'sample_count',
    ].join(',');
}

// ============================================================================
// VALIDATION
// ============================================================================

/**
 * Check if calibration is stale (older than threshold).
 */
export function isCalibrationStale(
    certificate: CalibrationCertificate,
    maxAgeHours: number = 24
): boolean {
    const ageMs = Date.now() - certificate.epochMs;
    const ageHours = ageMs / (1000 * 60 * 60);
    return ageHours > maxAgeHours;
}

/**
 * Check if calibration quality meets minimum threshold.
 */
export function isCalibrationQualityAcceptable(
    certificate: CalibrationCertificate,
    minQuality: number = 70
): boolean {
    return certificate.qualityScore >= minQuality;
}

/**
 * Get calibration status summary.
 */
export function getCalibrationStatus(certificate: CalibrationCertificate | null): {
    status: 'valid' | 'stale' | 'low_quality' | 'missing';
    message: string;
    color: string;
} {
    if (!certificate) {
        return {
            status: 'missing',
            message: 'No calibration certificate',
            color: '#ef4444',
        };
    }

    if (isCalibrationStale(certificate)) {
        return {
            status: 'stale',
            message: `Calibration is ${Math.floor((Date.now() - certificate.epochMs) / (1000 * 60 * 60))}h old`,
            color: '#eab308',
        };
    }

    if (!isCalibrationQualityAcceptable(certificate)) {
        return {
            status: 'low_quality',
            message: `Quality score: ${certificate.qualityScore}%`,
            color: '#f97316',
        };
    }

    return {
        status: 'valid',
        message: 'Calibration valid',
        color: '#22c55e',
    };
}
