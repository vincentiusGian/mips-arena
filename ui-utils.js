(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MipsArena = Object.assign(root.MipsArena || {}, { ui: factory() });
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const OP_SET = new Set([
    'add', 'addu', 'sub', 'subu', 'addi', 'addiu', 'mult', 'multu', 'div', 'divu',
    'mfhi', 'mflo', 'and', 'or', 'xor', 'nor', 'andi', 'ori', 'xori', 'slt', 'sltu',
    'slti', 'sltiu', 'sll', 'srl', 'sra', 'sllv', 'srlv', 'srav', 'lui', 'lb', 'lbu',
    'lh', 'lhu', 'lw', 'sb', 'sh', 'sw', 'beq', 'bne', 'blez', 'bgtz', 'bltz', 'bgez',
    'j', 'jal', 'jr', 'jalr', 'syscall', 'nop', 'halt', 'move', 'li', 'la', 'neg', 'negu',
    'not', 'bgt', 'blt', 'bge', 'ble', 'bgtu', 'bleu', 'beqz', 'bnez', 'seq', 'sne'
  ]);
  const DIRECTIVES = new Set(['.data', '.text', '.globl', '.global', '.word', '.half', '.byte', '.asciiz', '.ascii', '.space', '.zero', '.align']);
  const REG = /^\$(zero|at|v[01]|a[0-3]|t\d|s[0-7]|k[01]|gp|sp|fp|ra|\d\d?)$/i;

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
  }

  function tokenClass(token, nextChar) {
    if (token[0] === '#' || token.startsWith('//')) return 'tok-comment';
    if (token[0] === '"' || token[0] === "'") return 'tok-string';
    if (REG.test(token)) return 'tok-reg';
    if (token[0] === '.') return DIRECTIVES.has(token.toLowerCase()) ? 'tok-directive' : 'tok-directive';
    if (/^(0[xX][\da-fA-F]+|0[bB][01]+|-?\d+)$/.test(token)) return 'tok-number';
    if (/^[A-Za-z_.$][\w.$]*:$/.test(token)) return 'tok-label';
    const lower = token.toLowerCase();
    if (OP_SET.has(lower)) return 'tok-op';
    if (/^[A-Za-z_.$][\w.$]*$/.test(token) && nextChar === ':') return 'tok-label';
    return '';
  }

  function highlightLine(line) {
    const regex = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\/.*$|#.*$|\$-?\w+|\.[A-Za-z]\w*|\b0[xX][\da-fA-F]+\b|\b0[bB][01]+\b|-?\b\d+\b|[A-Za-z_.$][\w.$]*:?)/g;
    let output = '';
    let last = 0;
    let match;
    while ((match = regex.exec(line)) !== null) {
      output += escapeHtml(line.slice(last, match.index));
      const token = match[0];
      const rest = line.slice(regex.lastIndex);
      const nextChar = (rest.match(/^\s*(.)/) || [, ''])[1];
      const cls = tokenClass(token, nextChar);
      output += cls ? `<span class="${cls}">${escapeHtml(token)}</span>` : escapeHtml(token);
      last = regex.lastIndex;
    }
    return output + escapeHtml(line.slice(last));
  }

  function highlightCode(source) {
    return String(source).split('\n').map(highlightLine).join('\n');
  }

  return { escapeHtml, highlightLine, highlightCode, OP_SET, DIRECTIVES };
});
