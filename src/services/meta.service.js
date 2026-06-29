import { Lead } from "../models/lead.model.js";
import {
  ACTIVITY_TYPE,
  LEAD_STATUS,
  LEAD_TAG,
  NOTIFICATION_TYPE,
  TASK_TYPE,
} from "../constants/crm.constants.js";
import { normalizePhone } from "../utils/phone.js";
import { resolveAssignee } from "./assignment.service.js";
import { createInitialLeadTasks } from "./leadAutomation.service.js";
import { addActivity } from "./activity.service.js";
import { notifyAssigneeAndAdmins } from "./notification.service.js";
import { createTask } from "./task.service.js";
import { env } from "../config/env.js";
import { sameDayEvening } from "../utils/time.js";

const META_GRAPH_VERSION = "v21.0";

function extractField(fieldData = [], names = []) {
  const item = fieldData.find((f) =>
    names.includes(String(f.name || "").toLowerCase()),
  );
  const val = Array.isArray(item?.values) ? item.values[0] : item?.value;
  return val || "";
}

export function normalizeMetaPayload(payload) {
  const fieldData = payload.field_data || payload.fieldData || [];
  const phone = normalizePhone(
    payload.phone ||
      extractField(fieldData, [
        "phone_number",
        "phone",
        "mobile_number",
        "mobile",
      ]),
  );
  return {
    name:
      payload.name ||
      payload.full_name ||
      extractField(fieldData, ["full_name", "name", "first_name"]),
    phone,
    callPhone: phone,
    whatsappPhone: phone,
    businessName:
      payload.businessName ||
      payload.company_name ||
      extractField(fieldData, ["company_name", "business_name", "shop_name"]),
    place:
      payload.place ||
      payload.city ||
      extractField(fieldData, ["city", "place", "location"]),
    source: "META",
    campaignName: payload.campaign_name || payload.campaignName,
    adName: payload.ad_name || payload.adName,
    formName: payload.form_name || payload.formName,
    metaLeadId: payload.leadgen_id || payload.leadgenId || payload.id,
    metaCampaignId: payload.campaign_id,
    metaAdId: payload.ad_id,
    metaFormId: payload.form_id,
    rawPayload: payload,
  };
}

export async function fetchLeadgenFromGraph(leadgenId) {
  const token = env.META_PAGE_ACCESS_TOKEN;
  if (!token) {
    throw new Error("META_PAGE_ACCESS_TOKEN is not configured");
  }

  const url = new URL(`https://graph.facebook.com/${META_GRAPH_VERSION}/${leadgenId}`);
  url.searchParams.set("access_token", token);

  const response = await fetch(url);
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = data?.error?.message || response.statusText || "Meta Graph API request failed";
    throw new Error(message);
  }

  return data;
}

export async function resolveMetaWebhookPayload(value = {}) {
  const leadgenId = value.leadgen_id || value.leadgenId;
  if (!leadgenId) return value;

  const graphLead = await fetchLeadgenFromGraph(leadgenId);
  return {
    ...value,
    ...graphLead,
    leadgen_id: leadgenId,
    ad_id: value.ad_id || graphLead.ad_id,
    form_id: value.form_id || graphLead.form_id,
    field_data: graphLead.field_data || value.field_data,
  };
}

export async function createLeadFromMeta({ payload, currentUser }) {
  const data = normalizeMetaPayload(payload);
  let lead = data.phone
    ? await Lead.findOne({
        phone: data.phone,
        status: { $nin: [LEAD_STATUS.INVALID] },
      })
    : null;
  if (lead) {
    await addActivity({
      leadId: lead._id,
      userId: currentUser?._id || lead.assignedTo,
      type: ACTIVITY_TYPE.META_LEAD_RECEIVED,
      title: "Duplicate Meta lead received",
      description: "Repeat Meta inquiry added to existing lead.",
      metadata: data,
    });
    await createTask({
      leadId: lead._id,
      assignedTo: lead.assignedTo,
      type: TASK_TYPE.FOLLOW_UP_CALL,
      title: "Follow up repeat Meta inquiry",
      description:
        "This phone number submitted another Meta lead form. Treat as possible renewed interest.",
      dueAt: sameDayEvening(),
      priority: 5,
      metadata: {
        metaLeadId: data.metaLeadId,
        dedupeKey: `repeat-meta:${lead._id}:${data.metaLeadId || Date.now()}`,
      },
    });
    await notifyAssigneeAndAdmins({
      assignedTo: lead.assignedTo,
      leadId: lead._id,
      type: NOTIFICATION_TYPE.NEW_LEAD,
      title: "Repeat Meta inquiry",
      message: `${lead.businessName || lead.name || lead.phone || "Lead"} submitted again. Follow up today.`,
      priority: 5,
    });
    return { lead, duplicate: true };
  }
  const assignedTo = await resolveAssignee({
    currentUser,
    source: data.source,
    campaignName: data.campaignName,
  });
  lead = await Lead.create({
    ...data,
    assignedTo,
    tags: [LEAD_TAG.HIGH_INTENT],
    status: LEAD_STATUS.NEW_LEAD,
  });
  await addActivity({
    leadId: lead._id,
    userId: assignedTo,
    type: ACTIVITY_TYPE.META_LEAD_RECEIVED,
    title: "Meta lead received",
    metadata: data,
  });
  await addActivity({
    leadId: lead._id,
    userId: assignedTo,
    type: ACTIVITY_TYPE.LEAD_CREATED,
    title: "Lead created",
    description: "Created automatically from Meta lead.",
    metadata: { source: data.source, metaLeadId: data.metaLeadId },
  });
  await createInitialLeadTasks(lead);
  await notifyAssigneeAndAdmins({
    assignedTo,
    leadId: lead._id,
    type: NOTIFICATION_TYPE.NEW_LEAD,
    title: "New Meta lead assigned",
    message: `${lead.businessName || lead.name || lead.phone || "Meta lead"} needs first contact.`,
    priority: 5,
  });
  return { lead, duplicate: false };
}
