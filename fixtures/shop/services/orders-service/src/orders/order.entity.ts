import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity('orders')
export class Order {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column() userId: string;
  @Column('jsonb') items: { sku: string; qty: number }[];
  @Column() status: string;
}
