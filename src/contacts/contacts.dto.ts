import { ContactSyncStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsDateString, IsEmail, IsEnum, IsIn, IsOptional, IsString, Matches, MaxLength, ValidateIf } from 'class-validator';
import { PaginationQueryDto } from '../common/pagination';

const emptyToNull = ({ value }: { value: unknown }) => (typeof value === 'string' && value.trim() === '' ? null : typeof value === 'string' ? value.trim() : value);

export class ListContactsQueryDto extends PaginationQueryDto {
  @IsOptional() @IsString() @MaxLength(100)
  q?: string;

  @IsOptional() @IsEnum(ContactSyncStatus)
  status?: ContactSyncStatus;

  @IsOptional() @IsIn(['updatedAt', 'lastName', 'lastSyncedAt'])
  sort: 'updatedAt' | 'lastName' | 'lastSyncedAt' = 'updatedAt';
}

/**
 * Sólo estos campos son modificables (whitelist + forbidNonWhitelisted rechaza cualquier otro, p. ej. companyId,
 * ghlContactId o syncStatus). `null` o cadena vacía borra el valor.
 */
export class UpdateContactDto {
  @IsOptional() @Transform(emptyToNull) @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(100)
  firstName?: string | null;

  @IsOptional() @Transform(emptyToNull) @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(100)
  lastName?: string | null;

  @IsOptional() @Transform(emptyToNull) @ValidateIf((_, v) => v !== null) @IsEmail() @MaxLength(254)
  email?: string | null;

  @IsOptional() @Transform(emptyToNull) @ValidateIf((_, v) => v !== null) @Matches(/^\+?[0-9 ()\-.]{5,40}$/, { message: 'phone debe ser un teléfono válido' })
  phone?: string | null;

  /** Control de concurrencia optimista: updatedAt que el cliente vio. Si cambió, se responde 409. */
  @IsOptional() @IsDateString()
  expectedUpdatedAt?: string;
}
