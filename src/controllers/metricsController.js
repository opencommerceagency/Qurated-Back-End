import { z } from 'zod';
import { pool } from '../db/index.js';
import { calculateTokenCost } from '../services/costCalculator.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const querySchema = z.object({
  job_id: z.string().refine((val) => UUID_REGEX.test(val), { message: 'job_id must be a valid UUID' }).optional(),
  from: z.string().datetime({ offset: true }).optional().or(z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional()),
  to: z.string().datetime({ offset: true }).optional().or(z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional()),
  start_date: z.string().datetime({ offset: true }).optional().or(z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional()),
  end_date: z.string().datetime({ offset: true }).optional().or(z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional())
});

/**
 * GET /api/metrics/ai-costs
 * Aggregates AI token usage and calculates costs based on OpenRouter model pricing.
 * Strictly enforces multi-tenant isolation via req.merchantId.
 */
export async function getAiCosts(req, res) {
  try {
    const merchantId = req.merchantId;
    if (!merchantId) {
      return res.status(400).json({ error: 'Invalid or missing x-merchant-id header. Must be a valid UUID.' });
    }

    const parseResult = querySchema.safeParse(req.query);
    if (!parseResult.success) {
      const firstError = parseResult.error.issues[0]?.message || 'Invalid query parameters';
      return res.status(400).json({ error: firstError, details: parseResult.error.flatten() });
    }

    const { job_id: jobId, from, to, start_date: startDate, end_date: endDate } = parseResult.data;
    const fromDate = from || startDate;
    const toDate = to || endDate;

    // 1. Single Job Query
    if (jobId) {
      const jobRes = await pool.query(
        `SELECT id, merchant_id, total_records, processed_records, failed_records, status, created_at
         FROM extraction_jobs
         WHERE id = $1 AND merchant_id = $2`,
        [jobId, merchantId]
      );

      if (jobRes.rows.length === 0) {
        return res.status(404).json({ error: 'Extraction job not found' });
      }

      const job = jobRes.rows[0];

      const metricsRes = await pool.query(
        `SELECT id, model_used, prompt_tokens, completion_tokens, is_failover, status, created_at
         FROM extraction_metrics
         WHERE job_id = $1
         ORDER BY created_at ASC`,
        [jobId]
      );

      const metrics = metricsRes.rows;
      const modelMap = new Map();
      let totalPromptTokens = 0;
      let totalCompletionTokens = 0;
      let totalJobCost = 0;

      for (const m of metrics) {
        const model = m.model_used;
        const promptTokens = Number(m.prompt_tokens) || 0;
        const completionTokens = Number(m.completion_tokens) || 0;

        totalPromptTokens += promptTokens;
        totalCompletionTokens += completionTokens;

        const cost = calculateTokenCost(model, promptTokens, completionTokens);
        totalJobCost += cost.totalCost;

        if (!modelMap.has(model)) {
          modelMap.set(model, {
            model,
            prompt_tokens: 0,
            completion_tokens: 0,
            prompt_cost: 0,
            completion_cost: 0,
            total_cost: 0,
            attempts: 0
          });
        }

        const entry = modelMap.get(model);
        entry.prompt_tokens += promptTokens;
        entry.completion_tokens += completionTokens;
        entry.prompt_cost = Number((entry.prompt_cost + cost.promptCost).toFixed(8));
        entry.completion_cost = Number((entry.completion_cost + cost.completionCost).toFixed(8));
        entry.total_cost = Number((entry.total_cost + cost.totalCost).toFixed(8));
        entry.attempts += 1;
      }

      // Unique products attempted = total_records (or processed + failed)
      const productsAttempted = job.total_records > 0
        ? job.total_records
        : (job.processed_records + job.failed_records);

      const costPerProduct = productsAttempted > 0
        ? Number((totalJobCost / productsAttempted).toFixed(8))
        : 0;

      return res.status(200).json({
        job_id: job.id,
        status: job.status,
        total_cost: Number(totalJobCost.toFixed(8)),
        total_prompt_tokens: totalPromptTokens,
        total_completion_tokens: totalCompletionTokens,
        total_tokens: totalPromptTokens + totalCompletionTokens,
        total_products_attempted: productsAttempted,
        cost_per_product: costPerProduct,
        attempts_count: metrics.length,
        breakdown_by_model: Array.from(modelMap.values())
      });
    }

    // 2. Global / Date-Range Query across tenant's jobs
    const conditions = ['j.merchant_id = $1'];
    const params = [merchantId];
    let paramIndex = 2;

    if (fromDate) {
      conditions.push(`em.created_at >= $${paramIndex}`);
      params.push(new Date(fromDate).toISOString());
      paramIndex++;
    }

    if (toDate) {
      conditions.push(`em.created_at <= $${paramIndex}`);
      params.push(new Date(toDate).toISOString());
      paramIndex++;
    }

    const query = `
      SELECT
        j.id AS job_id,
        j.total_records,
        j.processed_records,
        j.failed_records,
        j.status AS job_status,
        em.id AS metric_id,
        em.model_used,
        em.prompt_tokens,
        em.completion_tokens,
        em.is_failover,
        em.status AS attempt_status,
        em.created_at AS metric_created_at
      FROM extraction_jobs j
      JOIN extraction_metrics em ON em.job_id = j.id
      WHERE ${conditions.join(' AND ')}
      ORDER BY em.created_at ASC
    `;

    const result = await pool.query(query, params);
    const rows = result.rows;

    const jobMap = new Map();
    const overallModelMap = new Map();
    let overallPromptTokens = 0;
    let overallCompletionTokens = 0;
    let overallTotalCost = 0;
    let overallProductsAttempted = 0;

    for (const r of rows) {
      const jobIdKey = r.job_id;
      const model = r.model_used;
      const promptTokens = Number(r.prompt_tokens) || 0;
      const completionTokens = Number(r.completion_tokens) || 0;

      const cost = calculateTokenCost(model, promptTokens, completionTokens);

      overallPromptTokens += promptTokens;
      overallCompletionTokens += completionTokens;
      overallTotalCost += cost.totalCost;

      // Track overall model breakdown
      if (!overallModelMap.has(model)) {
        overallModelMap.set(model, {
          model,
          prompt_tokens: 0,
          completion_tokens: 0,
          prompt_cost: 0,
          completion_cost: 0,
          total_cost: 0,
          attempts: 0
        });
      }
      const overallModelEntry = overallModelMap.get(model);
      overallModelEntry.prompt_tokens += promptTokens;
      overallModelEntry.completion_tokens += completionTokens;
      overallModelEntry.prompt_cost = Number((overallModelEntry.prompt_cost + cost.promptCost).toFixed(8));
      overallModelEntry.completion_cost = Number((overallModelEntry.completion_cost + cost.completionCost).toFixed(8));
      overallModelEntry.total_cost = Number((overallModelEntry.total_cost + cost.totalCost).toFixed(8));
      overallModelEntry.attempts += 1;

      // Track per-job breakdown
      if (!jobMap.has(jobIdKey)) {
        const attempted = r.total_records > 0 ? r.total_records : (r.processed_records + r.failed_records);
        overallProductsAttempted += attempted;

        jobMap.set(jobIdKey, {
          job_id: jobIdKey,
          status: r.job_status,
          total_records_attempted: attempted,
          total_cost: 0,
          total_prompt_tokens: 0,
          total_completion_tokens: 0,
          attempts_count: 0,
          models: new Map()
        });
      }

      const jobEntry = jobMap.get(jobIdKey);
      jobEntry.total_prompt_tokens += promptTokens;
      jobEntry.total_completion_tokens += completionTokens;
      jobEntry.total_cost = Number((jobEntry.total_cost + cost.totalCost).toFixed(8));
      jobEntry.attempts_count += 1;

      if (!jobEntry.models.has(model)) {
        jobEntry.models.set(model, {
          model,
          prompt_tokens: 0,
          completion_tokens: 0,
          total_cost: 0
        });
      }
      const jobModel = jobEntry.models.get(model);
      jobModel.prompt_tokens += promptTokens;
      jobModel.completion_tokens += completionTokens;
      jobModel.total_cost = Number((jobModel.total_cost + cost.totalCost).toFixed(8));
    }

    const jobs = Array.from(jobMap.values()).map((j) => {
      const costPerProduct = j.total_records_attempted > 0
        ? Number((j.total_cost / j.total_records_attempted).toFixed(8))
        : 0;

      return {
        job_id: j.job_id,
        status: j.status,
        total_cost: j.total_cost,
        total_prompt_tokens: j.total_prompt_tokens,
        total_completion_tokens: j.total_completion_tokens,
        total_products_attempted: j.total_records_attempted,
        cost_per_product: costPerProduct,
        attempts_count: j.attempts_count,
        breakdown_by_model: Array.from(j.models.values())
      };
    });

    const overallCostPerProduct = overallProductsAttempted > 0
      ? Number((overallTotalCost / overallProductsAttempted).toFixed(8))
      : 0;

    return res.status(200).json({
      summary: {
        total_cost: Number(overallTotalCost.toFixed(8)),
        total_prompt_tokens: overallPromptTokens,
        total_completion_tokens: overallCompletionTokens,
        total_tokens: overallPromptTokens + overallCompletionTokens,
        total_products_attempted: overallProductsAttempted,
        cost_per_product: overallCostPerProduct,
        total_attempts: rows.length
      },
      jobs,
      breakdown_by_model: Array.from(overallModelMap.values())
    });
  } catch (err) {
    console.error('[MetricsController] Error calculating AI costs:', err);
    return res.status(500).json({ error: 'Internal server error while calculating AI costs' });
  }
}

export default {
  getAiCosts
};

