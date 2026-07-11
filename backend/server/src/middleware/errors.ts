import { Request, Response, NextFunction } from 'express';

/**
 * Custom operational error class to distinguish handled errors
 * from unhandled system failures.
 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly isOperational: boolean;

  constructor(message: string, statusCode = 500, isOperational = true) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Global Express Error Handling Middleware.
 * Prevents stack trace leaks in production and provides consistent JSON error formatting.
 */
export function errorHandler(
  err: Error | AppError,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const statusCode = err instanceof AppError ? err.statusCode : 500;
  const isOperational = err instanceof AppError ? err.isOperational : false;
  
  const response = {
    status: 'error',
    message: err.message || 'Internal Server Error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  };

  // Log unhandled non-operational errors
  if (!isOperational) {
    console.error('🔥 System Failure / Unhandled Error:', err);
  } else if (process.env.NODE_ENV === 'development') {
    console.warn(`⚠️ Operational Error [${statusCode}]: ${err.message}`);
  }

  res.status(statusCode).json(response);
}
