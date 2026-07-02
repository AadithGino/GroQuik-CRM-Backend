import { env, isConfigured } from "../config/env.js";
import { pingRedis } from "../config/startupChecks.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import {
  createLeadFromMeta,
  resolveMetaWebhookPayload,
} from "../services/meta.service.js";
import { verifyMetaWebhookSignature } from "../utils/metaWebhook.js";

export const verifyWebhook = asyncHandler(async (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === env.META_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

export const receiveWebhook = asyncHandler(async (req, res) => {
  const signature = req.get("x-hub-signature-256");
  const rawBody = req.rawBody;

  if (env.META_APP_SECRET && !verifyMetaWebhookSignature(rawBody, signature, env.META_APP_SECRET)) {
    return res.sendStatus(403);
  }

  const body = req.body || {};
  if (body.object && body.object !== "page") {
    return res.status(200).json({ ok: true, ignored: true });
  }

  const entries = body.entry || [];
  const results = [];

  for (const entry of entries) {
    for (const change of entry.changes || []) {
      if (change.field && change.field !== "leadgen") continue;

      const value = change.value || change;
      const payload = await resolveMetaWebhookPayload(value);
      const result = await createLeadFromMeta({ payload, currentUser: null });
      results.push({
        leadId: result.lead._id,
        duplicate: result.duplicate,
        metaLeadId: payload.leadgen_id || payload.id,
      });
    }
  }

  return res.status(200).json({ ok: true, results });
});

export const getIntegrationStatus = asyncHandler(async (req, res) => {
  const baseUrl = (env.PUBLIC_API_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
  const redisConnected = await pingRedis();

  res.json({
    webhookUrl: `${baseUrl}/api/meta/webhook`,
    redis: {
      configured: Boolean(env.REDIS_URL || env.REDIS_HOST),
      mode: env.REDIS_URL ? "url" : "host",
      connected: redisConnected,
    },
    meta: {
      verifyTokenConfigured: isConfigured(env.META_VERIFY_TOKEN),
      pageAccessTokenConfigured: isConfigured(env.META_PAGE_ACCESS_TOKEN),
      appSecretConfigured: isConfigured(env.META_APP_SECRET),
      graphApiVersion: env.META_GRAPH_API_VERSION,
      webhookSignatureEnforced: isConfigured(env.META_APP_SECRET),
      readyForLiveLeads: isConfigured(env.META_PAGE_ACCESS_TOKEN),
    },
  });
});

export const testLead = asyncHandler(async (req, res) => {
  const result = await createLeadFromMeta({
    payload: req.body,
    currentUser: req.user,
  });
  res.status(result.duplicate ? 200 : 201).json(result);
});
