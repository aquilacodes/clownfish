import { Router } from 'express';
import { ordersApi, usersApi, CreateOrderRequest } from '../clients';

const router = Router();

router.post('/', async (req, res) => {
  const body: CreateOrderRequest = req.body;
  await usersApi.getUser(body.userId);
  const order = await ordersApi.create({ userId: body.userId, items: req.body.items, couponCode: req.body.couponCode });
  res.status(201).json({ order, via: 'gateway' });
});

router.get('/', async (req, res) => {
  const r = await ordersApi.list(String(req.query.userId));
  res.json(r.data);
});

export default router;
