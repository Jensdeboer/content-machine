'use strict';
// Minimal JSON Schema (draft 2020-12 subset) validator so the brief schema
// documents and enforces the same thing without a dependency. Supports:
// type, enum, const, required, properties, additionalProperties, items,
// minItems, maxItems, minimum, maximum, exclusiveMinimum, pattern, minLength,
// maxLength, anyOf, oneOf, allOf, if/then/else, $ref (local #/$defs only).

function validate(schema, data, root = schema, pathStr = '$') {
  const errors = [];
  const push = (m) => errors.push(`${pathStr}: ${m}`);
  if (schema === true) return errors;
  if (schema === false) { push('schema forbids any value'); return errors; }
  if (schema.$ref) {
    const target = resolveRef(root, schema.$ref);
    return validate(target, data, root, pathStr);
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(t, data))) {
      push(`expected ${types.join('|')}, got ${typeName(data)}`);
      return errors;
    }
  }
  if (schema.enum && !schema.enum.some((v) => deepEqual(v, data))) push(`must be one of ${JSON.stringify(schema.enum)}`);
  if (schema.const !== undefined && !deepEqual(schema.const, data)) push(`must equal ${JSON.stringify(schema.const)}`);
  if (typeof data === 'number') {
    if (schema.minimum !== undefined && data < schema.minimum) push(`must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && data > schema.maximum) push(`must be <= ${schema.maximum}`);
    if (schema.exclusiveMinimum !== undefined && data <= schema.exclusiveMinimum) push(`must be > ${schema.exclusiveMinimum}`);
  }
  if (typeof data === 'string') {
    if (schema.minLength !== undefined && data.length < schema.minLength) push(`must be at least ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && data.length > schema.maxLength) push(`must be at most ${schema.maxLength} characters`);
    if (schema.pattern && !new RegExp(schema.pattern).test(data)) push(`must match ${schema.pattern}`);
  }
  if (Array.isArray(data)) {
    if (schema.minItems !== undefined && data.length < schema.minItems) push(`needs at least ${schema.minItems} items`);
    if (schema.maxItems !== undefined && data.length > schema.maxItems) push(`allows at most ${schema.maxItems} items`);
    if (schema.items) data.forEach((d, i) => errors.push(...validate(schema.items, d, root, `${pathStr}[${i}]`)));
  }
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    for (const k of schema.required || []) if (!(k in data)) push(`missing required "${k}"`);
    const props = schema.properties || {};
    for (const [k, v] of Object.entries(data)) {
      if (props[k]) errors.push(...validate(props[k], v, root, `${pathStr}.${k}`));
      else if (schema.additionalProperties === false) push(`unknown property "${k}"`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        errors.push(...validate(schema.additionalProperties, v, root, `${pathStr}.${k}`));
      }
    }
  }
  if (schema.allOf) for (const s of schema.allOf) errors.push(...validate(s, data, root, pathStr));
  if (schema.anyOf && !schema.anyOf.some((s) => validate(s, data, root, pathStr).length === 0)) push('matches none of anyOf');
  if (schema.oneOf) {
    const n = schema.oneOf.filter((s) => validate(s, data, root, pathStr).length === 0).length;
    if (n !== 1) push(`matches ${n} of oneOf, needs exactly 1`);
  }
  if (schema.if) {
    const ok = validate(schema.if, data, root, pathStr).length === 0;
    if (ok && schema.then) errors.push(...validate(schema.then, data, root, pathStr));
    if (!ok && schema.else) errors.push(...validate(schema.else, data, root, pathStr));
  }
  return errors;
}

function resolveRef(root, ref) {
  if (!ref.startsWith('#/')) throw new Error(`schema-check: only local refs supported (${ref})`);
  return ref.slice(2).split('/').reduce((o, k) => o[k], root);
}
function matchesType(t, d) {
  switch (t) {
    case 'string': return typeof d === 'string';
    case 'number': return typeof d === 'number' && Number.isFinite(d);
    case 'integer': return Number.isInteger(d);
    case 'boolean': return typeof d === 'boolean';
    case 'null': return d === null;
    case 'array': return Array.isArray(d);
    case 'object': return d !== null && typeof d === 'object' && !Array.isArray(d);
    default: return false;
  }
}
function typeName(d) { return d === null ? 'null' : Array.isArray(d) ? 'array' : typeof d; }
function deepEqual(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

module.exports = { validate };
