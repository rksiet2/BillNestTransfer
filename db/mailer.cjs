// Minimal, dependency-free SMTP client used only to send the "Forgot PIN"
// OTP email via Gmail. We deliberately avoid nodemailer (or any npm
// package) here — this environment's npm registry proxy has been unreliable
// for new installs — and instead speak SMTP directly over Node's built-in
// `tls` module, which Electron's main process has full access to.
//
// Gmail requires an "App Password" (not the normal account password) when
// 2FA is enabled, which Google requires for App Passwords anyway:
// https://myaccount.google.com/apppasswords
const tls = require('tls');

function b64(str) {
  return Buffer.from(str, 'utf8').toString('base64');
}

// Reads all lines of a single (possibly multi-line "250-...\r\n250 ...")
// SMTP reply from the socket before resolving, since Gmail sends multi-line
// EHLO responses that arrive in one or more TCP chunks.
function readReply(socket) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      // A reply is complete once the last line has "code SP" (not "code-").
      const lines = buffer.split(/\r\n/).filter(Boolean);
      const last = lines[lines.length - 1];
      if (last && /^\d{3} /.test(last)) {
        cleanup();
        resolve(buffer);
      }
    };
    const onError = (err) => { cleanup(); reject(err); };
    const onTimeout = () => { cleanup(); reject(new Error('SMTP connection timed out.')); };
    function cleanup() {
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('timeout', onTimeout);
    }
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('timeout', onTimeout);
  });
}

function send(socket, line) {
  socket.write(`${line}\r\n`);
}

async function command(socket, line, expectedPrefixes = ['2', '3']) {
  send(socket, line);
  const reply = await readReply(socket);
  const code = reply.slice(0, 1);
  if (!expectedPrefixes.includes(code)) {
    throw new Error(`SMTP error: ${reply.trim()}`);
  }
  return reply;
}

// Sends a plain-text email via Gmail's SMTP-over-implicit-TLS port (465).
// `auth.user` is the full Gmail address; `auth.pass` is a 16-character
// Google App Password (spaces are fine, we strip them).
async function sendGmail({ user, pass, to, subject, text }) {
  if (!user || !pass) throw new Error('Recovery email / app password is not configured in Settings.');
  const cleanPass = pass.replace(/\s+/g, '');

  const socket = tls.connect({ host: 'smtp.gmail.com', port: 465, servername: 'smtp.gmail.com' });
  socket.setTimeout(15000);

  try {
    await new Promise((resolve, reject) => {
      socket.once('secureConnect', resolve);
      socket.once('error', reject);
    });
    await readReply(socket); // server greeting (220 ...)
    await command(socket, 'EHLO billnest.local');
    await command(socket, 'AUTH LOGIN');
    await command(socket, b64(user));
    await command(socket, b64(cleanPass));
    await command(socket, `MAIL FROM:<${user}>`);
    await command(socket, `RCPT TO:<${to}>`);
    await command(socket, 'DATA', ['3']);
    const message = [
      `From: BillNest <${user}>`,
      `To: ${to}`,
      `Subject: ${subject}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      text,
      '.',
    ].join('\r\n');
    await command(socket, message);
    await command(socket, 'QUIT', ['2', '0']);
  } finally {
    socket.end();
  }
}

module.exports = { sendGmail };
