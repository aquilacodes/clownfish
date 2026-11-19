import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import Redis from 'ioredis';
import { Order } from './order.entity';
import { CreateOrderDto } from './dto';
import { publishOrderCreated, enqueueEmail } from './events';

const redis = new Redis(process.env.REDIS_URL);

@Injectable()
export class OrdersService {
  constructor(@InjectRepository(Order) private readonly repo: Repository<Order>) {}

  async create(dto: CreateOrderDto) {
    const order = await this.repo.save({ ...dto, status: 'NEW' });
    await redis.del(`orders:user:${dto.userId}`);
    await publishOrderCreated(order);
    await enqueueEmail(dto.userId, 'order-confirmation');
    return order;
  }

  async listForUser(userId: string) {
    const cached = await redis.get(`orders:user:${userId}`);
    if (cached) return JSON.parse(cached);
    const rows = await this.repo.find({ where: { userId } });
    await redis.setex(`orders:user:${userId}`, 60, JSON.stringify(rows));
    return rows;
  }
}
