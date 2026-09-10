const express = require('express');
const serverless = require('serverless-http');
const { analyzeAggressiveSMC } = require('../../strategy_v71');

const app = express();

app.get('/status', (req, res) => {
  res.send('Bot is running on Netlify Functions!');
});

module.exports.handler = serverless(app);
