import React, { useEffect } from 'react';
import { io } from 'socket.io-client';

const socket = io('http://realtime:4000');

export function App() {
  useEffect(() => {
    fetch('/api/orders?userId=me').then((r) => r.json());
  }, []);

  async function checkout(items: { sku: string; qty: number }[]) {
    await fetch('/api/orders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: 'me', items }) });
    socket.emit('chat:message', { room: 'orders', text: 'placed' });
  }

  return <button onClick={() => checkout([])}>Buy</button>;
}
