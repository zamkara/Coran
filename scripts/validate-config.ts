import { readFile } from 'node:fs/promises';
import { validateConfig } from '../src/config';
const path = process.argv.slice(2).find(arg => arg !== '--');
if (path) validateConfig(JSON.parse(await readFile(path, 'utf8')));
console.log('Relay configuration is valid');
