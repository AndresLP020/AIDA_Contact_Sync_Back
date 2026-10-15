import { decideField, decideValue, retryDelayMs } from './reconcile';
import { missingProvisioningScopes, PROVISIONING_MANIFEST, PROVISIONING_SCOPES, type CustomFieldSpec, type CustomValueSpec } from './provisioning.manifest';

const fieldSpec = PROVISIONING_MANIFEST.find(s => s.resourceType === 'custom_field') as CustomFieldSpec;
const valueSpec = PROVISIONING_MANIFEST.find(s => s.resourceType === 'custom_value') as CustomValueSpec;
const field = (id: string, name: string, dataType: string | null = 'TEXT', model: string | null = 'contact') => ({ id, name, fieldKey: null, dataType, model });

describe('Manifiesto de configuración', () => {
  it('contiene exactamente 2 campos de contacto TEXT y 2 custom values con claves estables', () => {
    expect(PROVISIONING_MANIFEST.map(s => s.resourceKey)).toEqual(['aida.external_id', 'aida.sync_status', 'aida.integration_version', 'aida.configuration_status']);
    expect(PROVISIONING_MANIFEST.filter(s => s.resourceType === 'custom_field').every(s => s.resourceType === 'custom_field' && s.dataType === 'TEXT' && s.model === 'contact')).toBe(true);
    expect(PROVISIONING_MANIFEST.every(s => s.manifestVersion === 1 && s.required)).toBe(true);
  });
  it('scopes faltantes: lista vacía si GHL no informó scopes; detecta los ausentes', () => {
    expect(missingProvisioningScopes([])).toEqual([]);
    expect(missingProvisioningScopes(['contacts.readonly'])).toEqual([...PROVISIONING_SCOPES]);
    expect(missingProvisioningScopes([...PROVISIONING_SCOPES])).toEqual([]);
  });
});

describe('Reconciliación de recursos', () => {
  it('sin coincidencias → crear', () => {
    expect(decideField(fieldSpec, [field('1', 'Otro campo')])).toEqual({ action: 'create' });
  });
  it('una coincidencia compatible (sin distinguir mayúsculas/espacios) → adoptar', () => {
    expect(decideField(fieldSpec, [field('1', '  aida - id EXTERNO ')])).toMatchObject({ action: 'adopt', remote: { id: '1' } });
  });
  it('tipo o modelo incompatible → conflicto', () => {
    expect(decideField(fieldSpec, [field('1', fieldSpec.displayName, 'NUMERICAL')])).toEqual({ action: 'conflict', code: 'INCOMPATIBLE_TYPE' });
    expect(decideField(fieldSpec, [field('1', fieldSpec.displayName, 'TEXT', 'opportunity')])).toEqual({ action: 'conflict', code: 'INCOMPATIBLE_TYPE' });
    expect(decideField(fieldSpec, [field('1', fieldSpec.displayName, null)])).toEqual({ action: 'conflict', code: 'INCOMPATIBLE_TYPE' });
  });
  it('varias coincidencias → conflicto ambiguo (no se elige arbitrariamente)', () => {
    expect(decideField(fieldSpec, [field('1', fieldSpec.displayName), field('2', fieldSpec.displayName)])).toEqual({ action: 'conflict', code: 'AMBIGUOUS_MATCH' });
    const v = { id: 'x', name: valueSpec.displayName, fieldKey: null, value: '1' };
    expect(decideValue(valueSpec, [v, { ...v, id: 'y' }])).toEqual({ action: 'conflict', code: 'AMBIGUOUS_MATCH' });
    expect(decideValue(valueSpec, [v])).toMatchObject({ action: 'adopt' });
  });
  it('backoff con jitter acotado y respeto del mínimo (Retry-After)', () => {
    expect(retryDelayMs(1, () => 1)).toBe(5_000);
    expect(retryDelayMs(3, () => 1)).toBe(20_000);
    expect(retryDelayMs(20, () => 1)).toBe(15 * 60_000);
    expect(retryDelayMs(3, () => 0)).toBe(1_000);
    expect(retryDelayMs(1, () => 0, 30_000)).toBe(30_000);
  });
});
