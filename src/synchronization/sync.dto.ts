import { JobStatus, SyncDirection } from '@prisma/client';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, Equals, IsArray, IsBoolean, IsEnum, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../common/pagination';

export const MAX_EXPORT_BATCH = 50;
export const MAX_IMPORT_SELECTION = 100;

export class ImportDto {
  /** IDs de contactos GHL a importar. Si se omite, se importa toda la subcuenta (con límite de seguridad). */
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(MAX_IMPORT_SELECTION) @ArrayUnique()
  @IsString({ each: true }) @Matches(/^[A-Za-z0-9_-]{1,128}$/, { each: true })
  ghlContactIds?: string[];

  /** Sobrescribir cambios locales pendientes con el valor de GHL (resolución "conservar GHL"). Requiere admin. */
  @IsOptional() @IsBoolean()
  overwriteLocalChanges?: boolean;
}

export class ExportPreviewDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(MAX_EXPORT_BATCH) @ArrayUnique() @IsUUID('4', { each: true })
  contactIds!: string[];
}

export class ExportDto extends ExportPreviewDto {
  /** Confirmación explícita del usuario tras revisar la vista previa. */
  @Equals(true, { message: 'confirmed debe ser true' })
  confirmed!: boolean;

  @IsString() @MaxLength(200)
  previewToken!: string;

  /** Enviar aunque GHL haya cambiado (resolución "conservar local"). Requiere admin. */
  @IsOptional() @IsBoolean()
  overwriteConflicts?: boolean;
}

export class ListJobsQueryDto extends PaginationQueryDto {
  @IsOptional() @IsEnum(SyncDirection) direction?: SyncDirection;
  @IsOptional() @IsEnum(JobStatus) status?: JobStatus;
}
