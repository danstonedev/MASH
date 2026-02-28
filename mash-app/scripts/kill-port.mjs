/**
 * kill-port.mjs — Kill any process listening on the Vite dev port (default 5173).
 * Used as a `predev` step to prevent stale server accumulation.
 *
 * Usage:  node scripts/kill-port.mjs [port]
 */
import { execSync } from 'child_process';

const port = parseInt(process.argv[2] || '5173', 10);

try {
  // Find PID listening on the target port (Windows)
  const output = execSync(
    `netstat -ano | findstr "LISTENING" | findstr ":${port} "`,
    { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
  );

  const pids = new Set();
  for (const line of output.trim().split('\n')) {
    const parts = line.trim().split(/\s+/);
    const pid = parseInt(parts[parts.length - 1], 10);
    if (pid && pid !== process.pid) pids.add(pid);
  }

  for (const pid of pids) {
    try {
      execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' });
      console.log(`[kill-port] Killed stale process PID ${pid} on port ${port}`);
    } catch {
      // Process may have already exited
    }
  }

  if (pids.size === 0) {
    console.log(`[kill-port] Port ${port} is free`);
  }
} catch {
  // netstat found nothing — port is free
  console.log(`[kill-port] Port ${port} is free`);
}
