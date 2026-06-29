import { ZodError } from 'zod';
import { ApiError } from '../utils/apiError.js';

export function notFound(req, res, next) {
  next(new ApiError(404, `Route not found: ${req.originalUrl}`));
}

export function errorHandler(err, req, res, next) {
  if (err instanceof ZodError) {
    return res.status(400).json({ message: 'Validation failed', errors: err.errors });
  }

  const statusCode = err.statusCode || 500;
  const response = {
    message: err.message || 'Internal server error',
  };

  if (err.details) response.details = err.details;
  if (process.env.NODE_ENV !== 'production') response.stack = err.stack;

  res.status(statusCode).json(response);
}
