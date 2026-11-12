import { Router } from 'express';
import { z } from 'zod';
import { getAiCosts } from '../controllers/metricsController.js';

const router = Router();

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const merchantIdSchema = z.string().refine(
  (val) => z.string().uuid().safeParse(val).success || UUID_REGEX.test(val),
  { message: 'Must be a valid UUID' }
);

// Every tenant operation needs an explicit merchant ID header
router.use((req, res, next) => {
  const rawMerchantId = req.headers['x-merchant-id'];
  const parseResult = merchantIdSchema.safeParse(rawMerchantId);

  if (!parseResult.success) {
    return res.status(400).json({
      error: 'Invalid or missing x-merchant-id header. Must be a valid UUID.'
    });
  }

  req.merchantId = parseResult.data;
  next();
});

router.get('/ai-costs', getAiCosts);

export default router;

