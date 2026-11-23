// 가벼운 코드 에디터: textarea + 하이라이트 오버레이 + 라인번호 + 실행 라인 표시
const KW = {
  yaskawa: 'NOP END MOVJ MOVL MOVC MOVS IMOV TIMER DOUT PULSE WAIT DIN JUMP CALL RET PAUSE SET ADD SUB MUL DIV INC DEC IF JOB OT IN VJ V VR PL ON OFF T MSG TOOLON TOOLOFF SETE GETE CNVRT',
  kawasaki: 'PROGRAM END JMOVE LMOVE JAPPRO LAPPRO JDEPART LDEPART C1MOVE C2MOVE HOME DRAW TDRAW SPEED ACCURACY ALWAYS MM S SIGNAL PULSE SWAIT TWAIT WAIT IF THEN ELSE WHILE DO UNTIL FOR TO STEP CASE OF VALUE ANY CALL RETURN STOP HALT PAUSE PRINT TYPE POINT HERE TRANS SHIFT BY TOOL BASE NULL BREAK AND OR NOT SIG TRANS JOINTS REALS STRINGS',
  hyundai: 'MOVE P L C S A T DELAY DO DI WAIT WAITI IF THEN ELSEIF ELSE ENDIF FOR TO STEP NEXT WHILE ENDWHILE GOTO CALL END RETURN PRINT VAR AND OR NOT POSE SHIFT',
  abb: 'MODULE ENDMODULE PROC ENDPROC FUNC ENDFUNC TRAP ENDTRAP RETURN CONST PERS VAR LOCAL TASK IF THEN ELSEIF ELSE ENDIF WHILE DO ENDWHILE FOR FROM TO STEP ENDFOR TEST CASE DEFAULT ENDTEST GOTO MoveJ MoveL MoveC MoveAbsJ WaitTime WaitDI WaitDO WaitUntil SetDO Set Reset PulseDO TPWrite TPErase Stop Exit Incr Decr ConfJ ConfL AccSet VelSet Offs RelTool CRobT CJointT AND OR NOT XOR DIV MOD TRUE FALSE num bool string robtarget jointtarget tooldata wobjdata speeddata zonedata pos orient pose fine tool0 wobj0',
  doosan: 'DEF RETURN IF ELIF ELSE WHILE FOR IN RANGE BREAK CONTINUE PASS GLOBAL AND OR NOT IS NONE TRUE FALSE ON OFF POSJ POSX MOVEJ MOVEL MOVEC MOVEJX MOVESJ MOVESX AMOVEJ AMOVEL MWAIT WAIT TRANS SET_DIGITAL_OUTPUT GET_DIGITAL_INPUT WAIT_DIGITAL_INPUT SET_VELJ SET_ACCJ SET_VELX SET_ACCX TP_POPUP TP_LOG EXIT DR_BASE DR_TOOL',
  ur: 'DEF END IF ELIF ELSE WHILE RETURN BREAK CONTINUE HALT GLOBAL LOCAL AND OR XOR NOT TRUE FALSE PASS THREAD RUN JOIN KILL MOVEJ MOVEL MOVEP MOVEC SLEEP SYNC TEXTMSG POPUP SET_TCP SET_PAYLOAD POSE_TRANS POSE_ADD POSE_SUB POSE_INV GET_INVERSE_KIN GET_FORWARD_KIN GET_ACTUAL_TCP_POSE GET_ACTUAL_JOINT_POSITIONS SET_STANDARD_DIGITAL_OUT GET_STANDARD_DIGITAL_IN SET_CONFIGURABLE_DIGITAL_OUT GET_CONFIGURABLE_DIGITAL_IN SET_TOOL_DIGITAL_OUT GET_TOOL_DIGITAL_IN SOCKET_OPEN SOCKET_CLOSE SOCKET_SEND_STRING SOCKET_SEND_LINE SOCKET_READ_LINE',
  kuka: 'DEF END DEFFCT ENDFCT DEFDAT ENDDAT DECL GLOBAL PUBLIC INT REAL BOOL CHAR E6POS E6AXIS POS AXIS FRAME PTP LIN CIRC PTP_REL LIN_REL WAIT SEC FOR IF THEN ELSE ENDIF ENDFOR WHILE ENDWHILE REPEAT UNTIL LOOP ENDLOOP EXIT SWITCH CASE DEFAULT ENDSWITCH GOTO HALT RETURN TO STEP AND OR NOT EXOR TRUE FALSE PULSE BAS INI Vel PDAT CPDAT LDAT Tool Base C_PTP C_DIS C_VEL',
};
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export class CodeEditor {
  constructor(el) {
    this.el = el;
    el.classList.add('editor');
    el.innerHTML = `<div class="ed-find hidden"><input type="text" class="ed-fq" placeholder="찾기 (Enter: 다음, Shift+Enter: 이전)"><span class="ed-fc"></span><button type="button" class="ed-fp" title="이전">▲</button><button type="button" class="ed-fn" title="다음">▼</button><button type="button" class="ed-fx" title="닫기">✕</button></div><div class="ed-body"><div class="gutter"></div><div class="code"><div class="exec-bar"></div><div class="err-bar"></div><pre class="hl" aria-hidden="true"></pre><textarea spellcheck="false" wrap="off"></textarea></div></div>`;
    this.findBar = el.querySelector('.ed-find');
    this.findInput = el.querySelector('.ed-fq');
    this.findCount = el.querySelector('.ed-fc');
    this.gutter = el.querySelector('.gutter');
    this.ta = el.querySelector('textarea');
    this.hl = el.querySelector('.hl');
    this.execBar = el.querySelector('.exec-bar');
    this.errBar = el.querySelector('.err-bar');
    this.vendor = 'yaskawa';
    this.kw = new Set();
    this.bpLines = new Set();
    this.onGutterClick = () => {};
    this.onCursor = () => {};
    this.dirty = false;
    this.onChange = () => {};
    this._matches = [];
    this._matchIdx = -1;
    this.ta.addEventListener('input', () => { this.dirty = true; this.render(); this.onChange(); this._emitCursor(); if (!this.findBar.classList.contains('hidden')) this._updateFind(false); });
    this.ta.addEventListener('scroll', () => this.syncScroll());
    this.ta.addEventListener('keyup', () => this._emitCursor());
    this.ta.addEventListener('mouseup', () => this._emitCursor());
    this.ta.addEventListener('focus', () => this._emitCursor());
    // 라인 번호 클릭 → 브레이크포인트 토글
    this.gutter.addEventListener('click', (ev) => {
      const d = ev.target.closest('[data-ln]');
      if (d) this.onGutterClick(Number(d.dataset.ln));
    });
    this.ta.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.code === 'KeyF') {
        e.preventDefault();
        this.openFind();
        return;
      }
      if (e.key === 'Escape' && !this.findBar.classList.contains('hidden')) {
        e.preventDefault();
        this.closeFind();
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        const s = this.ta.selectionStart, end = this.ta.selectionEnd;
        if (e.shiftKey) {
          const val = this.ta.value;
          const ls = val.lastIndexOf('\n', s - 1) + 1;
          const block = val.slice(ls, end);
          const unindented = block.replace(/^(?: {1,2}|\t)/gm, '');
          const removed = block.length - unindented.length;
          if (removed > 0) {
            this.ta.setRangeText(unindented, ls, end, 'select');
            this.ta.selectionStart = Math.max(ls, s - (val.slice(ls, s).match(/^(?: {1,2}|\t)/)?.[0].length || 0));
            this.ta.selectionEnd = end - removed;
            this.ta.dispatchEvent(new Event('input'));
          }
        } else {
          this.ta.setRangeText('  ', s, end, 'end');
          this.ta.dispatchEvent(new Event('input'));
        }
      } else if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.isComposing) {
        const s = this.ta.selectionStart, end = this.ta.selectionEnd;
        if (s === end) {
          const val = this.ta.value;
          const ls = val.lastIndexOf('\n', s - 1) + 1;
          const curLine = val.slice(ls, s);
          const indent = curLine.match(/^[ \t]*/)[0];
          const extra = /:\s*$/.test(curLine) && (this.vendor === 'doosan' || this.vendor === 'ur') ? '  ' : '';
          if (indent || extra) {
            e.preventDefault();
            this.ta.setRangeText('\n' + indent + extra, s, end, 'end');
            this.ta.dispatchEvent(new Event('input'));
          }
        }
      }
    });
    this.findInput.addEventListener('input', () => this._updateFind(true));
    this.findInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this._stepFind(e.shiftKey ? -1 : 1); }
      else if (e.key === 'Escape') { e.preventDefault(); this.closeFind(); }
    });
    el.querySelector('.ed-fn').onclick = () => this._stepFind(1);
    el.querySelector('.ed-fp').onclick = () => this._stepFind(-1);
    el.querySelector('.ed-fx').onclick = () => this.closeFind();
    this.execLine = null;
    this.errLine = null;
    this._metrics = null;
  }

  openFind() {
    this.findBar.classList.remove('hidden');
    const sel = this.ta.value.slice(this.ta.selectionStart, this.ta.selectionEnd);
    if (sel && !sel.includes('\n') && sel.length <= 80) this.findInput.value = sel;
    this.findInput.focus();
    this.findInput.select();
    this._updateFind(true);
  }
  closeFind() {
    this.findBar.classList.add('hidden');
    this.ta.focus();
  }
  _updateFind(jump) {
    const q = this.findInput.value;
    this._matches = [];
    this._matchIdx = -1;
    if (q) {
      const hay = this.ta.value.toLowerCase(), needle = q.toLowerCase();
      let i = 0;
      while ((i = hay.indexOf(needle, i)) !== -1) {
        this._matches.push(i);
        i += Math.max(1, needle.length);
      }
    }
    if (jump && this._matches.length) {
      const cur = this.ta.selectionStart;
      let idx = this._matches.findIndex((p) => p >= cur);
      if (idx < 0) idx = 0;
      this._selectMatch(idx, false);
    } else {
      this._renderFindCount();
    }
  }
  _stepFind(delta) {
    if (!this._matches.length) { this._renderFindCount(); return; }
    const n = this._matches.length;
    const next = this._matchIdx < 0 ? 0 : (this._matchIdx + delta + n) % n;
    this._selectMatch(next, false);
  }
  _selectMatch(idx, focusTa = true) {
    this._matchIdx = idx;
    const start = this._matches[idx], len = this.findInput.value.length;
    if (focusTa) this.ta.focus();
    this.ta.setSelectionRange(start, start + len);
    const line = this.ta.value.slice(0, start).split('\n').length;
    const { lh } = this._getMetrics();
    const y = (line - 1) * lh;
    if (y < this.ta.scrollTop || y > this.ta.scrollTop + this.ta.clientHeight - lh * 2) {
      this.ta.scrollTop = Math.max(0, y - this.ta.clientHeight / 3);
    }
    this.syncScroll();
    this._renderFindCount();
    this._emitCursor();
  }
  _renderFindCount() {
    const q = this.findInput.value;
    if (!q) { this.findCount.textContent = ''; return; }
    this.findCount.textContent = this._matches.length ? `${this._matchIdx + 1}/${this._matches.length}` : '0/0';
  }
  _emitCursor() {
    const pos = this.ta.selectionStart || 0;
    const before = this.ta.value.slice(0, pos);
    const nl = before.lastIndexOf('\n');
    const line = nl === -1 ? 1 : before.split('\n').length;
    const col = pos - nl;
    this.onCursor({ line, col });
  }
  _getMetrics() {
    if (!this._metrics) {
      const cs = getComputedStyle(this.ta);
      this._metrics = { lh: parseFloat(cs.lineHeight) || 19, pad: parseFloat(cs.paddingTop) || 8 };
    }
    return this._metrics;
  }

  setLanguage(vendor) { this.vendor = vendor; this.kw = new Set(KW[vendor].toUpperCase().split(/\s+/)); this.render(); }
  get text() { return this.ta.value; }
  set text(v) { this.ta.value = v; this.dirty = false; this.render(); this._emitCursor(); }

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
    // 주석 분리 (작은따옴표 문자열 및 이스케이프 처리)
    const cm = { yaskawa: "'", kawasaki: ';', hyundai: "'", abb: '!', kuka: ';', doosan: '#', ur: '#' }[v];
    const hasSingleStr = v === 'doosan' || v === 'ur';
    let code = line, comment = '';
    let quote = null;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quote) {
        if (ch === '\\' && i + 1 < line.length) { i++; continue; }
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || (hasSingleStr && ch === "'")) { quote = ch; continue; }
      if (line.startsWith(cm, i)) { code = line.slice(0, i); comment = line.slice(i); break; }
    }
    if (v === 'kawasaki' && /^\s*\.\w+/.test(code)) return `<span class="t-dir">${esc(code)}</span><span class="t-cm">${esc(comment)}</span>`;
    if (v === 'yaskawa' && /^\s*\/\/?\/?/.test(code) && code.trim().startsWith('/')) return `<span class="t-dir">${esc(code)}</span>`;
    if (v === 'kuka' && /^\s*&/.test(code)) return `<span class="t-dir">${esc(code)}</span>`;
    const re = hasSingleStr
      ? /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(\$?[A-Za-z_#][\w#$%!]*)|(-?\b\d+\.?\d*(?:[eE][+-]?\d+)?\b)|([^"'\w$#]+)/g
      : /("(?:\\.|[^"\\])*")|(\$?[A-Za-z_#][\w#$%!]*)|(-?\b\d+\.?\d*(?:[eE][+-]?\d+)?\b)|([^"\w$#]+)/g;
    const out = code.replace(re, (m, str, id, num, other) => {
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
    const { lh, pad } = this._getMetrics();
    bar.style.display = 'block';
    bar.style.top = `${pad + (line - 1) * lh - this.ta.scrollTop}px`;
    bar.style.height = `${lh}px`;
  }

  setExecLine(line, scroll = true) {
    if (line === this.execLine) return;
    this.execLine = line;
    this.placeBar(this.execBar, line);
    if (line && scroll) {
      const { lh } = this._getMetrics();
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

  setErrLine(line) {
    if (line === this.errLine) return;
    this.errLine = line;
    this.placeBar(this.errBar, line);
  }
}
