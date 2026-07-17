import { z } from 'zod';

/**
 * Minimal JSON-Schema-ish projection for MCP tool input schemas.
 *
 * Detailed JSON Schema generation is deliberately out of scope for v0.1.
 * Tool handlers still validate with Zod at call time; this projection exists
 * so clients can discover the rough input shape.
 */
export function toJsonSchema(zodSchema: z.ZodTypeAny): Record<string, unknown> {
  if (zodSchema instanceof z.ZodObject) {
    const shape = zodSchema.shape as Record<string, z.ZodTypeAny>;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [k, v] of Object.entries(shape)) {
      properties[k] = describe(v);
      if (!v.isOptional()) required.push(k);
    }
    const out: Record<string, unknown> = { type: 'object', properties, additionalProperties: false };
    if (required.length > 0) out['required'] = required;
    return out;
  }
  return { type: 'object', additionalProperties: true };
}

function describe(t: z.ZodTypeAny): Record<string, unknown> {
  if (t instanceof z.ZodOptional) return describe(t.unwrap());
  if (t instanceof z.ZodEnum) return { type: 'string', enum: [...(t.options as string[])] };
  if (t instanceof z.ZodString) return { type: 'string' };
  if (t instanceof z.ZodNumber) return { type: 'number' };
  if (t instanceof z.ZodBoolean) return { type: 'boolean' };
  if (t instanceof z.ZodArray) return { type: 'array', items: describe(t.element) };
  if (t instanceof z.ZodUnion) {
    return { oneOf: (t.options as z.ZodTypeAny[]).map(describe) };
  }
  if (t instanceof z.ZodObject) return toJsonSchema(t);
  return {};
}
