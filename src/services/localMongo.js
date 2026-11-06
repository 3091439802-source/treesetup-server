const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { MongoBinary } = require('mongodb-memory-server-core/lib/util/MongoBinary');

function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function startLocalMongo(serverRoot) {
  const dbPath = path.join(serverRoot, 'data', 'mongodb');
  fs.mkdirSync(dbPath, { recursive: true });
  const binary = await MongoBinary.getPath();
  const port = await findFreePort();
  const child = spawn(binary, [
    '--dbpath', dbPath,
    '--port', String(port),
    '--bind_ip', '127.0.0.1',
    '--storageEngine', 'wiredTiger',
    '--setParameter', 'diagnosticDataCollectionEnabled=false'
  ], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  await new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(
      () => finish(new Error('Timed out waiting for mongod to start')),
      20000
    );
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    }
    const inspect = (chunk) => {
      if (chunk.toString().includes('Waiting for connections')) finish();
    };
    child.stdout.on('data', inspect);
    child.stderr.on('data', inspect);
    child.once('error', finish);
    child.once('exit', (code) => {
      if (!settled) finish(new Error(`mongod exited before readiness (code ${code})`));
    });
  });

  return {
    dbPath,
    uri: `mongodb://127.0.0.1:${port}/treesetup?directConnection=true`,
    stop: async () => {
      if (child.exitCode !== null) return;
      child.kill();
      await new Promise((resolve) => {
        child.once('exit', resolve);
        setTimeout(resolve, 5000);
      });
    }
  };
}

module.exports = {
  startLocalMongo
};
