/**
 * Manifiesto versionado de los recursos que AIDA Contact Sync configura en cada location de GHL.
 *
 * - `resourceKey` es un identificador INTERNO de esta app. No se envía a GHL como fieldKey: GHL genera su propia
 *   clave (p. ej. "contact.aida_id_externo") y se guarda en ProvisionedResource.remoteKey tal como la devuelve.
 * - `MANIFEST_VERSION` es independiente de la versión comercial de la app. Cambiar nombres, tipos o añadir recursos
 *   exige incrementarla.
 * - Fuera de este manifiesto no se crean campos, workflows, etiquetas, objetos ni otras configuraciones.
 */
export const MANIFEST_VERSION = 1;

/** Valor publicado en el Custom Value "AIDA - Versión de integración". */
export const INTEGRATION_VERSION = `aida-contact-sync/manifest-v${MANIFEST_VERSION}`;

export type ResourceType = 'custom_field' | 'custom_value';

/**
 * Política de administración:
 *  - create_only:        se crea si falta; un recurso existente NUNCA se modifica (ni nombre ni tipo).
 *                        Si el cliente lo renombró, se conserva por ID sin duplicarlo.
 *  - app_managed_value:  si el recurso lo creó la app, la app escribe su valor en cada ejecución.
 *                        Si se ADOPTÓ (ya existía con el mismo nombre), su valor NO se sobrescribe.
 */
export type ManagementPolicy = 'create_only' | 'app_managed_value';

/** Estados permitidos para "AIDA - Estado de sincronización" (sólo se escriben en exportaciones autorizadas). */
export const SYNC_STATUS_VALUES = ['synced', 'pending', 'conflict', 'failed'] as const;

export type CustomFieldSpec = {
  resourceKey: string;
  resourceType: 'custom_field';
  displayName: string;
  /** Modelo de destino en GHL (`model` de POST /locations/{locationId}/customFields). */
  model: 'contact';
  dataType: 'TEXT';
  placeholder?: string;
  required: boolean;
  policy: 'create_only';
  manifestVersion: number;
  description: string;
};

export type CustomValueSpec = {
  resourceKey: string;
  resourceType: 'custom_value';
  displayName: string;
  /** Valor esperado. `configuration_status` se calcula al final de cada ejecución. */
  value: string | 'dynamic:configuration_status';
  required: boolean;
  policy: 'app_managed_value';
  manifestVersion: number;
  description: string;
};

export type ResourceSpec = CustomFieldSpec | CustomValueSpec;

export const RESOURCE_KEYS = {
  externalId: 'aida.external_id',
  syncStatus: 'aida.sync_status',
  integrationVersion: 'aida.integration_version',
  configurationStatus: 'aida.configuration_status',
} as const;

export const PROVISIONING_MANIFEST: readonly ResourceSpec[] = [
  {
    resourceKey: RESOURCE_KEYS.externalId,
    resourceType: 'custom_field',
    displayName: 'AIDA - ID externo',
    model: 'contact',
    dataType: 'TEXT',
    required: true,
    policy: 'create_only',
    manifestVersion: 1,
    description: 'Identificador local (Contact.id de AIDA Contact Sync) del contacto.',
  },
  {
    resourceKey: RESOURCE_KEYS.syncStatus,
    resourceType: 'custom_field',
    displayName: 'AIDA - Estado de sincronización',
    model: 'contact',
    dataType: 'TEXT',
    required: true,
    policy: 'create_only',
    manifestVersion: 1,
    description: `Último estado de sincronización escrito por la app. Valores: ${SYNC_STATUS_VALUES.join(', ')}.`,
  },
  {
    resourceKey: RESOURCE_KEYS.integrationVersion,
    resourceType: 'custom_value',
    displayName: 'AIDA - Versión de integración',
    value: INTEGRATION_VERSION,
    required: true,
    policy: 'app_managed_value',
    manifestVersion: 1,
    description: 'Versión del manifiesto aplicada en la location (informativo).',
  },
  {
    resourceKey: RESOURCE_KEYS.configurationStatus,
    resourceType: 'custom_value',
    displayName: 'AIDA - Estado de configuración',
    value: 'dynamic:configuration_status',
    required: true,
    policy: 'app_managed_value',
    manifestVersion: 1,
    description: 'Copia informativa del estado de configuración. El estado autoritativo vive en PostgreSQL.',
  },
];

/**
 * Scopes de aprovisionamiento (verificados en apps/locations.json del repositorio oficial de HighLevel).
 * NO forman parte de REQUIRED_SCOPES de la conexión: su ausencia deja la configuración en requires_action
 * sin afectar la sincronización de contactos.
 */
export const PROVISIONING_SCOPES = [
  'locations/customFields.readonly',
  'locations/customFields.write',
  'locations/customValues.readonly',
  'locations/customValues.write',
] as const;

export function missingProvisioningScopes(granted: string[]): string[] {
  // Si GHL no informó scopes, no se puede afirmar que falten: la verificación ocurre con las propias llamadas (403).
  if (!granted.length) return [];
  return PROVISIONING_SCOPES.filter(s => !granted.includes(s));
}
