// checker/guia.test.js — tests del renderizador Markdown->HTML del manual. Correr con: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mdToHtml, inline, escapeHtml, renderGuia, slugify } from './guia.js';

// ── inline ──────────────────────────────────────────────────────────────────

test('inline: bold, italic y code', () => {
  assert.equal(inline('un **fuerte** y un *enfasis*'), 'un <strong>fuerte</strong> y un <em>enfasis</em>');
  assert.equal(inline('esto es `codigo`'), 'esto es <code>codigo</code>');
});

test('inline: link', () => {
  assert.equal(inline('ver [README](README.md)'), 'ver <a href="README.md">README</a>');
});

test('inline: dentro de code span NO se aplica markdown (link literal)', () => {
  assert.equal(inline('(`[checker/tls.js](checker/tls.js)`)'), '(<code>[checker/tls.js](checker/tls.js)</code>)');
});

test('inline: escapa HTML fuera de code', () => {
  assert.equal(inline('a < b & c'), 'a &lt; b &amp; c');
  assert.equal(inline('`<slug>`'), '<code>&lt;slug&gt;</code>');
});

// ── slugify (anclas del índice, estilo GitHub) ────────────────────────────────

test('slugify: minúsculas, sin puntuación/emoji, espacios->guiones', () => {
  assert.equal(slugify('Los colores (el semáforo)'), 'los-colores-el-semáforo');
  assert.equal(slugify('Alertas (email / Telegram)'), 'alertas-email--telegram');
  assert.equal(slugify('Apéndice — El caso "X"'), 'apéndice--el-caso-x');
});

test('mdToHtml: los títulos llevan id = slug (para el índice)', () => {
  assert.match(mdToHtml('## Cómo se calcula el uptime'), /<h2 id="cómo-se-calcula-el-uptime">/);
});

// ── bloques ─────────────────────────────────────────────────────────────────

test('mdToHtml: headings de distinto nivel (con id)', () => {
  assert.match(mdToHtml('# Uno'), /<h1 id="uno">Uno<\/h1>/);
  assert.match(mdToHtml('## Dos'), /<h2 id="dos">Dos<\/h2>/);
  assert.match(mdToHtml('### Tres'), /<h3 id="tres">Tres<\/h3>/);
});

test('mdToHtml: párrafo junta líneas y corta en blanco', () => {
  const h = mdToHtml('linea uno\nlinea dos\n\notra cosa');
  assert.match(h, /<p>linea uno linea dos<\/p>/);
  assert.match(h, /<p>otra cosa<\/p>/);
});

test('mdToHtml: code fence se escapa verbatim y no se parsea', () => {
  const h = mdToHtml('```\n│ **no** es bold <x>\n```');
  assert.match(h, /<pre><code>│ \*\*no\*\* es bold &lt;x&gt;<\/code><\/pre>/);
});

test('mdToHtml: tabla GFM', () => {
  const h = mdToHtml('| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |');
  assert.match(h, /<table><thead><tr><th>A<\/th><th>B<\/th><\/tr><\/thead>/);
  assert.match(h, /<tbody><tr><td>1<\/td><td>2<\/td><\/tr><tr><td>3<\/td><td>4<\/td><\/tr><\/tbody>/);
});

test('mdToHtml: blockquote', () => {
  assert.match(mdToHtml('> una nota **importante**'), /<blockquote>una nota <strong>importante<\/strong><\/blockquote>/);
});

test('mdToHtml: lista desordenada con continuación de línea', () => {
  const h = mdToHtml('- item uno que sigue\n  en otra linea\n- item dos');
  assert.match(h, /<ul><li>item uno que sigue en otra linea<\/li><li>item dos<\/li><\/ul>/);
});

test('mdToHtml: lista ordenada con sublista anidada', () => {
  const h = mdToHtml('1. primero\n2. segundo:\n   - a\n   - b\n3. tercero');
  assert.match(h, /<ol><li>primero<\/li><li>segundo:<ul><li>a<\/li><li>b<\/li><\/ul><\/li><li>tercero<\/li><\/ol>/);
});

test('mdToHtml: regla horizontal', () => {
  assert.match(mdToHtml('---'), /<hr>/);
});

test('renderGuia: envuelve el contenido en una página completa', () => {
  const html = renderGuia('# Título\n\nPárrafo.');
  assert.match(html, /<!DOCTYPE html>/);
  assert.match(html, /<link rel="stylesheet" href="styles\.css" \/>/);
  assert.match(html, /Volver al panel/);
  assert.match(html, /<h1 id="título">Título<\/h1>/);
});
