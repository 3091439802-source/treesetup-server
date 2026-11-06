const mongoose = require('mongoose');

const smsCodeSchema = new mongoose.Schema({
  phone: {
    type: String,
    required: true
  },
  code: {
    type: String,
    required: true
  },
  used: {
    type: Boolean,
    default: false
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

// TTL index: auto-delete expired codes
smsCodeSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

// Compound index for lookup
smsCodeSchema.index({ phone: 1, code: 1 });

module.exports = mongoose.model('SmsCode', smsCodeSchema);