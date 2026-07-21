import { NEXT_ACTION, PAYMENT_TYPE, QUOTE_STATUS, MOCKUP_STATUS } from '../constants/crm.constants.js';
import { ApiError } from '../utils/apiError.js';
import { Quote } from '../models/quote.model.js';
import { Mockup } from '../models/mockup.model.js';
import { Payment } from '../models/payment.model.js';
import { Project } from '../models/project.model.js';

export async function latestQuote(leadId) {
  return Quote.findOne({ leadId }).sort({ revisionNumber: -1, updatedAt: -1 });
}

export async function hasAnyQuote(leadId) {
  return Boolean(await Quote.exists({ leadId }));
}

export async function latestAcceptedQuote(leadId) {
  return Quote.findOne({ leadId, status: QUOTE_STATUS.ACCEPTED }).sort({ revisionNumber: -1, updatedAt: -1 });
}

export async function requireAcceptedQuote(leadId, message = 'This action requires an accepted quote first.') {
  const quote = await latestAcceptedQuote(leadId);
  if (!quote) throw new ApiError(400, message);
  return quote;
}

export async function requirePositiveAdvance(leadId) {
  const payment = await Payment.exists({ leadId, paymentType: PAYMENT_TYPE.ADVANCE, amount: { $gt: 0 } });
  if (!payment) throw new ApiError(400, 'This action requires a positive advance payment first.');
}

export async function requireReadyMockup(leadId) {
  const mockup = await Mockup.findOne({ leadId, status: MOCKUP_STATUS.READY }).sort({ updatedAt: -1 });
  if (!mockup) throw new ApiError(400, 'Cannot share mockup because no ready mockup exists for this lead.');
  return mockup;
}

export async function requirePaymentBeforeWon(leadId) {
  const payment = await Payment.exists({ leadId, amount: { $gt: 0 } });
  if (!payment) throw new ApiError(400, 'Cannot mark lead as Won before recording an advance/payment.');
}

export async function getLeadActionState(leadId) {
  const [quote, acceptedQuote, readyMockup, activeMockup, advancePayment, project] = await Promise.all([
    latestQuote(leadId),
    latestAcceptedQuote(leadId),
    Mockup.findOne({ leadId, status: MOCKUP_STATUS.READY }).sort({ updatedAt: -1 }),
    Mockup.findOne({ leadId, status: { $nin: [MOCKUP_STATUS.APPROVED, MOCKUP_STATUS.REJECTED] } }).sort({ updatedAt: -1 }),
    Payment.exists({ leadId, paymentType: PAYMENT_TYPE.ADVANCE, amount: { $gt: 0 } }),
    Project.exists({ leadId }),
  ]);

  return {
    hasQuote: Boolean(quote),
    latestQuoteStatus: quote?.status,
    latestQuoteId: quote?._id,
    latestQuoteAmount: quote?.finalAmount ?? null,
    latestQuoteRevision: quote?.revisionNumber ?? null,
    latestQuoteDeliverables: quote?.deliverables || [],
    latestQuoteGstMode: quote?.gstMode || 'INCLUDED',
    latestQuoteNote: quote?.note || '',
    latestQuoteRequirementSummary: quote?.requirementSummary || '',
    hasSentQuote: Boolean(quote && [QUOTE_STATUS.SENT, QUOTE_STATUS.REVISED_SENT, QUOTE_STATUS.ACCEPTED].includes(quote.status)),
    hasUnsentRevisionDraft: Boolean(quote && quote.revisionNumber > 1 && quote.status === QUOTE_STATUS.DRAFT),
    hasAcceptedQuote: Boolean(acceptedQuote),
    acceptedQuoteId: acceptedQuote?._id,
    hasReadyMockup: Boolean(readyMockup),
    readyMockupId: readyMockup?._id,
    hasActiveMockup: Boolean(activeMockup),
    activeMockupStatus: activeMockup?.status,
    hasAdvancePayment: Boolean(advancePayment),
    hasProject: Boolean(project),
  };
}

export async function assertNextActionPrerequisites({ leadId, nextAction }) {
  if (!nextAction) return;
  const state = await getLeadActionState(leadId);

  if (nextAction === NEXT_ACTION.SEND_QUOTE && state.hasQuote) {
    throw new ApiError(400, 'A quote already exists for this lead. Use revised quote instead of create/send quote.');
  }
  if (nextAction === NEXT_ACTION.SEND_REVISED_QUOTE && !state.hasQuote) {
    throw new ApiError(400, 'Cannot create revised quote because no original quote exists yet. Create the first quote first.');
  }
  if (nextAction === NEXT_ACTION.SEND_REVISED_QUOTE && state.hasUnsentRevisionDraft) {
    throw new ApiError(400, 'A revised quote draft is already pending. Send or update that revision before creating another one.');
  }
  if (nextAction === NEXT_ACTION.CREATE_MOCKUP && state.hasActiveMockup) {
    throw new ApiError(400, `An active mockup already exists (${state.activeMockupStatus}). Update/revise that mockup instead of creating another one.`);
  }
  if (nextAction === NEXT_ACTION.SHARE_MOCKUP) await requireReadyMockup(leadId);
  if (nextAction === NEXT_ACTION.QUOTE_CONFIRMED) {
    if (!state.hasQuote) throw new ApiError(400, 'Cannot confirm quote because no quote exists yet.');
    if (state.hasAcceptedQuote) throw new ApiError(400, 'Quote is already confirmed/accepted.');
  }
  if (nextAction === NEXT_ACTION.FOLLOW_UP_FOR_ADVANCE || nextAction === NEXT_ACTION.COLLECT_ADVANCE) {
    await requireAcceptedQuote(leadId, 'Cannot follow up for advance before the quote is confirmed/accepted.');
    if (state.hasAdvancePayment) throw new ApiError(400, 'Advance is already recorded for this lead.');
  }
  if (nextAction === NEXT_ACTION.ADVANCE_COLLECTED) {
    await requireAcceptedQuote(leadId, 'Confirm/accept the quote before marking advance collected.');
    if (state.hasAdvancePayment) throw new ApiError(400, 'Advance is already recorded. Open Payments to review it.');
  }
  if (nextAction === NEXT_ACTION.PROJECT_HANDOFF) {
    if (state.hasProject) throw new ApiError(400, 'Project handoff already exists for this lead. Open the existing project instead.');
    await requireAcceptedQuote(leadId, 'Cannot create project handoff before a quote is accepted.');
    await requirePositiveAdvance(leadId);
  }
  if (nextAction === NEXT_ACTION.MARK_WON) await requirePaymentBeforeWon(leadId);
}
