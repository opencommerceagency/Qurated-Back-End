import { Router } from 'express';
import { z } from 'zod';
import { authenticateApi } from '../middleware/auth.js';
import {
  createModel,
  updateModel,
  deleteModel,
  cloneModel,
  getModelById,
  getModels,
  addModelAttribute,
  updateModelAttribute,
  deleteModelAttribute,
  getModelAttributes
} from '../controllers/modelController.js';

const router = Router();

// Lock down all model endpoints with API key / basic auth
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

// Attribute endpoints for User Story B2.2 (Task 4)
router.get('/:id/attributes', getModelAttributes);
router.post('/:id/attributes', addModelAttribute);
router.put('/:id/attributes/:attributeId', updateModelAttribute);
router.put('/:id/attributes', updateModelAttribute);
router.delete('/:id/attributes/:attributeId', deleteModelAttribute);
router.delete('/:id/attributes', deleteModelAttribute);

// Model CRUD and template cloning routes
router.get('/', getModels);
router.post('/', createModel);
router.get('/:id', getModelById);
router.put('/:id', updateModel);
router.delete('/:id', deleteModel);
router.post('/:templateId/clone', cloneModel);

export default router;
