/**
 * Data Export Module - Industry Standard Formats
 * ===============================================
 * 
 * Unified export functionality for biomechanics research data.
 * 
 * Supported Formats:
 * - C3D: Industry standard for motion capture (Vicon, Visual3D, OpenSim)
 * - OpenSim: TRC + MOT files for musculoskeletal simulation
 * - BVH: Animation industry format (Blender, Maya, Unity)
 * - CSV: Spreadsheet-compatible raw data export
 * 
 * @module export
 */

export { C3DWriter, exportToC3D, downloadC3D } from './C3DExporter';
export type { C3DExportOptions, C3DPoint } from './C3DExporter';

export {
    OpenSimExporter,
    downloadOpenSimBundle
} from './OpenSimExporter';
export type { IMUFrame } from './OpenSimExporter';

export { BVHWriter, exportToBVH, downloadBVH } from './BVHExporter';
export type { BVHExportOptions } from './BVHExporter';
