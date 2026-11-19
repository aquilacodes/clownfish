import express from 'express';
import { usersApi } from '../clients';

export const usersRouter = express.Router();

usersRouter.post('/signup', async (req, res) => {
  const { email, name } = req.body;
  const user = await usersApi.register(email, name);
  res.status(201).json({ user });
});

usersRouter.get('/:id', async (req, res) => {
  const r = await usersApi.getUser(req.params.id);
  res.json(r.data);
});
