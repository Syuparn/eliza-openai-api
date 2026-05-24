'use strict';

const express = require('express');
const elizabot = require('elizabot');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());

// -------------------------
// State reconstruction
// -------------------------
// OpenAI API sends the full message history on every request.
// We replay all prior user messages through a fresh ElizaBot to
// reconstruct internal state (memory buffer, topic tracking, etc.),
// then process the latest user message to get the response.
function buildResponse(messages) {
  const userMessages = messages
    .filter((m) => m.role === 'user')
    .map((m) => (typeof m.content === 'string' ? m.content : m.content[0]?.text ?? ''));

  if (userMessages.length === 0) {
    throw new Error('No user message found');
  }

  const bot = new elizabot();

  // Replay all but the last message to rebuild bot state
  for (let i = 0; i < userMessages.length - 1; i++) {
    bot.transform(userMessages[i]);
  }

  // Process the latest message and capture the response
  const reply = bot.transform(userMessages[userMessages.length - 1]);
  return reply;
}

// -------------------------
// GET /v1/models
// -------------------------
app.get('/v1/models', (_req, res) => {
  res.json({
    object: 'list',
    data: [
      {
        id: 'doctor',
        object: 'model',
        created: 0,
        owned_by: 'emacs',
      },
    ],
  });
});

// -------------------------
// POST /v1/chat/completions
// -------------------------
app.post('/v1/chat/completions', (req, res) => {
  const { messages, model, stream } = req.body;

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({
      error: { message: 'messages is required', type: 'invalid_request_error' },
    });
  }

  if (stream) {
    return res.status(422).json({
      error: {
        message: 'Streaming is not supported by this server',
        type: 'invalid_request_error',
      },
    });
  }

  let reply;
  try {
    reply = buildResponse(messages);
  } catch (err) {
    return res.status(400).json({
      error: { message: err.message, type: 'invalid_request_error' },
    });
  }

  // Rough token counting (word-based, intentionally naive)
  const promptText = messages.map((m) => m.content).join(' ');
  const promptTokens = promptText.split(/\s+/).length;
  const completionTokens = reply.split(/\s+/).length;

  res.json({
    id: `chatcmpl-${uuidv4()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model ?? 'doctor',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: reply,
        },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  });
});

// -------------------------
// Start server
// -------------------------
const PORT = process.env.PORT ?? 11434;
app.listen(PORT, () => {
  console.log(`Doctor (Eliza) OpenAI-compatible API server listening on http://localhost:${PORT}`);
  console.log('Available endpoints:');
  console.log('  GET  /v1/models');
  console.log('  POST /v1/chat/completions');
});
