import { Router } from 'express';
import { z } from 'zod';
import { authenticateApi } from '../middleware/auth.js';
import {
  createExtractionJob,
  getExtractionJobById,
  updateProductState,
  getProductGaps
} from '../controllers/extractionController.js';

const router = Router();

// Protect all /api/extraction endpoints with authentication
router.use(authenticateApi);

// Validate UUID formatting so malformed headers get rejected right at the door
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

// Extraction job endpoints
router.post('/jobs', createExtractionJob);
router.get('/jobs/:id', getExtractionJobById);

// Product state machine and gap endpoints
router.patch('/products/:id/state', updateProductState);
router.get('/products/:id/gaps', getProductGaps);

export default router;
