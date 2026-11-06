const mongoose = require('mongoose');

const paymentOrderSchema = new mongoose.Schema({
  orderId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  uid: {
    type: String,
    required: true,
    index: true
  },
  provider: {
    type: String,
    required: true,
    enum: ['wechat', 'alipay']
  },
  productId: {
    type: String,
    required: true
  },
  productName: {
    type: String,
    required: true
  },
  amountCents: {
    type: Number,
    required: true,
    min: 1
  },
  currency: {
    type: String,
    default: 'CNY'
  },
  credits: {
    type: Number,
    required: true,
    min: 1
  },
  status: {
    type: String,
    required: true,
    enum: ['created', 'pending', 'paid', 'credited', 'failed', 'closed'],
    default: 'created',
    index: true
  },
  providerTransactionId: {
    type: String,
    sparse: true,
    index: true
  },
  providerPayload: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  paidAt: Date,
  creditedAt: Date,
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

paymentOrderSchema.index(
  { provider: 1, providerTransactionId: 1 },
  { unique: true, sparse: true }
);

paymentOrderSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('PaymentOrder', paymentOrderSchema);
