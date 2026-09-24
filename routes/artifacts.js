const express = require('express');
const { wrapRoute } = require('../lib/file-helpers');
const { getAllArtifacts, getArtifactSummary } = require('../lib/artifact-index');

const router = express.Router();

router.get('/summary', wrapRoute((req, res) => {
  res.json(getArtifactSummary());
}));

router.get('/', wrapRoute((req, res) => {
  res.json(getAllArtifacts());
}));

module.exports = router;
