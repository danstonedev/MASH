/**
 * Symmetry Mirror Bar
 * ====================
 *
 * A horizontal bar that extends left and right from a centre line.
 * Bar length = ROM in that direction, scaled against normal range.
 * Fill colour shifts from accent (good) → warning → danger as ROM
 * deviates from normal.
 *
 * Immediately communicates balance:
 *   - Equal bars = symmetric
 *   - Unequal bars = asymmetry visible at a glance
 *
 * Normal-range ghost outlines show expected ROM.
 *
 * @module SymmetryMirrorBar
 */

import { useRef, useEffect, useCallback } from "react";
import type { PlaneRom } from "../../analysis/CervicalRomAnalyzer";
import { cn } from "../../lib/utils";

// ============================================================================
// COLOURS
// ============================================================================

/** Colour based on % of normal: ≥80% green, ≥50% amber, <50% red */
function romColour(pctOfNormal: number): string {
  if (pctOfNormal >= 80) return "rgba(0, 154, 68, 0.85)"; // accent green
  if (pctOfNormal >= 50) return "rgba(245, 158, 11, 0.85)"; // warning amber
  return "rgba(239, 68, 68, 0.85)"; // danger red
}

function romGlowColour(pctOfNormal: number): string {
  if (pctOfNormal >= 80) return "rgba(0, 154, 68, 0.25)";
  if (pctOfNormal >= 50) return "rgba(245, 158, 11, 0.25)";
  return "rgba(239, 68, 68, 0.25)";
}

// ============================================================================
// COMPONENT
// ============================================================================

interface SymmetryMirrorBarProps {
  plane: PlaneRom;
  className?: string;
}

export function SymmetryMirrorBar({
  plane,
  className,
}: SymmetryMirrorBarProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const dpr = window.devicePixelRatio || 1;
    const width = container.clientWidth;
    const height = 44;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const midX = width / 2;
    const barY = 12;
    const barH = 20;
    const labelY = barY + barH + 10;

    // Determine scale: each side from centre
    // Scale so the larger of (observed, normal) fills ~90% of half-width
    const maxNeg = Math.max(plane.neg.rom, plane.neg.normalRom);
    const maxPos = Math.max(plane.pos.rom, plane.pos.normalRom);
    const maxRange = Math.max(maxNeg, maxPos, 1);
    const halfPx = midX - 24; // leave padding for labels
    const scale = halfPx / maxRange;

    // ---- Background ----
    ctx.fillStyle = "#111111";
    ctx.fillRect(0, 0, width, height);

    // ---- Normal-range ghost outlines ----
    const normNegPx = plane.neg.normalRom * scale;
    const normPosPx = plane.pos.normalRom * scale;

    ctx.strokeStyle = "rgba(0, 154, 68, 0.2)";
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    // Left ghost
    roundedRect(ctx, midX - normNegPx, barY, normNegPx, barH, 3);
    ctx.stroke();
    // Right ghost
    roundedRect(ctx, midX, barY, normPosPx, barH, 3);
    ctx.stroke();
    ctx.setLineDash([]);

    // ---- Actual ROM bars ----
    const negPx = plane.neg.rom * scale;
    const posPx = plane.pos.rom * scale;

    // Left (negative) bar
    const negCol = romColour(plane.neg.pctOfNormal);
    const negGlow = romGlowColour(plane.neg.pctOfNormal);
    ctx.fillStyle = negCol;
    roundedRect(ctx, midX - negPx, barY, negPx, barH, 3);
    ctx.fill();
    // Glow
    ctx.shadowColor = negGlow;
    ctx.shadowBlur = 8;
    ctx.fillStyle = negCol;
    roundedRect(ctx, midX - negPx, barY, negPx, barH, 3);
    ctx.fill();
    ctx.shadowBlur = 0;

    // Right (positive) bar
    const posCol = romColour(plane.pos.pctOfNormal);
    const posGlow = romGlowColour(plane.pos.pctOfNormal);
    ctx.fillStyle = posCol;
    roundedRect(ctx, midX, barY, posPx, barH, 3);
    ctx.fill();
    ctx.shadowColor = posGlow;
    ctx.shadowBlur = 8;
    ctx.fillStyle = posCol;
    roundedRect(ctx, midX, barY, posPx, barH, 3);
    ctx.fill();
    ctx.shadowBlur = 0;

    // ---- Speed indicators (fine line inside bars, proportional to avg velocity) ----
    // Thin brighter bar at bottom of each bar, length ~ velocity relative to max
    const maxVel = Math.max(
      plane.neg.avgVelocityDegS,
      plane.pos.avgVelocityDegS,
      1,
    );
    const velBarH = 3;
    const velBarY = barY + barH - velBarH - 1;

    const negVelPx = (plane.neg.avgVelocityDegS / maxVel) * negPx;
    const posVelPx = (plane.pos.avgVelocityDegS / maxVel) * posPx;

    ctx.fillStyle = "rgba(255, 255, 255, 0.35)";
    if (negVelPx > 2) {
      roundedRect(ctx, midX - negVelPx, velBarY, negVelPx, velBarH, 1.5);
      ctx.fill();
    }
    if (posVelPx > 2) {
      roundedRect(ctx, midX, velBarY, posVelPx, velBarH, 1.5);
      ctx.fill();
    }

    // ---- Centre line ----
    ctx.strokeStyle = "rgba(255, 255, 255, 0.4)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(midX, barY - 2);
    ctx.lineTo(midX, barY + barH + 2);
    ctx.stroke();

    // ---- Degree labels ----
    ctx.font = "10px Inter, system-ui, sans-serif";
    ctx.textBaseline = "top";

    // Left label
    ctx.fillStyle = "rgba(163, 163, 163, 0.9)";
    ctx.textAlign = "right";
    ctx.fillText(`${plane.neg.rom.toFixed(0)}°`, midX - negPx - 4, barY + 4);

    // Right label
    ctx.textAlign = "left";
    ctx.fillText(`${plane.pos.rom.toFixed(0)}°`, midX + posPx + 4, barY + 4);
  }, [plane]);

  useEffect(() => {
    draw();
    const ro = new ResizeObserver(draw);
    if (containerRef.current) ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [draw]);

  return (
    <div className={cn("space-y-0.5", className)}>
      {/* Direction labels */}
      <div className="flex items-center justify-between text-[10px] text-text-secondary px-1">
        <span>{plane.negLabel}</span>
        <span className="font-semibold text-text-primary text-[11px]">
          {plane.label}
        </span>
        <span>{plane.posLabel}</span>
      </div>
      {/* Canvas */}
      <div ref={containerRef} className="w-full">
        <canvas ref={canvasRef} className="block rounded" />
      </div>
      {/* Symmetry score pill centred below */}
      <div className="flex justify-center">
        <span
          className={cn(
            "text-[9px] tabular-nums px-2 py-0.5 rounded-full",
            plane.symmetry.compositeScore >= 90
              ? "text-accent bg-accent/10"
              : plane.symmetry.compositeScore >= 75
                ? "text-accent/80 bg-accent/10"
                : plane.symmetry.compositeScore >= 55
                  ? "text-warning bg-warning/10"
                  : "text-danger bg-danger/10",
          )}
        >
          {plane.symmetry.compositeScore.toFixed(0)}% symmetry
        </span>
      </div>
    </div>
  );
}

// ============================================================================
// CANVAS HELPERS
// ============================================================================

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}
