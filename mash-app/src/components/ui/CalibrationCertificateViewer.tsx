/**
 * Calibration Certificate Viewer - Minimal traceability display
 * Apple-style: clean list, focused info
 */

import { useState, useEffect } from "react";
import { Download, Check, Clock, Thermometer, Cpu } from "lucide-react";
import {
  loadCertificateStore,
  type CalibrationCertificate,
  exportCertificateText,
  getCalibrationStatus,
} from "../../lib/calibration/CalibrationCertificate";
import { downloadFile } from "../../lib/export/download";

interface CalibrationCertificateViewerProps {
  onClose: () => void;
}

export function CalibrationCertificateViewer({
  onClose,
}: CalibrationCertificateViewerProps) {
  const [certificates, setCertificates] = useState<CalibrationCertificate[]>(
    [],
  );

  const statusBadgeClass: Record<
    "valid" | "stale" | "low_quality" | "missing",
    string
  > = {
    valid: "bg-green-500/20 text-green-400",
    stale: "bg-amber-500/20 text-amber-400",
    low_quality: "bg-red-500/20 text-red-400",
    missing: "bg-white/15 text-white/60",
  };

  useEffect(() => {
    const store = loadCertificateStore();
    setCertificates(store.certificates);
  }, []);

  const handleExport = (cert: CalibrationCertificate) => {
    const content = exportCertificateText(cert);
    downloadFile(content, `calibration_${cert.deviceName}_${cert.id}.txt`);
  };

  const formatDate = (timestamp: string) => {
    const date = new Date(timestamp);
    return date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full sm:max-w-md bg-[#1C1C1E] sm:rounded-2xl rounded-t-2xl overflow-hidden max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 shrink-0">
          <button onClick={onClose} className="text-accent text-sm font-medium">
            Done
          </button>
          <span className="text-sm font-semibold text-white">Calibration</span>
          <div className="w-12" />
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {certificates.length === 0 ? (
            <div className="p-8 text-center">
              <div className="w-12 h-12 rounded-full bg-white/5 flex items-center justify-center mx-auto mb-3">
                <Cpu className="h-6 w-6 text-white/30" />
              </div>
              <div className="text-sm text-white/50">
                No calibration certificates yet
              </div>
              <div className="text-xs text-white/30 mt-1">
                Calibrate your sensors to create a certificate
              </div>
            </div>
          ) : (
            <div className="p-3 space-y-2">
              {certificates.map((cert) => {
                const status = getCalibrationStatus(cert);
                return (
                  <div
                    key={cert.id}
                    className="bg-white/5 rounded-xl p-4 space-y-3"
                  >
                    {/* Header */}
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-sm font-medium text-white">
                          {cert.deviceName}
                        </div>
                        <div className="text-xs text-white/40 font-mono">
                          {cert.id}
                        </div>
                      </div>
                      <div
                        className={`px-2 py-1 rounded-full text-[10px] font-medium ${statusBadgeClass[status.status]}`}
                      >
                        {status.status.toUpperCase()}
                      </div>
                    </div>

                    {/* Details */}
                    <div className="grid grid-cols-2 gap-3 text-xs">
                      <div className="flex items-center gap-2 text-white/50">
                        <Clock className="h-3.5 w-3.5" />
                        {formatDate(cert.timestamp)}
                      </div>
                      <div className="flex items-center gap-2 text-white/50">
                        <Check className="h-3.5 w-3.5" />
                        {cert.qualityScore}% quality
                      </div>
                      {cert.temperature && (
                        <div className="flex items-center gap-2 text-white/50">
                          <Thermometer className="h-3.5 w-3.5" />
                          {cert.temperature.toFixed(1)}°C
                        </div>
                      )}
                      <div className="flex items-center gap-2 text-white/50">
                        <Cpu className="h-3.5 w-3.5" />
                        {cert.calibrationType}
                      </div>
                    </div>

                    {/* Bias Values (collapsed) */}
                    <div className="pt-2 border-t border-white/10 text-xs font-mono text-white/40">
                      Gyro: [{cert.gyroBias.map((b) => b.toFixed(4)).join(", ")}
                      ]
                    </div>

                    {/* Export */}
                    <button
                      onClick={() => handleExport(cert)}
                      className="w-full py-2 rounded-lg bg-white/5 text-white/70 text-xs font-medium hover:bg-white/10 transition-colors flex items-center justify-center gap-2"
                    >
                      <Download className="h-3.5 w-3.5" />
                      Export Certificate
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
