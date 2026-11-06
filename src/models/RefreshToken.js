const mongoose = require('mongoose');
const crypto = require('crypto');

const refreshTokenSchema = new mongoose.Schema({
  uid: {
    type: String,
    required: true,
    index: true
  },
  token: {
    type: String,
    required: true,
    unique: true
  },
  deviceInfo: {
    type: String,
    default: ''
  },
  expireAt: {
    type: Date,
    required: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// TTL index
refreshTokenSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

// Generate random token
refreshTokenSchema.statics.generateToken = function () {
  return crypto.randomBytes(32).toString('hex');
};

module.exports = mongoose.model('RefreshToken', refreshTokenSchema);