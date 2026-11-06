const express = require('express');

const authMiddleware = require('../middleware/auth');
const GameSave = require('../models/GameSave');
const { validateEntries } = require('../services/gameSaveData');

const router = express.Router();
const SCHEMA_VERSION = 1;

function responseFor(save) {
  return {
    uid: save.uid,
    revision: save.revision,
    schemaVersion: save.schemaVersion,
    entries: save.entries,
    updatedAt: save.updatedAt
  };
}

router.get('/', authMiddleware, async (req, res) => {
  try {
    const save = await GameSave.findOne({ uid: req.user.uid }).lean();
    if (!save) {
      return res.status(404).json({ error: 'Game save not found' });
    }
    res.json(responseFor(save));
  } catch (error) {
    console.error('game-save read error:', error);
    res.status(500).json({ error: 'Failed to read game save' });
  }
});

router.put('/', authMiddleware, async (req, res) => {
  try {
    const baseRevision = req.body && req.body.baseRevision;
    const schemaVersion = req.body && req.body.schemaVersion;
    if (!Number.isInteger(baseRevision) || baseRevision < 0
        || schemaVersion !== SCHEMA_VERSION) {
      return res.status(400).json({ error: 'Invalid game save metadata' });
    }

    const validation = validateEntries(req.body && req.body.entries);
    if (!validation.ok) {
      return res.status(400).json({ error: validation.error });
    }

    const updated = await GameSave.findOneAndUpdate(
      { uid: req.user.uid, revision: baseRevision },
      {
        $set: {
          entries: validation.entries,
          schemaVersion,
          updatedAt: new Date()
        },
        $inc: { revision: 1 }
      },
      { new: true, runValidators: true, lean: true }
    );

    if (updated) return res.json(responseFor(updated));

    const existing = await GameSave.findOne({ uid: req.user.uid }).lean();
    if (existing) {
      return res.status(409).json({
        error: 'Game save revision conflict',
        revision: existing.revision
      });
    }
    if (baseRevision !== 0) {
      return res.status(409).json({ error: 'Game save revision conflict' });
    }

    const created = await GameSave.create({
      uid: req.user.uid,
      revision: 1,
      schemaVersion,
      entries: validation.entries,
      updatedAt: new Date()
    });
    res.status(201).json(responseFor(created));
  } catch (error) {
    if (error && error.code === 11000) {
      return res.status(409).json({ error: 'Game save revision conflict' });
    }
    console.error('game-save write error:', error);
    res.status(500).json({ error: 'Failed to write game save' });
  }
});

module.exports = router;
