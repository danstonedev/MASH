/**
 * FirmwareUpdate.tsx - Firmware Update Page Component
 *
 * Provides UI for:
 * - Viewing current device firmware versions
 * - Checking for available updates
 * - Manual firmware upload
 * - OTA update progress tracking
 */

import React, { useState, useCallback, useRef } from "react";
import { useFirmwareStore } from "../../store/useFirmwareStore";
import { useDeviceStore } from "../../store/useDeviceStore";
import { connectionManager } from "../../lib/connection/ConnectionManager";
import { loadFirmwareFromFile } from "../../lib/ota";
import "./FirmwareUpdate.css";

export const FirmwareUpdate: React.FC = () => {
  const {
    gatewayFirmware,
    latestRelease,
    updateAvailable,
    isUpdating,
    otaProgress,
    startUpdate,
    setProgress,
    completeUpdate,
    failUpdate,
  } = useFirmwareStore();

  useDeviceStore(); // for reactivity

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Handle file selection
  const handleFileSelect = useCallback((file: File) => {
    if (file.name.endsWith(".bin")) {
      setSelectedFile(file);
    } else {
      alert("Please select a .bin firmware file");
    }
  }, []);

  // Drag and drop handlers
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  };

  const handleDragLeave = () => {
    setDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFileSelect(file);
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFileSelect(file);
  };

  // Start OTA update
  const handleStartUpdate = async () => {
    if (!selectedFile) {
      alert("Please select a firmware file first");
      return;
    }

    const wifiIP = useDeviceStore.getState().wifiIP;
    if (!wifiIP) {
      alert("Gateway WiFi not connected. Configure WiFi first.");
      return;
    }

    try {
      startUpdate("gateway");
      const firmware = await loadFirmwareFromFile(selectedFile);
      const { performWiFiOTA } = await import("../../lib/ota/WiFiOTAManager");

      await performWiFiOTA(wifiIP, firmware, (progress) => {
        setProgress({
          phase:
            progress.phase === "uploading" ? "transferring" : progress.phase,
          percent: progress.percent,
          message: progress.message,
          bytesTransferred: 0,
          totalBytes: firmware.byteLength,
        });

        if (progress.phase === "complete") {
          completeUpdate();
          setSelectedFile(null);
        } else if (progress.phase === "error") {
          failUpdate(progress.message);
        }
      });
    } catch (error) {
      failUpdate(error instanceof Error ? error.message : "OTA update failed");
    }
  };

  // Request firmware version from device
  const handleCheckVersion = async () => {
    if (connectionManager) {
      try {
        await connectionManager.sendCommand("GET_VERSION");
      } catch (error) {
        console.error("Failed to get version:", error);
      }
    }
  };

  return (
    <div className="firmware-update">
      <div className="firmware-header">
        <h2>🔄 Firmware Update</h2>
        <p>Update your IMU Connect devices wirelessly</p>
      </div>

      {/* Current Version Info */}
      <div className="firmware-section">
        <h3>Current Firmware</h3>
        <div className="version-cards">
          <div className="version-card">
            <div className="version-icon">📡</div>
            <div className="version-info">
              <span className="version-label">Gateway</span>
              <span className="version-number">
                {gatewayFirmware?.version || "Unknown"}
              </span>
            </div>
            <button className="version-check-btn" onClick={handleCheckVersion}>
              Check
            </button>
          </div>
        </div>

        {updateAvailable && latestRelease && (
          <div className="update-available">
            <span className="update-badge">Update Available</span>
            <span>Version {latestRelease.version} is available</span>
          </div>
        )}
      </div>

      {/* File Upload */}
      <div className="firmware-section">
        <h3>Upload Firmware</h3>
        <div
          className={`drop-zone ${dragOver ? "drag-over" : ""} ${selectedFile ? "has-file" : ""}`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".bin"
            onChange={handleInputChange}
            style={{ display: "none" }}
          />
          {selectedFile ? (
            <div className="file-info">
              <span className="file-icon">📦</span>
              <span className="file-name">{selectedFile.name}</span>
              <span className="file-size">
                {(selectedFile.size / 1024).toFixed(1)} KB
              </span>
            </div>
          ) : (
            <div className="drop-prompt">
              <span className="drop-icon">📁</span>
              <span>Drop firmware .bin file here</span>
              <span className="drop-hint">or click to browse</span>
            </div>
          )}
        </div>
      </div>

      {/* Update Progress */}
      {isUpdating && otaProgress && (
        <div className="firmware-section">
          <h3>Update Progress</h3>
          <div className="progress-container">
            <div className="progress-bar">
              <div
                className="progress-fill"
                style={{ width: `${otaProgress.percent}%` }}
              />
            </div>
            <div className="progress-info">
              <span className="progress-percent">{otaProgress.percent}%</span>
              <span className="progress-message">{otaProgress.message}</span>
            </div>
          </div>
        </div>
      )}

      {/* Update Button */}
      <div className="firmware-actions">
        <button
          className="update-button"
          onClick={handleStartUpdate}
          disabled={!selectedFile || isUpdating}
        >
          {isUpdating ? "Updating..." : "Start Update"}
        </button>
      </div>

      {/* Instructions */}
      <div className="firmware-section instructions">
        <h3>Instructions</h3>
        <ol>
          <li>Connect to your Gateway device via USB Serial</li>
          <li>Select or drag-and-drop a firmware .bin file</li>
          <li>Click "Start Update" to begin the OTA process</li>
          <li>Wait for the update to complete (~2-3 minutes)</li>
          <li>The device will reboot automatically</li>
        </ol>
        <div className="warning">
          ⚠️ Do not disconnect or power off the device during update
        </div>
      </div>
    </div>
  );
};
