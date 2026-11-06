const mongoose = require('mongoose');

const gameSaveEntrySchema = new mongoose.Schema({
  key: { type: String, required: true },
  type: {
    type: String,
    required: true,
    enum: ['int', 'float', 'string']
  },
  value: { type: String, required: true }
}, { _id: false });

const gameSaveSchema = new mongoose.Schema({
  uid: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  revision: {
    type: Number,
    required: true,
    default: 0,
    min: 0
  },
  schemaVersion: {
    type: Number,
    required: true,
    default: 1
  },
  entries: {
    type: [gameSaveEntrySchema],
    default: []
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('GameSave', gameSaveSchema);
