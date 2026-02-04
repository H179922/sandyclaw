import type { Sandbox } from '@cloudflare/sandbox';
import type { MoltbotEnv } from '../types';
import { R2_MOUNT_PATH } from '../config';
import { mountR2Storage } from './r2';
import { waitForProcess } from './utils';

export interface SyncResult {
  success: boolean;
  lastSync?: string;
  error?: string;
  details?: string;
}

export interface ManifestEntry {
  path: string;
  checksum: string;
  size: number;
}

export interface BackupManifest {
  version: number;
  timestamp: string;
  entries: ManifestEntry[];
}

/**
 * Sync moltbot config from container to R2 for persistence.
 * 
 * This function:
 * 1. Mounts R2 if not already mounted
 * 2. Verifies source has critical files (prevents overwriting good backup with empty data)
 * 3. Runs rsync to copy config to R2
 * 4. Writes a timestamp file for tracking
 * 
 * @param sandbox - The sandbox instance
 * @param env - Worker environment bindings
 * @returns SyncResult with success status and optional error details
 */
export async function syncToR2(sandbox: Sandbox, env: MoltbotEnv): Promise<SyncResult> {
  // Check if R2 is configured
  if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.CF_ACCOUNT_ID) {
    return { success: false, error: 'R2 storage is not configured' };
  }

  // Mount R2 if not already mounted
  const mounted = await mountR2Storage(sandbox, env);
  if (!mounted) {
    return { success: false, error: 'Failed to mount R2 storage' };
  }

  // Sanity check: verify source has critical files before syncing
  // This prevents accidentally overwriting a good backup with empty/corrupted data
  try {
    const checkProc = await sandbox.startProcess('test -f /root/.clawdbot/clawdbot.json && echo "ok"');
    await waitForProcess(checkProc, 5000);
    const checkLogs = await checkProc.getLogs();
    if (!checkLogs.stdout?.includes('ok')) {
      return { 
        success: false, 
        error: 'Sync aborted: source missing clawdbot.json',
        details: 'The local config directory is missing critical files. This could indicate corruption or an incomplete setup.',
      };
    }
  } catch (err) {
    return { 
      success: false, 
      error: 'Failed to verify source files',
      details: err instanceof Error ? err.message : 'Unknown error',
    };
  }

  // Run rsync to backup config to R2
  // Note: Use --no-times because s3fs doesn't support setting timestamps
  // SECURITY: Don't use --delete on first sync to avoid wiping existing good backups
  // Instead, create versioned backups and keep previous version
  const backupDir = `${R2_MOUNT_PATH}/clawdbot`;
  const backupDirPrev = `${R2_MOUNT_PATH}/clawdbot.prev`;
  const skillsDir = `${R2_MOUNT_PATH}/skills`;
  const skillsDirPrev = `${R2_MOUNT_PATH}/skills.prev`;

  // Rotate previous backup (keep one version back for recovery)
  const rotateCmd = `
    if [ -d "${backupDir}" ]; then
      rm -rf "${backupDirPrev}" 2>/dev/null || true
      cp -a "${backupDir}" "${backupDirPrev}" 2>/dev/null || true
    fi
    if [ -d "${skillsDir}" ]; then
      rm -rf "${skillsDirPrev}" 2>/dev/null || true
      cp -a "${skillsDir}" "${skillsDirPrev}" 2>/dev/null || true
    fi
  `;

  try {
    // Rotate backups first
    const rotateProc = await sandbox.startProcess(rotateCmd);
    await waitForProcess(rotateProc, 15000);

    // Now sync with --delete (safe because we have .prev backup)
    const syncCmd = `rsync -r --no-times --delete --exclude='*.lock' --exclude='*.log' --exclude='*.tmp' /root/.clawdbot/ ${backupDir}/ && rsync -r --no-times --delete /root/clawd/skills/ ${skillsDir}/`;
    const proc = await sandbox.startProcess(syncCmd);
    await waitForProcess(proc, 30000); // 30 second timeout for sync

    // Generate manifest with checksums for integrity verification
    const manifestCmd = `
      cd ${R2_MOUNT_PATH} && find clawdbot skills -type f 2>/dev/null | while read f; do
        sum=$(md5sum "$f" 2>/dev/null | cut -d' ' -f1)
        size=$(stat -c%s "$f" 2>/dev/null || stat -f%z "$f" 2>/dev/null)
        echo "$f|$sum|$size"
      done
    `;
    const manifestProc = await sandbox.startProcess(manifestCmd);
    await waitForProcess(manifestProc, 15000);
    const manifestLogs = await manifestProc.getLogs();

    // Create manifest JSON
    const entries: ManifestEntry[] = (manifestLogs.stdout || '').trim().split('\n')
      .filter(line => line.includes('|'))
      .map(line => {
        const [path, checksum, size] = line.split('|');
        return { path, checksum, size: parseInt(size, 10) || 0 };
      });

    const manifest: BackupManifest = {
      version: 1,
      timestamp: new Date().toISOString(),
      entries,
    };

    // Write manifest and timestamp
    const writeManifestCmd = `cat > ${R2_MOUNT_PATH}/.manifest.json << 'EOFMANIFEST'
${JSON.stringify(manifest, null, 2)}
EOFMANIFEST
date -Iseconds > ${R2_MOUNT_PATH}/.last-sync`;

    const writeProc = await sandbox.startProcess(writeManifestCmd);
    await waitForProcess(writeProc, 5000);

    // Check for success by reading the timestamp file
    const timestampProc = await sandbox.startProcess(`cat ${R2_MOUNT_PATH}/.last-sync`);
    await waitForProcess(timestampProc, 5000);
    const timestampLogs = await timestampProc.getLogs();
    const lastSync = timestampLogs.stdout?.trim();

    if (lastSync && lastSync.match(/^\d{4}-\d{2}-\d{2}/)) {
      return { success: true, lastSync };
    } else {
      const logs = await proc.getLogs();
      return {
        success: false,
        error: 'Sync failed',
        details: logs.stderr || logs.stdout || 'No timestamp file created',
      };
    }
  } catch (err) {
    return {
      success: false,
      error: 'Sync error',
      details: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}

/**
 * Verify R2 backup integrity using the manifest.
 *
 * @param sandbox - The sandbox instance
 * @param env - Worker environment bindings
 * @returns Object with verified status and any errors
 */
export async function verifyR2Backup(sandbox: Sandbox, env: MoltbotEnv): Promise<{ valid: boolean; errors: string[] }> {
  const errors: string[] = [];

  // Check if R2 is configured
  if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.CF_ACCOUNT_ID) {
    return { valid: false, errors: ['R2 storage is not configured'] };
  }

  // Mount R2 if not already mounted
  const mounted = await mountR2Storage(sandbox, env);
  if (!mounted) {
    return { valid: false, errors: ['Failed to mount R2 storage'] };
  }

  try {
    // Read manifest
    const manifestProc = await sandbox.startProcess(`cat ${R2_MOUNT_PATH}/.manifest.json`);
    await waitForProcess(manifestProc, 5000);
    const manifestLogs = await manifestProc.getLogs();

    if (!manifestLogs.stdout) {
      return { valid: false, errors: ['No manifest found - backup may be from older version'] };
    }

    const manifest: BackupManifest = JSON.parse(manifestLogs.stdout);

    // Verify each file's checksum
    for (const entry of manifest.entries) {
      const verifyProc = await sandbox.startProcess(`md5sum "${R2_MOUNT_PATH}/${entry.path}" 2>/dev/null | cut -d' ' -f1`);
      await waitForProcess(verifyProc, 5000);
      const verifyLogs = await verifyProc.getLogs();
      const actualChecksum = verifyLogs.stdout?.trim();

      if (actualChecksum !== entry.checksum) {
        errors.push(`Checksum mismatch: ${entry.path} (expected ${entry.checksum}, got ${actualChecksum})`);
      }
    }

    return { valid: errors.length === 0, errors };
  } catch (err) {
    return { valid: false, errors: [`Verification error: ${err instanceof Error ? err.message : 'Unknown'}`] };
  }
}
