import mongoose from 'mongoose';

const whatsappTemplateSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    category: { type: String, default: 'GENERAL' },
    body: { type: String, required: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export const WhatsAppTemplate = mongoose.model('WhatsAppTemplate', whatsappTemplateSchema);
