import { LEAD_STATUS, TASK_TYPE } from '../constants/crm.constants.js';
import { getNewLeadDueTimes } from '../utils/time.js';
import { createTask } from './task.service.js';
import { scheduleSlaCheck } from './scheduler.service.js';

export async function createInitialLeadTasks(lead) {
  const { whatsappDueAt, callDueAt } = getNewLeadDueTimes(lead.createdAt || new Date());

  const whatsappTask = await createTask({
    leadId: lead._id,
    assignedTo: lead.assignedTo,
    type: TASK_TYPE.SEND_WHATSAPP,
    title: 'Send WhatsApp details',
    description: 'First touch must be completed within 15 minutes during working hours.',
    dueAt: whatsappDueAt,
    priority: 4,
    metadata: { slaType: 'WHATSAPP_NOT_SENT_15_MIN' },
  });

  const callTask = await createTask({
    leadId: lead._id,
    assignedTo: lead.assignedTo,
    type: TASK_TYPE.FIRST_CALL,
    title: 'First call',
    description: 'First call must be completed within 60 minutes during working hours.',
    dueAt: callDueAt,
    priority: 5,
    metadata: { slaType: 'FIRST_CALL_NOT_DONE_60_MIN' },
  });

  await scheduleSlaCheck({ leadId: lead._id, taskId: whatsappTask._id, slaType: 'WHATSAPP_NOT_SENT_15_MIN', dueAt: whatsappDueAt });
  await scheduleSlaCheck({ leadId: lead._id, taskId: callTask._id, slaType: 'FIRST_CALL_NOT_DONE_60_MIN', dueAt: callDueAt });

  lead.status = LEAD_STATUS.FIRST_TOUCH_PENDING;
  await lead.save();

  return { whatsappTask, callTask };
}
