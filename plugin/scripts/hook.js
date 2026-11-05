'use strict';

// Entry point of every hook. The order below is the guarantee behind principle P1:
// output is silenced and failures are trapped before anything else can run.

const done = () => process.exit(0);

process.stdout.write = () => true;
process.stderr.write = () => true;
process.on('uncaughtException', done);
process.on('unhandledRejection', done);

try {
  if (process.env.PRODUCT_DECISIONS_SYNTH === '1') done();

  const [tool, hookEvent] = process.argv.slice(2);

  // Open stdin keeps the process alive, so this fires if the payload never ends.
  setTimeout(done, hookEvent === 'SessionEnd' ? 1000 : 2000).unref();

  // A stream, not fs.readFileSync(0), which fails on some Windows and non-blocking pipes.
  const chunks = [];
  process.stdin.on('data', (chunk) => chunks.push(chunk));
  process.stdin.on('error', done);
  process.stdin.on('end', () => {
    try {
      require('../src/hook/run.js').handlePayload({
        raw: Buffer.concat(chunks),
        tool,
        cwd: process.cwd(),
      });
    } finally {
      done();
    }
  });
} catch {
  done();
}
