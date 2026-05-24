'use strict';

const express = require('express');
const elizabot = require('elizabot');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

const app = express();
app.use(express.json());

// -------------------------
// Session cache
// -------------------------
// Key:   SHA-256( JSON(messages_so_far + assistant_reply) )
//   = the exact messages array the next request will send minus its last user message
// Value: ElizaBot instance in the state AFTER processing those messages
//
// This avoids the "replay divergence" problem: if we rebuilt state by
// replaying user messages through a fresh bot, the bot would generate
// different (phantom) responses internally, which shifts its memory
// buffer and response-rotation counters away from the real conversation.
const sessions = new Map();
const SESSION_MAX = 500;

function hashMessages(messages) {
  return crypto.createHash('sha256').update(JSON.stringify(messages)).digest('hex');
}

function evictOldestSession() {
  const firstKey = sessions.keys().next().value;
  sessions.delete(firstKey);
}

function buildResponse(messages) {
  const lastMsg = messages[messages.length - 1];
  const lastUserContent =
    typeof lastMsg.content === 'string' ? lastMsg.content : lastMsg.content[0]?.text ?? '';

  if (!lastUserContent) {
    throw new Error('No user message found');
  }

  // history = every message except the final user turn
  const history = messages.slice(0, -1);
  const historyKey = hashMessages(history);

  let bot;
  if (history.length === 0) {
    // First turn: always a fresh bot
    bot = new elizabot();
  } else {
    const cached = sessions.get(historyKey);
    if (cached) {
      bot = cached;
    } else {
      // Cache miss (e.g. server restart): fall back to replay.
      // State fidelity is not guaranteed in this path.
      bot = new elizabot();
      history
        .filter((m) => m.role === 'user')
        .forEach((m) => {
          const text = typeof m.content === 'string' ? m.content : m.content[0]?.text ?? '';
          bot.transform(text);
        });
    }
  }

  const reply = bot.transform(lastUserContent);

  // Cache the bot under the key the NEXT request will look up:
  //   hash( current messages + { role: assistant, content: reply } )
  // That is exactly messages.slice(0, -1) of the next request.
  const nextHistoryKey = hashMessages([...messages, { role: 'assistant', content: reply }]);
  if (sessions.size >= SESSION_MAX) evictOldestSession();
  sessions.set(nextHistoryKey, bot);

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
