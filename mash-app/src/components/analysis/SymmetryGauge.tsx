/**
 * Symmetry Gauge
 * ===============
 *
 * A semicircular arc gauge for the master symmetry score.
 * Reads like a speedometer: needle position + arc colour gradient
 * communicate the score instantly.
 *
 * Arc segments:   0-55 red │ 55-75 amber │ 75-90 green │ 90-100 bright green
 * Needle:         thin white line pointing at the score value
 * Centre text:    score + grade label
 *
 * @module SymmetryGauge
 */

import { useRef, useEffect, useCallback } from "react";
import type { MasterSymmetry } from "../../analysis/CervicalRomAnalyzer";
import { cn } from "../../lib/utils";

// ============================================================================
// ARC SEGMENTS
// ============================================================================

interface ArcSegment {
  startPct: number; // 0-100
  endPct: number;
  colour: string;
}

const SEGMENTS: ArcSegment[] = [
  { startPct: 0, endPct: 55, colour: "rgba(239, 68, 68, 0.7)" }, // red
  { startPct: 55, endPct: 75, colour: "rgba(245, 158, 11, 0.7)" }, // amber
  { startPct: 75, endPct: 90, colour: "rgba(0, 154, 68, 0.6)" }, // green
  { startPct: 90, endPct: 100, colour: "rgba(0, 200, 80, 0.85)" }, // bright green
];

const GRADE_COLOURS: Record<MasterSymmetry["grade"], string> = {
  excellent: "#00c850",
  good: "#009A44",
  fair: "#F59E0B",
  poor: "#EF4444",
};

// ============================================================================
// COMPONENT
// ============================================================================

interface SymmetryGaugeProps {
  symmetry: MasterSymmetry;
  className?: string;
}

export function SymmetryGauge({ symmetry, className }: SymmetryGaugeProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const dpr = window.devicePixelRatio || 1;
    const size = Math.min(container.clientWidth, 200);
    const height = size * 0.62; // semicircle + some space below
    canvas.width = size * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${size}px`;
    canvas.style.height = `${height}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const cx = size / 2;
    const cy = size * 0.52; // centre of arc
    const outerR = size * 0.42;
    const innerR = outerR - 10;
    const startAngle = Math.PI; // left (180°)
    const endAngle = 2 * Math.PI; // right (360°)

    // ---- Background arc (track) ----
    ctx.beginPath();
    ctx.arc(cx, cy, outerR, startAngle, endAngle);
    ctx.arc(cx, cy, innerR, endAngle, startAngle, true);
    ctx.closePath();
    ctx.fillStyle = "rgba(31, 31, 31, 0.8)";
    ctx.fill();

    // ---- Coloured segments ----
    for (const seg of SEGMENTS) {
      const a0 = startAngle + (seg.startPct / 100) * Math.PI;
      const a1 = startAngle + (seg.endPct / 100) * Math.PI;
      ctx.beginPath();
      ctx.arc(cx, cy, outerR, a0, a1);
      ctx.arc(cx, cy, innerR, a1, a0, true);
      ctx.closePath();
      ctx.fillStyle = seg.colour;
      ctx.fill();
    }

    // ---- Tick marks at grade boundaries ----
    const ticks = [55, 75, 90];
    for (const t of ticks) {
      const angle = startAngle + (t / 100) * Math.PI;
      const x1 = cx + Math.cos(angle) * (innerR - 2);
      const y1 = cy + Math.sin(angle) * (innerR - 2);
      const x2 = cx + Math.cos(angle) * (outerR + 2);
      const y2 = cy + Math.sin(angle) * (outerR + 2);
      ctx.strokeStyle = "rgba(0, 0, 0, 0.6)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }

    // ---- Needle ----
    const score = Math.max(0, Math.min(100, symmetry.score));
    const needleAngle = startAngle + (score / 100) * Math.PI;
    const needleR = outerR + 4;
    const needleInner = innerR - 8;

    // Needle glow
    ctx.shadowColor = GRADE_COLOURS[symmetry.grade];
    ctx.shadowBlur = 6;
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(
      cx + Math.cos(needleAngle) * needleInner,
      cy + Math.sin(needleAngle) * needleInner,
    );
    ctx.lineTo(
      cx + Math.cos(needleAngle) * needleR,
      cy + Math.sin(needleAngle) * needleR,
    );
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Needle dot at tip
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(
      cx + Math.cos(needleAngle) * needleR,
      cy + Math.sin(needleAngle) * needleR,
      3,
      0,
      Math.PI * 2,
    );
    ctx.fill();

    // ---- Centre hub dot ----
    ctx.fillStyle = "#333333";
    ctx.beginPath();
    ctx.arc(cx, cy, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.3)";
    ctx.lineWidth = 1;
    ctx.stroke();

    // ---- Score text ----
    ctx.fillStyle = GRADE_COLOURS[symmetry.grade];
    ctx.font = `bold ${Math.round(size * 0.16)}px Inter, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillText(score.toFixed(1), cx, cy - 2);

    // Grade label
    ctx.fillStyle = "rgba(163, 163, 163, 0.8)";
    ctx.font = `600 ${Math.round(size * 0.065)}px Inter, system-ui, sans-serif`;
    ctx.textBaseline = "top";
    ctx.fillText(symmetry.grade.toUpperCase(), cx, cy + 4);

    // Min/max labels
    ctx.fillStyle = "rgba(163, 163, 163, 0.5)";
    ctx.font = "9px Inter, system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText("0", cx - outerR, cy + 6);
    ctx.textAlign = "right";
    ctx.fillText("100", cx + outerR, cy + 6);
  }, [symmetry]);

  useEffect(() => {
    draw();
    const ro = new ResizeObserver(draw);
    if (containerRef.current) ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [draw]);

  return (
    <div className={cn("flex flex-col items-center", className)}>
      <div ref={containerRef} className="w-full max-w-[200px]">
        <canvas ref={canvasRef} className="block mx-auto" />
      </div>
      <span className="text-[10px] text-text-secondary -mt-1">
        Master Symmetry Score
      </span>
    </div>
  );
}
