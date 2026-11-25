(function (root) {
  'use strict';

  const TEXT_BASE = 0x00400000;
  const DATA_BASE = 0x10010000;
  const STACK_BASE = 0x7fffe000;
  const WORD_MASK = 0xffffffff;

  const ERROR_CODES = {
    LANGUAGE: 'E_LANGUAGE',
    SYMBOL: 'E_SYMBOL',
    LABEL: 'E_LABEL',
    OPERAND: 'E_OPERAND',
    REGISTER: 'E_REGISTER',
    STRING: 'E_STRING',
    OVERFLOW: 'E_OVERFLOW',
    DIV_ZERO: 'E_DIV_ZERO',
    ALIGNMENT: 'E_ALIGNMENT',
    JUMP: 'E_JUMP',
    INSTRUCTION: 'E_INSTRUCTION',
    LIMIT: 'E_LIMIT'
  };

  const REGISTERS = {
    zero: 0, at: 1,
    v0: 2, v1: 3,
    a0: 4, a1: 5, a2: 6, a3: 7,
    t0: 8, t1: 9, t2: 10, t3: 11,
    t4: 12, t5: 13, t6: 14, t7: 15,
    s0: 16, s1: 17, s2: 18, s3: 19,
    s4: 20, s5: 21, s6: 22, s7: 23,
    t8: 24, t9: 25,
    k0: 26, k1: 27,
    gp: 28, sp: 29, fp: 30, s8: 30, ra: 31
  };

  const REG_NAMES = [
    'zero', 'at', 'v0', 'v1', 'a0', 'a1', 'a2', 'a3',
    't0', 't1', 't2', 't3', 't4', 't5', 't6', 't7',
    's0', 's1', 's2', 's3', 's4', 's5', 's6', 's7',
    't8', 't9', 'k0', 'k1', 'gp', 'sp', 'fp', 'ra'
  ];

  const ARITY = {
    add: 3, addu: 3, sub: 3, subu: 3, and: 3, or: 3, xor: 3, nor: 3,
    slt: 3, sltu: 3, sll: 3, srl: 3, sra: 3,
    sllv: 3, srlv: 3, srav: 3,
    mult: 2, multu: 2, div: 2, divu: 2, mfhi: 1, mflo: 1,
    jr: 1, jalr: 1,
    addi: 3, addiu: 3, andi: 3, ori: 3, xori: 3, slti: 3, sltiu: 3, lui: 2,
    lw: 2, sw: 2, lb: 2, lbu: 2, sb: 2, lh: 2, lhu: 2, sh: 2,
    beq: 3, bne: 3, blez: 2, bgtz: 2, bltz: 2, bgez: 2,
    j: 1, jal: 1, syscall: 0,
    li: 2, la: 2, move: 2, nop: 0, halt: 0,
    not: 2, neg: 2, negu: 2, seq: 3, sne: 3,
    blt: 3, ble: 3, bgt: 3, bge: 3, beqz: 2, bnez: 2
  };

  function toInt32(value) {
    return value | 0;
  }

  function add32(a, b, trap) {
    const result = (a + b) | 0;
    if (trap && ((a ^ result) & (b ^ result)) < 0) {
      const error = new Error('Integer overflow');
      error.code = ERROR_CODES.OVERFLOW;
      throw error;
    }
    return result;
  }

  function sub32(a, b, trap) {
    const result = (a - b) | 0;
    if (trap && ((a ^ b) & (a ^ result)) < 0) {
      const error = new Error('Integer overflow');
      error.code = ERROR_CODES.OVERFLOW;
      throw error;
    }
    return result;
  }

  function stripComments(line) {
    let out = '';
    let inString = false;
    let escaped = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (escaped) {
        out += ch;
        escaped = false;
        continue;
      }
      if (inString && ch === '\\') {
        out += ch;
        escaped = true;
        continue;
      }
      if (ch === '"' || ch === "'") {
        inString = !inString;
        out += ch;
        continue;
      }
      if (!inString && (ch === '#' || (ch === '/' && line[i + 1] === '/'))) break;
      out += ch;
    }
    return out.trim();
  }

  function splitOperands(text) {
    const parts = [];
    let current = '';
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (const ch of text) {
      if (escaped) {
        current += ch;
        escaped = false;
        continue;
      }
      if (inString && ch === '\\') {
        current += ch;
        escaped = true;
        continue;
      }
      if (ch === '"' || ch === "'") {
        inString = !inString;
        current += ch;
        continue;
      }
      if (!inString) {
        if (ch === '(') depth++;
        if (ch === ')') depth--;
        if (ch === ',' && depth === 0) {
          parts.push(current.trim());
          current = '';
          continue;
        }
      }
      current += ch;
    }
    if (current.trim()) parts.push(current.trim());
    return parts;
  }

  function unescapeString(text) {
    let result = '';
    for (let i = 1; i < text.length - 1; i++) {
      if (text[i] === '\\' && i + 1 < text.length - 1) {
        const next = text[++i];
        result += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next === '0' ? '\0' : next;
      } else {
        result += text[i];
      }
    }
    return result;
  }

  function stringToBytes(text) {
    if (typeof TextEncoder !== 'undefined') return Array.from(new TextEncoder().encode(text));
    const bytes = [];
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code < 0x80) bytes.push(code);
      else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
      else bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
    return bytes;
  }

  function parseNumber(token) {
    if (/^[-+]?\d+$/.test(token)) return parseInt(token, 10);
    if (/^[-+]?0x[0-9a-f]+$/i.test(token)) return parseInt(token, 16);
    if (/^[-+]?0b[01]+$/i.test(token)) return parseInt(token.replace('0b', ''), 2) * (token[0] === '-' ? -1 : 1);
    if (/^'.'$/.test(token)) return token.charCodeAt(1);
    return null;
  }

  function parseRegister(token) {
    const name = token.replace(/^\$/, '').toLowerCase();
    if (!(name in REGISTERS)) {
      const error = new Error('Illegal register: ' + token);
      error.code = ERROR_CODES.REGISTER;
      throw error;
    }
    return REGISTERS[name];
  }

  function assemble(source) {
    const errors = [];
    const textLabels = Object.create(null);
    const dataLabels = Object.create(null);
    const rawInstructions = [];
    const dataItems = [];
    const lines = String(source).replace(/\r\n?/g, '\n').split('\n');
    let segment = 'text';
    let dataAddr = DATA_BASE;

    function columnOf(token, line) {
      const raw = lines[line - 1] || '';
      const index = raw.toLowerCase().indexOf(String(token).toLowerCase());
      return index >= 0 ? index + 1 : 1;
    }

    function addError(line, message, code, column) {
      errors.push({
        line,
        column: column || 1,
        code: code || ERROR_CODES.LANGUAGE,
        message
      });
    }

    function resolveToken(token, line) {
      const numeric = parseNumber(token);
      if (numeric !== null) return { value: numeric, text: false };
      const key = token.replace(/^\$/, '');
      if (key in dataLabels) return { value: dataLabels[key], text: false };
      if (key in textLabels) return { value: textLabels[key], text: true };
      addError(line, 'Symbol "' + token + '" not found in symbol table.', ERROR_CODES.SYMBOL, columnOf(token, line));
      return { value: 0, text: false };
    }

    for (let i = 0; i < lines.length; i++) {
      const lineNo = i + 1;
      let text = stripComments(lines[i]);
      if (!text) continue;

      const directiveMatch = text.match(/^\.(text|data|globl|global|align|extern|include)\b(.*)$/i);
      if (directiveMatch) {
        const name = directiveMatch[1].toLowerCase();
        const rest = directiveMatch[2].trim();
        if (name === 'text') { segment = 'text'; continue; }
        if (name === 'data') { segment = 'data'; continue; }
        if (name === 'globl' || name === 'global' || name === 'extern' || name === 'include') continue;
        if (name === 'align') {
          const amount = parseNumber(rest) || 0;
          if (segment === 'data') dataAddr = Math.ceil(dataAddr / (1 << amount)) * (1 << amount);
          continue;
        }
      }

      const labelInline = text.match(/^([A-Za-z_.$][\w.$]*)\s*:\s*(.*)$/);
      if (labelInline) {
        const name = labelInline[1];
        if (segment === 'data') {
          dataLabels[name] = dataAddr;
        } else {
          if (name in textLabels) {
            addError(lineNo, 'Label "' + name + '" is already defined.', ERROR_CODES.LABEL, columnOf(name, lineNo));
          }
          textLabels[name] = rawInstructions.length;
        }
        text = labelInline[2].trim();
        if (!text) continue;
      }

      if (segment === 'data') {
        const directive = text.match(/^\.(word|half|byte|asciiz|ascii|space|zero)\b\s*(.*)$/i);
        if (!directive) {
          addError(lineNo, 'Invalid language element: ' + text.split(/\s+/)[0], ERROR_CODES.LANGUAGE, columnOf(text[0], lineNo));
          continue;
        }
        dataItems.push({ line: lineNo, kind: directive[1].toLowerCase(), rest: directive[2].trim(), address: dataAddr });
        const tokens = splitOperands(directive[2]);
        if (directive[1].toLowerCase() === 'word') dataAddr += tokens.length * 4;
        else if (directive[1].toLowerCase() === 'half') dataAddr += tokens.length * 2;
        else if (directive[1].toLowerCase() === 'byte') dataAddr += tokens.length;
        else if (directive[1].toLowerCase() === 'space') dataAddr += parseNumber(tokens[0] || '0') || 0;
        else if (directive[1].toLowerCase() === 'zero') dataAddr += parseNumber(tokens[0] || '0') || 0;
        else {
          const value = tokens[0] || '""';
          if (value[0] !== '"') {
            addError(lineNo, 'Illegal operand: expected a string after .ascii/.asciiz.', ERROR_CODES.STRING, columnOf(value, lineNo));
            continue;
          }
          const bytes = stringToBytes(unescapeString(value));
          dataAddr += bytes.length + (directive[1].toLowerCase() === 'asciiz' ? 1 : 0);
        }
        continue;
      }

      const pieces = text.split(/\s+/);
      const op = pieces.shift().toLowerCase();
      const operandText = text.slice(op.length).trim();
      const tokens = operandText ? splitOperands(operandText) : [];
      if (!(op in ARITY)) {
        addError(lineNo, 'Invalid language element: ' + op, ERROR_CODES.LANGUAGE, columnOf(op, lineNo));
        continue;
      }
      if (tokens.length !== ARITY[op]) {
        addError(
          lineNo,
          '"' + op + '": Too many or incorrectly formatted operands. Expected: ' +
            ARITY[op] + ' operand' + (ARITY[op] === 1 ? '' : 's') + '.',
          ERROR_CODES.OPERAND,
          columnOf(op, lineNo)
        );
        continue;
      }
      rawInstructions.push({ op, tokens, line: lineNo, index: rawInstructions.length });
    }

    function parseArg(token, line) {
      const memoryMatch = token.match(/^([^()]*)\(([^()]+)\)$/);
      if (memoryMatch) {
        const offsetToken = memoryMatch[1].trim();
        const baseToken = memoryMatch[2].trim();
        try {
          const base = parseRegister(baseToken);
          const offset = offsetToken ? resolveToken(offsetToken, line).value : 0;
          return { kind: 'mem', base, offset };
        } catch (error) {
          addError(line, error.message, error.code || ERROR_CODES.OPERAND, columnOf(token, line));
          return { kind: 'imm', value: 0 };
        }
      }
      const name = token.replace(/^\$/, '').toLowerCase();
      if (name in REGISTERS) return { kind: 'reg', index: REGISTERS[name] };
      const resolved = resolveToken(token, line);
      if (resolved.text) return { kind: 'target', index: resolved.value };
      return { kind: 'imm', value: resolved.value };
    }

    const instructions = rawInstructions.map(raw => ({
      op: raw.op,
      line: raw.line,
      index: raw.index,
      address: TEXT_BASE + raw.index * 4,
      args: raw.tokens.map(token => parseArg(token, raw.line))
    }));

    const dataSegments = [];
    for (const item of dataItems) {
      const bytes = [];
      const tokens = splitOperands(item.rest);
      if (item.kind === 'word' || item.kind === 'half' || item.kind === 'byte') {
        const size = item.kind === 'word' ? 4 : item.kind === 'half' ? 2 : 1;
        for (const token of tokens) {
          const value = resolveToken(token, item.line).value;
          for (let i = 0; i < size; i++) bytes.push((value >>> (8 * i)) & 0xff);
        }
      } else if (item.kind === 'space' || item.kind === 'zero') {
        const count = parseNumber(tokens[0] || '0') || 0;
        for (let i = 0; i < count; i++) bytes.push(0);
      } else {
        const value = tokens[0] || '""';
        if (value[0] !== '"') {
          addError(item.line, 'Illegal operand: expected a string.', ERROR_CODES.STRING, columnOf(value, item.line));
        } else {
          const encoded = stringToBytes(unescapeString(value));
          for (const byte of encoded) bytes.push(byte);
          if (item.kind === 'asciiz') bytes.push(0);
        }
      }
      dataSegments.push({ address: item.address, bytes });
    }

    return {
      instructions,
      dataSegments,
      textLabels,
      dataLabels,
      errors,
      source,
      constants: { TEXT_BASE, DATA_BASE, STACK_BASE }
    };
  }

  function parseInput(text) {
    const values = [];
    const errors = [];
    String(text == null ? '' : text).split(/\s+/).forEach((token, index) => {
      if (!token) return;
      const value = parseNumber(token);
      if (value === null) {
        errors.push({
          index,
          token,
          code: ERROR_CODES.SYMBOL,
          message: '"' + token + '" is not a valid integer constant or label'
        });
      }
      else values.push(value);
    });
    return { values, errors };
  }

  function loadInput(machine, program, text) {
    const parsed = parseInput(text);
    machine.inputQueue = parsed.values.slice();
    machine.inputIndex = 0;
    const base = program.dataLabels.input;
    if (base !== undefined) {
      parsed.values.forEach((value, index) => machine.setWord(base + index * 4, value));
      machine.writeReg(4, parsed.values.length);
      machine.writeReg(5, base);
    }
    return parsed;
  }

  class RuntimeError extends Error {
    constructor(message, line, code) {
      super(message);
      this.name = 'RuntimeError';
      this.line = line;
      this.code = code || ERROR_CODES.INSTRUCTION;
    }
  }

  class Machine {
    constructor(program, options) {
      this.program = program;
      this.options = options || {};
      this.inputQueue = [];
      this.reset();
    }

    reset() {
      this.regs = new Int32Array(32);
      this.hi = 0;
      this.lo = 0;
      this.pc = 'main' in this.program.textLabels ? this.program.textLabels.main : 0;
      this.steps = 0;
      this.halted = false;
      this.reason = null;
      this.output = [];
      this.memory = new Map();
      this.lastChanged = [];
      this.inputIndex = 0;
      this.regs[29] = STACK_BASE;
      this.regs[28] = DATA_BASE + 0x800;
      for (const segment of this.program.dataSegments) {
        segment.bytes.forEach((byte, offset) => this.setByte(segment.address + offset, byte));
      }
    }

    reg(name) {
      return this.regs[parseRegister(typeof name === 'number' ? REG_NAMES[name] : name)];
    }

    writeReg(index, value) {
      const next = toInt32(value);
      if (index === 0) return;
      if (this.regs[index] !== next) this.lastChanged.push(index);
      this.regs[index] = next;
    }

    setByte(address, value) {
      const byte = value & 0xff;
      if (byte === 0) this.memory.delete(address);
      else this.memory.set(address, byte);
    }

    getByte(address) {
      return this.memory.get(address) || 0;
    }

    setHalf(address, value) {
      this.setByte(address, value & 0xff);
      this.setByte(address + 1, (value >>> 8) & 0xff);
    }

    getHalf(address) {
      return this.getByte(address) | (this.getByte(address + 1) << 8);
    }

    setWord(address, value) {
      const word = toInt32(value);
      for (let i = 0; i < 4; i++) this.setByte(address + i, (word >>> (8 * i)) & 0xff);
    }

    getWord(address) {
      if (address % 4 !== 0) {
        throw new RuntimeError('Unaligned word address: 0x' + (address >>> 0).toString(16), undefined, ERROR_CODES.ALIGNMENT);
      }
      return (this.getByte(address) |
        (this.getByte(address + 1) << 8) |
        (this.getByte(address + 2) << 16) |
        (this.getByte(address + 3) << 24)) | 0;
    }

    getString(address, limit) {
      let text = '';
      const max = limit || 4096;
      for (let i = 0; i < max; i++) {
        const byte = this.getByte(address + i);
        if (byte === 0) break;
        text += String.fromCharCode(byte);
      }
      return text;
    }

    dumpWords(address, count) {
      const result = [];
      for (let i = 0; i < count; i++) {
        const word = this.getWord(address + i * 4);
        result.push({
          address: address + i * 4,
          value: word,
          hex: (word >>> 0).toString(16).padStart(8, '0').toUpperCase(),
          ascii: String.fromCharCode(
            (word >>> 0) & 0xff, (word >>> 8) & 0xff, (word >>> 16) & 0xff, (word >>> 24) & 0xff
          ).replace(/[^\x20-\x7e]/g, '.')
        });
      }
      return result;
    }

    operandValue(arg) {
      if (arg.kind === 'imm' || arg.kind === 'target') return arg.value !== undefined ? arg.value : arg.index;
      if (arg.kind === 'reg') return this.regs[arg.index];
      if (arg.kind === 'mem') return arg.offset + this.regs[arg.base];
      const error = new Error('Illegal operand');
      error.code = ERROR_CODES.OPERAND;
      throw error;
    }

    addressOf(arg) {
      if (arg.kind !== 'mem') {
        throw new RuntimeError('Illegal operand: memory address expected', undefined, ERROR_CODES.OPERAND);
      }
      return (arg.offset + this.regs[arg.base]) | 0;
    }

    step() {
      if (this.halted) {
        return { halted: true, line: null, changed: [], outputDelta: '' };
      }
      if (this.pc < 0 || this.pc >= this.program.instructions.length) {
        this.halted = true;
        this.reason = 'program reached end of code';
        return { halted: true, line: null, changed: [], outputDelta: '' };
      }

      const instruction = this.program.instructions[this.pc];
      const args = instruction.args;
      const line = instruction.line;
      const outputBefore = this.output.length;
      this.lastChanged = [];
      let next = this.pc + 1;

      const value = index => this.operandValue(args[index]);
      const sourceReg = index => {
        if (args[index].kind !== 'reg') {
          throw new RuntimeError('Illegal operand: register expected as operand ' + (index + 1), line, ERROR_CODES.OPERAND);
        }
        return args[index].index;
      };
      const target = index => {
        if (args[index].kind !== 'target') {
          throw new RuntimeError('Illegal operand: label expected as operand ' + (index + 1), line, ERROR_CODES.OPERAND);
        }
        return args[index].index;
      };
      const guard = condition => {
        if (!condition) {
          throw new RuntimeError('Illegal operand type for ' + instruction.op, line, ERROR_CODES.OPERAND);
        }
      };

      try {
        switch (instruction.op) {
          case 'add': case 'addu': case 'sub': case 'subu':
          case 'and': case 'or': case 'xor': case 'nor':
          case 'slt': case 'sltu':
            guard(args[0].kind === 'reg' && args[1].kind === 'reg' && args[2].kind === 'reg');
            {
              const a = this.regs[sourceReg(1)];
              const b = this.regs[sourceReg(2)];
              let result;
              if (instruction.op === 'add') result = add32(a, b, true);
              else if (instruction.op === 'addu') result = add32(a, b, false);
              else if (instruction.op === 'sub') result = sub32(a, b, true);
              else if (instruction.op === 'subu') result = sub32(a, b, false);
              else if (instruction.op === 'and') result = a & b;
              else if (instruction.op === 'or') result = a | b;
              else if (instruction.op === 'xor') result = a ^ b;
              else if (instruction.op === 'nor') result = ~(a | b);
              else if (instruction.op === 'slt') result = a < b ? 1 : 0;
              else result = (a >>> 0) < (b >>> 0) ? 1 : 0;
              this.writeReg(sourceReg(0), result);
            }
            break;

          case 'sll': case 'srl': case 'sra':
          case 'sllv': case 'srlv': case 'srav':
            guard(args[0].kind === 'reg' && args[1].kind === 'reg');
            {
              const variable = instruction.op.endsWith('v');
              const shiftSource = variable ? args[2] : args[2];
              const shift = variable ? this.operandValue(shiftSource) & 31 : this.operandValue(shiftSource) & 31;
              const a = this.regs[sourceReg(1)];
              let result;
              if (instruction.op === 'sll' || instruction.op === 'sllv') result = a << shift;
              else if (instruction.op === 'srl' || instruction.op === 'srlv') result = a >>> shift;
              else result = a >> shift;
              this.writeReg(sourceReg(0), result);
            }
            break;

          case 'mult': case 'multu': case 'div': case 'divu':
            guard(args[0].kind === 'reg' && args[1].kind === 'reg');
            {
              const a = this.regs[sourceReg(0)];
              const b = this.regs[sourceReg(1)];
              if (instruction.op === 'mult' || instruction.op === 'multu') {
                const left = instruction.op === 'multu' ? BigInt(a >>> 0) : BigInt(a);
                const right = instruction.op === 'multu' ? BigInt(b >>> 0) : BigInt(b);
                const product = left * right;
                this.lo = Number(product & 0xffffffffn) | 0;
                this.hi = Number(product >> 32n) | 0;
              } else {
                if (b === 0) throw new RuntimeError('Division by zero', line, ERROR_CODES.DIV_ZERO);
                const left = instruction.op === 'divu' ? BigInt(a >>> 0) : BigInt(a);
                const right = instruction.op === 'divu' ? BigInt(b >>> 0) : BigInt(b);
                const quotient = left / right;
                const remainder = left - quotient * right;
                this.lo = Number(quotient) | 0;
                this.hi = Number(remainder) | 0;
              }
            }
            break;

          case 'mfhi': case 'mflo':
            guard(args[0].kind === 'reg');
            this.writeReg(sourceReg(0), instruction.op === 'mfhi' ? this.hi : this.lo);
            break;

          case 'jr': case 'jalr':
            guard(args[0].kind === 'reg');
            {
              const address = this.regs[sourceReg(0)];
              if ((address - TEXT_BASE) % 4 !== 0) {
                throw new RuntimeError('Illegal jump target: 0x' + (address >>> 0).toString(16), line, ERROR_CODES.JUMP);
              }
              next = (address - TEXT_BASE) / 4;
              if (instruction.op === 'jalr') this.writeReg(31, (this.pc + 1) * 4 + TEXT_BASE | 0);
            }
            break;

          case 'addi': case 'addiu': case 'andi': case 'ori': case 'xori': case 'slti': case 'sltiu':
            guard(args[0].kind === 'reg' && args[1].kind === 'reg');
            {
              const immediate = value(2);
              const a = this.regs[sourceReg(1)];
              let result;
              if (instruction.op === 'addi') result = add32(a, immediate, true);
              else if (instruction.op === 'addiu') result = add32(a, immediate, false);
              else if (instruction.op === 'andi') result = a & immediate;
              else if (instruction.op === 'ori') result = a | immediate;
              else if (instruction.op === 'xori') result = a ^ immediate;
              else if (instruction.op === 'slti') result = a < immediate ? 1 : 0;
              else result = (a >>> 0) < (immediate >>> 0) ? 1 : 0;
              this.writeReg(sourceReg(0), result);
            }
            break;

          case 'lui':
            guard(args[0].kind === 'reg');
            this.writeReg(sourceReg(0), (value(1) & 0xffff) << 16);
            break;

          case 'lw': case 'lb': case 'lbu': case 'lh': case 'lhu':
            guard(args[0].kind === 'reg');
            {
              const address = this.addressOf(args[1]);
              let loaded;
              if (instruction.op === 'lw') loaded = this.getWord(address);
              else if (instruction.op === 'lb') loaded = (this.getByte(address) << 24) >> 24;
              else if (instruction.op === 'lbu') loaded = this.getByte(address);
              else if (instruction.op === 'lh') loaded = (this.getHalf(address) << 16) >> 16;
              else loaded = this.getHalf(address);
              this.writeReg(sourceReg(0), loaded);
            }
            break;

          case 'sw': case 'sb': case 'sh':
            {
              const address = this.addressOf(args[1]);
              const stored = value(0);
              if (instruction.op === 'sw') this.setWord(address, stored);
              else if (instruction.op === 'sb') this.setByte(address, stored);
              else this.setHalf(address, stored);
            }
            break;

          case 'beq': case 'bne': case 'blt': case 'ble': case 'bgt': case 'bge':
            guard(args[2].kind === 'target');
            {
              const left = value(0);
              const right = value(1);
              const taken =
                instruction.op === 'beq' ? left === right :
                instruction.op === 'bne' ? left !== right :
                instruction.op === 'blt' ? left < right :
                instruction.op === 'ble' ? left <= right :
                instruction.op === 'bgt' ? left > right : left >= right;
              if (taken) next = target(2);
            }
            break;

          case 'blez': case 'bgtz': case 'bltz': case 'bgez': case 'beqz': case 'bnez':
            guard(args[1].kind === 'target');
            {
              const checked = value(0);
              const taken =
                instruction.op === 'blez' ? checked <= 0 :
                instruction.op === 'bgtz' ? checked > 0 :
                instruction.op === 'bltz' ? checked < 0 :
                instruction.op === 'bgez' ? checked >= 0 :
                instruction.op === 'beqz' ? checked === 0 : checked !== 0;
              if (taken) next = target(1);
            }
            break;

          case 'j': case 'jal':
            next = target(0);
            if (instruction.op === 'jal') this.writeReg(31, (this.pc + 1) * 4 + TEXT_BASE | 0);
            break;

          case 'syscall':
            this.executeSyscall();
            break;

          case 'li':
            guard(args[0].kind === 'reg');
            this.writeReg(sourceReg(0), value(1));
            break;

          case 'la':
            guard(args[0].kind === 'reg' && (args[1].kind === 'imm' || args[1].kind === 'target'));
            this.writeReg(sourceReg(0), args[1].kind === 'target'
              ? TEXT_BASE + args[1].index * 4
              : args[1].value);
            break;

          case 'move':
            guard(args[0].kind === 'reg');
            this.writeReg(sourceReg(0), value(1));
            break;

          case 'not':
            guard(args[0].kind === 'reg' && args[1].kind === 'reg');
            this.writeReg(sourceReg(0), ~this.regs[sourceReg(1)]);
            break;

          case 'neg': case 'negu':
            guard(args[0].kind === 'reg' && args[1].kind === 'reg');
            this.writeReg(sourceReg(0), sub32(0, this.regs[sourceReg(1)], instruction.op === 'neg'));
            break;

          case 'seq': case 'sne':
            guard(args[0].kind === 'reg');
            {
              const equal = value(1) === value(2);
              this.writeReg(sourceReg(0), (instruction.op === 'seq' ? equal : !equal) ? 1 : 0);
            }
            break;

          case 'nop': case 'halt':
            if (instruction.op === 'halt') {
              this.halted = true;
              this.reason = 'halt';
            }
            break;

          default:
            throw new RuntimeError('Unsupported instruction: ' + instruction.op, line, ERROR_CODES.INSTRUCTION);
        }
      } catch (error) {
        if (error instanceof RuntimeError) {
          if (!error.line) error.line = line;
          throw error;
        }
        throw new RuntimeError(error.message, line, error.code || ERROR_CODES.INSTRUCTION);
      }

      this.steps++;
      this.pc = next;
      return {
        line,
        index: this.pc,
        changed: this.lastChanged.slice(),
        outputDelta: this.output.slice(outputBefore).join(''),
        halted: this.halted
      };
    }

    executeSyscall() {
      const code = this.regs[2];
      if (code === 1) {
        this.output.push(String(this.regs[4]));
      } else if (code === 4) {
        this.output.push(this.getString(this.regs[4]));
      } else if (code === 11) {
        this.output.push(String.fromCharCode(this.regs[4] & 0xff));
      } else if (code === 10) {
        this.halted = true;
        this.reason = 'syscall exit';
      } else if (code === 5) {
        const input = this.inputQueue[this.inputIndex++];
        this.writeReg(2, input === undefined ? 0 : toInt32(input));
      } else if (code === 9) {
        this.writeReg(2, this.program.constants.DATA_BASE + this.steps * 4);
      }
    }

    runSync(maxSteps) {
      let count = 0;
      while (!this.halted && count < maxSteps) {
        this.step();
        count++;
      }
      if (!this.halted && count >= maxSteps) {
        throw new RuntimeError('Instruction limit exceeded (' + maxSteps + ' steps)', undefined, ERROR_CODES.LIMIT);
      }
      return {
        steps: this.steps,
        output: this.output.join(''),
        reason: this.reason
      };
    }
  }

  const api = {
    assemble,
    Machine,
    RuntimeError,
    parseInput,
    loadInput,
    REG_NAMES,
    REGISTERS,
    ARITY,
    ERROR_CODES,
    constants: { TEXT_BASE, DATA_BASE, STACK_BASE },
    toInt32
  };

  root.MipsArena = Object.assign(root.MipsArena || {}, { core: api });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
