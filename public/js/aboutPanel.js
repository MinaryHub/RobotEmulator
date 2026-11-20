// 정보 창: 버전 · 업데이트 확인/적용 · 문의하기(GitHub 이슈) · 후원하기
//  서버 상태는 init/about 메시지의 about 객체 (server/updater.js info())
import { escHtml } from './ioLabels.js';

const $ = (s) => document.querySelector(s);
let about = null;
let loaded = null;          // 이 페이지를 처음 불러왔을 때의 서버 빌드 (버전+커밋)
let ctx = null;             // { cmd, run, getState, isDirty, showToast }

const fmtDate = (t) => (t ? new Date(t).toLocaleString() : '');

// 환경 정보 (이슈 본문에 미리 채움 — 개인 정보 없음)
function envText() {
  const st = ctx.getState();
  return [
    `- 버전: v${about?.version ?? '?'}${about?.commit ? ` (${about.commit}${about.branch ? `, ${about.branch}` : ''})` : ''}`,
    `- 설치: ${about?.install === 'git' ? 'git clone' : '압축 파일'}`,
    `- 서버: ${about?.platform ?? '?'}, Node.js ${about?.node ?? '?'}`,
    `- 브라우저: ${navigator.userAgent}`,
    st ? `- 로봇: ${st.robotId} (${st.vendor}), 모드 ${st.mode}` : null,
  ].filter(Boolean).join('\n');
}
function issueUrl(template, title) {
  const base = about?.links?.issues;
  if (!base) return null;
  const q = new URLSearchParams({ template, title, env: envText() });
  return `${base}/new?${q}`;
}
const setLink = (el, href) => { el.hidden = !href; if (href) el.href = href; };

function render() {
  if (!about) return;
  const u = about.update || {};
  $('#abVer').textContent = `v${about.version}`;
  $('#abBuild').textContent = [about.commit && `커밋 ${about.commit}${about.branch ? ` (${about.branch})` : ''}`, about.install === 'git' ? 'git clone 설치' : '압축 파일 설치', `Node.js ${about.node}`].filter(Boolean).join(' · ');
  const L = about.links || {};
  let html;
  if (u.applying) html = `⏳ ${escHtml(u.applying)}`;
  else if (u.restartNeeded) html = `<span class="new">${escHtml(u.restartNeeded)} 설치됨</span> — 서버를 다시 시작하세요`;
  else if (u.available && u.latest) html = `<span class="new">새 버전 v${escHtml(u.latest.version)}</span> (${escHtml(fmtDate(u.latest.publishedAt))}) — 현재 v${escHtml(about.version)}`;
  else if (u.error) html = `<span class="err">${escHtml(u.error)}</span>`;
  else if (u.note) html = `<span class="dim">${escHtml(u.note)} (확인: ${escHtml(fmtDate(u.checkedAt))})</span>`;
  else if (u.checkedAt) html = `최신 버전입니다 (확인: ${escHtml(fmtDate(u.checkedAt))})`;
  else html = u.autoCheck ? '확인 대기 중…' : '자동 확인이 꺼져 있습니다';
  if (u.error && u.available) html += `<br><span class="err">${escHtml(u.error)}</span>`;
  $('#abUpd').innerHTML = html;
  const notes = u.available && u.latest?.notes;
  $('#abNotes').hidden = !notes;
  $('#abNotes').textContent = notes || '';
  $('#abApply').hidden = !(u.available && !u.restartNeeded);
  $('#abApply').disabled = !!u.applying;
  setLink($('#abRelease'), u.latest?.url || L.releases);
  setLink($('#abChangelog'), L.changelog);
  setLink($('#abIssues'), L.issues);
  setLink($('#abBug'), issueUrl('bug_report.yml', '[버그] '));
  setLink($('#abIdea'), issueUrl('feature_request.yml', '[제안] '));
  $('#abSponsorSec').hidden = !L.sponsor;
  setLink($('#abSponsor'), L.sponsor);
  const b = $('#btnUpdate');
  b.classList.toggle('hidden', !(u.available && u.latest));
  if (u.available && u.latest) b.textContent = u.applying ? '⏳ 업데이트 중' : `⬆ v${u.latest.version}`;
}

export function initAboutPanel(c) {
  ctx = c;
  const dlg = $('#aboutDlg');
  const open = () => { render(); dlg.showModal(); };
  $('#btnAbout').onclick = open;
  $('#btnUpdate').onclick = open;
  $('#abCheck').onclick = async () => {
    $('#abCheck').disabled = true;
    $('#abUpd').textContent = '확인 중…';
    try { const r = await ctx.cmd('updateCheck'); onAbout(r.about); } catch { render(); } finally { $('#abCheck').disabled = false; }
  };
  $('#abApply').onclick = async () => {
    const v = about?.update?.latest?.version;
    if (!confirm(`v${v} 으로 업데이트하고 서버를 다시 시작합니다.\n\n· 진행 중인 통신 연결이 끊깁니다\n· 작업 내용은 자동 저장되어 재시작 후 복원됩니다\n\n계속할까요?`)) return;
    if (ctx.isDirty()) await ctx.saveAll().catch(() => {});
    try { await ctx.cmd('updateApply'); } catch { /* 사유는 cmd 가 알림으로 표시 */ }
  };
}

// 서버 about 상태 반영 (init · about 브로드캐스트)
export function onAbout(a, { fromInit = false } = {}) {
  if (!a) return;
  about = a;
  const build = `${a.version}|${a.commit ?? ''}`;
  if (fromInit) {
    if (loaded && loaded !== build) {
      // 서버가 새 버전으로 재시작됨 → 화면 코드도 새로 불러와야 함
      if (!ctx.isDirty()) { location.reload(); return; }
      ctx.showToast(`<b>v${escHtml(a.version)} 으로 업데이트되었습니다</b> — 저장하지 않은 편집을 저장한 뒤 새로고침(F5)하세요`, 'ok');
    }
    loaded ??= build;
  }
  render();
}

export function onRestarting(tag) {
  ctx.showToast(`<b>${escHtml(tag)} 설치 완료</b> — 서버를 다시 시작하는 중입니다. 잠시 후 자동으로 다시 연결됩니다`, 'ok');
}
