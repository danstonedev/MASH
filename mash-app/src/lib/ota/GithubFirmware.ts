/**
 * GithubFirmware.ts - GitHub Releases API for Firmware Distribution
 *
 * Fetches firmware releases from GitHub for OTA updates.
 */

export interface FirmwareRelease {
  version: string;
  major: number;
  minor: number;
  patch: number;
  releaseNotes: string;
  publishedAt: string;
  gatewayUrl: string | null;
  nodeUrl: string | null;
  gatewaySize: number;
  nodeSize: number;
}

// GitHub repository for firmware releases
// GitHub repository for firmware releases
const GITHUB_OWNER = "danstonedev";
const GITHUB_REPO = "connect2imu";

/**
 * Parse semantic version string to components
 */
export function parseVersion(version: string): {
  major: number;
  minor: number;
  patch: number;
} {
  const match = version.replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return { major: 0, minor: 0, patch: 0 };
  }
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
  };
}

/**
 * Compare two version strings
 * Returns: 1 if a > b, -1 if a < b, 0 if equal
 */
export function compareVersions(a: string, b: string): number {
  const va = parseVersion(a);
  const vb = parseVersion(b);

  if (va.major !== vb.major) return va.major > vb.major ? 1 : -1;
  if (va.minor !== vb.minor) return va.minor > vb.minor ? 1 : -1;
  if (va.patch !== vb.patch) return va.patch > vb.patch ? 1 : -1;
  return 0;
}

/**
 * Fetch the latest firmware release from GitHub
 */
/**
 * Fetch the latest firmware release from GitHub
 */
export async function fetchLatestRelease(): Promise<FirmwareRelease | null> {
  try {
    const response = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`,
      {
        headers: {
          Accept: "application/vnd.github.v3+json",
        },
      },
    );

    if (!response.ok) {
      // If latest not found (e.g. non-semver tag), try fetching all and picking the first
      if (response.status === 404) {
        console.debug(
          "[Firmware] Latest release not found (404), checking all releases...",
        );
        const all = await fetchAllReleases();
        return all.length > 0 ? all[0] : null;
      }
      console.warn(
        "[Firmware] Failed to fetch latest release:",
        response.status,
      );
      return null;
    }

    const release = await response.json();
    return parseGitHubRelease(release);
  } catch (error) {
    console.error("[Firmware] Failed to fetch release:", error);
    return null;
  }
}

/**
 * Fetch all available firmware releases
 */
export async function fetchAllReleases(): Promise<FirmwareRelease[]> {
  try {
    const response = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases`,
      {
        headers: {
          Accept: "application/vnd.github.v3+json",
        },
      },
    );

    if (!response.ok) {
      console.warn("[Firmware] Failed to fetch releases:", response.status);
      return [];
    }

    const releases = await response.json();
    return releases
      .map(parseGitHubRelease)
      .filter((r: FirmwareRelease | null): r is FirmwareRelease => r !== null);
  } catch (error) {
    console.error("[Firmware] Failed to fetch releases:", error);
    return [];
  }
}

/**
 * GitHub Release API response types
 */
interface GitHubReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

interface GitHubRelease {
  tag_name: string;
  name: string | null;
  body: string | null;
  published_at: string;
  assets: GitHubReleaseAsset[];
}

/**
 * Parse GitHub release JSON into FirmwareRelease
 */
function parseGitHubRelease(release: GitHubRelease): FirmwareRelease | null {
  if (!release) return null;

  // Try parsing version from tag, then fallback to release name
  let version = parseVersion(release.tag_name || "");
  if (
    version.major === 0 &&
    version.minor === 0 &&
    version.patch === 0 &&
    release.name
  ) {
    // Fallback to name
    const nameVersion = parseVersion(release.name);
    if (
      nameVersion.major !== 0 ||
      nameVersion.minor !== 0 ||
      nameVersion.patch !== 0
    ) {
      version = nameVersion;
    }
  }

  // Find firmware binary assets
  const assets = release.assets || [];

  const gatewayAsset = assets.find(
    (a) => a.name.toLowerCase().includes("gateway") && a.name.endsWith(".bin"),
  );

  const nodeAsset = assets.find(
    (a) => a.name.toLowerCase().includes("node") && a.name.endsWith(".bin"),
  );

  return {
    version: release.name || release.tag_name, // Prefer name if tag is weird
    major: version.major,
    minor: version.minor,
    patch: version.patch,
    releaseNotes: release.body || "",
    publishedAt: release.published_at,
    gatewayUrl: gatewayAsset?.browser_download_url || null,
    nodeUrl: nodeAsset?.browser_download_url || null,
    gatewaySize: gatewayAsset?.size || 0,
    nodeSize: nodeAsset?.size || 0,
  };
}

/**
 * Download firmware binary from GitHub
 */
export async function downloadFirmware(
  url: string,
  onProgress?: (loaded: number, total: number) => void,
): Promise<ArrayBuffer> {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to download firmware: ${response.status}`);
  }

  const contentLength = response.headers.get("content-length");
  const total = contentLength ? parseInt(contentLength, 10) : 0;

  if (!response.body) {
    // Fallback for browsers without streaming support
    return response.arrayBuffer();
  }

  // Stream the download with progress
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    chunks.push(value);
    loaded += value.length;
    onProgress?.(loaded, total);
  }

  // Combine chunks into single ArrayBuffer
  const combined = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }

  return combined.buffer;
}

/**
 * Check if an update is available for the given current version
 */
export async function checkForUpdates(
  currentVersion: string,
): Promise<FirmwareRelease | null> {
  const latest = await fetchLatestRelease();

  if (!latest) return null;

  if (compareVersions(latest.version, currentVersion) > 0) {
    return latest;
  }

  return null;
}
