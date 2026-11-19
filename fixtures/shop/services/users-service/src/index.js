const Koa = require('koa');
const Router = require('@koa/router');
const { z } = require('zod');
const { createClient } = require('redis');
const { User } = require('./models');

const cache = createClient({ url: 'redis://redis:6379' });
const app = new Koa();
const router = new Router({ prefix: '/users' });

const NewUser = z.object({ email: z.string().email(), name: z.string(), marketingOptIn: z.boolean().optional() });

router.post('/', async (ctx) => {
  const input = NewUser.parse(ctx.request.body);
  const user = await User.create(input);
  ctx.status = 201;
  ctx.body = { id: user.id, email: user.email };
});

router.get('/:id', async (ctx) => {
  const hit = await cache.get(`user:${ctx.params.id}`);
  if (hit) { ctx.body = JSON.parse(hit); return; }
  const user = await User.findById(ctx.params.id);
  await cache.set(`user:${ctx.params.id}`, JSON.stringify(user));
  ctx.body = { id: user.id, email: user.email, name: user.name };
});

app.use(router.routes());
app.listen(3002);
