import { IsString, IsArray, IsOptional } from 'class-validator';

export class CreateOrderDto {
  @IsString() userId: string;
  @IsArray() items: OrderItem[];
  @IsOptional() @IsString() couponCode?: string;
}

export interface OrderItem {
  sku: string;
  qty: number;
}
