import { createClient, postJson } from '@shop/http-client';
import { config } from './config';

const users = createClient(config.usersUrl);
const orders = createClient(config.ordersUrl);

export interface CreateOrderRequest {
  userId: string;
  items: { sku: string; qty: number }[];
  couponCode?: string;
}

export const usersApi = {
  getUser: (id: string) => users.get(`/users/${id}`),
  register: (email: string, name: string) => postJson(users, '/users', { email, name }),
};

export const ordersApi = {
  create: (req: CreateOrderRequest) => postJson(orders, '/orders', req),
  list: (userId: string) => orders.get('/orders', { params: { userId } }),
};
