/**
 * ROM Heatmap Bar
 * ================
 *
 * A horizontal bar showing range-of-motion distribution as a dwell-time
 * density heatmap.  Brighter colour = more time spent at that degree.
 *
 * Features:
 *   - Canvas-rendered density gradient (1° resolution)
 *   - Normal-range tick marks
 *   - Min/max peak indicators
 *   - Zero-line centre marker
 *   - Responsive sizing
 *
 * @module RomHeatmapBar
 */

import { useRef, useEffect, useCallback } from "react";
import type { PlaneRom } from "../../analysis/CervicalRomAnalyzer";
import { cn } from "../../lib/utils";

// ============================================================================
// COLOUR RAMP
// ============================================================================

/** Interpolate between dark-teal → cyan → white based on intensity 0-1 */
function densityColour(t: number): string {
  // 0.0 → transparent / bg
  // 0.01-0.3 → dark teal
  // 0.3-0.7 → cyan
  // 0.7-1.0 → bright white-cyan
  if (t < 0.01) return "rgba(0,0,0,0)";

  const r = Math.round(lerp(0, 200, clamp01(t)));
  const g = Math.round(lerp(60, 255, clamp01(t)));
  const b = Math.round(lerp(80, 255, clamp01(t * 0.8)));
  const a = lerp(0.35, 1.0, clamp01(t));

  return `rgba(${r},${g},${b},${a})`;
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}
function clamp01(v: number) {
  return Math.max(0, Math.min(1, v));
}

// ============================================================================
// COMPONENT
// ============================================================================

interface RomHeatmapBarProps {
  plane: PlaneRom;
  className?: string;
}

export function RomHeatmapBar({ plane, className }: RomHeatmapBarProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const dpr = window.devicePixelRatio || 1;
    const width = container.clientWidth;
    const height = 32; // bar height in CSS px
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const { bins, density } = plane.histogram;
    if (bins.length === 0) return;

    const degMin = bins[0];
    const degMax = bins[bins.length - 1];
    const degRange = degMax - degMin || 1;

    // px per degree
    const pxPerDeg = width / degRange;

    // ---- background ----
    ctx.fillStyle = "#111111";
    ctx.fillRect(0, 0, width, height);

    // ---- normal-range shaded area ----
    const normLeftPx = (plane.normalMinDeg - degMin) * pxPerDeg;
    const normRightPx = (plane.normalMaxDeg - degMin) * pxPerDeg;
    ctx.fillStyle = "rgba(0, 154, 68, 0.08)"; // accent with low alpha
    ctx.fillRect(normLeftPx, 0, normRightPx - normLeftPx, height);

    // ---- density bars ----
    for (let i = 0; i < bins.length; i++) {
      const x = (bins[i] - degMin) * pxPerDeg;
      const w = Math.max(pxPerDeg, 1);
      ctx.fillStyle = densityColour(density[i]);
      ctx.fillRect(x, 2, w, height - 4);
    }

    // ---- zero line ----
    const zeroPx = (0 - degMin) * pxPerDeg;
    if (zeroPx > 0 && zeroPx < width) {
      ctx.strokeStyle = "rgba(255,255,255,0.3)";
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(zeroPx, 0);
      ctx.lineTo(zeroPx, height);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // ---- normal range tick marks ----
    const drawTick = (deg: number, colour: string) => {
      const px = (deg - degMin) * pxPerDeg;
      if (px < 0 || px > width) return;
      ctx.strokeStyle = colour;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, 5);
      ctx.moveTo(px, height - 5);
      ctx.lineTo(px, height);
      ctx.stroke();
    };
    drawTick(plane.normalMinDeg, "rgba(0,154,68,0.5)");
    drawTick(plane.normalMaxDeg, "rgba(0,154,68,0.5)");

    // ---- observed peak markers (triangles) ----
    const drawPeak = (deg: number) => {
      const px = (deg - degMin) * pxPerDeg;
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.beginPath();
      ctx.moveTo(px, height);
      ctx.lineTo(px - 3, height - 5);
      ctx.lineTo(px + 3, height - 5);
      ctx.closePath();
      ctx.fill();
    };
    drawPeak(plane.minDeg);
    drawPeak(plane.maxDeg);
  }, [plane]);

  // Re-draw on mount and when plane data changes
  useEffect(() => {
    draw();
    const ro = new ResizeObserver(draw);
    if (containerRef.current) ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [draw]);

  return (
    <div className={cn("space-y-1", className)}>
      {/* Label row */}
      <div className="flex items-center justify-between text-[10px] text-text-secondary">
        <span>{plane.negLabel}</span>
        <span className="font-semibold text-text-primary text-xs">
          {plane.label}
        </span>
        <span>{plane.posLabel}</span>
      </div>

      {/* Canvas bar */}
      <div
        ref={containerRef}
        className="w-full rounded overflow-hidden ring-1 ring-border"
      >
        <canvas ref={canvasRef} className="block" />
      </div>

      {/* Metrics row */}
      <div className="flex items-center justify-between text-[10px] text-text-secondary">
        <span>{plane.minDeg.toFixed(0)}°</span>
        <span className="text-accent font-medium">
          {plane.totalRomDeg.toFixed(0)}° total
        </span>
        <span>{plane.maxDeg.toFixed(0)}°</span>
      </div>
    </div>
  );
}
