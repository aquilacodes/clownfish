import axios, { AxiosInstance } from 'axios';

export function createClient(baseURL: string): AxiosInstance {
  return axios.create({ baseURL, timeout: 3000 });
}

export async function postJson<T>(client: AxiosInstance, path: string, body: unknown): Promise<T> {
  const { data } = await client.post<T>(path, body);
  return data;
}
