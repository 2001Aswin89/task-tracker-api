const router = require('express').Router();
const { z } = require('zod');
const { validate } = require('../middleware/validate');
const { requireAuth } = require('../middleware/auth');
const { generateTask } = require('../services/llm');

router.use(requireAuth);

const schema = z.object({ prompt: z.string().trim().min(3).max(1000) });

// Turns a rough note into a suggested title + description. It does not create a task;
// the client reviews the suggestion and then calls POST /tasks.
router.post('/task-description', validate(schema), async (req, res) => {
  res.json({ suggestion: await generateTask(req.body.prompt) });
});

module.exports = router;
