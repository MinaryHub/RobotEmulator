// 가벼운 코드 에디터: textarea + 하이라이트 오버레이 + 라인번호 + 실행 라인 표시
const KW = {
  yaskawa: 'NOP END MOVJ MOVL MOVC MOVS IMOV TIMER DOUT PULSE WAIT DIN JUMP CALL RET PAUSE SET ADD SUB MUL DIV INC DEC IF JOB OT IN VJ V VR PL ON OFF T MSG TOOLON TOOLOFF SETE GETE CNVRT',
  kawasaki: 'PROGRAM END JMOVE LMOVE JAPPRO LAPPRO JDEPART LDEPART C1MOVE C2MOVE HOME DRAW TDRAW SPEED ACCURACY ALWAYS MM S SIGNAL PULSE SWAIT TWAIT WAIT IF THEN ELSE WHILE DO UNTIL FOR TO STEP CASE OF VALUE ANY CALL RETURN STOP HALT PAUSE PRINT TYPE POINT HERE TRANS SHIFT BY TOOL BASE NULL BREAK AND OR NOT SIG TRANS JOINTS REALS STRINGS',
  hyundai: 'MOVE P L C S A T DELAY DO DI WAIT WAITI IF THEN ELSEIF ELSE ENDIF FOR TO STEP NEXT WHILE ENDWHILE GOTO CALL END RETURN PRINT VAR AND OR NOT POSE SHIFT',
  abb: 'MODULE ENDMODULE PROC ENDPROC FUNC ENDFUNC TRAP ENDTRAP RETURN CONST PERS VAR LOCAL TASK IF THEN ELSEIF ELSE ENDIF WHILE DO ENDWHILE FOR FROM TO STEP ENDFOR TEST CASE DEFAULT ENDTEST GOTO MoveJ MoveL MoveC MoveAbsJ WaitTime WaitDI WaitDO WaitUntil SetDO Set Reset PulseDO TPWrite TPErase Stop Exit Incr Decr ConfJ ConfL AccSet VelSet Offs RelTool CRobT CJointT AND OR NOT XOR DIV MOD TRUE FALSE num bool string robtarget jointtarget tooldata wobjdata speeddata zonedata pos orient pose fine tool0 wobj0',
  doosan: 'DEF RETURN IF ELIF ELSE WHILE FOR IN RANGE BREAK CONTINUE PASS GLOBAL AND OR NOT IS NONE TRUE FALSE ON OFF POSJ POSX MOVEJ MOVEL MOVEC MOVEJX MOVESJ MOVESX AMOVEJ AMOVEL MWAIT WAIT TRANS SET_DIGITAL_OUTPUT GET_DIGITAL_INPUT WAIT_DIGITAL_INPUT SET_VELJ SET_ACCJ SET_VELX SET_ACCX TP_POPUP TP_LOG EXIT DR_BASE DR_TOOL',
  kuka: 'DEF END DEFFCT ENDFCT DEFDAT ENDDAT DECL GLOBAL PUBLIC INT REAL BOOL CHAR E6POS E6AXIS POS AXIS FRAME PTP LIN CIRC PTP_REL LIN_REL WAIT SEC FOR IF THEN ELSE ENDIF ENDFOR WHILE ENDWHILE REPEAT UNTIL LOOP ENDLOOP EXIT SWITCH CASE DEFAULT ENDSWITCH GOTO HALT RETURN TO STEP AND OR NOT EXOR TRUE FALSE PULSE BAS INI Vel PDAT CPDAT LDAT Tool Base C_PTP C_DIS C_VEL',
};
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export class CodeEditor {
  constructor(el) {
    this.el = el;
    el.classList.add('editor');
    el.innerHTML = `<div class="gutter"></div><div class="code"><div class="exec-bar"></div><div class="err-bar"></div><pre class="hl" aria-hidden="true"></pre><textarea spellcheck="false" wrap="off"></textarea></div>`;
    this.gutter = el.querySelector('.gutter');
    this.ta = el.querySelector('textarea');
    this.hl = el.querySelector('.hl');
    this.execBar = el.querySelector('.exec-bar');
    this.errBar = el.querySelector('.err-bar');
    this.vendor = 'yaskawa';
    this.kw = new Set();
    this.bpLines = new Set();
    this.onGutterClick = () => {};
    this.dirty = false;
    this.onChange = () => {};
    this.ta.addEventListener('input', () => { this.dirty = true; this.render(); this.onChange(); });
    this.ta.addEventListener('scroll', () => this.syncScroll());
    // 라인 번호 클릭 → 브레이크포인트 토글
    this.gutter.addEventListener('click', (ev) => {
      const d = ev.target.closest('[data-ln]');
      if (d) this.onGutterClick(Number(d.dataset.ln));
    });
    this.ta.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        const s = this.ta.selectionStart;
        this.ta.setRangeText('  ', s, this.ta.selectionEnd, 'end');
        this.ta.dispatchEvent(new Event('input'));
      }
    });
    this.execLine = null;
    this.errLine = null;
  }

  setLanguage(vendor) { this.vendor = vendor; this.kw = new Set(KW[vendor].toUpperCase().split(/\s+/)); this.render(); }
  get text() { return this.ta.value; }
  set text(v) { this.ta.value = v; this.dirty = false; this.render(); }

  insertAtCursor(s) {
    const pos = this.ta.selectionStart;
    const lineStart = this.ta.value.lastIndexOf('\n', pos - 1) + 1;
    const lineEnd = this.ta.value.indexOf('\n', pos);
    const at = lineEnd === -1 ? this.ta.value.length : lineEnd;
    const prefix = this.ta.value.slice(lineStart, at).trim() ? '\n' : '';
    this.ta.setRangeText(prefix + s, at, at, 'end');
    this.ta.focus();
    this.ta.dispatchEvent(new Event('input'));
  }

  render() {
    const lines = this.ta.value.split('\n');
    this.gutter.innerHTML = lines.map((_, i) => `<div data-ln="${i + 1}"${this.bpLines.has(i + 1) ? ' class="bp"' : ''}>${i + 1}</div>`).join('') + '<div>&nbsp;</div>';
    this.hl.innerHTML = lines.map((l) => this.highlight(l)).join('\n') + '\n ';
    this.syncScroll();
  }

  highlight(line) {
    const v = this.vendor;
    // 주석 분리
    const cm = { yaskawa: "'", kawasaki: ';', hyundai: "'", abb: '!', kuka: ';', doosan: '#' }[v];
    let code = line, comment = '';
    let inStr = false;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"') inStr = !inStr;
      if (!inStr && line.startsWith(cm, i)) { code = line.slice(0, i); comment = line.slice(i); break; }
    }
    if (v === 'kawasaki' && /^\s*\.\w+/.test(code)) return `<span class="t-dir">${esc(code)}</span><span class="t-cm">${esc(comment)}</span>`;
    if (v === 'yaskawa' && /^\s*\/\/?\/?/.test(code) && code.trim().startsWith('/')) return `<span class="t-dir">${esc(code)}</span>`;
    if (v === 'kuka' && /^\s*&/.test(code)) return `<span class="t-dir">${esc(code)}</span>`;
    const out = code.replace(/("[^"]*")|(\$?[A-Za-z_#][\w#$%!]*)|(-?\b\d+\.?\d*(?:[eE][+-]?\d+)?\b)|([^"\w$#]+)/g, (m, str, id, num, other) => {
      if (str) return `<span class="t-str">${esc(str)}</span>`;
      if (id) {
        if (this.kw.has(id.toUpperCase())) return `<span class="t-kw">${esc(id)}</span>`;
        if (id.startsWith('$') || id.startsWith('#')) return `<span class="t-sys">${esc(id)}</span>`;
        return `<span class="t-id">${esc(id)}</span>`;
      }
      if (num) return `<span class="t-num">${esc(num)}</span>`;
      return esc(other);
    });
    return out + (comment ? `<span class="t-cm">${esc(comment)}</span>` : '');
  }

  syncScroll() {
    const st = this.ta.scrollTop, sl = this.ta.scrollLeft;
    this.hl.style.transform = `translate(${-sl}px, ${-st}px)`;
    this.gutter.scrollTop = st;
    this.placeBar(this.execBar, this.execLine);
    this.placeBar(this.errBar, this.errLine);
  }

  placeBar(bar, line) {
    if (!line) { bar.style.display = 'none'; return; }
    const lh = parseFloat(getComputedStyle(this.ta).lineHeight);
    const pad = parseFloat(getComputedStyle(this.ta).paddingTop);
    bar.style.display = 'block';
    bar.style.top = `${pad + (line - 1) * lh - this.ta.scrollTop}px`;
    bar.style.height = `${lh}px`;
  }

  setExecLine(line, scroll = true) {
    if (line === this.execLine) return;
    this.execLine = line;
    this.placeBar(this.execBar, line);
    if (line && scroll) {
      const lh = parseFloat(getComputedStyle(this.ta).lineHeight);
      const y = (line - 1) * lh;
      if (y < this.ta.scrollTop || y > this.ta.scrollTop + this.ta.clientHeight - lh * 2) this.ta.scrollTop = Math.max(0, y - this.ta.clientHeight / 3);
    }
  }
  setBreakpoints(lines) {
    const s = new Set(lines);
    if ([...s].join() === [...this.bpLines].join()) return;
    this.bpLines = s;
    for (const d of this.gutter.querySelectorAll('[data-ln]')) d.classList.toggle('bp', s.has(Number(d.dataset.ln)));
  }

  setErrLine(line) { this.errLine = line; this.placeBar(this.errBar, line); }
}
