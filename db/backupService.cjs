// Local, no-cloud backup/restore for BillNest.
//
// Strategy: copy the SQLite database file + "Bill Records" + "KOT Records"
// folders into a single "BillNest-Backup" folder that the owner chooses.
// We deliberately do NOT implement any Google Drive API/OAuth integration —
// instead, if the owner points this folder at their local Google Drive
// desktop-sync folder, that app uploads the backup automatically
// with zero extra code on our side. On a new PC, installing Google Drive
// (signed into the same Gmail) syncs the folder back down, and "Restore
// from Backup" in Settings loads it — that's the whole continuity story.
const fs = require('fs');
const path = require('path');
const { getDb, getDbFilePath, getBillRecordsDir, getKotRecordsDir } = require('./database.cjs');

const BACKUP_SUBFOLDER = 'BillNest-Backup';

function copyDirRecursive(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// Copies a SQLite file plus its -wal/-shm sidecar files (WAL mode keeps
// recent writes in the -wal file until a checkpoint; we force a full
// checkpoint first so the main .db file alone is always complete/consistent).
function copyDbFile(destDir) {
  const dbPath = getDbFilePath();
  try {
    getDb().pragma('wal_checkpoint(FULL)');
  } catch {
    // Non-fatal — worst case the -wal file (also copied below) has the rest.
  }
  fs.mkdirSync(destDir, { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) {
    const src = `${dbPath}${suffix}`;
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(destDir, path.basename(dbPath) + suffix));
  }
}

function resolveBackupRoot(chosenFolder) {
  return path.join(chosenFolder, BACKUP_SUBFOLDER);
}

function performBackup(chosenFolder) {
  if (!chosenFolder) throw new Error('No backup folder configured.');
  if (!fs.existsSync(chosenFolder)) throw new Error('Backup folder no longer exists. Please choose it again in Settings.');

  const root = resolveBackupRoot(chosenFolder);
  copyDbFile(path.join(root, 'data'));
  copyDirRecursive(getBillRecordsDir(), path.join(root, 'Bill Records'));
  copyDirRecursive(getKotRecordsDir(), path.join(root, 'KOT Records'));

  const manifest = { backedUpAt: new Date().toISOString(), app: 'BillNest', version: 1 };
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

// Restoring overwrites the live database file + records folders, so the
// caller (main.cjs) must relaunch the app right after this returns — the
// currently-open better-sqlite3 handle still points at the old (now
// overwritten) file until then.
function restoreBackup(chosenFolder) {
  if (!chosenFolder) throw new Error('No backup folder selected.');
  const root = resolveBackupRoot(chosenFolder);
  const manifestPath = path.join(root, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error('No BillNest backup found in that folder.');
  }

  const dbPath = getDbFilePath();
  const backupDataDir = path.join(root, 'data');
  for (const suffix of ['', '-wal', '-shm']) {
    const src = path.join(backupDataDir, path.basename(dbPath) + suffix);
    const dest = `${dbPath}${suffix}`;
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
    } else if (fs.existsSync(dest)) {
      // Backup has no -wal/-shm (clean checkpoint) — remove stale sidecar
      // files so we don't resurrect old, already-checkpointed writes.
      fs.rmSync(dest, { force: true });
    }
  }

  copyDirRecursive(path.join(root, 'Bill Records'), getBillRecordsDir());
  copyDirRecursive(path.join(root, 'KOT Records'), getKotRecordsDir());

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  return manifest;
}

module.exports = { performBackup, restoreBackup, resolveBackupRoot };
