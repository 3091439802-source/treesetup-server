require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');

const authRoutes = require('./routes/auth');
const antifraudRoutes = require('./routes/antifraud');
const gameSaveRoutes = require('./routes/gameSave');
const paymentRoutes = require('./routes/payments');
const { startLocalMongo } = require('./services/localMongo');
const { ensureConfiguredAccounts } = require('./services/testAccount');

async function startServer() {
  const app = express();
  const PORT = process.env.PORT || 3000;

  // 优先使用持久化 MongoDB（生产环境必须）；未配置时回退到内存库（开发/联调用）
  let mongoUri = process.env.MONGODB_URI;
  let localMongo = null;
  if (mongoUri) {
    console.log('Using persistent MongoDB from MONGODB_URI');
  } else if (process.env.NODE_ENV === 'production') {
    throw new Error('MONGODB_URI is required when NODE_ENV=production');
  } else {
    localMongo = await startLocalMongo(path.join(__dirname, '..'));
    console.log('Starting local MongoDB with persistent data at ' + localMongo.dbPath);
    mongoUri = localMongo.uri;
    console.log('MongoDB URI:', mongoUri);
  }

  // Middleware
  app.use(cors());
  // WeChat Pay signature verification requires the exact, unparsed JSON body.
  app.use('/api/payments/wechat/notify',
    express.raw({ type: 'application/json', limit: '256kb' }));
  app.use(express.json());
  app.use(express.urlencoded({ extended: false, limit: '256kb' }));
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/')) {
      console.log(`[HTTP] ${new Date().toISOString()} ${req.ip} ${req.method} ${req.originalUrl}`);
    }
    next();
  });

  // Routes
  app.use('/api/auth', authRoutes);
  app.use('/api/game-save', gameSaveRoutes);
  app.use('/api/antifraud', antifraudRoutes);
  app.use('/api/payments', paymentRoutes);

  // Health check
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Connect and start
  await mongoose.connect(mongoUri, { dbName: 'treesetup' });
  console.log('MongoDB connected');
  try {
    await ensureConfiguredAccounts();
  } catch (error) {
    console.error('[ACCOUNT-CONFIG] Shared account import failed:', error.message);
  }

  if (localMongo) {
    const stop = async () => {
      await mongoose.disconnect().catch(() => {});
      await localMongo.stop().catch(() => {});
    };
    process.once('SIGINT', () => stop().finally(() => process.exit(0)));
    process.once('SIGTERM', () => stop().finally(() => process.exit(0)));
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log('Server running on http://0.0.0.0:' + PORT);
  });
}

startServer().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
