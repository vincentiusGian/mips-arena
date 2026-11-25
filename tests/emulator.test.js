'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../emulator.js');

function build(source) {
  const program = core.assemble(source);
  assert.deepEqual(program.errors, [], 'assembler errors: ' + JSON.stringify(program.errors));
  return program;
}

test('assembler reports the error line', () => {
  const program = core.assemble('main:\n  halo $t0\n');
  assert.equal(program.errors.length, 1);
  assert.equal(program.errors[0].line, 2);
  assert.equal(program.errors[0].column, 3);
  assert.equal(program.errors[0].code, 'E_LANGUAGE');
  assert.match(program.errors[0].message, /Invalid language element: halo/);
});

test('assembler uses MARS-style symbol and operand errors', () => {
  const missing = core.assemble('main:\n  add $t0, $t1, missing\n');
  assert.equal(missing.errors[0].code, 'E_SYMBOL');
  assert.match(missing.errors[0].message, /Symbol "missing" not found in symbol table\./);

  const arity = core.assemble('main:\n  syscall 1\n');
  assert.equal(arity.errors[0].code, 'E_OPERAND');
  assert.match(arity.errors[0].message, /Too many or incorrectly formatted operands/);
});

test('add detects overflow, addu wraps', () => {
  const trap = new core.Machine(build('main:\n li $t0, 2147483647\n add $t1, $t0, $t0\n halt\n'));
  trap.step();
  assert.throws(() => trap.step(), /Integer overflow/);
  const wrap = new core.Machine(build('main:\n li $t0, 2147483647\n addu $t1, $t0, $t0\n halt\n'));
  wrap.runSync(10);
  assert.equal(wrap.reg('t1'), -2);
});

test('mult/div fills HI and LO correctly', () => {
  const machine = new core.Machine(build('main:\n li $t0, -7\n li $t1, 3\n mult $t0, $t1\n mflo $s0\n mfhi $s1\n div $t0, $t1\n mflo $s2\n mfhi $s3\n halt\n'));
  machine.runSync(20);
  assert.equal(machine.reg('s0'), -21);
  assert.equal(machine.reg('s1'), -1);
  assert.equal(machine.reg('s2'), -2);
  assert.equal(machine.reg('s3'), -1);
});

test('lw/sw use little-endian bytes and label addresses', () => {
  const program = build('.data\nval: .word 0x01020304\n.text\nmain:\n la $t0, val\n lw $t1, 0($t0)\n lb $t2, 1($t0)\n halt\n');
  const machine = new core.Machine(program);
  machine.runSync(10);
  assert.equal(machine.reg('t1'), 0x01020304);
  assert.equal(machine.reg('t2'), 3);
  assert.equal(machine.getByte(program.dataLabels.val), 4);
});

test('syscall prints integers, strings, and characters', () => {
  const program = build('.data\nmessage: .asciiz "MIPS!"\n.text\nmain:\n li $v0, 4\n la $a0, message\n syscall\n li $v0, 1\n li $a0, 42\n syscall\n li $v0, 11\n li $a0, 10\n syscall\n li $v0, 10\n syscall\n');
  const machine = new core.Machine(program);
  machine.runSync(50);
  assert.equal(machine.output.join(''), 'MIPS!42\n');
  assert.equal(machine.reason, 'syscall exit');
});

test('parseInput accepts decimal, hexadecimal, and negative values', () => {
  const parsed = core.parseInput('10\n-3 0x1f  oops  7');
  assert.deepEqual(parsed.values, [10, -3, 31, 7]);
  assert.equal(parsed.errors.length, 1);
  assert.equal(parsed.errors[0].token, 'oops');
  assert.match(parsed.errors[0].message, /"oops" is not a valid integer constant or label/);
});

test('loadInput fills the syscall queue and input label', () => {
  const program = build('.data\ninput: .space 40\n.text\nmain:\n li $v0, 5\n syscall\n move $t0, $v0\n li $v0, 5\n syscall\n add $t1, $t0, $v0\n li $v0, 1\n move $a0, $t1\n syscall\n halt\n');
  const machine = new core.Machine(program);
  core.loadInput(machine, program, '10 0x7');
  assert.equal(machine.reg('a0'), 2);
  assert.equal(machine.reg('a1'), program.dataLabels.input);
  assert.equal(machine.getWord(program.dataLabels.input), 10);
  assert.equal(machine.getWord(program.dataLabels.input + 4), 7);
  machine.runSync(30);
  assert.equal(machine.output.join(''), '17');
});

test('instruction limit raises an error', () => {
  const machine = new core.Machine(build('main:\nloop:\n j loop\n'));
  assert.throws(() => machine.runSync(25), /Instruction limit exceeded \(25 steps\)/);
  assert.equal(machine.steps, 25);
});
