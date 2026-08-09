import { Router } from 'express';
import { handleWebhook } from '../controllers/webhook.controller';

export const webhookRouter = Router();

/**
 * @openapi
 * /webhook/github:
 *   post:
 *     summary: GitHub Webhook endpoint
 *     description: Ingests push or pull_request events, verifies payload signature, and schedules workflow execution.
 *     headers:
 *       X-Hub-Signature-256:
 *         schema:
 *           type: string
 *         required: true
 *         description: HMAC-SHA256 signature of the payload
 *     responses:
 *       200:
 *         description: Webhook received. Event is not push/pull_request.
 *       202:
 *         description: Webhook received. Workflow run scheduled.
 *       401:
 *         description: Invalid signature.
 *       404:
 *         description: Repository not registered.
 */
webhookRouter.post('/github', handleWebhook);
