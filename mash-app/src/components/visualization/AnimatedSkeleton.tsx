/**
 * Animated Skeleton - Plays Mixamo GLB animations on the base model.
 * Loads animation clips from separate GLB files and applies them to Neutral_Model.glb.
 */

import { useRef, useEffect, useState } from "react";
import { useFrame } from "@react-three/fiber";
import { useGLTF } from "@react-three/drei";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import * as THREE from "three";
import { useAnimationStore } from "../../store/useAnimationStore";
import { useJointAnglesStore } from "../../store/useJointAnglesStore";

import { SEGMENT_TO_BONE } from "../../biomech/boneMapping";

interface AnimatedSkeletonProps {
  animationFile: string | null;
}

// Preload the model
useGLTF.preload("/models/Neutral_Model.glb");

export function AnimatedSkeleton({ animationFile }: AnimatedSkeletonProps) {
  const mixerRef = useRef<THREE.AnimationMixer | null>(null);
  const actionRef = useRef<THREE.AnimationAction | null>(null);
  const clockRef = useRef(new THREE.Clock());
  const bonesRef = useRef<Map<string, THREE.Bone>>(new Map());
  const [animClip, setAnimClip] = useState<THREE.AnimationClip | null>(null);

  const { isPlaying, playbackSpeed, setProgress } = useAnimationStore();
  const { isTracking, updateJointAngles } = useJointAnglesStore();

  // Use drei's useGLTF instead of raw useLoader for better caching
  const baseModel = useGLTF("/models/Neutral_Model.glb");

  // Load animation clip from separate file
  useEffect(() => {
    if (!animationFile) {
      setAnimClip(null);
      return;
    }

    const loader = new GLTFLoader();
    loader.load(
      animationFile,
      (gltf) => {
        if (gltf.animations && gltf.animations.length > 0) {
          setAnimClip(gltf.animations[0]);
          console.debug(
            `[Animation] Loaded clip: ${animationFile}, duration: ${gltf.animations[0].duration.toFixed(2)}s`,
          );
        }
      },
      undefined,
      (error) => {
        console.error(`[Animation] Failed to load: ${animationFile}`, error);
      },
    );
  }, [animationFile]);

  // Setup bone map from base model
  useEffect(() => {
    if (!baseModel.scene) return;

    const boneMap = new Map<string, THREE.Bone>();
    baseModel.scene.traverse((obj) => {
      if (obj instanceof THREE.Bone) {
        boneMap.set(obj.name, obj);
      }
    });
    bonesRef.current = boneMap;

    // Create mixer for the base model
    const mixer = new THREE.AnimationMixer(baseModel.scene);
    mixerRef.current = mixer;

    return () => {
      mixer.stopAllAction();
    };
  }, [baseModel]);

  // Apply animation clip when it changes
  useEffect(() => {
    if (!mixerRef.current || !animClip) {
      if (actionRef.current) {
        actionRef.current.stop();
        actionRef.current = null;
      }
      return;
    }

    // Stop previous action
    if (actionRef.current) {
      actionRef.current.stop();
    }

    // Create new action from clip
    const action = mixerRef.current.clipAction(animClip);
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.timeScale = playbackSpeed;
    actionRef.current = action;

    // Auto-play if isPlaying is true
    if (isPlaying) {
      action.play();
      clockRef.current.start();
    }
  }, [animClip, playbackSpeed]);

  // Control playback
  useEffect(() => {
    if (!actionRef.current) return;

    if (isPlaying) {
      actionRef.current.paused = false;
      actionRef.current.play();
      clockRef.current.start();
    } else {
      actionRef.current.paused = true;
    }
  }, [isPlaying]);

  // Update playback speed
  useEffect(() => {
    if (actionRef.current) {
      actionRef.current.timeScale = playbackSpeed;
    }
  }, [playbackSpeed]);

  // Animation loop
  useFrame(() => {
    if (!mixerRef.current) return;

    if (isPlaying && animClip) {
      const delta = clockRef.current.getDelta();
      mixerRef.current.update(delta);

      // Update progress
      if (actionRef.current) {
        const time = actionRef.current.time % animClip.duration;
        setProgress(time / animClip.duration);
      }
    }

    // Extract joint angles for ROM panel
    if (isTracking) {
      const segmentQuats = new Map<string, THREE.Quaternion>();

      for (const [segment, boneName] of Object.entries(SEGMENT_TO_BONE)) {
        const bone = bonesRef.current.get(boneName);
        if (bone) {
          const worldQuat = new THREE.Quaternion();
          bone.getWorldQuaternion(worldQuat);
          segmentQuats.set(segment, worldQuat);
        }
      }

      if (segmentQuats.size > 0) {
        updateJointAngles(segmentQuats);
      }
    }
  });

  return <primitive object={baseModel.scene} />;
}
