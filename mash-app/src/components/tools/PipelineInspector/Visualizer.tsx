/**
 * Visualizer.tsx — 3D visualization components for the Pipeline Inspector.
 *
 * Contains:
 *  - VectorArrow: Renders a live-updating arrow in Three.js
 *  - BodySegmentMesh: Renders a limb segment cylinder with orientation markers
 *  - ArrowHelperMutable: Ref-driven arrow for high-perf updates (no re-renders)
 *  - DeviceVisualizer: Full 3D scene for a single device (sensor + body frames)
 */

import { useFrame } from "@react-three/fiber";
import { Grid, Html } from "@react-three/drei";
import { useRef, useMemo, useEffect } from "react";
import * as THREE from "three";
import {
  useDeviceRegistry,
  deviceAccelCache,
  deviceQuaternionCache,
} from "../../../store/useDeviceRegistry";
import { useSensorAssignmentStore } from "../../../store/useSensorAssignmentStore";
import { getTposeTarget } from "../../../calibration/tposeTargets";

// ─── VectorArrow ──────────────────────────────────────────────────────────────

export function VectorArrow({
  direction,
  origin = new THREE.Vector3(0, 0, 0),
  length = 1,
  color = "#ffff00",
}: {
  direction: THREE.Vector3;
  origin?: THREE.Vector3;
  length?: number;
  color?: string;
}) {
  // We use a ref to update direction without re-mounting
  const ref = useRef<THREE.ArrowHelper>(null);
  useFrame(() => {
    if (ref.current) {
      ref.current.setDirection(direction);
      ref.current.setLength(length);
      ref.current.setColor(color);
    }
  });
  return <arrowHelper ref={ref} args={[direction, origin, length, color]} />;
}

// ─── BodySegmentMesh ──────────────────────────────────────────────────────────

export function BodySegmentMesh({
  opacity = 1,
  isGhost = false,
}: {
  segmentId?: string;
  opacity?: number;
  isGhost?: boolean;
}) {
  // Determine shape/size based on simplistic mapping
  // Default is a general limb segment
  const height = 1.2;
  const radius = 0.12;

  return (
    <group>
      {/* The Bone/Flesh Cylinder */}
      <mesh position={[0, 0, 0]}>
        <cylinderGeometry args={[radius, radius, height, 16]} />
        <meshStandardMaterial
          color={isGhost ? "#ffffff" : "#22c55e"}
          wireframe={isGhost}
          transparent
          opacity={isGhost ? 0.1 : opacity}
        />
      </mesh>

      {/* Orientation Markers (Anterior/Superior) */}
      {!isGhost && (
        <group>
          {/* Superior (Y+) Marker */}
          <mesh position={[0, height / 2 + 0.1, 0]}>
            <sphereGeometry args={[radius * 0.5]} />
            <meshStandardMaterial color="#22c55e" />
          </mesh>
          {/* Anterior (Z+) Marker (Flat face usually means forward?) - Let's use Z+ as Forward for standard body frame */}
          <mesh position={[0, 0, radius]} rotation={[Math.PI / 2, 0, 0]}>
            <cylinderGeometry args={[0.02, 0.02, 0.2]} />
            <meshStandardMaterial color="#0000ff" />
          </mesh>
        </group>
      )}
    </group>
  );
}

// ─── ArrowHelperMutable ───────────────────────────────────────────────────────

export function ArrowHelperMutable({
  dirRef,
  origin,
  color,
  label,
}: {
  dirRef: React.MutableRefObject<THREE.Vector3>;
  origin: THREE.Vector3;
  color: string | number;
  label?: string;
}) {
  const arrowRef = useRef<THREE.ArrowHelper>(null);
  useFrame(() => {
    if (arrowRef.current && dirRef.current) {
      arrowRef.current.setDirection(dirRef.current);
    }
  });
  return (
    <group>
      <arrowHelper
        ref={arrowRef}
        args={[new THREE.Vector3(0, 1, 0), origin, 1.5, color]}
      />
      {label && (
        <Html position={[origin.x, origin.y + 1.6, origin.z]}>
          <div
            style={{ color: typeof color === "string" ? color : "yellow" }}
            className="text-[10px] bg-black/50 px-1 rounded whitespace-nowrap"
          >
            {label}
          </div>
        </Html>
      )}
    </group>
  );
}

// ─── DeviceVisualizer ─────────────────────────────────────────────────────────

export function DeviceVisualizer({
  deviceId,
  viewOptions,
}: {
  deviceId: string;
  viewOptions: { showSensor: boolean; showBody: boolean };
}) {
  // Refs
  const sensorRef = useRef<THREE.Group>(null);
  const bodyRef = useRef<THREE.Group>(null);
  const ghostRef = useRef<THREE.Group>(null);
  const sensorOnBodyRef = useRef<THREE.Group>(null); // Sensor mesh parented to body
  const accelArrowDir = useRef(new THREE.Vector3(0, 1, 0)); // Points UP by default

  // Data refs
  const currentSensorQ = useRef(new THREE.Quaternion());
  const calibrationQ = useRef(new THREE.Quaternion());
  const tposeQ = useRef(new THREE.Quaternion()); // The Ideal World Orientation for T-Pose

  // Connect to store state
  const calibration = useDeviceRegistry((s) => s.sensorTransforms[deviceId]);
  const assignment = useSensorAssignmentStore((s) =>
    s.assignments.get(deviceId),
  );
  const segmentId = assignment?.segmentId;

  // Update calibration quaternion
  useEffect(() => {
    if (calibration) {
      const euler = new THREE.Euler(
        calibration.rotation[0],
        calibration.rotation[1],
        calibration.rotation[2],
        "XYZ",
      );
      calibrationQ.current.setFromEuler(euler);
    } else {
      calibrationQ.current.identity();
    }
  }, [calibration]);

  // Update T-Pose Target (Ideal World Orientation of the BONE)
  useEffect(() => {
    if (segmentId) {
      tposeQ.current = getTposeTarget(segmentId);
    } else {
      tposeQ.current.identity();
    }
  }, [segmentId]);

  // Animation Loop
  useFrame(() => {
    // 1. Update Sensor (Raw World)
    const qData = deviceQuaternionCache.get(deviceId);
    if (qData) {
      currentSensorQ.current.set(qData[1], qData[2], qData[3], qData[0]);
    }

    // Update Accel Arrow (Sensor Perception of Gravity/Proper Accel)
    const aData = deviceAccelCache.get(deviceId);
    if (aData) {
      const v = new THREE.Vector3(aData[0], aData[1], aData[2]).normalize();
      v.applyQuaternion(currentSensorQ.current);
      accelArrowDir.current.copy(v);
    }

    // 2. Drive Sensor Visual
    if (sensorRef.current) {
      sensorRef.current.quaternion.copy(currentSensorQ.current);
    }

    // 3. Drive Body Visual (Live)
    if (bodyRef.current) {
      /**
       * ⚠️  QUATERNION CONVENTION - DO NOT CHANGE WITHOUT READING THIS! ⚠️
       *
       * Step A: Apply Mounting Tare (L1 Calibration)
       * Formula: tared = sensor × offset
       *
       * The multiplication order is CRITICAL:
       * - CORRECT: sensor.multiply(offset) - local frame, preserves axes
       * - WRONG: offset.multiply(sensor) - world frame, swaps Y/Z!
       *
       * Tests: src/tests/quaternionConventions.test.ts (19 tests verify this)
       * Utility: src/lib/math/quaternionTare.ts (centralized docs)
       */
      const mountingOffset =
        useDeviceRegistry.getState().mountingOffsets[deviceId];
      const taredQ = currentSensorQ.current.clone();

      if (mountingOffset) {
        const mq = new THREE.Quaternion(
          mountingOffset[1],
          mountingOffset[2],
          mountingOffset[3],
          mountingOffset[0],
        );
        // CORRECT: sensor × offset (DO NOT change to mq.multiply(taredQ)!)
        taredQ.multiply(mq);
      }

      // Step B: Apply Bone Calibration (L2 Calibration - Sensor to Bone)
      const bodyQ = taredQ.multiply(calibrationQ.current);
      bodyRef.current.quaternion.copy(bodyQ);
    }

    // 4. Drive Ghost (Fixed T-Pose Reference)
    if (ghostRef.current) {
      ghostRef.current.quaternion.copy(tposeQ.current);
    }

    // 5. Drive Sensor-on-Body visual (inverse calibration for relative orientation)
    if (sensorOnBodyRef.current) {
      sensorOnBodyRef.current.quaternion.copy(
        calibrationQ.current.clone().invert(),
      );
    }
  });

  // Calculate Relative Position for Visualization only
  const sensorOffsetLocal = useMemo(() => {
    const q = new THREE.Quaternion();
    if (calibration) {
      const e = new THREE.Euler(
        calibration.rotation[0],
        calibration.rotation[1],
        calibration.rotation[2],
        "XYZ",
      );
      q.setFromEuler(e);
    }

    // Cal = Sensor->Body. So Inverse = Body->Sensor.
    const inv = q.clone().invert();
    const vec = new THREE.Vector3(0, 0, 1); // Z+ is "Out"
    vec.applyQuaternion(inv);
    vec.multiplyScalar(0.12 + 0.05); // Radius + HalfSensorThickness
    return vec;
  }, [calibration]);

  return (
    <group>
      <ambientLight intensity={0.5} />
      <pointLight position={[5, 5, 5]} />
      <Grid
        infiniteGrid
        fadeDistance={20}
        sectionColor="#404040"
        cellColor="#202020"
      />

      {/* World Axes */}
      <axesHelper args={[2]} />
      <Html position={[2, 0, 0]}>
        <span className="text-red-500 text-[10px]">X</span>
      </Html>
      <Html position={[0, 2, 0]}>
        <span className="text-green-500 text-[10px]">Y</span>
      </Html>
      <Html position={[0, 0, 2]}>
        <span className="text-blue-500 text-[10px]">Z</span>
      </Html>

      {/* 1. GHOST BODY (T-Pose Reference) */}
      {viewOptions.showBody && (
        <group ref={ghostRef}>
          <BodySegmentMesh segmentId={segmentId} isGhost={true} />
          <Html position={[0.5, 1, 0]}>
            <div className="text-white/20 text-[10px] font-mono whitespace-nowrap">
              Neutral Ref
            </div>
          </Html>
        </group>
      )}

      {/* 2. LIVE BODY SEGMENT */}
      {viewOptions.showBody && (
        <group ref={bodyRef}>
          <BodySegmentMesh segmentId={segmentId} opacity={0.6} />
          <axesHelper args={[1]} />

          {/* If showing sensor too, attach it to the body here for realism */}
          {viewOptions.showSensor && (
            <group position={sensorOffsetLocal}>
              <group ref={sensorOnBodyRef}>
                {/* Visual Correction: Rotate Mesh Only (90 X) so flattened shape aligns with Up */}
                <mesh rotation={[Math.PI / 2, 0, 0]}>
                  <boxGeometry args={[0.3, 0.5, 0.1]} /> {/* 3x5x1cm approx */}
                  <meshStandardMaterial color="#3b82f6" />
                </mesh>
                {/* Axes and Label remain in Data Frame (Unrotated) */}
                <axesHelper args={[0.6]} />
                <Html position={[0, 0.4, 0]}>
                  <div className="text-[8px] bg-blue-500/80 text-white px-1 rounded">
                    Avg Sensor
                  </div>
                </Html>
              </group>
            </group>
          )}

          <Html position={[0, 0.8, 0]}>
            <div className="text-green-400 text-[10px] bg-black/50 px-1 rounded backdrop-blur font-mono whitespace-nowrap">
              {segmentId || "Body Segment"}
            </div>
          </Html>
        </group>
      )}

      {/* 3. INDEPENDENT SENSOR FRAME (World Space) */}
      {viewOptions.showSensor && !viewOptions.showBody && (
        <group ref={sensorRef}>
          <group ref={sensorRef}>
            {/* Visual Correction: Rotate Mesh Only (90 X) */}
            <mesh rotation={[Math.PI / 2, 0, 0]}>
              <boxGeometry args={[0.3, 0.5, 0.1]} />
              <meshStandardMaterial color="#3b82f6" opacity={0.8} transparent />
            </mesh>
            <axesHelper args={[1]} />
            <Html position={[0, 0.4, 0]}>
              <div className="text-blue-400 text-[10px] bg-black/50 px-1 rounded backdrop-blur font-mono whitespace-nowrap">
                Raw Sensor (World)
              </div>
            </Html>
          </group>
        </group>
      )}

      {/* 4. GRAVITY / ACCEL ARROWS */}
      {viewOptions.showSensor && (
        <>
          {/* World Up Reference (Cyan) - True Vertical */}
          <VectorArrow
            direction={new THREE.Vector3(0, 1, 0)}
            origin={new THREE.Vector3(2, 0, 0)}
            length={1.5}
            color="#00ffff"
          />
          <Html position={[2, 1.5, 0]}>
            <div className="text-cyan-400 text-[10px] bg-black/50 px-1 rounded">
              World Up
            </div>
          </Html>

          {/* Measured Accel (Yellow) - Should Match World Up if Stationary & Flat */}
          <ArrowHelperMutable
            dirRef={accelArrowDir}
            origin={new THREE.Vector3(0, 0, 0)}
            color="#ffff00"
            label="Sensor Up (Accel)"
          />
        </>
      )}
    </group>
  );
}
