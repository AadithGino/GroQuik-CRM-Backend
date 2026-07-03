import mongoose from 'mongoose';
import { env } from './env.js';

export async function connectDb() {
  mongoose.set('strictQuery', true);
  const originalSave = mongoose.Model.prototype.save;
  mongoose.Model.prototype.save = function saveWithoutValidation(options, ...args) {
    const nextOptions = options && typeof options === 'object'
      ? { ...options, validateBeforeSave: false }
      : { validateBeforeSave: false };
    return originalSave.call(this, nextOptions, ...args);
  };

  const originalSetOptions = mongoose.Query.prototype.setOptions;
  mongoose.Query.prototype.setOptions = function setOptionsWithoutValidators(options, ...args) {
    const nextOptions = options && typeof options === 'object'
      ? { ...options, runValidators: false }
      : { runValidators: false };
    return originalSetOptions.call(this, nextOptions, ...args);
  };
  await mongoose.connect(env.MONGO_URI);
  console.log(`MongoDB connected: ${mongoose.connection.name}`);
}
