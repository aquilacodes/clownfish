import express from 'express';
import ordersRouter from './routes/orders';
import { usersRouter } from './routes/users';

const app = express();
app.use(express.json());
app.use('/api/orders', ordersRouter);
app.use('/api/users', usersRouter);
app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.listen(Number(process.env.PORT ?? 8080));
