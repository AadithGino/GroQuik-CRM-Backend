import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { ROLES } from '../constants/crm.constants.js';

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    phone: { type: String, trim: true },
    password: { type: String, required: true, select: false },
    role: { type: String, enum: Object.values(ROLES), default: ROLES.SALES, index: true },
    managerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    teamId: { type: mongoose.Schema.Types.ObjectId, ref: 'Team' },
    acceptingLeads: { type: Boolean, default: true, index: true },
    assignmentWeight: { type: Number, default: 1, min: 0 },
    lastAssignedAt: { type: Date },
    isActive: { type: Boolean, default: true, index: true },
  },
  { timestamps: true }
);

userSchema.pre('save', async function hashPassword(next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 10);
  next();
});

userSchema.methods.comparePassword = function comparePassword(candidate) {
  return bcrypt.compare(candidate, this.password);
};

export const User = mongoose.model('User', userSchema);
