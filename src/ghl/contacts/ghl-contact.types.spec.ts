import { diffFields, fieldsHash, normalizeFields, parseRemoteContact } from './ghl-contact.types';
import { detectRemoteChange, signPreview, verifyPreview } from '../../synchronization/conflict';

describe('Normalización y validación de contactos remotos', () => {
  it('normaliza email, espacios, vacíos y caracteres de control', () => {
    expect(normalizeFields({ firstName: '  Ana\u0000 ', lastName: '', email: ' ANA@Example.TEST ', phone: 42 })).toEqual({ firstName: 'Ana', lastName: null, email: 'ana@example.test', phone: null });
  });

  it('valida la respuesta externa y descarta campos desconocidos', () => {
    const c = parseRemoteContact({ id: 'abc', firstName: 'Ana', dateUpdated: '2026-01-01T00:00:00Z', customFields: [{ secret: 1 }] });
    expect(c).toMatchObject({ id: 'abc', firstName: 'Ana', email: null });
    expect(c.dateUpdated?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(c).not.toHaveProperty('customFields');
  });

  it('rechaza respuestas sin id con GHL_INVALID_RESPONSE', () => {
    expect(() => parseRemoteContact({ firstName: 'x' })).toThrow(expect.objectContaining({ code: 'GHL_INVALID_RESPONSE' }));
  });

  it('el hash ignora el formato del teléfono (GHL normaliza a E.164) pero detecta otros cambios', () => {
    const a = { firstName: 'A', lastName: 'B', email: 'a@b.test', phone: '+52 55 1234 5678' };
    expect(fieldsHash(a)).toBe(fieldsHash({ ...a, phone: '+525512345678' }));
    expect(fieldsHash(a)).not.toBe(fieldsHash({ ...a, lastName: 'C' }));
    expect(diffFields(a, { ...a, phone: '+525512345678' })).toEqual([]);
    expect(diffFields(a, { ...a, email: 'z@b.test' })).toEqual([{ field: 'email', local: 'a@b.test', remote: 'z@b.test' }]);
  });
});

describe('Detección de conflictos y token de vista previa', () => {
  const remote = parseRemoteContact({ id: 'r1', firstName: 'Ana', lastName: 'Ruiz' });

  it('sin huella previa no se permite sobrescribir (NO_BASELINE)', () => {
    expect(detectRemoteChange({ remoteHash: null }, remote)).toBe('NO_BASELINE');
  });
  it('detecta cambios remotos por huella', () => {
    expect(detectRemoteChange({ remoteHash: fieldsHash(remote) }, remote)).toBeNull();
    expect(detectRemoteChange({ remoteHash: fieldsHash({ ...remote, lastName: 'Otro' }) }, remote)).toBe('REMOTE_CHANGED');
  });

  it('el token de vista previa se invalida si cambian contactos, empresa o expira', () => {
    const contacts = [{ id: 'c1', updatedAt: new Date('2026-01-01') }];
    const { token } = signPreview('s'.repeat(32), 'co1', contacts, 1000);
    expect(verifyPreview('s'.repeat(32), token, 'co1', contacts, 2000)).toBe(true);
    expect(verifyPreview('s'.repeat(32), token, 'co2', contacts, 2000)).toBe(false);
    expect(verifyPreview('s'.repeat(32), token, 'co1', [{ id: 'c1', updatedAt: new Date('2026-01-02') }], 2000)).toBe(false);
    expect(verifyPreview('s'.repeat(32), token, 'co1', contacts, 1000 + 11 * 60_000)).toBe(false);
    expect(verifyPreview('s'.repeat(32), token.replace(/.$/, c => (c === '0' ? '1' : '0')), 'co1', contacts, 2000)).toBe(false);
  });
});
