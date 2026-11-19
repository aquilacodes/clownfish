// Structural shapes from TS type syntax and schema builders (zod / joi / yup).
import type { Shape } from './model.ts';

/** Convert a TS type node / interface / class declaration into a Shape (type references kept as typeName). */
export function tsTypeToShape(n: any, depth = 0): Shape {
  if (!n || depth > 8) return { type: 'unknown' };
  switch (n.type) {
    case 'TSTypeAnnotation':
      return tsTypeToShape(n.typeAnnotation, depth);
    case 'TSStringKeyword':
      return { type: 'string', source: 'ts' };
    case 'TSNumberKeyword':
    case 'TSBigIntKeyword':
      return { type: 'number', source: 'ts' };
    case 'TSBooleanKeyword':
      return { type: 'boolean', source: 'ts' };
    case 'TSNullKeyword':
    case 'TSUndefinedKeyword':
    case 'TSVoidKeyword':
      return { type: 'null', source: 'ts' };
    case 'TSAnyKeyword':
    case 'TSUnknownKeyword':
      return { type: 'any', source: 'ts' };
    case 'TSLiteralType': {
      const v = n.literal?.value;
      return { type: typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : 'string', source: 'ts' };
    }
    case 'TSArrayType':
      return { type: 'array', items: tsTypeToShape(n.elementType, depth + 1), source: 'ts' };
    case 'TSUnionType': {
      const nonNull = n.types.filter((t: any) => t.type !== 'TSNullKeyword' && t.type !== 'TSUndefinedKeyword');
      const sh = tsTypeToShape(nonNull[0] ?? n.types[0], depth + 1);
      return nonNull.length < n.types.length ? { ...sh, optional: true } : sh;
    }
    case 'TSIntersectionType': {
      const fields: Record<string, Shape> = {};
      for (const t of n.types) Object.assign(fields, tsTypeToShape(t, depth + 1).fields ?? {});
      return { type: 'object', fields, source: 'ts' };
    }
    case 'TSParenthesizedType':
      return tsTypeToShape(n.typeAnnotation, depth);
    case 'TSTypeReference': {
      const name = n.typeName?.name ?? n.typeName?.right?.name;
      const p0 = n.typeParameters?.params?.[0];
      if ((name === 'Array' || name === 'ReadonlyArray') && p0) return { type: 'array', items: tsTypeToShape(p0, depth + 1), source: 'ts' };
      if ((name === 'Partial' || name === 'Readonly' || name === 'Required' || name === 'Promise') && p0) return tsTypeToShape(p0, depth + 1);
      if (name === 'Date') return { type: 'string', typeName: 'Date', source: 'ts' };
      if (name === 'Record') return { type: 'object', source: 'ts' };
      return { type: 'object', typeName: name, source: 'ts' };
    }
    case 'TSTypeLiteral':
    case 'TSInterfaceBody':
      return { type: 'object', fields: members(n.members ?? n.body, depth), source: 'ts' };
    case 'TSInterfaceDeclaration': {
      const fields = members(n.body.body, depth);
      for (const ext of n.extends ?? []) {
        const nm = ext.expression?.name;
        if (nm) fields[`...${nm}`] = { type: 'object', typeName: nm, source: 'ts' };
      }
      return { type: 'object', fields, source: 'ts' };
    }
    case 'ClassDeclaration':
    case 'ClassExpression': {
      const fields: Record<string, Shape> = {};
      for (const m of n.body.body) {
        if ((m.type === 'ClassProperty' || m.type === 'PropertyDefinition') && !m.static && m.key?.name && (m.typeAnnotation || hasValidatorDecorator(m))) {
          if (m.value && /Function/.test(m.value.type)) continue;
          const sh = m.typeAnnotation ? tsTypeToShape(m.typeAnnotation, depth + 1) : decoratorShape(m);
          fields[m.key.name] = m.optional ? { ...sh, optional: true } : sh;
        }
      }
      return { type: 'object', fields, source: 'ts' };
    }
    default:
      return { type: 'unknown' };
  }
}

function members(list: any[], depth: number): Record<string, Shape> {
  const fields: Record<string, Shape> = {};
  for (const m of list ?? []) {
    if (m.type !== 'TSPropertySignature') continue;
    const k = m.key?.name ?? m.key?.value;
    if (!k) continue;
    const sh = tsTypeToShape(m.typeAnnotation, depth + 1);
    fields[k] = m.optional ? { ...sh, optional: true } : sh;
  }
  return fields;
}

function hasValidatorDecorator(m: any) {
  return (m.decorators ?? []).some((d: any) => /^Is[A-Z]|^Min|^Max|^Length|^ApiProperty/.test(d.expression?.callee?.name ?? ''));
}
function decoratorShape(m: any): Shape {
  const names = (m.decorators ?? []).map((d: any) => d.expression?.callee?.name ?? '');
  if (names.some((n: string) => /IsString|IsEmail|IsUUID|IsDateString|Length/.test(n))) return { type: 'string', source: 'ts' };
  if (names.some((n: string) => /IsInt|IsNumber|IsPositive|Min|Max/.test(n))) return { type: 'number', source: 'ts' };
  if (names.some((n: string) => /IsBoolean/.test(n))) return { type: 'boolean', source: 'ts' };
  if (names.some((n: string) => /IsArray/.test(n))) return { type: 'array', source: 'ts' };
  return { type: 'unknown' };
}

/**
 * Recognise zod / joi / yup builder chains and convert them to shapes.
 * `rootExt(node)` returns the external module name the chain's root identifier was imported from (if any).
 */
export function schemaShape(n: any, rootExt: (node: any) => string | undefined): Shape | undefined {
  const lib = rootExt(n);
  if (!lib) return undefined;
  const kind = /zod/.test(lib) ? 'zod' : /joi/.test(lib) ? 'joi' : lib === 'yup' ? 'yup' : undefined;
  if (!kind) return undefined;
  return build(n, kind);
}

function build(n: any, kind: 'zod' | 'joi' | 'yup', depth = 0): Shape | undefined {
  if (!n || depth > 12) return undefined;
  // peel modifiers: .optional() .nullable() .required() .min() .email() ...
  let optional = false;
  let cur = n;
  const chain: { name: string; args: any[] }[] = [];
  while (cur?.type === 'CallExpression' && cur.callee.type === 'MemberExpression') {
    chain.unshift({ name: cur.callee.property?.name ?? '', args: cur.arguments });
    cur = cur.callee.object;
  }
  if (cur?.type === 'CallExpression' && cur.callee.type === 'Identifier') chain.unshift({ name: cur.callee.name, args: cur.arguments });
  if (!chain.length) return undefined;
  let base: Shape | undefined;
  for (const c of chain) {
    switch (c.name) {
      case 'object': {
        const obj = c.args[0];
        base = { type: 'object', fields: obj?.type === 'ObjectExpression' ? objFields(obj, kind, depth) : {}, source: kind === 'yup' ? 'joi' : kind };
        break;
      }
      case 'keys':
      case 'shape':
      case 'extend':
        if (c.args[0]?.type === 'ObjectExpression') base = { type: 'object', fields: { ...(base?.fields ?? {}), ...objFields(c.args[0], kind, depth) }, source: kind === 'yup' ? 'joi' : kind };
        break;
      case 'string':
      case 'email':
      case 'uuid':
      case 'date':
      case 'isoDate':
      case 'enum':
      case 'nativeEnum':
      case 'literal':
        if (!base || c.name === 'string') base = { type: 'string', source: kind === 'yup' ? 'joi' : kind };
        break;
      case 'number':
      case 'bigint':
      case 'integer':
        base = { type: 'number', source: kind === 'yup' ? 'joi' : kind };
        break;
      case 'boolean':
      case 'bool':
        base = { type: 'boolean', source: kind === 'yup' ? 'joi' : kind };
        break;
      case 'array':
        base = { type: 'array', items: c.args[0] ? build(c.args[0], kind, depth + 1) ?? { type: 'unknown' } : { type: 'unknown' }, source: kind === 'yup' ? 'joi' : kind };
        break;
      case 'items':
      case 'of':
        if (base?.type === 'array' && c.args[0]) base = { ...base, items: build(c.args[0], kind, depth + 1) ?? { type: 'unknown' } };
        break;
      case 'any':
      case 'unknown':
        base = { type: 'any' };
        break;
      case 'optional':
      case 'nullish':
      case 'nullable':
        optional = true;
        break;
      case 'required':
        optional = false;
        break;
    }
  }
  if (!base) return undefined;
  if (kind === 'joi' && !chain.some((c) => c.name === 'required') && depth > 0) optional = true;
  return optional ? { ...base, optional } : base;
}

function objFields(obj: any, kind: 'zod' | 'joi' | 'yup', depth: number): Record<string, Shape> {
  const fields: Record<string, Shape> = {};
  for (const p of obj.properties) {
    if (p.type !== 'ObjectProperty') continue;
    const k = p.key?.name ?? p.key?.value;
    if (!k) continue;
    fields[k] = build(p.value, kind, depth + 1) ?? { type: 'unknown' };
  }
  return fields;
}
