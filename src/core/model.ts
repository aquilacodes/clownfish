// Map v1 — the output model written as JSON or XML and consumed by the viewer.

export const MAP_VERSION = '1.0';

export type ShapeType = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null' | 'unknown' | 'any';

export interface Shape {
  type: ShapeType;
  /** Field name → shape (objects). */
  fields?: Record<string, Shape>;
  /** Element shape (arrays). */
  items?: Shape;
  /** Optional field / type name hints. */
  optional?: boolean;
  typeName?: string;
  /** Where the shape was derived from. */
  source?: 'literal' | 'ts' | 'zod' | 'joi' | 'usage' | 'sql';
}

export interface Evidence {
  file: string; // absolute path
  line: number;
  col: number;
  snippet?: string;
}

export interface ServiceInfo {
  id: string;
  name: string;
  root: string;
  kind: 'service' | 'library' | 'frontend' | 'lambda';
  frameworks: string[];
  language: 'js' | 'ts' | 'mixed';
  aliases: string[];
  ports: number[];
}

export type NodeKind = 'entry' | 'endpoint' | 'queue' | 'topic' | 'bus' | 'function' | 'sink' | 'external';

export interface MapNode {
  id: string;
  kind: NodeKind;
  label: string;
  service?: string;
  /** Sub type: http | ws | sqs-consumer | lambda | postgres | mysql | redis | mongo | dynamodb | s3 | elasticsearch | sns | sqs | eventbridge ... */
  type?: string;
  meta?: Record<string, unknown>;
  request?: Shape;
  responses?: { status?: number; shape: Shape }[];
  evidence?: Evidence[];
}

export interface MapEdge {
  id: string;
  from: string;
  to: string;
  protocol: 'http' | 'ws' | 'sqs' | 'sns' | 'eventbridge' | 'lambda' | 'sql' | 'redis' | 'mongo' | 'dynamodb' | 's3' | 'elasticsearch' | 'subscription' | 'invoke';
  method?: string;
  path?: string;
  operations?: string[];
  request?: Shape;
  response?: Shape;
  confidence: number;
  evidence: Evidence[];
  meta?: Record<string, unknown>;
}

export interface Warning {
  code: string;
  message: string;
  file?: string;
  line?: number;
}

export interface ServiceMap {
  version: string;
  generatedAt: string;
  root: string;
  stats: { services: number; files: number; nodes: number; edges: number; flows: number; durationMs: number };
  services: ServiceInfo[];
  nodes: MapNode[];
  edges: MapEdge[];
  flows: string[][];
  warnings: Warning[];
}
