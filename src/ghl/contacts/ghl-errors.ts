export type GhlErrorCode =
  | 'GHL_NOT_CONNECTED'
  | 'GHL_UNAUTHORIZED'
  | 'GHL_FORBIDDEN'
  | 'GHL_NOT_FOUND'
  | 'GHL_CONFLICT'
  | 'GHL_VALIDATION'
  | 'GHL_RATE_LIMITED'
  | 'GHL_UNAVAILABLE'
  | 'GHL_NETWORK'
  | 'GHL_INVALID_RESPONSE'
  | 'GHL_FOREIGN_LOCATION'
  | 'GHL_REFRESH_REJECTED'
  | 'GHL_FEATURE_DISABLED';

const MESSAGES: Record<GhlErrorCode, string> = {
  GHL_NOT_CONNECTED: 'La empresa no tiene una instalación GHL activa. Conecta la subcuenta desde Integraciones.',
  GHL_UNAUTHORIZED: 'GHL rechazó las credenciales. Es necesario reconectar la integración.',
  GHL_FORBIDDEN: 'GHL denegó la operación: revisa los scopes autorizados.',
  GHL_NOT_FOUND: 'El recurso no existe en GHL.',
  GHL_CONFLICT: 'GHL reportó un conflicto con el estado remoto.',
  GHL_VALIDATION: 'GHL rechazó los datos enviados.',
  GHL_RATE_LIMITED: 'Se alcanzó el límite de solicitudes de GHL. Inténtalo más tarde.',
  GHL_UNAVAILABLE: 'GHL no está disponible temporalmente.',
  GHL_NETWORK: 'No se pudo establecer conexión con GHL.',
  GHL_INVALID_RESPONSE: 'GHL devolvió una respuesta con formato inesperado.',
  GHL_FOREIGN_LOCATION: 'El contacto remoto pertenece a otra subcuenta.',
  GHL_REFRESH_REJECTED: 'GHL rechazó la renovación del token. Reconecta la integración.',
  GHL_FEATURE_DISABLED: 'La operación no está habilitada en esta instalación.',
};

/** Error normalizado del cliente GHL. Nunca incluye cuerpos de respuesta ni tokens. */
export class GhlApiError extends Error {
  constructor(
    readonly code: GhlErrorCode,
    readonly upstreamStatus?: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(MESSAGES[code]);
    this.name = 'GhlApiError';
  }

  /** Estado HTTP que devuelve NUESTRA API (no el de GHL). */
  httpStatus(): number {
    switch (this.code) {
      case 'GHL_NOT_CONNECTED':
        return 409;
      case 'GHL_NOT_FOUND':
        return 404;
      case 'GHL_FEATURE_DISABLED':
        return 403;
      case 'GHL_RATE_LIMITED':
      case 'GHL_UNAVAILABLE':
      case 'GHL_NETWORK':
        return 503;
      default:
        return 502;
    }
  }
}
