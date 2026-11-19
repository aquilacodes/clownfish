import { createServer } from 'http';
import { Server } from 'socket.io';
import { WebSocketServer } from 'ws';
import { Client } from '@elastic/elasticsearch';
import { PrismaClient } from '@prisma/client';

const es = new Client({ node: 'http://elasticsearch:9200' });
const prisma = new PrismaClient();
const httpServer = createServer();
const io = new Server(httpServer);

io.on('connection', (socket) => {
  socket.on('chat:message', async (msg: { room: string; text: string }) => {
    await es.index({ index: 'chat-messages', document: { room: msg.room, text: msg.text } });
    await prisma.message.create({ data: { room: msg.room, text: msg.text } });
  });
  socket.on('presence:join', async (room: string) => {
    await prisma.presence.upsert({ where: { room }, create: { room }, update: {} });
  });
});

const wss = new WebSocketServer({ port: 4001, path: '/ticks' });
wss.on('connection', (ws) => {
  ws.on('message', async () => {
    const rows = await prisma.tick.findMany();
    ws.send(JSON.stringify(rows));
  });
});

httpServer.listen(4000);
