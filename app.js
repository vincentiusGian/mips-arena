(function () {
  'use strict';

  const core = window.MipsArena.core;
  const ui = window.MipsArena.ui;
  const el = id => document.getElementById(id);
  const LS_CODE = 'mips-ide.code';
  const LS_INPUT = 'mips-ide.input';
  const LS_TEMPLATE = 'mips-ide.template';
  const LS_THEME = 'mips-ide.theme';
  const LS_ISA = 'mips-ide.isa';
  const LS_IO_MODE = 'mips-ide.ioMode';

  const TEMPLATES = {
    dasar: `# Read three integers (Custom Input or Terminal), then print their sum
.text
.globl main
main:
    li $v0, 5
    syscall
    move $t0, $v0

    li $v0, 5
    syscall
    move $t1, $v0

    li $v0, 5
    syscall
    add $t2, $t0, $t1
    add $t2, $t2, $v0

    li $v0, 1
    move $a0, $t2
    syscall

    li $v0, 11
    li $a0, 10
    syscall
    halt
`,
    array: `# Custom Input is stored at the input label
# $a0 = number of values, $a1 = address of the input label
.data
input: .space 404

.text
.globl main
main:
    la $t0, input
    li $t1, 0
    li $t2, 0
loop:
    beq $t1, $a0, done
    lw $t3, 0($t0)
    add $t2, $t2, $t3
    addi $t0, $t0, 4
    addi $t1, $t1, 1
    j loop
done:
    li $v0, 1
    move $a0, $t2
    syscall
    li $v0, 11
    li $a0, 10
    syscall
    halt
`
  };

  const state = {
    program: null,
    session: null,
    displayMachine: null,
    running: false,
    raf: null,
    lastTs: 0,
    acc: 0,
    breakpoints: new Set(),
    currentLine: null,
    outputLines: [],
    activeTab: 'registers',
    memoryBase: '0x10010000',
    memoryAddress: core.constants.DATA_BASE,
    saveTimer: null,
    inputTimer: null,
    ioMode: 'split',
    terminalQueue: [],
    resumeAfterInput: false
  };

  function escapeHtml(value) {
    return ui.escapeHtml(value);
  }

  function hex32(value) {
    return (value >>> 0).toString(16).padStart(8, '0').toUpperCase();
  }

  function highlightCode(source) {
    return ui.highlightCode(source);
  }

  function renderGutter() {
    const count = el('editor').value.split('\n').length;
    let html = '';
    for (let i = 1; i <= count; i++) {
      const classes = ['gutter-line'];
      if (state.breakpoints.has(i)) classes.push('has-breakpoint');
      if (state.currentLine === i) classes.push('current');
      html += `<div class="${classes.join(' ')}" data-line="${i}">${i}</div>`;
    }
    el('gutter').innerHTML = html;
  }

  function editorLineHeight() {
    const value = parseFloat(getComputedStyle(el('editor')).lineHeight);
    return Number.isFinite(value) ? value : 22;
  }

  function syncEditorScroll() {
    const editor = el('editor');
    el('highlight').scrollTop = editor.scrollTop;
    el('highlight').scrollLeft = editor.scrollLeft;
    el('gutter').scrollTop = editor.scrollTop;
    updateCurrentLinePosition();
  }

  function updateCurrentLinePosition() {
    const overlay = el('currentLine');
    if (!state.currentLine) {
      overlay.style.top = '-100px';
      return;
    }
    const editor = el('editor');
    const paddingTop = parseFloat(getComputedStyle(editor).paddingTop) || 0;
    overlay.style.top = (paddingTop + (state.currentLine - 1) * editorLineHeight() - editor.scrollTop) + 'px';
  }

  function setCurrentLine(line) {
    state.currentLine = line || null;
    Array.from(el('gutter').children).forEach((node, index) => {
      node.classList.toggle('current', state.currentLine === index + 1);
    });
    updateCurrentLinePosition();
  }

  function setRunStatus(text) {
    el('runStatus').textContent = text;
  }

  function logOutput(text, kind) {
    state.outputLines.push({ text: String(text), kind: kind || 'out' });
    renderOutput();
  }

  function appendStdout(delta) {
    if (!delta) return;
    const last = state.outputLines[state.outputLines.length - 1];
    if (last && last.kind === 'out') last.text += delta;
    else state.outputLines.push({ text: delta, kind: 'out' });
    renderOutput();
  }

  function renderOutput() {
    el('consoleOutput').innerHTML = state.outputLines
      .map(entry => `<span class="console-${entry.kind}">${escapeHtml(entry.text)}</span>`)
      .join('');
    el('consoleOutput').scrollTop = el('consoleOutput').scrollHeight;
  }

  function rate() {
    return Math.round(Math.pow(10, 1 + Number(el('speed').value) / 100 * 3.7));
  }

  function updateSpeedLabel() {
    const value = rate();
    el('speedLabel').textContent = value >= 1000 ? (value / 1000).toFixed(1) + 'k/s' : value + '/s';
  }

  function updateInputMeta() {
    const parsed = core.parseInput(el('inputText').value);
    const suffix = parsed.errors.length ? `, ${parsed.errors.length} invalid` : '';
    el('inputMeta').textContent = `${parsed.values.length} values${suffix}`;
  }

  function runtimeInput() {
    return state.ioMode === 'terminal' ? '' : el('inputText').value;
  }

  function applyIoMode(persist) {
    const split = state.ioMode === 'split';
    el('sidePanel').dataset.ioMode = state.ioMode;
    el('inputPanel').hidden = !split;
    el('terminalRow').hidden = split;
    el('consoleTitle').textContent = split ? 'Program Output' : 'Terminal';
    el('ioModeBtn').textContent = split ? 'Terminal' : 'Split';
    el('ioModeBtn').setAttribute('aria-pressed', String(!split));
    if (persist !== false) localStorage.setItem(LS_IO_MODE, state.ioMode);
    if (!split && state.session && state.session.machine.waitingForInput) {
      el('terminalInput').focus();
    }
  }

  function toggleIoMode() {
    stopRun();
    state.session = null;
    state.terminalQueue = [];
    state.resumeAfterInput = false;
    state.ioMode = state.ioMode === 'split' ? 'terminal' : 'split';
    applyIoMode();
    setCurrentLine(null);
    setRunStatus('Ready');
  }

  function submitTerminalInput() {
    const raw = el('terminalInput').value;
    if (!raw.trim()) return;
    el('terminalInput').value = '';
    logOutput('> ' + raw + '\n', 'in');
    const parsed = core.parseInput(raw);
    if (parsed.errors.length) {
      const first = parsed.errors[0];
      logOutput(`Invalid input [${first.code}] at position ${first.index + 1}: ${first.message}\n`, 'err');
      return;
    }
    const machine = state.session && state.session.machine;
    if (machine) {
      machine.provideInput(parsed.values);
    } else {
      state.terminalQueue.push(...parsed.values);
    }
    if (machine && machine.waitingForInput) {
      el('terminalInput').focus();
      return;
    }
    if (state.resumeAfterInput) {
      state.resumeAfterInput = false;
      startLoop();
    } else if (!state.running) {
      setRunStatus('Ready to step');
    }
  }

  function stopRun() {
    state.running = false;
    if (state.raf) cancelAnimationFrame(state.raf);
    state.raf = null;
    el('pauseBtn').disabled = true;
    el('runBtn').disabled = false;
  }

  function assembleNow(logErrors) {
    const program = core.assemble(el('editor').value);
    state.program = program;
    const status = el('assemblerStatus');
    if (program.errors.length) {
      status.className = 'assembler-status error';
      status.textContent = `${program.errors.length} assembly error${program.errors.length === 1 ? '' : 's'}`;
      if (logErrors) {
        const first = program.errors[0];
        logOutput(`Assembly error [${first.code}] at line ${first.line}, column ${first.column}: ${first.message}`, 'err');
        setRunStatus(`Assembly error at line ${first.line}: ${first.message}`);
      }
      return null;
    }
    status.className = 'assembler-status ok';
    status.textContent = `${program.instructions.length} instruction${program.instructions.length === 1 ? '' : 's'}`;
    return program;
  }

  function resetDisplay() {
    const program = state.program;
    if (!program) return;
    const machine = new core.Machine(program);
    core.loadInput(machine, program, runtimeInput());
    state.displayMachine = machine;
    updateRegisters();
    updateMemory();
  }

  function createSession() {
    stopRun();
    state.outputLines = [];
    renderOutput();
    state.resumeAfterInput = false;
    const program = assembleNow(true);
    if (!program) return null;
    const machine = new core.Machine(program);
    core.loadInput(machine, program, runtimeInput());
    if (state.terminalQueue.length) {
      machine.inputQueue.push(...state.terminalQueue);
      state.terminalQueue = [];
    }
    state.session = { machine, program };
    state.displayMachine = machine;
    setCurrentLine(null);
    updateRegisters();
    updateMemory();
    updateStats();
    setRunStatus('Ready');
    return state.session;
  }

  function ensureSession() {
    if (state.session && !state.session.machine.halted) return state.session;
    return createSession();
  }

  function handleRuntimeError(error) {
    stopRun();
    logOutput(`Runtime error [${error.code || 'E_RUNTIME'}] at line ${error.line || '?'}: ${error.message}`, 'err');
    setRunStatus(`Runtime error at line ${error.line || '?'}: ${error.message}`);
  }

  function updateStats() {
    const machine = state.session && state.session.machine;
    if (!machine) {
      el('pcStatus').textContent = 'PC ' + hex32(core.constants.TEXT_BASE);
      el('instrStatus').textContent = '0 instructions';
      el('rateStatus').textContent = '0 instr/s';
      return;
    }
    el('pcStatus').textContent = 'PC ' + hex32(core.constants.TEXT_BASE + machine.pc * 4);
    el('instrStatus').textContent = machine.steps.toLocaleString('en-US') + ' instructions';
    el('rateStatus').textContent = state.running ? rate().toLocaleString('en-US') + ' instr/s' : '0 instr/s';
  }

  function finishSession() {
    stopRun();
    const machine = state.session.machine;
    setRunStatus(`Finished · ${machine.steps.toLocaleString('en-US')} instructions`);
    updateStats();
  }

  function tick(timestamp) {
    if (!state.running) return;
    const delta = Math.min(timestamp - state.lastTs, 120);
    state.lastTs = timestamp;
    state.acc += delta / 1000 * rate();
    let budget = Math.min(Math.floor(state.acc), 4000);
    state.acc -= budget;

    const machine = state.session.machine;
    const changed = new Set();
    let stoppedByBreakpoint = false;
    let waitingForInput = false;
    let promptShown = machine.waitingForInput;

    while (budget-- > 0 && !machine.halted) {
      let result;
      try {
        result = machine.step();
      } catch (error) {
        handleRuntimeError(error);
        return;
      }
      appendStdout(result.outputDelta);
      if (result.waitingForInput) {
        waitingForInput = true;
        if (!promptShown && state.ioMode === 'terminal') logOutput('? ', 'prompt');
        promptShown = true;
        break;
      }
      result.changed.forEach(index => changed.add(index));
      setCurrentLine(result.line);
      if (state.breakpoints.has(result.line)) {
        stoppedByBreakpoint = true;
        break;
      }
    }

    updateRegisters(changed);
    updateMemory();
    updateStats();

    if (waitingForInput) {
      stopRun();
      state.resumeAfterInput = true;
      updateStats();
      setRunStatus('Waiting for input');
      if (state.ioMode === 'terminal') el('terminalInput').focus();
      return;
    }
    if (machine.halted) { finishSession(); return; }
    if (stoppedByBreakpoint) {
      stopRun();
      const next = machine.program.instructions[machine.pc];
      setRunStatus(`Breakpoint · line ${next ? next.line : '?'}`);
      return;
    }
    state.raf = requestAnimationFrame(tick);
  }

  function startLoop() {
    state.running = true;
    el('pauseBtn').disabled = false;
    el('runBtn').disabled = true;
    setRunStatus('Running');
    state.lastTs = performance.now();
    state.acc = 0;
    state.raf = requestAnimationFrame(tick);
  }

  function run() {
    if (state.running) {
      stopRun();
      setRunStatus('Paused');
      return;
    }
    const session = ensureSession();
    if (!session) return;
    if (session.machine.waitingForInput) {
      state.resumeAfterInput = true;
      setRunStatus('Waiting for input');
      if (state.ioMode === 'terminal') el('terminalInput').focus();
      return;
    }
    startLoop();
  }

  function runFromStart() {
    stopRun();
    if (!createSession()) return;
    startLoop();
  }

  function step() {
    stopRun();
    const session = ensureSession();
    if (!session) return;
    const wasWaiting = session.machine.waitingForInput;
    let result;
    try {
      result = session.machine.step();
    } catch (error) {
      handleRuntimeError(error);
      return;
    }
    appendStdout(result.outputDelta);
    if (result.waitingForInput) {
      if (!wasWaiting && state.ioMode === 'terminal') logOutput('? ', 'prompt');
      state.resumeAfterInput = false;
      updateRegisters(new Set(result.changed));
      updateStats();
      setRunStatus('Waiting for input');
      if (state.ioMode === 'terminal') el('terminalInput').focus();
      return;
    }
    setCurrentLine(result.line);
    updateRegisters(new Set(result.changed));
    updateMemory();
    updateStats();
    setRunStatus(result.halted ? 'Finished' : 'Step');
    if (session.machine.halted) finishSession();
  }

  function buildRegisterGrid() {
    let html = '';
    const extras = ['PC', 'HI', 'LO'];
    core.REG_NAMES.forEach(name => {
      html += `<div class="reg-card" id="card-${name}"><div class="reg-name">$${name}</div><div class="reg-value" id="reg-${name}"><span class="reg-hex">00000000</span><span class="reg-dec">0</span></div></div>`;
    });
    extras.forEach(name => {
      html += `<div class="reg-card" id="card-${name}"><div class="reg-name">${name}</div><div class="reg-value" id="reg-${name}"><span class="reg-hex">00000000</span><span class="reg-dec">0</span></div></div>`;
    });
    el('registerGrid').innerHTML = html;
  }

  function flashCard(name) {
    const card = el('card-' + name);
    if (!card) return;
    card.classList.remove('flash');
    void card.offsetWidth;
    card.classList.add('flash');
    setTimeout(() => card.classList.remove('flash'), 300);
  }

  function updateRegisters(changed) {
    const machine = state.displayMachine;
    if (!machine) return;
    const flashes = new Set(changed || []);
    core.REG_NAMES.forEach((name, index) => {
      const value = machine.regs[index];
      el('reg-' + name).innerHTML = `<span class="reg-hex">${hex32(value)}</span><span class="reg-dec">${value}</span>`;
      if (flashes.has(index)) flashCard(name);
    });
    const pc = core.constants.TEXT_BASE + machine.pc * 4;
    el('reg-PC').innerHTML = `<span class="reg-hex">${hex32(pc)}</span><span class="reg-dec">${pc}</span>`;
    el('reg-HI').innerHTML = `<span class="reg-hex">${hex32(machine.hi)}</span><span class="reg-dec">${machine.hi}</span>`;
    el('reg-LO').innerHTML = `<span class="reg-hex">${hex32(machine.lo)}</span><span class="reg-dec">${machine.lo}</span>`;
  }

  function resolveMemoryBase(text, machine, program) {
    const token = text.trim();
    if (token in program.dataLabels) return program.dataLabels[token];
    if (token in program.textLabels) return core.constants.TEXT_BASE + program.textLabels[token] * 4;
    if (token === 'sp' || token === '$sp') return machine.reg('sp');
    if (token === 'gp' || token === '$gp') return machine.reg('gp');
    if (/^0x[\da-f]+$/i.test(token)) return parseInt(token, 16);
    if (/^-?\d+$/.test(token)) return parseInt(token, 10);
    return core.constants.DATA_BASE;
  }

  function updateMemory() {
    const machine = state.displayMachine;
    const program = state.program;
    if (!machine || !program) return;
    const address = Math.floor(resolveMemoryBase(state.memoryBase, machine, program) / 4) * 4;
    state.memoryAddress = address;
    el('memoryView').innerHTML = machine.dumpWords(address, 28).map(word =>
      `<div class="memory-row"><span class="mem-addr">0x${hex32(word.address)}</span>` +
      `<span class="mem-hex">${word.hex}</span>` +
      `<span class="mem-dec">${word.value}</span></div>`
    ).join('');
  }

  function switchTab(name) {
    state.activeTab = name;
    Array.from(el('tabs').querySelectorAll('.tab')).forEach(button => {
      button.classList.toggle('active', button.dataset.tab === name);
    });
    el('tab-registers').hidden = name !== 'registers';
    el('tab-memory').hidden = name !== 'memory';
  }

  function loadTemplate(name) {
    stopRun();
    state.session = null;
    state.breakpoints.clear();
    state.currentLine = null;
    state.memoryBase = name === 'array' ? 'input' : '0x10010000';
    el('memoryBase').value = state.memoryBase;
    el('editor').value = TEMPLATES[name] || TEMPLATES.dasar;
    el('templateSelect').value = TEMPLATES[name] ? name : 'dasar';
    onEditorInput();
    resetDisplay();
    localStorage.setItem(LS_TEMPLATE, el('templateSelect').value);
    setRunStatus('Template loaded');
  }

  function onEditorInput() {
    stopRun();
    state.session = null;
    el('highlight').innerHTML = highlightCode(el('editor').value);
    renderGutter();
    syncEditorScroll();
    requestAnimationFrame(syncEditorScroll);
    assembleNow(false);
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(() => localStorage.setItem(LS_CODE, el('editor').value), 200);
  }

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    const button = el('themeBtn');
    button.textContent = theme === 'dark' ? 'Light' : 'Dark';
    button.setAttribute('aria-label', `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`);
    localStorage.setItem(LS_THEME, theme);
  }

  function toggleTheme() {
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  }

  function setIsaOpen(open) {
    el('isaPanel').hidden = !open;
    el('isaBackdrop').hidden = !open;
    el('isaBtn').setAttribute('aria-pressed', String(open));
    el('isaBtn').setAttribute('aria-label', open ? 'Close ISA reference' : 'Open ISA reference');
    localStorage.setItem(LS_ISA, open ? 'open' : 'closed');
    if (open) el('isaSearch').focus();
  }

  function filterIsa() {
    const query = el('isaSearch').value.trim().toLowerCase();
    let visible = 0;
    document.querySelectorAll('.isa-section').forEach(section => {
      let sectionVisible = 0;
      section.querySelectorAll('.isa-item').forEach(item => {
        const match = !query || item.textContent.toLowerCase().includes(query);
        item.hidden = !match;
        if (match) sectionVisible += 1;
      });
      section.hidden = sectionVisible === 0;
      visible += sectionVisible;
    });
    el('isaEmpty').hidden = visible !== 0;
  }

  function bindEvents() {
    el('editor').addEventListener('input', onEditorInput);
    el('editor').addEventListener('scroll', syncEditorScroll);
    el('editor').addEventListener('keyup', syncEditorScroll);
    el('editor').addEventListener('click', syncEditorScroll);
    window.addEventListener('resize', syncEditorScroll);
    el('editor').addEventListener('keydown', event => {
      if (event.key !== 'Tab') return;
      event.preventDefault();
      const textarea = el('editor');
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      if (typeof textarea.setRangeText === 'function') {
        textarea.setRangeText('    ', start, end, 'end');
      } else {
        textarea.value = textarea.value.slice(0, start) + '    ' + textarea.value.slice(end);
        textarea.selectionStart = textarea.selectionEnd = start + 4;
      }
      onEditorInput();
    });

    el('inputText').addEventListener('input', () => {
      stopRun();
      state.session = null;
      updateInputMeta();
      clearTimeout(state.inputTimer);
      state.inputTimer = setTimeout(() => localStorage.setItem(LS_INPUT, el('inputText').value), 200);
    });

    el('gutter').addEventListener('click', event => {
      const line = event.target.closest('.gutter-line');
      if (!line) return;
      const number = Number(line.dataset.line);
      if (state.breakpoints.has(number)) state.breakpoints.delete(number);
      else state.breakpoints.add(number);
      renderGutter();
    });

    el('runBtn').addEventListener('click', run);
    el('pauseBtn').addEventListener('click', () => {
      stopRun();
      setRunStatus('Paused');
    });
    el('stepBtn').addEventListener('click', step);
    el('resetBtn').addEventListener('click', () => {
      createSession();
      setRunStatus('Reset');
    });
    el('clearOutput').addEventListener('click', () => {
      state.outputLines = [];
      renderOutput();
    });
    el('ioModeBtn').addEventListener('click', toggleIoMode);
    el('terminalInput').addEventListener('keydown', event => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      submitTerminalInput();
    });
    el('speed').addEventListener('input', updateSpeedLabel);

    el('templateSelect').addEventListener('change', event => loadTemplate(event.target.value));

    el('tabs').addEventListener('click', event => {
      const button = event.target.closest('.tab');
      if (button) switchTab(button.dataset.tab);
    });

    el('memoryBase').addEventListener('change', event => {
      state.memoryBase = event.target.value;
      updateMemory();
    });
    el('memoryBase').addEventListener('keydown', event => {
      if (event.key !== 'Enter') return;
      state.memoryBase = event.target.value;
      updateMemory();
    });
    el('memoryPrev').addEventListener('click', () => {
      state.memoryBase = String(state.memoryAddress - 128);
      el('memoryBase').value = state.memoryBase;
      updateMemory();
    });
    el('memoryNext').addEventListener('click', () => {
      state.memoryBase = String(state.memoryAddress + 128);
      el('memoryBase').value = state.memoryBase;
      updateMemory();
    });

    el('themeBtn').addEventListener('click', toggleTheme);
    el('isaBtn').addEventListener('click', () => setIsaOpen(el('isaPanel').hidden));
    el('isaClose').addEventListener('click', () => setIsaOpen(false));
    el('isaBackdrop').addEventListener('click', () => setIsaOpen(false));
    el('isaSearch').addEventListener('input', filterIsa);

    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !el('isaPanel').hidden) {
        setIsaOpen(false);
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        runFromStart();
      } else if (event.key === 'F5') {
        event.preventDefault();
        run();
      } else if (event.key === 'F10') {
        event.preventDefault();
        step();
      }
    });
  }

  function init() {
    const savedTheme = localStorage.getItem(LS_THEME);
    applyTheme(savedTheme === 'light' || savedTheme === 'dark'
      ? savedTheme
      : (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));
    state.ioMode = localStorage.getItem(LS_IO_MODE) === 'terminal' ? 'terminal' : 'split';
    applyIoMode(false);
    buildRegisterGrid();
    bindEvents();
    updateSpeedLabel();
    filterIsa();
    setIsaOpen(localStorage.getItem(LS_ISA) === 'open');

    const savedInput = localStorage.getItem(LS_INPUT);
    el('inputText').value = savedInput === null ? '3 7 12' : savedInput;
    updateInputMeta();

    const savedCode = localStorage.getItem(LS_CODE);
    if (savedCode === null) {
      loadTemplate(localStorage.getItem(LS_TEMPLATE) || 'dasar');
    } else {
      el('editor').value = savedCode;
      onEditorInput();
      resetDisplay();
      setRunStatus('Ready');
    }
  }

  init();
})();
