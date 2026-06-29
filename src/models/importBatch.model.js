import mongoose from 'mongoose';

const importBatchSchema = new mongoose.Schema(
  {
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    filename: { type: String, required: true },
    sourceTag: { type: String, default: 'Excel Import' },
    totalRows: { type: Number, default: 0 },
    createdLeads: { type: Number, default: 0 },
    updatedLeads: { type: Number, default: 0 },
    invalidRows: { type: Number, default: 0 },
    errors: [{ row: Number, reason: String }],
  },
  { timestamps: true }
);

export const ImportBatch = mongoose.model('ImportBatch', importBatchSchema);
