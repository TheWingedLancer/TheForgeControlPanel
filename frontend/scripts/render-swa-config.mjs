#!/usr/bin/env node
/**
 * Renders staticwebapp.config.json from staticwebapp.config.template.json by
 * substituting AAD_TENANT_ID with the value from the environment, then writes
 * the result into dist/ where the SWA deploy action will pick it up.
 *
 * The tenant ID is not a secret (it's discoverable from any login URL), but
 * we treat it as build-time config because SWA does not support runtime
 * env-var interpolation inside the openIdIssuer field.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const tenantId = process.env.AAD_TENANT_ID;
if (!tenantId) {
  console.error('ERROR: AAD_TENANT_ID env var is required to render staticwebapp.config.json');
  process.exit(1);
}

const templatePath = resolve(root, 'staticwebapp.config.template.json');
const outDir = resolve(root, 'dist');
const outPath = resolve(outDir, 'staticwebapp.config.json');

if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

const template = readFileSync(templatePath, 'utf8');
const rendered = template.replace(/AAD_TENANT_ID/g, tenantId);

// Validate it parses as JSON before writing
try {
  JSON.parse(rendered);
} catch (err) {
  console.error('ERROR: Rendered config is not valid JSON:', err.message);
  process.exit(1);
}

writeFileSync(outPath, rendered);
console.log(`Wrote ${outPath}`);
