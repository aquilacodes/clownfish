CREATE TABLE orders (id uuid primary key, user_id text not null, items jsonb, status text);
