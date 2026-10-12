import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class PaginationQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100000)
  page: number = 1;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  limit: number = 20;
}

export type Paginated<T> = { items: T[]; page: number; limit: number; total: number; pages: number };

export function paginated<T>(items: T[], total: number, q: PaginationQueryDto): Paginated<T> {
  return { items, page: q.page, limit: q.limit, total, pages: Math.max(1, Math.ceil(total / q.limit)) };
}
