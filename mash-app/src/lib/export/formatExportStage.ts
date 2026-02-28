export const EXPORT_PROGRESS_STAGE = {
  STARTING: "starting",
  START: "start",
  NORMALIZE: "normalize",
  SERIALIZE_CSV: "serialize-csv",
  SERIALIZE_JSON: "serialize-json",
  SERIALIZE_JSON_IMU: "serialize-json-imu",
  SERIALIZE_JSON_ENV: "serialize-json-env",
  SERIALIZE_C3D: "serialize-c3d",
  SERIALIZE_BVH: "serialize-bvh",
  SERIALIZE_OPENSIM: "serialize-opensim",
  DONE: "done",
  WORKING: "working",
} as const;

const STAGE_LABELS: Record<string, string> = {
  [EXPORT_PROGRESS_STAGE.STARTING]: "Starting",
  [EXPORT_PROGRESS_STAGE.NORMALIZE]: "Preparing data",
  [EXPORT_PROGRESS_STAGE.SERIALIZE_CSV]: "Serializing CSV",
  [EXPORT_PROGRESS_STAGE.SERIALIZE_JSON]: "Serializing JSON",
  [EXPORT_PROGRESS_STAGE.SERIALIZE_JSON_IMU]: "Serializing IMU JSON",
  [EXPORT_PROGRESS_STAGE.SERIALIZE_JSON_ENV]: "Serializing environment JSON",
  [EXPORT_PROGRESS_STAGE.SERIALIZE_C3D]: "Serializing C3D",
  [EXPORT_PROGRESS_STAGE.SERIALIZE_BVH]: "Serializing BVH",
  [EXPORT_PROGRESS_STAGE.SERIALIZE_OPENSIM]: "Serializing OpenSim",
  [EXPORT_PROGRESS_STAGE.DONE]: "Finalizing",
  [EXPORT_PROGRESS_STAGE.WORKING]: "Working",
};

const STAGE_ALIASES: Record<string, string> = {
  [EXPORT_PROGRESS_STAGE.START]: EXPORT_PROGRESS_STAGE.STARTING,
};

export function normalizeExportStage(
  stage: string | undefined | null,
): string | null {
  if (!stage) {
    return null;
  }

  const normalized = stage.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  return STAGE_ALIASES[normalized] || normalized;
}

export function formatExportStage(stage: string | undefined | null): string {
  const normalized = normalizeExportStage(stage);
  if (!normalized) {
    return STAGE_LABELS[EXPORT_PROGRESS_STAGE.WORKING];
  }

  const knownLabel = STAGE_LABELS[normalized];
  if (knownLabel) {
    return knownLabel;
  }

  return normalized
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join(" ");
}
