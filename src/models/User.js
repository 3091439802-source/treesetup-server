const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  uid: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  nickname: {
    type: String,
    default: ''
  },
  avatar: {
    type: String,
    default: ''
  },
  phone: {
    type: String,
    sparse: true,
    unique: true,
    index: true
  },
  passwordHash: {
    type: String,
    select: false,
    default: ''
  },
  bindings: [{
    platform: {
      type: String,
      enum: ['qq', 'wechat']
    },
    openId: String,
    unionId: String
  }],
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  },
  lastLoginAt: {
    type: Date,
    default: Date.now
  },
  lastLoginPlatform: {
    type: String,
    enum: ['qq', 'wechat', 'phone'],
    default: 'phone'
  },
  accountType: {
    type: String,
    enum: ['standard', 'shared_test', 'premium_test'],
    default: 'standard'
  },
  paymentAccount: {
    huanYuPurchasedTotal: {
      type: Number,
      default: 0,
      min: 0
    }
  },
  isDeleted: {
    type: Boolean,
    default: false
  }
});

// Compound unique index on bindings.platform + bindings.openId
userSchema.index({ 'bindings.platform': 1, 'bindings.openId': 1 }, { unique: true, sparse: true });

// Generate unique uid before save
userSchema.pre('save', function (next) {
  if (this.isNew && !this.uid) {
    this.uid = 'u_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 6);
  }
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('User', userSchema);
