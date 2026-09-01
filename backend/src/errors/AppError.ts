/**
 * Gerarchia di errori applicativi tipizzati con status HTTP e flag di visibilità pubblica.
 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly isPublic: boolean;
  public readonly details?: unknown;

  constructor(message: string, statusCode: number = 400, isPublic: boolean = false, details?: unknown) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.isPublic = isPublic;
    this.details = details;
    Error.captureStackTrace?.(this, this.constructor);
  }
}

export class BadRequestError extends AppError {
  constructor(message = 'Richiesta non valida', details?: unknown) {
    super(message, 400, true, details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Non autorizzato', details?: unknown) {
    super(message, 401, true, details);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Accesso negato', details?: unknown) {
    super(message, 403, true, details);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Risorsa non trovata', details?: unknown) {
    super(message, 404, true, details);
  }
}

export class InternalServerError extends AppError {
  constructor(message = 'Errore interno del server', details?: unknown) {
    super(message, 500, false, details);
  }
}
