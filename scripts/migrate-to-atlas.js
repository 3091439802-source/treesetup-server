const { MongoClient } = require('mongodb');

const sourceUri = process.env.SOURCE_MONGODB_URI;
const targetUri = process.env.MONGODB_URI;
const databaseName = process.env.MONGODB_DATABASE || 'treesetup';

if (!sourceUri || !targetUri) {
  console.error('SOURCE_MONGODB_URI and MONGODB_URI are required');
  process.exit(2);
}

async function copyCollection(sourceDb, targetDb, collectionName) {
  const source = sourceDb.collection(collectionName);
  const target = targetDb.collection(collectionName);
  const cursor = source.find({});
  let copied = 0;
  let batch = [];

  async function flush() {
    if (batch.length === 0) return;
    await target.bulkWrite(batch.map((document) => ({
      replaceOne: {
        filter: { _id: document._id },
        replacement: document,
        upsert: true
      }
    })), { ordered: false });
    copied += batch.length;
    batch = [];
  }

  for await (const document of cursor) {
    batch.push(document);
    if (batch.length >= 500) await flush();
  }
  await flush();

  const indexes = await source.indexes();
  for (const index of indexes) {
    if (index.name === '_id_') continue;
    const options = { ...index };
    delete options.key;
    delete options.v;
    delete options.ns;
    await target.createIndex(index.key, options);
  }
  return copied;
}

async function main() {
  const sourceClient = new MongoClient(sourceUri);
  const targetClient = new MongoClient(targetUri);
  try {
    await sourceClient.connect();
    await targetClient.connect();
    const sourceDb = sourceClient.db(databaseName);
    const targetDb = targetClient.db(databaseName);
    const collections = await sourceDb.listCollections({}, { nameOnly: true })
      .toArray();

    for (const { name } of collections) {
      if (name.startsWith('system.')) continue;
      const copied = await copyCollection(sourceDb, targetDb, name);
      console.log(`${name}: ${copied}`);
    }
    await targetDb.command({ ping: 1 });
    console.log('MIGRATION_OK');
  } finally {
    await sourceClient.close().catch(() => {});
    await targetClient.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error('MIGRATION_FAILED:', error);
  process.exit(1);
});
