'use strict';

const fs = require('fs');
const path = require('path');

const htmlFile = path.join(__dirname, '..', 'infancia-feliz-v27.html');
const html = fs.readFileSync(htmlFile, 'utf8');
const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)]
  .map((match) => match[1])
  .join('\n');

try {
  new Function(scripts);
  console.log('HTML scripts OK');
} catch (err) {
  console.error('Erro nos scripts do HTML:', err.message);
  process.exit(1);
}
