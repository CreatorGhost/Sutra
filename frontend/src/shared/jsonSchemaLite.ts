// A tiny JSON Schema validator for the subset Sutra's AI schemas use (src/local/aiPrompts.ts):
// object/properties/required, array/items, string/number/integer/boolean/null, `type` unions, enum and
// anyOf/oneOf. Engines that can't enforce a schema natively get it in the prompt; we check the reply
// here and retry once with the errors, so a model that drops a field can't corrupt a meeting's notes.
//
// Deliberately lenient where it doesn't matter: extra properties are ignored (callers only read the
// keys they know), and unknown keywords are skipped.

type Schema = Record<string, any>;

const MAX_ERRORS = 8;

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

function typeMatches(want: string, v: unknown): boolean {
  const got = typeOf(v);
  if (want === got) return true;
  return want === "number" && got === "integer";
}

const at = (path: string) => path || "(root)";

function check(schema: Schema | undefined, v: unknown, path: string, errors: string[]): void {
  if (!schema || typeof schema !== "object" || errors.length >= MAX_ERRORS) return;
  const union = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(union)) {
    // Pass if any branch passes; otherwise report the first branch's errors (the usual intended one).
    const branchErrors = union.map((s: Schema) => { const e: string[] = []; check(s, v, path, e); return e; });
    if (!branchErrors.some((e) => e.length === 0)) errors.push(...(branchErrors[0] ?? [`${at(path)}: no matching schema`]));
    return;
  }
  if (schema.type != null) {
    const types: string[] = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(t, v))) {
      errors.push(`${at(path)}: expected ${types.join(" or ")}, got ${typeOf(v)}`);
      return;
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e: unknown) => e === v)) {
    errors.push(`${at(path)}: must be one of ${schema.enum.map((e: unknown) => JSON.stringify(e)).join(", ")}`);
    return;
  }
  if (typeOf(v) === "object") {
    const o = v as Record<string, unknown>;
    for (const k of Array.isArray(schema.required) ? schema.required : []) {
      if (!(k in o)) errors.push(`${path ? path + "." : ""}${k}: required`);
    }
    const props = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
    for (const [k, s] of Object.entries(props)) if (k in o) check(s as Schema, o[k], path ? `${path}.${k}` : k, errors);
  } else if (Array.isArray(v) && schema.items && typeof schema.items === "object") {
    v.forEach((item, i) => check(schema.items, item, `${path}[${i}]`, errors));
  }
}

/** Validation errors (empty = valid), at most a handful so they fit in a retry prompt. */
export function validateJson(schema: object, value: unknown): string[] {
  const errors: string[] = [];
  check(schema as Schema, value, "", errors);
  return errors.slice(0, MAX_ERRORS);
}
