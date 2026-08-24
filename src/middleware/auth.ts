import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../db.js';
import { AuthError, ForbiddenError } from './errorHandler.js';

export interface AuthRequest extends Request {
  userId?: string;
  userRole?: string;
}

export const authenticate = (req: AuthRequest, res: Response, next: NextFunction) => {
  const token = req.headers.authorization?.split(' ')[1];
  
  if (!token) {
    throw new AuthError('Missing authorization token');
  }
  
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as {
      userId: string;
      role: string;
    };
    
    req.userId = decoded.userId;
    req.userRole = decoded.role;
    next();
  } catch (error) {
    throw new AuthError('Invalid or expired token');
  }
};

export const requireAdmin = (req: AuthRequest, res: Response, next: NextFunction) => {
  authenticate(req, res, () => {
    if (req.userRole !== 'ADMIN') {
      throw new ForbiddenError('Admin access required');
    }
    next();
  });
};

/**
 * Allow only approved users (or admin) to access the resource.
 * Must be chained after `authenticate`.
 */
export const requireApproved = async (req: AuthRequest, res: Response, next: NextFunction) => {
  if (!req.userId) throw new AuthError('Not authenticated');
  if (req.userRole === 'ADMIN') return next();

  const profile = await prisma.profile.findUnique({ where: { userId: req.userId } });
  if (!profile || profile.status !== 'APPROVED') {
    throw new ForbiddenError('Account not approved yet');
  }
  next();
};

export const optional = (req: AuthRequest, res: Response, next: NextFunction) => {
  const token = req.headers.authorization?.split(' ')[1];
  
  if (token) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET!) as {
        userId: string;
        role: string;
      };
      req.userId = decoded.userId;
      req.userRole = decoded.role;
    } catch (error) {
      // Token invalid, continue without auth
    }
  }
  
  next();
};
