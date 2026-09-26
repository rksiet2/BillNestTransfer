// Tiny cross-process "is the main BillNest app currently running?" lock,
// used so the standalone Factory Reset tool (factoryReset.cjs) can refuse
// to touch the SQLite file while the main app might also be writing to it.
// Deliberately file-based (not a named pipe/socket) — simplest thing that
// works across both processes without adding a new dependency.
const fs = require('fs');
const path = require('path');

function lockPath(userDataPath) {
  return path.join(userDataPath, '.billnest-running.lock');
}

function acquire(userDataPath) {
  try {
    fs.writeFileSync(lockPath(userDataPath), String(process.pid));
  } catch { /* non-fatal — worst case the reset tool just can't detect us */ }
}

function release(userDataPath) {
  try {
    fs.unlinkSync(lockPath(userDataPath));
  } catch { /* already gone, fine */ }
}

// Returns true only if a lock file exists AND the PID it names is still alive
// (an app that crashed without cleaning up its lock file shouldn't block reset forever).
function isMainAppRunning(userDataPath) {
  const file = lockPath(userDataPath);
  if (!fs.existsSync(file)) return false;
  const pid = parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
  if (!pid) return false;
  try {
    process.kill(pid, 0); // signal 0 = just checks the process exists, doesn't kill it
    return true;
  } catch {
    fs.unlinkSync(file); // stale lock from a crashed process — clean it up
    return false;
  }
}

module.exports = { acquire, release, isMainAppRunning };
