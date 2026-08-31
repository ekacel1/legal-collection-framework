/**
 * Validation de schema JSON, sous-ensemble delibere — Volume III, 4.3.
 *
 * Le manifeste exige `additionalProperties: false` et un schema simple. Un
 * validateur complet (et sa dependance) apporterait des fonctions que le
 * contrat interdit deja d'employer. Le sous-ensemble couvert ici est celui que
 * la specification autorise, ni plus ni moins :
 *
 *   type, properties, required, additionalProperties, items, enum,
 *   minimum, maximum, minLength, maxLength, pattern, const
 *
 * Toute construction non reconnue est signalee comme erreur de schema, jamais
 * ignoree en silence : un schema partiellement applique est pire qu'aucun.
 */

export type JsonSchema = {
  readonly type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly items?: JsonSchema;
  readonly enum?: readonly unknown[];
  readonly const?: unknown;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minItems?: number;
  readonly pattern?: string;
  readonly description?: string;
  readonly default?: unknown;
};

const KNOWN_KEYWORDS = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "minItems",
  "pattern",
  "description",
  "default",
  "title",
  "examples",
]);

export interface ValidationIssue {
  /** Chemin JSON du champ fautif, ex. `config.startYear`. */
  readonly path: string;
  readonly message: string;
}

export function validateSchemaShape(schema: JsonSchema, path = "schema"): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const key of Object.keys(schema)) {
    if (!KNOWN_KEYWORDS.has(key)) {
      issues.push({ path, message: `mot-clef de schema non supporte : ${key}` });
    }
  }
  for (const [name, sub] of Object.entries(schema.properties ?? {})) {
    issues.push(...validateSchemaShape(sub, `${path}.${name}`));
  }
  if (schema.items !== undefined) {
    issues.push(...validateSchemaShape(schema.items, `${path}[]`));
  }
  return issues;
}

export function validate(value: unknown, schema: JsonSchema, path = "config"): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (schema.const !== undefined && value !== schema.const) {
    issues.push({ path, message: `valeur attendue : ${JSON.stringify(schema.const)}` });
  }
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    issues.push({ path, message: `valeur hors du domaine autorise : ${JSON.stringify(value)}` });
  }

  switch (schema.type) {
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return [...issues, { path, message: "objet attendu" }];
      }
      const record = value as Record<string, unknown>;
      for (const name of schema.required ?? []) {
        if (record[name] === undefined) {
          issues.push({ path: `${path}.${name}`, message: "champ obligatoire manquant" });
        }
      }
      const known = new Set(Object.keys(schema.properties ?? {}));
      if (schema.additionalProperties === false) {
        for (const name of Object.keys(record)) {
          if (!known.has(name)) {
            issues.push({ path: `${path}.${name}`, message: "champ inconnu" });
          }
        }
      }
      for (const [name, sub] of Object.entries(schema.properties ?? {})) {
        if (record[name] !== undefined) {
          issues.push(...validate(record[name], sub, `${path}.${name}`));
        }
      }
      return issues;
    }

    case "array": {
      if (!Array.isArray(value)) return [...issues, { path, message: "tableau attendu" }];
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        issues.push({ path, message: `au moins ${schema.minItems} element(s) attendu(s)` });
      }
      if (schema.items !== undefined) {
        value.forEach((item, index) => {
          issues.push(...validate(item, schema.items as JsonSchema, `${path}[${index}]`));
        });
      }
      return issues;
    }

    case "string": {
      if (typeof value !== "string") return [...issues, { path, message: "chaine attendue" }];
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        issues.push({ path, message: `longueur minimale ${schema.minLength}` });
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        issues.push({ path, message: `longueur maximale ${schema.maxLength}` });
      }
      if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
        issues.push({ path, message: `format attendu : ${schema.pattern}` });
      }
      return issues;
    }

    case "integer":
    case "number": {
      if (typeof value !== "number" || Number.isNaN(value)) {
        return [...issues, { path, message: "nombre attendu" }];
      }
      if (schema.type === "integer" && !Number.isInteger(value)) {
        issues.push({ path, message: "entier attendu" });
      }
      if (schema.minimum !== undefined && value < schema.minimum) {
        issues.push({ path, message: `valeur minimale ${schema.minimum}` });
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        issues.push({ path, message: `valeur maximale ${schema.maximum}` });
      }
      return issues;
    }

    case "boolean":
      if (typeof value !== "boolean") issues.push({ path, message: "booleen attendu" });
      return issues;

    case "null":
      if (value !== null) issues.push({ path, message: "null attendu" });
      return issues;

    case undefined:
      return issues;

    default:
      return [...issues, { path, message: `type de schema inconnu : ${String(schema.type)}` }];
  }
}

export function formatIssues(issues: readonly ValidationIssue[]): string {
  return issues.map((issue) => `${issue.path} : ${issue.message}`).join(" ; ");
}
