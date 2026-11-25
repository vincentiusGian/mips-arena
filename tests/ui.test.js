const test = require('node:test');
const assert = require('node:assert/strict');
const { highlightLine, highlightCode } = require('../ui-utils.js');

test('highlightLine recognizes opcodes, registers, numbers, labels, directives, strings, and comments', () => {
  const line = 'main: addi $t0, $zero, 10 # init';
  const html = highlightLine(line);
  assert.match(html, /<span class="tok-label">main:<\/span>/);
  assert.match(html, /<span class="tok-op">addi<\/span>/);
  assert.match(html, /<span class="tok-reg">\$t0<\/span>/);
  assert.match(html, /<span class="tok-reg">\$zero<\/span>/);
  assert.match(html, /<span class="tok-number">10<\/span>/);
  assert.match(html, /<span class="tok-comment"># init<\/span>/);
});

test('highlightCode processes multiple lines, directives, and strings', () => {
  const html = highlightCode('.data\nmsg: .asciiz "hi"\n.text\nli $v0, 4');
  assert.match(html, /<span class="tok-directive">\.data<\/span>/);
  assert.match(html, /<span class="tok-directive">\.asciiz<\/span>/);
  assert.match(html, /<span class="tok-string">&quot;hi&quot;<\/span>/);
  assert.match(html, /<span class="tok-op">li<\/span>/);
});

test('highlight escapes HTML', () => {
  const html = highlightLine('li $t0, <script>');
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});
