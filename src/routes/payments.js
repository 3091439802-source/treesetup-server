const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const axios = require('axios');
const mongoose = require('mongoose');

const authMiddleware = require('../middleware/auth');
const User = require('../models/User');
const PaymentOrder = require('../models/PaymentOrder');

const router = express.Router();

// 价格与到账数量只在服务端定义。客户端只能提交 productId，不能提交金额或到账数量。
const PRODUCTS = Object.freeze({
  huan_yu_60: {
    name: '幻玉 x60',
    amountCents: 600,
    credits: 60
  },
  huan_yu_300: {
    name: '幻玉 x300',
    amountCents: 2800,
    credits: 300
  },
  huan_yu_600: {
    name: '幻玉 x600',
    amountCents: 5200,
    credits: 600
  }
});

function readSecret(inlineName, pathName) {
  if (process.env[inlineName]) {
    return process.env[inlineName].replace(/\\n/g, '\n').trim();
  }
  if (process.env[pathName]) {
    return fs.readFileSync(process.env[pathName], 'utf8').trim();
  }
  return '';
}

function pemPrivate(value) {
  if (!value) return '';
  if (value.includes('BEGIN')) return value;
  const lines = value.match(/.{1,64}/g) || [];
  return '-----BEGIN PRIVATE KEY-----\n' + lines.join('\n')
    + '\n-----END PRIVATE KEY-----';
}

function pemPublic(value) {
  if (!value) return '';
  if (value.includes('BEGIN')) return value;
  const lines = value.match(/.{1,64}/g) || [];
  return '-----BEGIN PUBLIC KEY-----\n' + lines.join('\n')
    + '\n-----END PUBLIC KEY-----';
}

function alipayConfig() {
  const appId = process.env.ALIPAY_APP_ID || '';
  const privateKey = pemPrivate(readSecret(
    'ALIPAY_PRIVATE_KEY', 'ALIPAY_PRIVATE_KEY_PATH'));
  const publicKey = pemPublic(readSecret(
    'ALIPAY_PUBLIC_KEY', 'ALIPAY_PUBLIC_KEY_PATH'));
  return {
    appId,
    privateKey,
    publicKey,
    ready: !!appId && !!privateKey && !!publicKey
  };
}

function wechatConfig() {
  const appId = process.env.WECHAT_PAY_APP_ID
    || process.env.WECHAT_APP_ID || '';
  const mchId = process.env.WECHAT_PAY_MCH_ID || '';
  const serialNo = process.env.WECHAT_PAY_SERIAL_NO || '';
  const privateKey = pemPrivate(readSecret(
    'WECHAT_PAY_PRIVATE_KEY', 'WECHAT_PAY_PRIVATE_KEY_PATH'));
  const apiV3Key = process.env.WECHAT_PAY_API_V3_KEY || '';
  const platformCert = readSecret(
    'WECHAT_PAY_PLATFORM_CERT', 'WECHAT_PAY_PLATFORM_CERT_PATH');
  return {
    appId,
    mchId,
    serialNo,
    privateKey,
    apiV3Key,
    platformCert,
    ready: !!appId && !!mchId && !!serialNo && !!privateKey
      && Buffer.byteLength(apiV3Key) === 32 && !!platformCert
  };
}

function notifyBaseUrl() {
  return (process.env.PAYMENT_NOTIFY_BASE_URL || '').replace(/\/+$/, '');
}

function createOrderId() {
  return 'gy' + Date.now().toString(36)
    + crypto.randomBytes(6).toString('hex');
}

function chinaTimestamp() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000)
    .toISOString().slice(0, 19).replace('T', ' ');
}

function alipayCanonical(params) {
  return Object.keys(params)
    .filter((key) => key !== 'sign' && key !== 'sign_type'
      && params[key] !== undefined && params[key] !== null
      && String(params[key]) !== '')
    .sort()
    .map((key) => key + '=' + String(params[key]))
    .join('&');
}

function buildAlipayAppOrder(order, config) {
  const params = {
    app_id: config.appId,
    method: 'alipay.trade.app.pay',
    format: 'JSON',
    charset: 'utf-8',
    sign_type: 'RSA2',
    timestamp: chinaTimestamp(),
    version: '1.0',
    notify_url: notifyBaseUrl() + '/api/payments/alipay/notify',
    biz_content: JSON.stringify({
      out_trade_no: order.orderId,
      total_amount: (order.amountCents / 100).toFixed(2),
      subject: order.productName,
      product_code: 'QUICK_MSECURITY_PAY',
      timeout_express: '30m'
    })
  };
  const signature = crypto.sign(
    'RSA-SHA256',
    Buffer.from(alipayCanonical(params), 'utf8'),
    config.privateKey
  ).toString('base64');

  return Object.keys(params)
    .sort()
    .map((key) => encodeURIComponent(key) + '='
      + encodeURIComponent(params[key]))
    .join('&') + '&sign=' + encodeURIComponent(signature);
}

function verifyAlipayNotify(body, config) {
  if (!body || !body.sign) return false;
  const expected = alipayCanonical(body);
  return crypto.verify(
    'RSA-SHA256',
    Buffer.from(expected, 'utf8'),
    config.publicKey,
    Buffer.from(body.sign, 'base64')
  );
}

function wechatRequestSignature(method, path, body, config) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const message = method + '\n' + path + '\n' + timestamp + '\n'
    + nonce + '\n' + body + '\n';
  const signature = crypto.sign(
    'RSA-SHA256',
    Buffer.from(message, 'utf8'),
    config.privateKey
  ).toString('base64');
  return {
    timestamp,
    nonce,
    authorization: 'WECHATPAY2-SHA256-RSA2048 '
      + 'mchid="' + config.mchId + '",'
      + 'nonce_str="' + nonce + '",'
      + 'signature="' + signature + '",'
      + 'timestamp="' + timestamp + '",'
      + 'serial_no="' + config.serialNo + '"'
  };
}

function verifyWechatSignature(headers, rawBody, config) {
  const timestamp = headers['wechatpay-timestamp'];
  const nonce = headers['wechatpay-nonce'];
  const signature = headers['wechatpay-signature'];
  if (!timestamp || !nonce || !signature || !config.platformCert) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const message = timestamp + '\n' + nonce + '\n' + rawBody + '\n';
  const certificate = new crypto.X509Certificate(config.platformCert);
  const expectedSerial = String(process.env.WECHAT_PAY_PLATFORM_CERT_SERIAL || '')
    .replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  const actualSerial = String(certificate.serialNumber || '')
    .replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  if (expectedSerial && expectedSerial !== actualSerial) return false;
  const headerSerial = String(headers['wechatpay-serial'] || '')
    .replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  if (headerSerial && headerSerial !== actualSerial) return false;
  return crypto.verify(
    'RSA-SHA256',
    Buffer.from(message, 'utf8'),
    certificate.publicKey,
    Buffer.from(signature, 'base64')
  );
}

function decryptWechatResource(resource, apiV3Key) {
  if (!resource || resource.algorithm !== 'AEAD_AES_256_GCM') {
    throw new Error('Unsupported WeChat notification encryption');
  }
  const ciphertext = Buffer.from(resource.ciphertext, 'base64');
  if (ciphertext.length <= 16) throw new Error('Invalid WeChat ciphertext');
  const authTag = ciphertext.subarray(ciphertext.length - 16);
  const encrypted = ciphertext.subarray(0, ciphertext.length - 16);
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    Buffer.from(apiV3Key, 'utf8'),
    Buffer.from(resource.nonce, 'utf8')
  );
  decipher.setAuthTag(authTag);
  decipher.setAAD(Buffer.from(resource.associated_data || '', 'utf8'));
  const plain = Buffer.concat([
    decipher.update(encrypted),
    decipher.final()
  ]);
  return JSON.parse(plain.toString('utf8'));
}

async function createWechatAppOrder(order, config) {
  const path = '/v3/pay/transactions/app';
  const body = JSON.stringify({
    appid: config.appId,
    mchid: config.mchId,
    description: order.productName,
    out_trade_no: order.orderId,
    notify_url: notifyBaseUrl() + '/api/payments/wechat/notify',
    amount: {
      total: order.amountCents,
      currency: 'CNY'
    }
  });
  const signed = wechatRequestSignature('POST', path, body, config);
  const response = await axios.post(
    'https://api.mch.weixin.qq.com' + path,
    body,
    {
      timeout: 15000,
      transformResponse: [(data) => data],
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: signed.authorization
      }
    }
  );
  const rawBody = typeof response.data === 'string'
    ? response.data : JSON.stringify(response.data);
  if (!verifyWechatSignature(response.headers, rawBody, config)) {
    throw new Error('WeChat response signature verification failed');
  }
  const data = JSON.parse(rawBody);
  if (!data.prepay_id) {
    throw new Error(data.message || data.code || 'Missing prepay_id');
  }

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const appMessage = config.appId + '\n' + timestamp + '\n'
    + nonce + '\n' + data.prepay_id + '\n';
  const appSign = crypto.sign(
    'RSA-SHA256',
    Buffer.from(appMessage, 'utf8'),
    config.privateKey
  ).toString('base64');
  return {
    appId: config.appId,
    partnerId: config.mchId,
    prepayId: data.prepay_id,
    packageValue: 'Sign=WXPay',
    nonceStr: nonce,
    timeStamp: timestamp,
    sign: appSign
  };
}

function publicOrder(order) {
  return {
    orderId: order.orderId,
    provider: order.provider,
    status: order.status,
    amountCents: order.amountCents,
    credits: order.credits,
    credited: order.status === 'credited'
  };
}

async function creditOrder(orderId, provider, transactionId, amountCents) {
  const session = await mongoose.startSession();
  let result = null;
  try {
    await session.withTransaction(async () => {
      const order = await PaymentOrder.findOne({
        orderId,
        provider
      }).session(session);
      if (!order) throw new Error('Payment order not found');
      if (!['created', 'pending', 'paid'].includes(order.status)) {
        result = order;
        return;
      }
      if (order.amountCents !== Number(amountCents)) {
        throw new Error('Payment amount mismatch');
      }
      if (order.providerTransactionId
        && order.providerTransactionId !== transactionId) {
        throw new Error('Payment transaction mismatch');
      }

      order.status = 'paid';
      order.providerTransactionId = transactionId;
      order.paidAt = new Date();
      await order.save({ session });

      await User.updateOne(
        { uid: order.uid },
        { $inc: { 'paymentAccount.huanYuPurchasedTotal': order.credits } },
        { session }
      );
      order.status = 'credited';
      order.creditedAt = new Date();
      await order.save({ session });
      result = order;
    });
    return result;
  } finally {
    await session.endSession();
  }
}

router.post('/orders', authMiddleware, async (req, res) => {
  try {
    const provider = String(req.body?.provider || '').toLowerCase();
    const productId = String(req.body?.productId || '');
    const product = PRODUCTS[productId];
    if (!product) {
      return res.status(400).json({ error: 'Unknown payment product' });
    }
    if (provider !== 'wechat' && provider !== 'alipay') {
      return res.status(400).json({ error: 'Unknown payment provider' });
    }
    if (!notifyBaseUrl().startsWith('https://')) {
      return res.status(503).json({
        error: 'Payment callback URL is not configured'
      });
    }

    const config = provider === 'wechat' ? wechatConfig() : alipayConfig();
    if (!config.ready) {
      return res.status(503).json({
        error: 'Payment provider is not configured'
      });
    }

    const user = await User.findOne({ uid: req.user.uid, isDeleted: false });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const order = await PaymentOrder.create({
      orderId: createOrderId(),
      uid: user.uid,
      provider,
      productId,
      productName: product.name,
      amountCents: product.amountCents,
      credits: product.credits,
      status: 'pending'
    });

    try {
      if (provider === 'wechat') {
        const appPay = await createWechatAppOrder(order, config);
        order.providerPayload = { prepayId: appPay.prepayId };
        await order.save();
        return res.json(Object.assign(publicOrder(order), { appPay }));
      }

      const alipayOrderInfo = buildAlipayAppOrder(order, config);
      order.providerPayload = { appOrderCreatedAt: new Date() };
      await order.save();
      return res.json(Object.assign(publicOrder(order), { alipayOrderInfo }));
    } catch (providerError) {
      order.status = 'failed';
      order.providerPayload = {
        error: providerError.message
      };
      await order.save();
      console.error('[Payments] create order failed:', providerError.message);
      return res.status(502).json({
        error: 'Payment provider rejected the order'
      });
    }
  } catch (err) {
    console.error('[Payments] order error:', err.message);
    return res.status(500).json({ error: 'Failed to create payment order' });
  }
});

router.get('/status/:orderId', authMiddleware, async (req, res) => {
  try {
    const order = await PaymentOrder.findOne({
      orderId: req.params.orderId,
      uid: req.user.uid
    });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    return res.json(publicOrder(order));
  } catch (err) {
    console.error('[Payments] status error:', err.message);
    return res.status(500).json({ error: 'Failed to query payment order' });
  }
});

router.post('/wechat/notify', async (req, res) => {
  try {
    const config = wechatConfig();
    if (!config.ready) {
      return res.status(503).json({ code: 'FAIL', message: 'not configured' });
    }
    const rawBody = Buffer.isBuffer(req.body)
      ? req.body.toString('utf8') : '';
    if (!rawBody || !verifyWechatSignature(req.headers, rawBody, config)) {
      return res.status(401).json({ code: 'FAIL', message: 'invalid signature' });
    }
    const notification = JSON.parse(rawBody);
    if (notification.event_type !== 'TRANSACTION.SUCCESS') {
      return res.json({ code: 'SUCCESS', message: 'ignored' });
    }
    const data = decryptWechatResource(notification.resource, config.apiV3Key);
    if (data.appid !== config.appId || data.mchid !== config.mchId
      || data.trade_state !== 'SUCCESS') {
      return res.status(400).json({ code: 'FAIL', message: 'trade mismatch' });
    }
    await creditOrder(
      data.out_trade_no,
      'wechat',
      data.transaction_id,
      data.amount?.total
    );
    return res.json({ code: 'SUCCESS', message: '成功' });
  } catch (err) {
    console.error('[Payments] WeChat notify error:', err.message);
    return res.status(500).json({ code: 'FAIL', message: 'processing failed' });
  }
});

router.post('/alipay/notify', async (req, res) => {
  try {
    const config = alipayConfig();
    if (!config.ready || !verifyAlipayNotify(req.body || {}, config)) {
      return res.status(401).type('text/plain').send('failure');
    }
    const body = req.body;
    if (body.app_id !== config.appId) {
      return res.status(400).type('text/plain').send('failure');
    }
    if (body.trade_status !== 'TRADE_SUCCESS'
      && body.trade_status !== 'TRADE_FINISHED') {
      return res.type('text/plain').send('success');
    }
    await creditOrder(
      body.out_trade_no,
      'alipay',
      body.trade_no,
      Math.round(Number(body.total_amount) * 100)
    );
    return res.type('text/plain').send('success');
  } catch (err) {
    console.error('[Payments] Alipay notify error:', err.message);
    return res.status(500).type('text/plain').send('failure');
  }
});

module.exports = router;
