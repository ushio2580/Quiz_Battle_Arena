import { io } from 'socket.io-client';
import * as XLSX from 'xlsx';
import { startArena, pressDash, pressAbility } from './game.js';
import './style.css';

const app=document.querySelector('#app');
const characters=[['bot','Basic Bot'],['ninja','Cyber Ninja'],['explorer','Space Explorer'],['knight','Star Knight'],['alien','Alien'],['warrior','Mech Warrior'],['mage','Energy Mage'],['pixel','Pixel Survivor']];
const colors=['#ff657f','#5bb6ff','#ffc857','#69e4a5'];
let host=null,socket=null,activeRoom=null,playerPublicId=null,playerId=null,activeQuiz=null,arena=null,gameState=null,questionData=null,activeMatchId=null,currentView='home',hostMode='quizzes',roomTimer=null,featuredMatch=null,previewState=new Map(),bracketData=null,analyticsData=null,quizCache=[];
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const $=(sel,root=document)=>root.querySelector(sel);
const $$=(sel,root=document)=>[...root.querySelectorAll(sel)];
const fmtTime=ms=>`${Math.max(0,Math.ceil(ms/1000))}s`;
function toast(message,type='info'){let el=$('.toast');if(!el){el=document.createElement('div');el.className='toast';document.body.append(el);}el.textContent=message;el.dataset.type=type;el.classList.add('show');clearTimeout(el.hideTimer);el.hideTimer=setTimeout(()=>el.classList.remove('show'),3600);}
async function api(url,options={}){
  const response=await fetch(url,{credentials:'same-origin',headers:{'Content-Type':'application/json',...(options.headers||{})},...options});
  const data=response.status===204?null:await response.json().catch(()=>({error:'The server returned an unreadable response.'}));
  if(!response.ok){const message=data?.error||`Request failed (${response.status}).`;const error=new Error(data?.errorId?`${message} (ref. ${data.errorId})`:message);error.details=data?.details;error.errorId=data?.errorId;throw error;}
  return data;
}
function showError(form,error){const box=$('.form-error',form);if(box)box.innerHTML=`${esc(error.message)}${error.details?.length?`<ul>${error.details.map(x=>`<li>${esc(x)}</li>`).join('')}</ul>`:''}`;else toast(error.message,'error');}
function download(name,content,type='application/json'){
  const blob=new Blob([content],{type});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function setRoute(path){history.pushState({},'',path);renderRoute();}
window.addEventListener('popstate',renderRoute);

async function renderRoute(){
  const path=location.pathname;
  if(path.startsWith('/join/'))return renderJoin(path.split('/')[2]);
  if(path==='/game')return recoverPlayer();
  try{const data=await api('/api/me');host={...data.host,displayName:data.host.displayName||data.host.display_name};return renderDashboard();}
  catch{host=null;return renderLanding();}
}
function brand(){return `<a class="brand" href="/" data-nav="/"><span class="brand-icon">Q<span>✦</span></span><span>QUIZ BATTLE <b>ARENA</b></span></a>`;}

function renderLanding(){
  disconnectSocket();currentView='landing';
  app.innerHTML=`<main class="landing-shell"><nav class="topbar">${brand()}<div class="top-actions"><a class="text-link" href="#how">How it works</a><button class="btn btn-quiet" data-action="login">Host sign in</button><button class="btn btn-primary" data-action="register">Create a host account <span>↗</span></button></div></nav>
  <section class="hero"><div class="hero-copy"><div class="eyebrow"><i></i> THE CLASSROOM, REIMAGINED</div><h1>Knowledge is your<br><span>ultimate power.</span></h1><p>Race through a living arena, dodge the swarm, and move to the right answer. Learning gets a little more legendary.</p><div class="hero-actions"><button class="btn btn-primary btn-large" data-action="register">Build your first battle <span>→</span></button><a class="btn btn-glass btn-large" href="#how">See how it works</a></div><div class="hero-proof"><div class="avatar-stack"><i>✦</i><i>◈</i><i>✧</i><i>+</i></div><span>Made for curious minds<br><b>Built for classrooms</b></span></div></div>
  <div class="hero-art" aria-label="Neon robot in an arena"><div class="orbit orbit-one"></div><div class="orbit orbit-two"></div><div class="battle-badge badge-top"><span>✦</span> KNOWLEDGE + SKILL</div><div class="robot"><div class="antenna"></div><div class="robot-head"><i></i><i></i><b></b></div><div class="robot-body"><span>Q</span></div><div class="robot-arm arm-left"></div><div class="robot-arm arm-right"></div><div class="robot-leg leg-left"></div><div class="robot-leg leg-right"></div></div><div class="art-spark spark-a">✦</div><div class="art-spark spark-b">✧</div><div class="battle-badge badge-bottom"><span class="live-dot"></span> LIVE ARENA</div><div class="art-platform"></div></div></section>
  <section class="join-strip"><div><span class="mini-icon">⌁</span><b>Joining a battle?</b><span>Enter your room code to jump in.</span></div><form id="quick-join"><input name="code" inputmode="numeric" maxlength="6" placeholder="6-digit code" aria-label="Room code" required><button class="btn btn-dark">Join room <span>→</span></button></form></section>
  <section class="how-section" id="how"><div class="eyebrow">READY, SET, LEARN</div><h2>Three steps to the arena</h2><div class="steps-grid"><article><span>01</span><h3>Make it yours</h3><p>Build a quiz from scratch or start with the editable 30-question starter pack.</p></article><article><span>02</span><h3>Bring your crew</h3><p>Share a room code, link, or real QR code. No student accounts or downloads.</p></article><article><span>03</span><h3>Move to answer</h3><p>Race through a live survival arena. Knowledge gives you the edge to advance.</p></article></div></section>
  <footer class="landing-footer">${brand()}<span>Learn loud. Play fair. ✦</span></footer></main>`;
}

function renderAuth(mode='login'){
  currentView='auth';
  app.innerHTML=`<main class="auth-shell"><aside class="auth-art"><div class="auth-orb orb-a"></div><div class="auth-orb orb-b"></div>${brand()}<div class="auth-quote"><span>✦</span><h2>Every great answer<br>starts with a brave move.</h2><p>Turn your next lesson into a tournament students will talk about.</p></div><div class="auth-foot">QUIZ BATTLE ARENA <span>·</span> LEARN / PLAY / LEVEL UP</div></aside><section class="auth-main"><button class="back-link" data-action="home">← Back home</button><div class="auth-card"><div class="eyebrow">HOST PORTAL</div><h1>${mode==='login'?'Welcome back':'Start your arena'}</h1><p>${mode==='login'?'Sign in to manage your quizzes and tournaments.':'Create a teacher account. Students join with a nickname only.'}</p><div class="auth-tabs"><button class="${mode==='login'?'selected':''}" data-action="login">Sign in</button><button class="${mode==='register'?'selected':''}" data-action="register">Create account</button></div><form id="auth-form" class="stack-form">${mode==='register'?`<label>Display name<input name="displayName" autocomplete="name" placeholder="Alex Teacher" required maxlength="60"></label>`:''}<label>Email address<input name="email" type="email" autocomplete="email" placeholder="you@school.edu" required></label><label>Password<input name="password" type="password" autocomplete="${mode==='login'?'current-password':'new-password'}" minlength="10" placeholder="At least 10 characters" required></label><div class="form-error" role="alert"></div><button class="btn btn-primary btn-full">${mode==='login'?'Sign in to dashboard':'Create host account'} <span>→</span></button></form><div class="privacy-note">🔒 Student players do not need accounts or personal details.</div></div></section></main>`;
  $('#auth-form').addEventListener('submit',async e=>{
    e.preventDefault();const form=e.currentTarget;const values=Object.fromEntries(new FormData(form));const endpoint=mode==='login'?'/api/auth/login':'/api/auth/register';
    try{host=await api(endpoint,{method:'POST',body:JSON.stringify(values)});await renderDashboard();}
    catch(error){showError(form,error);}
  });
}

async function renderDashboard(tab=hostMode){
  if(!host){try{host=(await api('/api/me')).host;}catch{return renderLanding();}}
  currentView='dashboard';hostMode=tab;
  const queries=[api('/api/quizzes'),api('/api/results'),api('/api/analytics'),api('/api/tournaments')];
  const [quizzes,results,analytics,rooms]=await Promise.all(queries.map(p=>p.catch(()=>[])));
  quizCache=Array.isArray(quizzes)?quizzes:[];analyticsData=analytics?.questionStats?analytics:null;
  app.innerHTML=`<div class="dashboard-shell"><aside class="sidebar">${brand()}<div class="side-label">WORKSPACE</div><button class="side-link ${tab==='quizzes'?'active':''}" data-tab="quizzes"><span>▦</span> My quizzes</button><button class="side-link ${tab==='rooms'?'active':''}" data-tab="rooms"><span>⌁</span> New tournament</button><button class="side-link ${tab==='analytics'?'active':''}" data-tab="analytics"><span>◔</span> Learning results</button><div class="sidebar-bottom"><button class="side-link" data-action="accessibility"><span>⚙</span> Display settings</button><div class="host-profile"><div class="profile-avatar">${esc((host.displayName||host.email||'H')[0].toUpperCase())}</div><div><b>${esc(host.displayName||'Host')}</b><small>${esc(host.email||'')}</small></div><button class="icon-button" aria-label="Sign out" title="Sign out" data-action="logout">↗</button></div></div></aside><main class="dash-main"><header class="dash-header"><div><div class="eyebrow">${tab==='rooms'?'TOURNAMENT SETUP':tab==='analytics'?'CLASSROOM INSIGHTS':'YOUR TEACHING HUB'}</div><h1>${tab==='rooms'?'Set up a new tournament':tab==='analytics'?'Learning results':'Good day, '+esc((host.displayName||'Teacher').split(' ')[0])+' ✦'}</h1></div><div class="header-actions"><button class="btn btn-quiet" data-action="logout">Sign out</button>${tab==='quizzes'?'<button class="btn btn-primary" data-action="new-quiz">＋ New quiz</button>':''}</div></header>${rooms?.length?`<section class="active-rooms panel"><div class="panel-heading"><div><div class="eyebrow">ROOMS YOU CAN REJOIN</div><h2>Live tournaments</h2></div></div><div class="active-room-list">${rooms.map(room=>`<div class="active-room-row"><div><b>${esc(room.quizTitle)} · ${esc(room.roomCode)}</b><small>${room.connectedCount} connected · ${room.playerCount} total · ${esc(room.status)}</small></div><button class="btn btn-outline btn-small" data-action="open-room" data-id="${esc(room.publicId)}">Open host controls →</button></div>`).join('')}</div></section>`:''}<section id="dash-content">${tab==='quizzes'?renderQuizLibrary(quizCache):tab==='rooms'?renderRoomSetup(quizCache):renderAnalytics(results,analyticsData)}</section></main></div><div id="modal-root"></div>`;
  bindDashboard(tab,results);
}
function renderQuizLibrary(quizzes){
  return `<div class="library-intro"><div><h2>Your quiz library</h2><p>Build reusable question sets. Edits save to your account and never change a live match.</p></div><label class="search-box"><span>⌕</span><input id="quiz-search" placeholder="Search your quizzes" aria-label="Search quizzes"></label></div><div class="quiz-grid" id="quiz-grid">${quizzes.length?quizzes.map((q,i)=>`<article class="quiz-card" data-title="${esc(q.title.toLowerCase())}"><div class="quiz-card-top"><span class="quiz-symbol sym-${i%4}">${['✦','◈','⌘','✧'][i%4]}</span><button class="icon-button more-button" data-action="quiz-menu" data-id="${q.id}" aria-label="More quiz actions">•••</button></div><h3>${esc(q.title)}</h3><p>${esc(q.description||'A ready-to-play question set.')}</p><div class="quiz-meta"><span>▤ ${q.question_count} questions</span><span>Updated ${new Date(q.updated_at).toLocaleDateString()}</span></div><div class="quiz-actions"><button class="btn btn-outline" data-action="edit-quiz" data-id="${q.id}">Edit quiz</button><button class="btn btn-dark" data-action="use-quiz" data-id="${q.id}">Create battle →</button></div><div class="quiz-menu hidden" id="quiz-menu-${q.id}"><button data-action="duplicate-quiz" data-id="${q.id}">Duplicate</button><button data-action="export-quiz" data-id="${q.id}">Export JSON</button><button data-action="delete-quiz" data-id="${q.id}" class="danger-text">Delete</button></div></article>`).join(''):`<div class="empty-state"><span>✦</span><h3>Your first quiz is waiting</h3><p>Create one yourself or start with the editable 30-question general knowledge set.</p><button class="btn btn-primary" data-action="new-quiz">Create a quiz</button></div>`}</div>`;
}
function renderRoomSetup(quizzes){
  if(!quizzes.length)return `<div class="empty-state"><span>⌁</span><h3>Choose a quiz first</h3><p>Create a question set before opening a tournament room.</p><button class="btn btn-primary" data-action="new-quiz">Create a quiz →</button></div>`;
  return `<div class="setup-grid"><form id="room-form" class="panel setup-form"><div class="panel-heading"><div><div class="eyebrow">THE BASICS</div><h2>Build your battle</h2></div><span class="step-pill">01 / 02</span></div>
  <label>Question set<select name="quizId" required>${quizzes.map(q=>`<option value="${q.id}">${esc(q.title)} · ${q.question_count} questions</option>`).join('')}</select></label>
  <div class="setting-row"><label>Players<input type="number" name="maxPlayers" value="32" min="2" max="100"></label><label>Questions per match<input type="number" name="questionsPerMatch" value="3" min="1" max="30"></label></div>
  <div class="setting-row"><label>Match answer time<input type="number" name="answerSeconds" value="25" min="5" max="120"><small>used when match-wide timing is selected</small></label><label>Reading phase<input type="number" name="readingSeconds" value="3" min="0" max="15"><small>seconds before hazards</small></label></div>
  <div class="setting-row"><label>Feedback time<input type="number" name="feedbackSeconds" value="5" min="2" max="20"></label><label>Rule preset<select name="rulePreset"><option value="educational">Educational · classroom friendly</option><option value="arcade">Arcade · higher danger</option></select></label></div>
  <div class="setting-row"><label>Starting HP<input type="number" name="startingHp" value="100" min="20" max="300"></label><label>Correct answer healing<input type="number" name="correctHealing" value="10" min="0" max="100"></label></div>
  <div class="setting-row"><label>Wrong answer damage<input type="number" name="wrongDamage" value="25" min="0" max="100"></label><label>Unanswered damage<input type="number" name="unansweredDamage" value="20" min="0" max="100"></label></div>
  <div class="setting-row"><label>Enemy damage<input type="number" name="enemyDamage" value="5" min="0" max="40"></label><label>Enemy spawn interval<input type="number" name="enemySpawnMs" value="3800" min="1000" max="15000"><small>milliseconds</small></label></div>
  <div class="setting-row"><label>Question time source<select name="timeMode"><option value="question">Use each question’s time</option><option value="match">Use match answer time</option></select></label><label>Wrong damage source<select name="damageMode"><option value="question">Use each question’s damage</option><option value="match">Use tournament damage</option></select></label></div>
  <div class="setting-row"><label>Correct reward source<select name="rewardMode"><option value="question">Use each question’s reward</option><option value="match">Use tournament healing</option></select></label><label>Round transition<input type="number" name="restSeconds" value="5" min="2" max="30"><small>seconds between rounds</small></label></div>
  <label class="check-row"><input type="checkbox" name="antiCopy" checked><span><b>Anti-copy mode</b><small>Hide rival movement near answer zones and use independent layouts.</small></span></label>
  <label class="check-row"><input type="checkbox" name="randomQuestions" checked><span><b>Randomize question order</b><small>Each round shares equivalent questions.</small></span></label>
  <label class="check-row"><input type="checkbox" name="randomAnswers" checked><span><b>Randomize answer positions</b><small>Every match in a round receives the same answer order.</small></span></label>
  <div class="duration-estimate" id="duration-estimate"><span>◷</span><span><b>Estimated tournament</b><small>Based on your roster and settings</small></span><strong>~ 8 min</strong></div><div class="form-error" role="alert"></div><button class="btn btn-primary btn-full">Create room & show QR <span>→</span></button></form>
  <aside class="setup-aside"><div class="preset-card"><div class="eyebrow">CLASSROOM PICK</div><h3>Educational mode</h3><p>Environmental damage can’t eliminate a student. Knowledge decides who advances, and the tournament champion is kept separate from the academic ranking.</p><div class="preset-tags"><span>✓ No environmental knockouts</span><span>✓ Full health each round</span><span>✓ Real time sync</span></div></div><div class="setup-note"><span>✦</span><p><b>Small but mighty.</b> This first arena mode supports real 1v1 survival matches and automatic single-elimination brackets.</p></div><div class="setup-note"><span>◈</span><p><b>Quiz snapshot.</b> Starting a tournament freezes a private copy of these questions for every active match.</p></div></aside></div>`;
}
function renderAnalytics(results,data){
  const items=Array.isArray(results)?results:[];const qstats=data?.questionStats||[];const students=data?.students||[];
  return `<div class="metrics-grid"><article class="metric-card"><span>ATTEMPTS</span><b>${data?.totalAttempts||0}</b><small>Across saved tournaments</small></article><article class="metric-card"><span>CLASS ACCURACY</span><b>${data?.accuracy??0}%</b><small>${data?.correct||0} correct responses</small></article><article class="metric-card"><span>AVG RESPONSE</span><b>${data?.averageResponseMs?`${(data.averageResponseMs/1000).toFixed(1)}s`:'—'}</b><small>Correct and missed answers</small></article><article class="metric-card"><span>TOURNAMENTS</span><b>${items.length}</b><small>Completed, active, or interrupted</small></article></div><div class="analytics-columns"><section class="panel"><div class="panel-heading"><div><div class="eyebrow">REVIEW OPPORTUNITIES</div><h2>Most missed questions</h2></div></div>${qstats.length?`<div class="table-wrap"><table><thead><tr><th>Question</th><th>Accuracy</th><th>Attempts</th></tr></thead><tbody>${qstats.slice(0,12).map(q=>`<tr><td>${esc(q.question)}<small>${esc(q.roomCode||'')}</small></td><td><span class="accuracy-chip ${q.accuracy<50?'low':''}">${q.accuracy}%</span></td><td>${q.total}</td></tr>`).join('')}</tbody></table></div>`:`<div class="empty-inline">Completed matches will add classroom question insights here.</div>`}</section><section class="panel"><div class="panel-heading"><div><div class="eyebrow">EDUCATIONAL RANKING</div><h2>Student results</h2></div></div>${students.length?`<div class="student-list">${students.slice(0,14).map(p=>`<div class="student-row"><span class="rank-no">${p.placement||'·'}</span><b>${esc(p.nickname)}</b><small>${p.stats.correct||0} correct · ${p.stats.accuracy||0}% accuracy</small></div>`).join('')}</div>`:`<div class="empty-inline">Students’ academic and game rankings appear separately here.</div>`}</section></div><section class="panel results-panel"><div class="panel-heading"><div><div class="eyebrow">TOURNAMENT HISTORY</div><h2>Recent rooms</h2></div><button class="btn btn-outline btn-small" data-action="refresh-results">Refresh results</button></div>${items.length?`<div class="table-wrap"><table><thead><tr><th>Room</th><th>Quiz</th><th>Status</th><th>Winner</th><th>Export</th></tr></thead><tbody>${items.map(t=>`<tr><td>${esc(t.room_code)}</td><td>${esc(t.quiz_title)}</td><td><span class="status-chip">${esc(t.status)}</span></td><td>${esc(t.results?.champion?.nickname||(t.status==='interrupted'?'Interrupted':'No champion'))}</td><td><button class="text-button" data-action="export-results" data-id="${t.id}">CSV ↓</button></td></tr>`).join('')}</tbody></table></div>`:`<div class="empty-inline">No tournaments yet. Create a room to get started.</div>`}</section>`;
}

function bindDashboard(tab,results){
  $$('[data-tab]').forEach(button=>button.addEventListener('click',()=>renderDashboard(button.dataset.tab)));
  $('#quiz-search')?.addEventListener('input',e=>$$('.quiz-card').forEach(card=>card.classList.toggle('hidden',!card.dataset.title.includes(e.target.value.toLowerCase()))));
  $('#room-form')?.addEventListener('input',updateEstimate);$('#room-form')?.addEventListener('change',updateEstimate);updateEstimate();
  $('#room-form')?.addEventListener('submit',createRoom);
  $('.dash-main')?.addEventListener('click',handleDashboardClick);
}
function updateEstimate(){
  const f=$('#room-form');if(!f)return;const count=Number(f.maxPlayers.value)||2,q=Number(f.questionsPerMatch.value)||1,answer=Number(f.answerSeconds.value)||25,read=Number(f.readingSeconds.value)||0,feedback=Number(f.feedbackSeconds.value)||0;
  const rounds=Math.ceil(Math.log2(Math.max(2,count)));const mins=Math.max(2,Math.round((rounds*q*(answer+read+feedback+2)+Math.max(0,rounds-1)*5)/60));$('#duration-estimate strong').textContent=`~ ${mins} min`;
}
async function createRoom(event){
  event.preventDefault();const form=event.currentTarget;const values=Object.fromEntries(new FormData(form));const body={quizId:values.quizId,settings:{maxPlayers:Number(values.maxPlayers),questionsPerMatch:Number(values.questionsPerMatch),answerSeconds:Number(values.answerSeconds),readingSeconds:Number(values.readingSeconds),feedbackSeconds:Number(values.feedbackSeconds),startingHp:Number(values.startingHp),correctHealing:Number(values.correctHealing),wrongDamage:Number(values.wrongDamage),unansweredDamage:Number(values.unansweredDamage),enemyDamage:Number(values.enemyDamage),enemySpawnMs:Number(values.enemySpawnMs),restSeconds:Number(values.restSeconds),rulePreset:values.rulePreset,timeMode:values.timeMode,damageMode:values.damageMode,rewardMode:values.rewardMode,antiCopy:form.antiCopy.checked,randomQuestions:form.randomQuestions.checked,randomAnswers:form.randomAnswers.checked}};
  try{const room=await api('/api/tournaments',{method:'POST',body:JSON.stringify(body)});activeRoom=room;await renderHostLobby(room.publicId);}
  catch(error){showError(form,error);}
}
async function handleDashboardClick(event){
  const button=event.target.closest('[data-action]');if(!button)return;const {action,id}=button.dataset;
  if(action==='new-quiz')return openEditor(null);
  if(action==='open-room')return renderHostLobby(id);
  if(action==='edit-quiz')return openEditor(id);
  if(action==='use-quiz'){hostMode='rooms';await renderDashboard('rooms');const select=$('[name="quizId"]');if(select)select.value=id;return;}
  if(action==='quiz-menu'){const menu=$(`#quiz-menu-${CSS.escape(id)}`);$$('.quiz-menu').forEach(m=>m.classList.add('hidden'));menu?.classList.toggle('hidden');return;}
  if(action==='duplicate-quiz'){try{await api(`/api/quizzes/${id}/duplicate`,{method:'POST'});toast('Quiz duplicated.');renderDashboard('quizzes');}catch(e){toast(e.message,'error');}return;}
  if(action==='delete-quiz'){if(!confirm('Delete this quiz and all of its questions?'))return;try{await api(`/api/quizzes/${id}`,{method:'DELETE'});toast('Quiz deleted.');renderDashboard('quizzes');}catch(e){toast(e.message,'error');}return;}
  if(action==='export-quiz'){try{const q=await api(`/api/quizzes/${id}`);download(`${q.title.replace(/[^\p{L}\p{N}-]+/gu,'-')}.json`,JSON.stringify({title:q.title,description:q.description,questions:q.questions},null,2));}catch(e){toast(e.message,'error');}return;}
  if(action==='refresh-results')return renderDashboard('analytics');
  if(action==='export-results'){const link=document.createElement('a');link.href=`/api/results/${id}/export.csv`;link.click();return;}
}

async function openEditor(id){
  let quiz={title:'Untitled quiz',description:'',questions:[blankQuestion()]};
  if(id){try{const data=await api(`/api/quizzes/${id}`);quiz={id:data.id,title:data.title,description:data.description,questions:data.questions};}catch(e){toast(e.message,'error');return;}}
  activeQuiz=structuredClone(quiz);renderEditor();
}
function blankQuestion(){return{id:crypto.randomUUID(),question:'',answers:['','','',''],correctAnswerIndex:0,timeLimit:25,difficulty:'medium',wrongAnswerDamage:25,correctAnswerReward:10,explanation:'',image:null};}
function renderEditor(importErrors=[]){
  const q=activeQuiz;
  $('#modal-root').innerHTML=`<div class="modal-backdrop" data-close-modal><section class="editor-modal" role="dialog" aria-modal="true" aria-label="Quiz editor"><header class="editor-header"><div>${brand()}<span class="editor-label">QUIZ EDITOR</span></div><button class="icon-button" data-editor-action="close" aria-label="Close editor">×</button></header><div class="editor-body"><aside class="editor-sidebar"><div class="eyebrow">QUESTION LIST <span>${q.questions.length}</span></div><div id="question-nav" class="question-nav">${q.questions.map((item,i)=>`<button class="question-nav-item ${i===0?'selected':''}" data-editor-action="focus-question" data-index="${i}"><span>${String(i+1).padStart(2,'0')}</span><b>${esc(item.question||'New question')}</b></button>`).join('')}</div><button class="btn btn-outline btn-full" data-editor-action="add-question">＋ Add question</button><button class="btn btn-quiet btn-full" data-editor-action="import">⇧ Import CSV / Excel / JSON</button><input type="file" id="quiz-import" accept=".csv,.xlsx,.xls,.json,application/json,text/csv" hidden><button class="btn btn-quiet btn-full" data-editor-action="preview">▷ Preview quiz</button></aside><main class="question-editor"><div class="editor-title"><div><div class="eyebrow">YOUR QUESTION SET</div><h1>${q.id?'Edit quiz':'Create quiz'}</h1></div><div class="editor-save-status">● Changes save when you click save</div></div><label>Quiz title<input id="quiz-title" value="${esc(q.title)}" maxlength="120" placeholder="e.g. Fractions & decimals"></label><label>Description<textarea id="quiz-description" rows="2" placeholder="What will students learn?">${esc(q.description)}</textarea></label>${importErrors.length?`<div class="import-errors"><b>Some rows need attention before you save:</b><ul>${importErrors.map(x=>`<li>${esc(x)}</li>`).join('')}</ul></div>`:''}<div id="question-cards">${q.questions.map((item,i)=>questionCard(item,i)).join('')}</div><button class="btn btn-outline add-question-wide" data-editor-action="add-question">＋ Add another question</button><div class="editor-bottom"><button class="btn btn-quiet" data-editor-action="close">Cancel</button><button class="btn btn-primary" data-editor-action="save">Save quiz <span>✓</span></button></div></main></div></section></div>`;
  $('.modal-backdrop').addEventListener('click',e=>{if(e.target===e.currentTarget)closeEditor();});
  $('.editor-modal').addEventListener('click',handleEditorClick);
  $('#question-cards').addEventListener('input',e=>syncEditorFromDom());
  $('#quiz-import').addEventListener('change',importFile);
}
function questionCard(q,index){
  const activeAnswers=(q.answers||[]).map((a,i)=>({a,i}));
  return `<article class="question-card" id="question-card-${index}" data-index="${index}"><div class="question-card-heading"><span>QUESTION ${String(index+1).padStart(2,'0')}</span><div><button class="icon-button" title="Move up" data-editor-action="move-question" data-index="${index}" data-delta="-1" ${index===0?'disabled':''}>↑</button><button class="icon-button" title="Move down" data-editor-action="move-question" data-index="${index}" data-delta="1" ${index===activeQuiz.questions.length-1?'disabled':''}>↓</button><button class="icon-button danger-text" title="Delete question" data-editor-action="delete-question" data-index="${index}">×</button></div></div><label>Question text<textarea data-field="question" rows="2" placeholder="Write your question">${esc(q.question)}</textarea></label><div class="answer-editor-heading"><b>Answer choices</b><small>Select the correct answer</small></div><div class="answer-options">${activeAnswers.map(({a,i})=>`<div class="answer-option-row"><label class="answer-radio" title="Mark correct"><input type="radio" name="correct-${index}" value="${i}" ${i===q.correctAnswerIndex?'checked':''}><span>${'ABCD'[i]}</span></label><input class="answer-input" data-answer-index="${i}" value="${esc(a)}" maxlength="300" placeholder="Answer ${i+1}"><button class="icon-button remove-answer" data-editor-action="remove-answer" data-index="${index}" data-answer="${i}" title="Remove option" ${activeAnswers.length<=2?'disabled':''}>×</button></div>`).join('')}</div>${activeAnswers.length<4?`<button class="text-button add-answer" data-editor-action="add-answer" data-index="${index}">＋ Add answer option</button>`:''}<div class="setting-row question-settings"><label>Time limit (seconds)<input type="number" data-field="timeLimit" min="5" max="180" value="${q.timeLimit||25}"></label><label>Difficulty<select data-field="difficulty"><option ${q.difficulty==='easy'?'selected':''}>easy</option><option ${q.difficulty==='medium'?'selected':''}>medium</option><option ${q.difficulty==='hard'?'selected':''}>hard</option></select></label><label>Wrong-answer damage<input type="number" data-field="wrongAnswerDamage" min="0" max="100" value="${q.wrongAnswerDamage??25}"></label><label>Correct-answer reward<input type="number" data-field="correctAnswerReward" min="0" max="100" value="${q.correctAnswerReward??10}"></label></div><label>Explanation after reveal<textarea data-field="explanation" rows="2" placeholder="Add a helpful explanation (optional)">${esc(q.explanation)}</textarea></label><label>Image URL <span class="optional">optional</span><input data-field="image" value="${esc(q.image||'')}" placeholder="https://…"></label></article>`;
}
function syncEditorFromDom(){
  if(!activeQuiz)return;
  if($('#quiz-title'))activeQuiz.title=$('#quiz-title').value;
  if($('#quiz-description'))activeQuiz.description=$('#quiz-description').value;
  $$('.question-card').forEach(card=>{const i=Number(card.dataset.index),q=activeQuiz.questions[i];if(!q)return;
    q.question=$('[data-field="question"]',card).value;q.timeLimit=Number($('[data-field="timeLimit"]',card).value);q.difficulty=$('[data-field="difficulty"]',card).value;q.wrongAnswerDamage=Number($('[data-field="wrongAnswerDamage"]',card).value);q.correctAnswerReward=Number($('[data-field="correctAnswerReward"]',card).value);q.explanation=$('[data-field="explanation"]',card).value;q.image=$('[data-field="image"]',card).value||null;
    q.answers=$$('.answer-input',card).map(input=>input.value);q.correctAnswerIndex=Number($(`input[name="correct-${i}"]:checked`,card)?.value||0);
  });
  $$('.question-nav-item').forEach((button,i)=>{const name=$('b',button);if(name)name.textContent=activeQuiz.questions[i]?.question||'New question';});
}
function rerenderEditorKeepFocus(index=0){syncEditorFromDom();renderEditor();const card=$(`#question-card-${index}`);card?.scrollIntoView({block:'center',behavior:'smooth'});$(`.question-nav-item[data-index="${index}"]`)?.classList.add('selected');}
async function handleEditorClick(event){
  const button=event.target.closest('[data-editor-action]');if(!button)return;const action=button.dataset.editorAction;syncEditorFromDom();const i=Number(button.dataset.index||0);
  if(action==='close')return closeEditor();
  if(action==='add-question'){activeQuiz.questions.push(blankQuestion());renderEditor();$(`#question-card-${activeQuiz.questions.length-1}`)?.scrollIntoView({behavior:'smooth'});return;}
  if(action==='delete-question'){if(activeQuiz.questions.length===1)return toast('Keep at least one question in the quiz.','error');activeQuiz.questions.splice(i,1);return renderEditor();}
  if(action==='move-question'){const j=i+Number(button.dataset.delta);if(j<0||j>=activeQuiz.questions.length)return;[activeQuiz.questions[i],activeQuiz.questions[j]]=[activeQuiz.questions[j],activeQuiz.questions[i]];return renderEditor();}
  if(action==='add-answer'){if(activeQuiz.questions[i].answers.length>=4)return;activeQuiz.questions[i].answers.push('');return renderEditor();}
  if(action==='remove-answer'){const answerIndex=Number(button.dataset.answer);if(activeQuiz.questions[i].answers.length<=2)return;activeQuiz.questions[i].answers.splice(answerIndex,1);if(activeQuiz.questions[i].correctAnswerIndex===answerIndex)activeQuiz.questions[i].correctAnswerIndex=0;else if(activeQuiz.questions[i].correctAnswerIndex>answerIndex)activeQuiz.questions[i].correctAnswerIndex--;return renderEditor();}
  if(action==='focus-question'){$$('.question-nav-item').forEach((b,j)=>b.classList.toggle('selected',j===i));$(`#question-card-${i}`)?.scrollIntoView({behavior:'smooth',block:'center'});return;}
  if(action==='import')return $('#quiz-import').click();
  if(action==='preview')return previewQuiz();
  if(action==='save')return saveQuiz();
}
function closeEditor(){$('#modal-root').innerHTML='';activeQuiz=null;}
function saveQuiz(){
  syncEditorFromDom();activeQuiz.title=$('#quiz-title').value.trim();activeQuiz.description=$('#quiz-description').value.trim();
  const errors=[];if(!activeQuiz.title)errors.push('Quiz title is required.');if(!activeQuiz.questions.length)errors.push('Add at least one question.');
  activeQuiz.questions.forEach((q,i)=>{if(!q.question.trim())errors.push(`Question ${i+1}: question text is required.`);if(q.answers.length<2||q.answers.length>4||q.answers.some(a=>!a.trim()))errors.push(`Question ${i+1}: provide 2–4 non-empty answer options.`);if(q.correctAnswerIndex<0||q.correctAnswerIndex>=q.answers.length)errors.push(`Question ${i+1}: select a correct answer.`);});
  if(errors.length){renderEditor(errors);$('.question-editor')?.scrollTo({top:0,behavior:'smooth'});return;}
  const method=activeQuiz.id?'PUT':'POST';const url=activeQuiz.id?`/api/quizzes/${activeQuiz.id}`:'/api/quizzes';const payload={title:activeQuiz.title,description:activeQuiz.description,questions:activeQuiz.questions};
  api(url,{method,body:JSON.stringify(payload)}).then(()=>{toast('Quiz saved. Your changes are permanent.');closeEditor();renderDashboard('quizzes');}).catch(error=>{renderEditor(error.details||[error.message]);});
}
async function importFile(event){
  const file=event.target.files?.[0];if(!file)return;let parsed=[];const errors=[];
  try{
    if(file.name.toLowerCase().endsWith('.json')){const value=JSON.parse(await file.text());parsed=Array.isArray(value)?value:value.questions||[];if(value.title&&activeQuiz.title==='Untitled quiz')activeQuiz.title=value.title;}
    else{const bytes=await file.arrayBuffer();const workbook=XLSX.read(bytes,{type:'array'});const sheet=workbook.Sheets[workbook.SheetNames[0]];const rows=XLSX.utils.sheet_to_json(sheet,{defval:''});parsed=rows.map((row,idx)=>rowFromImport(row,idx));}
    const normalized=parsed.map((q,i)=>normalizeImported(q,i,errors));
    const valid=normalized.filter(q=>q.question.trim()&&q.answers.length>=2&&q.answers.every(Boolean)&&Number.isInteger(q.correctAnswerIndex)&&q.correctAnswerIndex>=0&&q.correctAnswerIndex<q.answers.length);
    if(normalized.length)activeQuiz.questions=normalized;
    if(!parsed.length)errors.push('No question rows were found.');
    if(!valid.length)errors.push('No valid question rows could be imported.');
    renderEditor(errors);toast(`${valid.length} valid question${valid.length===1?'':'s'} imported${errors.length?' with issues':''}.`,errors.length?'error':'success');
  }catch(error){renderEditor([`Could not read this file: ${error.message}`]);}
  event.target.value='';
}
function rowFromImport(row,index){
  const normalized=Object.fromEntries(Object.entries(row).map(([k,v])=>[String(k).toLowerCase().replace(/[^a-z0-9]/g,''),v]));
  const question=normalized.question||normalized.prompt||normalized.text||'';
  let answers=normalized.answers??normalized.options;
  if(typeof answers==='string')answers=answers.split(/[|;]/).map(s=>s.trim());
  if(!Array.isArray(answers)){answers=['a','b','c','d'].map((k,i)=>normalized[`answer${i+1}`]??normalized[`option${i+1}`]??normalized[`answer${k}`]??normalized[`option${k}`]??normalized[k]??'').filter(x=>String(x).trim()!=='');}
  const correctRaw=normalized.correctanswerindex??normalized.correctindex??normalized.correctanswer??normalized.correct??normalized.answer;
  const setting=(value,fallback)=>value==null||String(value).trim()===''?fallback:value;
  return{question,answers,correctAnswerIndex:correctRaw,explanation:normalized.explanation||'',timeLimit:setting(normalized.timelimit,25),difficulty:normalized.difficulty||'medium',wrongAnswerDamage:setting(normalized.wronganswerdamage,25),correctAnswerReward:setting(normalized.correctanswerreward,10),id:`import-${index}-${crypto.randomUUID()}`};
}
function normalizeImported(raw,index,errors){
  const q={...raw,question:String(raw.question??'').trim(),answers:Array.isArray(raw.answers)?raw.answers.map(a=>String(a??'').trim()):[]};let correct=raw.correctAnswerIndex??raw.correctIndex;
  if(correct==null||String(correct).trim()==='')correct=NaN;
  if(typeof correct==='string'){const text=correct.trim();if(/^[A-D]$/i.test(text))correct=text.toUpperCase().charCodeAt(0)-65;else if(/^\d+$/.test(text))correct=Number(text);else correct=q.answers.findIndex(a=>a.toLocaleLowerCase()===text.toLocaleLowerCase());}
  q.correctAnswerIndex=Number(correct);if(q.answers.length<2||q.answers.length>4||!Number.isInteger(q.correctAnswerIndex)||q.correctAnswerIndex<0||q.correctAnswerIndex>=q.answers.length||!q.question||q.answers.some(x=>!x))errors.push(`Row ${index+1}: add question text, 2–4 answers, and a valid correct answer index/text (0-based).`);
  q.timeLimit=Number(q.timeLimit)||25;q.wrongAnswerDamage=Number(q.wrongAnswerDamage)||25;q.correctAnswerReward=Number(q.correctAnswerReward)||10;return q;
}
function previewQuiz(){
  syncEditorFromDom();const i={index:0};const show=()=>{const q=activeQuiz.questions[i.index];$('#preview-content').innerHTML=`<div class="eyebrow">QUESTION ${i.index+1} / ${activeQuiz.questions.length} · ${esc(q.difficulty)}</div><h2>${esc(q.question||'Your question appears here')}</h2><div class="preview-answers">${q.answers.map((a,j)=>`<div class="preview-answer ${j===q.correctAnswerIndex?'is-correct':''}"><b>${'ABCD'[j]}</b><span>${esc(a||'Answer')}</span>${j===q.correctAnswerIndex?'<em>✓ correct</em>':''}</div>`).join('')}</div>${q.explanation?`<p class="preview-explanation">${esc(q.explanation)}</p>`:''}<div class="preview-nav"><button class="btn btn-outline" data-preview="prev" ${i.index===0?'disabled':''}>← Previous</button><button class="btn btn-dark" data-preview="next" ${i.index===activeQuiz.questions.length-1?'disabled':''}>Next →</button></div>`;};
  $('#modal-root').insertAdjacentHTML('beforeend',`<div class="preview-backdrop"><div class="preview-modal"><div class="preview-head"><div><div class="eyebrow">HOST PREVIEW</div><h1>${esc(activeQuiz.title||'Untitled quiz')}</h1></div><button class="icon-button" data-preview="close">×</button></div><div id="preview-content"></div></div></div>`);show();$('.preview-backdrop').addEventListener('click',e=>{if(e.target===e.currentTarget)e.currentTarget.remove();});$('.preview-backdrop').addEventListener('click',e=>{const b=e.target.closest('[data-preview]');if(!b)return;if(b.dataset.preview==='close')return $('.preview-backdrop').remove();if(b.dataset.preview==='prev')i.index=Math.max(0,i.index-1);if(b.dataset.preview==='next')i.index=Math.min(activeQuiz.questions.length-1,i.index+1);show();});
}

async function renderHostLobby(publicId){
  activeRoom=await api(`/api/tournaments/${publicId}`);currentView='host-lobby';
  const qr=await api(`/api/tournaments/${publicId}/qr`);connectSocket();
  renderLobbyMarkup(activeRoom,qr);hostMode='quizzes';
}
function renderLobbyMarkup(room,qr){
  activeRoom=room;currentView='host-lobby';
  app.innerHTML=`<div class="lobby-shell"><header class="lobby-topbar">${brand()}<div class="room-live"><span class="live-dot"></span>${room.status==='lobby'?'LOBBY OPEN':esc(room.status.toUpperCase())}</div><button class="btn btn-quiet" data-action="back-dashboard">← Dashboard</button></header><main class="lobby-main"><div class="lobby-heading"><div><div class="eyebrow">ROOM ${esc(room.roomCode)} · ${esc(room.quizTitle)}</div><h1>Bring your players in.</h1><p>Scan the code or head to <b>${esc(new URL(room.joinUrl||location.href).host)}/join/${esc(room.publicId)}</b></p></div><div class="room-lock"><label class="switch-row"><input type="checkbox" id="room-lock-toggle" ${room.locked?'checked':''}><span class="switch-ui"></span><b>${room.locked?'Room locked':'Room open'}</b></label></div></div><div class="lobby-grid"><section class="qr-card"><div class="qr-image-wrap"><img src="${qr.dataUrl}" alt="Scannable room QR code"><span class="qr-corner corner-tl"></span><span class="qr-corner corner-tr"></span><span class="qr-corner corner-bl"></span><span class="qr-corner corner-br"></span></div><div class="room-code-label">ROOM CODE</div><div class="room-code">${esc(room.roomCode)}</div><button class="btn btn-outline btn-full" data-action="copy-link" data-url="${esc(qr.joinUrl)}">Copy room link <span>↗</span></button><small class="qr-caption">QR opens the player join screen directly.</small></section><section class="player-card"><div class="panel-heading"><div><div class="eyebrow">CONNECTED PLAYERS</div><h2><span id="player-count">${room.connectedCount}</span><small> / ${room.settings.maxPlayers}</small></h2></div><span class="connection-pill"><i></i> LIVE</span></div><div id="lobby-players" class="lobby-player-list">${room.players.map((p,i)=>lobbyPlayer(p,i)).join('')||`<div class="empty-inline">Waiting for your first player to join…</div>`}</div><div class="lobby-player-footer"><span>✓ Students join with nickname only</span><span>◉ ${esc(room.settings.rulePreset)} mode</span></div><div class="lobby-buttons"><button class="btn btn-outline" data-action="refresh-room">Refresh lobby</button><button class="btn btn-primary" data-action="start-tournament" ${room.connectedCount<2||room.status!=='lobby'?'disabled':''}>Lock roster & start <span>→</span></button></div><div class="form-error" id="lobby-error" role="alert"></div></section></div><section class="bracket-panel panel"><div class="panel-heading"><div><div class="eyebrow">TOURNAMENT BRACKET</div><h2>Elimination rounds</h2></div><div class="bracket-caption">Random pairings · fair byes for odd rosters</div></div><div id="bracket-content">${renderBracket(bracketData)}</div></section><div class="host-tools"><div><button class="btn btn-quiet" data-action="spectator">▣ Open projector view</button><button class="btn btn-outline" data-action="toggle-pause" ${room.status==='lobby'||room.status==='complete'?'disabled':''}>${room.paused?'▶ Resume tournament':'Ⅱ Pause tournament'}</button></div><button class="btn btn-quiet danger-text" data-action="close-tournament">End room</button></div></main></div>`;
  $('#room-lock-toggle').addEventListener('change',async e=>{try{await api(`/api/tournaments/${room.publicId}/lock`,{method:'POST',body:JSON.stringify({locked:e.target.checked})});toast(e.target.checked?'Room locked.':'Room is open.');}catch(error){e.target.checked=!e.target.checked;toast(error.message,'error');}});
  $('.lobby-main').addEventListener('click',handleLobbyClick);
}
function lobbyPlayer(p,i){return `<div class="lobby-player"><div class="player-avatar avatar-${i%6}">${['◈','✦','●','✧','◇','✺'][i%6]}</div><div><b>${esc(p.nickname)}</b><small>${esc(characters.find(c=>c[0]===p.character)?.[1]||'Basic Bot')}</small></div><span class="player-connection ${p.connected?'online':'offline'}">${p.connected?'● online':'○ reconnecting'}</span><button class="icon-button danger-text" title="Remove player" data-action="remove-player" data-id="${p.id}" ${activeRoom?.status!=='lobby'?'disabled':''}>×</button></div>`;}
function renderBracket(data){
  if(!data?.rounds?.length)return `<div class="bracket-empty"><span>⌘</span><p>Players will be paired automatically once the host starts the tournament.</p></div>`;
  return `<div class="bracket-rounds">${data.rounds.map((round,i)=>`<div class="bracket-round"><div class="bracket-round-title">ROUND ${i+1}</div>${round.map(match=>`<article class="bracket-match ${match.status}">${match.players.map(p=>`<div class="bracket-player ${match.winner?.id===p.id?'winner':''}"><span>${esc(p.nickname)}</span><small>${match.winner?.id===p.id?'✓':match.status==='bye'?'BYE':''}</small></div>`).join('')}${match.status==='active'?'<div class="match-live">● LIVE MATCH</div>':''}</article>`).join('')}</div>`).join('')}</div>`;
}
async function handleLobbyClick(event){
  const b=event.target.closest('[data-action]');if(!b)return;
  if(b.dataset.action==='back-dashboard'){disconnectSocket();history.pushState({},'','/');return renderDashboard('quizzes');}
  if(b.dataset.action==='copy-link'){try{await navigator.clipboard.writeText(b.dataset.url);toast('Room link copied.');}catch{toast(b.dataset.url); }return;}
  if(b.dataset.action==='refresh-room'){try{activeRoom=await api(`/api/tournaments/${activeRoom.publicId}`);renderLobbyMarkup(activeRoom,await api(`/api/tournaments/${activeRoom.publicId}/qr`));if(socket?.connected)socket.emit('host:attach',{publicId:activeRoom.publicId});}catch(e){toast(e.message,'error');}return;}
  if(b.dataset.action==='start-tournament'){if(b.disabled)return;socket?.emit('host:start');$('#lobby-error').textContent='';toast('Roster locked. Preparing simultaneous arenas…');return;}
  if(b.dataset.action==='remove-player'){try{await api(`/api/tournaments/${activeRoom.publicId}/players/${b.dataset.id}`,{method:'DELETE'});}catch(e){toast(e.message,'error');}return;}
  if(b.dataset.action==='toggle-pause'){socket?.emit(activeRoom.paused?'host:resume':'host:pause');return;}
  if(b.dataset.action==='close-tournament'){if(!confirm('End this room and stop the tournament?'))return;socket?.emit('host:close');toast('Room ended.');setTimeout(()=>renderDashboard('quizzes'),600);return;}
  if(b.dataset.action==='spectator'){return showSpectator();}
}
function updateLobby(room){
  activeRoom=room;
  if(currentView!=='host-lobby')return;
  $('#player-count')&&($('#player-count').textContent=room.connectedCount);
  const list=$('#lobby-players');if(list)list.innerHTML=room.players.map((p,i)=>lobbyPlayer(p,i)).join('')||'<div class="empty-inline">Waiting for your first player to join…</div>';
  const start=$('[data-action="start-tournament"]');if(start)start.disabled=room.connectedCount<2||room.status!=='lobby';
  const lock=$('#room-lock-toggle');if(lock)lock.checked=room.locked;
  const label=$('.switch-row b');if(label)label.textContent=room.locked?'Room locked':'Room open';
  const status=$('.room-live');if(status)status.innerHTML=`<span class="live-dot"></span>${room.status==='lobby'?'LOBBY OPEN':esc(room.status.toUpperCase())}`;
  const pause=$('[data-action="toggle-pause"]');if(pause){pause.textContent=room.paused?'▶ Resume tournament':'Ⅱ Pause tournament';pause.disabled=room.status==='lobby'||room.status==='complete';}
}

async function renderJoin(publicId){
  currentView='join';host=null;activeRoom=null;disconnectSocket();let room=null;
  try{room=await api(`/api/public-room/${encodeURIComponent(publicId)}`);}catch(e){app.innerHTML=`<main class="join-page"><div class="join-card"><a href="/" class="brand">${brand()}</a><div class="eyebrow">ROOM UNAVAILABLE</div><h1>This room has closed.</h1><p>${esc(e.message)}</p><a class="btn btn-primary" href="/">Go to QBA</a></div></main>`;return;}
  playerPublicId=room.publicId;const prior=localStorage.getItem(`qba-player:${room.publicId}`);
  app.innerHTML=`<main class="join-page"><div class="join-card"><div class="brand"><span class="brand-icon">Q<span>✦</span></span><span>QUIZ BATTLE <b>ARENA</b></span></div><div class="join-emblem">⌁</div><div class="eyebrow">YOU’RE INVITED TO PLAY</div><h1>Enter the arena.</h1><p>Room <b class="join-room-code">${esc(room.roomCode)}</b> · ${esc(room.quizTitle)}</p><form id="join-form" class="stack-form"><label>Your nickname<input name="nickname" placeholder="Choose a name students know" maxlength="24" minlength="2" required autocomplete="nickname"></label><label>Choose your robot<select name="character">${characters.map(([key,name])=>`<option value="${key}">${name}</option>`).join('')}</select></label><div class="form-error" role="alert"></div><button class="btn btn-primary btn-full" ${room.status!=='lobby'||room.locked?'disabled':''}>${room.status!=='lobby'?'Tournament in progress':'Join the lobby'} <span>→</span></button></form>${room.status!=='lobby'?'<button class="btn btn-outline btn-full watch-room" data-action="watch-room">Watch live battles</button>':''}${prior?`<button class="text-button reconnect-link" data-action="reconnect-player" data-public="${esc(publicId)}">Already joined? Reconnect</button>`:''}<div class="privacy-note">No account needed. Pick a nickname and play.</div></div></main>`;
  $('#join-form').addEventListener('submit',async e=>{e.preventDefault();const form=e.currentTarget;try{const body=Object.fromEntries(new FormData(form));body.publicId=/^\d{6}$/.test(publicId)?'':publicId;body.roomCode=/^\d{6}$/.test(publicId)?publicId:'';const player=await api('/api/join',{method:'POST',body:JSON.stringify(body)});playerPublicId=player.publicId;localStorage.setItem(`qba-player:${player.publicId}`,player.token);localStorage.setItem('qba:last-player',JSON.stringify({publicId:player.publicId,token:player.token}));history.replaceState({},'','/game');connectSocket(player.token);renderPlayerLobby(room,player.nickname);}catch(error){showError(form,error);}});
  $('[data-action="reconnect-player"]')?.addEventListener('click',()=>{localStorage.setItem('qba:last-player',JSON.stringify({publicId:room.publicId,token:prior}));history.replaceState({},'','/game');connectSocket(prior);renderPlayerLobby(room,'Player');});
  $('[data-action="watch-room"]')?.addEventListener('click',()=>showSpectator(room.publicId));
}
function renderPlayerLobby(room,nickname){
  currentView='player-waiting';
  app.innerHTML=`<main class="player-waiting"><header>${brand()}<span class="connection-pill"><i></i> CONNECTED</span></header><section class="waiting-card"><div class="waiting-orbit">✦</div><div class="eyebrow">ROOM ${esc(room.roomCode)}</div><h1>You’re in, <span>${esc(nickname)}</span>.</h1><p>Hang tight while your host brings everyone into the arena.</p><div class="waiting-status"><span class="waiting-pulse"></span><b>Waiting for the tournament to start</b></div><div class="waiting-tip"><span>QUICK TIP</span><p>Move with <b>W A S D</b> or the arrow keys. On mobile, use the on-screen joystick. Stand inside an answer zone for a moment to lock it in.</p></div><button class="btn btn-quiet" data-action="leave-room">Leave room</button></section></main>`;
  $('[data-action="leave-room"]').addEventListener('click',()=>{localStorage.removeItem(`qba-player:${room.publicId}`);localStorage.removeItem('qba:last-player');disconnectSocket();setRoute('/');});
}
async function recoverPlayer(){
  const last=JSON.parse(localStorage.getItem('qba:last-player')||'null');
  if(!last?.publicId||!last?.token){history.replaceState({},'','/');return renderLanding();}
  playerPublicId=last.publicId;
  try{const room=await api(`/api/public-room/${last.publicId}`);connectSocket(last.token);renderPlayerLobby(room,'Player');}
  catch{localStorage.removeItem('qba:last-player');localStorage.removeItem(`qba-player:${last.publicId}`);history.replaceState({},'','/');renderLanding();}
}
function renderPlayerWaiting(){
  if(arena){arena.destroy();arena=null;}gameState=null;activeMatchId=null;
  currentView='player-waiting';
  app.innerHTML=`<main class="player-waiting"><header>${brand()}</header><section class="waiting-card"><div class="waiting-orbit">✦</div><div class="eyebrow">TOURNAMENT IN PROGRESS</div><h1>Matchmaking.</h1><p>The next battle is being prepared. You’ll enter automatically.</p><div class="waiting-status"><span class="waiting-pulse"></span><b>Waiting for your match</b></div><div id="waiting-bracket"></div>${playerPublicId?'<button class="btn btn-outline" data-action="watch-live">Watch another battle</button>':''}</section></main>`;
  if(bracketData)$('#waiting-bracket').innerHTML=renderBracket(bracketData);
  $('[data-action="watch-live"]')?.addEventListener('click',()=>showSpectator(playerPublicId));
}

function connectSocket(playerToken=null){
  disconnectSocket();socket=io({transports:['websocket','polling'],reconnection:true,reconnectionAttempts:Infinity,auth:playerToken?{token:playerToken}:undefined});
  socket.on('connect',()=>{if(playerToken)socket.emit('player:attach',{token:playerToken});else if(activeRoom?.publicId&&host)socket.emit('host:attach',{publicId:activeRoom.publicId});});
  socket.on('room:error',data=>{const box=$('#lobby-error')||$('.form-error');if(box)box.textContent=data.error;else toast(data.error,'error');});
  socket.on('room:lobby',room=>{updateLobby(room);if(currentView==='player-waiting')$('#waiting-bracket')&&( $('#waiting-bracket').innerHTML=renderBracket(bracketData));});
  socket.on('player:ready',data=>{playerId=data.playerId;});
  socket.on('player:waiting',data=>{bracketData=data.bracket;renderPlayerWaiting();});
  socket.on('tournament:state',data=>{bracketData=data;if(currentView==='host-lobby')$('#bracket-content')&&($('#bracket-content').innerHTML=renderBracket(data));if(currentView==='player-waiting')$('#waiting-bracket')&&($('#waiting-bracket').innerHTML=renderBracket(data));});
  socket.on('game:question',data=>{questionData=data;});
  socket.on('game:state',state=>{
    if(state.matchId!==activeMatchId){$('.match-overlay')?.remove();questionData=null;}
    if(!arena){renderGame();}
    gameState=state;activeMatchId=state.matchId;arena?.setState(state);questionData=state.question||questionData;updateGameHud(state);
  });
  socket.on('game:locked',()=>toast('Answer locked. Nice move.','success'));
  socket.on('game:damage',data=>toast(`−${data.amount} HP`,'error'));
  socket.on('match:result',result=>{if(result.matchId!==activeMatchId)return;showMatchResult(result);});
  socket.on('tournament:complete',results=>showChampion(results));
  socket.on('tournament:paused',data=>{$('.pause-banner')?.remove();if(data.paused)app.insertAdjacentHTML('beforeend','<div class="pause-banner">Ⅱ TOURNAMENT PAUSED BY HOST</div>');});
  socket.on('tournament:closed',()=>{disconnectSocket();renderLanding();toast('The host closed this room.');});
  socket.on('room:removed',data=>{if(playerPublicId)localStorage.removeItem(`qba-player:${playerPublicId}`);localStorage.removeItem('qba:last-player');disconnectSocket();renderLanding();toast(data.reason,'error');});
  socket.on('battle:preview',preview=>{previewState.set(preview.matchId,preview);if(currentView==='spectator')renderSpectatorCards();});
  socket.on('spectator:snapshots',snapshots=>{for(const s of snapshots)previewState.set(s.matchId,s);if(currentView==='spectator')renderSpectatorCards();});
  socket.on('disconnect',()=>{if(currentView.startsWith('player'))toast('Connection interrupted. Reconnecting…','error');});
}
function disconnectSocket(){if(socket){socket.removeAllListeners();socket.disconnect();socket=null;}if(arena){arena.destroy();arena=null;}gameState=null;activeMatchId=null;}
function renderGame(){
  currentView='game';history.replaceState({},'','/game');
  app.innerHTML=`<main class="game-screen"><header class="game-top"><div class="brand"><span class="brand-icon">Q<span>✦</span></span><span>QUIZ BATTLE <b>ARENA</b></span></div><div class="game-status"><span class="live-dot"></span> LIVE MATCH <b id="game-round">ROUND 1</b></div><button class="icon-button" data-action="game-help" title="Controls">?</button></header><section class="game-layout"><div class="game-hud"><div class="question-progress"><span id="question-index">QUESTION 1 / 3</span><span id="phase-label">GET READY</span></div><h1 id="game-question">Prepare to move into an answer zone.</h1><img id="question-image" class="question-image hidden" alt="Question illustration"><p id="game-subtitle">Stand in a zone for 0.75 seconds to lock in your answer.</p><div class="countdown-row"><div class="countdown-track"><span id="countdown-fill"></span></div><b id="countdown">—</b></div></div><div class="arena-wrap"><div id="phaser-root"></div><div class="arena-label">SURVIVAL ARENA <span>960 × 540</span></div><div class="touch-controls"><button class="touch-button dash-button" id="dash-button"><span>⇧</span><small>DASH</small></button><button class="touch-button ability-button" id="ability-button"><span>◉</span><small>SHIELD</small></button></div><div class="move-hint">WASD / ARROWS <span>·</span> MOVE <span>·</span> SPACE DASH</div></div><div class="answers-grid" id="answers-grid"></div><div class="game-note"><span>⚡</span><span>Find the answer zone and hold it to lock your answer. Rival movement stays hidden until reveal.</span></div></section></main>`;
  arena=startArena($('#phaser-root'),socket,{hud:updateGameHud});
  $('#dash-button').addEventListener('pointerdown',e=>{e.preventDefault();pressDash();});$('#ability-button').addEventListener('pointerdown',e=>{e.preventDefault();pressAbility();});
  $('.game-screen').addEventListener('click',e=>{const b=e.target.closest('[data-action]');if(b?.dataset.action==='game-help')showHelp();});
  if(gameState){arena.setState(gameState);updateGameHud(gameState);}
}
function updateGameHud(state,remaining){
  if(!$('#game-question'))return;
  const q=state.question?{...(questionData||{}),...state.question}:questionData;const idx=$('#question-index');if(idx)idx.textContent=`QUESTION ${state.questionNumber||q?.number||1} / ${state.total||q?.total||3}`;
  $('#game-round').textContent=`ROUND ${state.round||1}`;
  const phaseNames={PREPARE:'GET READY',READING:'READ THE QUESTION',ACTIVE:'MOVE TO ANSWER',ANSWER_LOCK:'LOCKING IN',FEEDBACK:'ANSWER REVEALED',COMPLETE:'MATCH OVER'};
  $('#phase-label').textContent=phaseNames[state.phase]||state.phase;
  if(q?.question)$('#game-question').textContent=q.question;
  const questionImage=$('#question-image');if(questionImage){if(q?.image){questionImage.src=q.image;questionImage.classList.remove('hidden');}else{questionImage.removeAttribute('src');questionImage.classList.add('hidden');}}
  const feedback=state.feedback;
  $('#game-subtitle').textContent=feedback?`${feedback.explanation||'Answer revealed.'} · Correct answer: ${'ABCD'[feedback.correctAnswerIndex]}`:state.phase==='ACTIVE'?'Move into a glowing answer zone and stay there for 0.75 seconds.':state.phase==='READING'?'Take a moment to read. Hazards activate when the timer starts.':'Stand inside your choice for 0.75 seconds to lock it in.';
  const answers=q?.answers||[];$('#answers-grid').innerHTML=answers.map((a,i)=>`<div class="game-answer answer-${i} ${feedback&&feedback.correctAnswerIndex===i?'revealed-correct':''}"><b>${'ABCD'[i]}</b><span>${esc(a)}</span>${feedback&&feedback.correctAnswerIndex===i?'<em>✓ CORRECT</em>':''}</div>`).join('');
  const ms=remaining??Math.max(0,state.endsAt-Date.now());$('#countdown').textContent=state.phase==='FEEDBACK'?'REVEAL':state.phase==='COMPLETE'?'DONE':fmtTime(ms);
  const pct=state.phase==='ACTIVE'?Math.max(0,Math.min(100,ms/((state.question?.timeLimit||25)*1000)*100)):state.phase==='READING'?Math.max(0,Math.min(100,ms/((questionData?.readingSeconds||3)*1000)*100)):state.phase==='FEEDBACK'?100:0;
  $('#countdown-fill').style.width=`${pct}%`;$('#countdown-fill').classList.toggle('urgent',pct<25&&state.phase==='ACTIVE');
  const self=state.self;if(self&&self.hp<35)$('#game-question').classList.add('low-health');else $('#game-question').classList.remove('low-health');
}
function showMatchResult(result){
  const winner=result.players.find(p=>p.id===result.winnerId);
  const isWinner=winner?.id===playerId;
  app.insertAdjacentHTML('beforeend',`<div class="match-overlay"><section class="match-result-card"><span class="result-burst">✦</span><div class="eyebrow">MATCH COMPLETE</div><h1>${esc(winner?.nickname||'Winner')} <span>advances</span></h1><p>${esc(result.note||'Knowledge performance decides the result.')}</p><div class="result-players">${result.players.map(p=>`<div><b>${esc(p.nickname)} ${p.id===result.winnerId?'✦':''}</b><span>${p.correct} correct</span><strong>${p.hp} HP</strong></div>`).join('')}</div><button class="btn btn-primary btn-full" data-action="${isWinner?'continue-waiting':'spectate-after-elim'}">${isWinner?'Continue to bracket':'Watch the tournament'} <span>→</span></button></section></div>`);
  $('[data-action="continue-waiting"]')?.addEventListener('click',()=>renderPlayerWaiting());
  $('[data-action="spectate-after-elim"]')?.addEventListener('click',()=>showSpectator(playerPublicId));
}
function showChampion(results){
  if(arena){arena.destroy();arena=null;}gameState=null;
  const champion=results.champion;currentView='champion';
  app.innerHTML=`<main class="champion-screen"><div class="champion-confetti">✦　✧　✦</div>${brand()}<div class="champion-content"><div class="eyebrow">TOURNAMENT COMPLETE</div><div class="trophy">🏆</div><h1>${esc(champion?.nickname||'The Arena')}</h1><p class="champion-title">ARENA CHAMPION</p><div class="podium">${(results.educationalRanking||[]).slice(0,3).map((p,i)=>`<div class="podium-item place-${i+1}"><span>${i===0?'🥇':i===1?'🥈':'🥉'}</span><b>${esc(p.nickname)}</b><small>${p.correct} correct · ${p.responseTotal?`${(p.responseTotal/1000).toFixed(1)}s`:''}</small></div>`).join('')}</div><div class="champion-note">Game placement and educational performance are shown separately.</div><div class="champion-actions"><button class="btn btn-primary" data-action="champion-dashboard">Back to dashboard</button><button class="btn btn-outline" data-action="champion-results">View learning results</button></div></div></main>`;
  $('[data-action="champion-dashboard"]').onclick=()=>{disconnectSocket();history.pushState({},'','/');renderDashboard('quizzes');};$('[data-action="champion-results"]').onclick=()=>{disconnectSocket();history.pushState({},'','/');renderDashboard('analytics');};
}
function showHelp(){
  const root=document.createElement('div');root.className='preview-backdrop';root.innerHTML=`<section class="help-modal"><button class="icon-button close-help">×</button><div class="eyebrow">HOW TO PLAY</div><h2>Move to answer.</h2><p>Use <b>WASD</b> or the arrow keys to move. On mobile, hold the joystick at the lower left of the arena.</p><p>Reach the glowing zone with the letter for your answer, then stay inside for 0.75 seconds to lock it. You cannot change a locked answer.</p><p><b>Space</b> or the DASH button gives you a short burst. <b>E</b> or SHIELD adds a brief protection effect.</p><button class="btn btn-primary btn-full close-help">Got it</button></section>`;document.body.append(root);$$('.close-help',root).forEach(b=>b.onclick=()=>root.remove());
}

function showSpectator(publicId=activeRoom?.publicId){
  if(!socket)connectSocket();
  if(!publicId)return toast('Room details are unavailable.','error');
  const hostWatching=Boolean(host&&activeRoom?.publicId===publicId);
  socket.emit('spectator:attach',{publicId});
  currentView='spectator';
  app.innerHTML=`<main class="spectator-shell"><header class="lobby-topbar"><div class="brand"><span class="brand-icon">Q<span>✦</span></span><span>QUIZ BATTLE <b>ARENA</b></span></div><div class="room-live"><span class="live-dot"></span> PROJECTOR VIEW</div><button class="btn btn-outline" data-action="spectator-back">← ${hostWatching?'Back to host lobby':'Back to room'}</button><button class="btn btn-dark" data-action="fullscreen">⛶ Fullscreen</button></header><section class="spectator-header"><div><div class="eyebrow">ROUND ${activeRoom?.round||1} · LIVE ARENAS</div><h1>Classroom battle watch</h1><p>Live snapshots are display-only; the server remains authoritative.</p></div><div class="spectator-modes"><button class="selected" data-spectator-mode="multi">Multi-arena</button><button data-spectator-mode="bracket">Bracket</button></div></section><div class="spectator-grid" id="spectator-grid"></div><section class="panel spectator-bracket hidden" id="spectator-bracket"><div id="bracket-content">${renderBracket(bracketData)}</div></section></main>`;
  renderSpectatorCards();
  $('.spectator-shell').addEventListener('click',e=>{const card=e.target.closest('[data-match]');if(card){featuredMatch=featuredMatch===card.dataset.match?null:card.dataset.match;renderSpectatorCards();return;}const b=e.target.closest('[data-action],[data-spectator-mode]');if(!b)return;if(b.dataset.action==='spectator-back'){if(hostWatching)return renderHostLobby(publicId);disconnectSocket();return renderJoin(publicId);}if(b.dataset.action==='fullscreen')document.documentElement.requestFullscreen?.();if(b.dataset.spectatorMode){$$('[data-spectator-mode]').forEach(x=>x.classList.toggle('selected',x===b));if(b.dataset.spectatorMode==='multi')featuredMatch=null;$('#spectator-grid').classList.toggle('hidden',b.dataset.spectatorMode==='bracket');$('#spectator-grid').classList.toggle('has-featured',Boolean(featuredMatch));$('#spectator-bracket').classList.toggle('hidden',b.dataset.spectatorMode!=='bracket');}});
}
function renderSpectatorCards(){
  const grid=$('#spectator-grid');if(!grid)return;const previews=[...previewState.values()];
  if(!previews.length){grid.innerHTML='<div class="empty-inline">Waiting for live arenas to start…</div>';return;}
  if(featuredMatch&&!previews.some(p=>p.matchId===featuredMatch))featuredMatch=null;
  grid.classList.toggle('has-featured',Boolean(featuredMatch));
  grid.innerHTML=previews.map(p=>`<article class="spectator-card ${featuredMatch===p.matchId?'featured':''} ${featuredMatch&&featuredMatch!==p.matchId?'hidden':''}" data-match="${p.matchId}"><div class="spectator-card-head"><span>ROUND ${p.round}</span><b>${esc(p.phase)}</b><span class="live-dot"></span></div>${p.question?`<div class="spectator-question">${esc(p.question)}</div>`:''}<div class="mini-arena"><div class="mini-grid"></div>${(p.enemies||[]).map(e=>`<i class="mini-enemy" style="left:${e.x/9.6}%;top:${e.y/5.4}%"></i>`).join('')}${p.players.map((player,i)=>`<div class="mini-player" style="left:${player.x/9.6}%;top:${player.y/5.4}%;--player-color:${colors[i]}" title="${esc(player.nickname)}"></div>`).join('')}</div><div class="spectator-contestants">${p.players.map((player,i)=>`<div><span>${esc(player.nickname)}</span><b>${player.hp} HP</b><i><em style="width:${Math.max(0,player.hp/player.maxHp*100)}%;background:${colors[i]}"></em></i></div>`).join('')}</div></article>`).join('');
}

function renderAccessibility(){
  const settings=JSON.parse(localStorage.getItem('qba-accessibility')||'{}');const modal=document.createElement('div');modal.className='preview-backdrop';modal.innerHTML=`<section class="help-modal"><button class="icon-button close-access">×</button><div class="eyebrow">DISPLAY SETTINGS</div><h2>Make the arena yours.</h2><label class="check-row"><input type="checkbox" name="highContrast" ${settings.highContrast?'checked':''}><span><b>High contrast</b><small>Increase interface contrast.</small></span></label><label class="check-row"><input type="checkbox" name="reducedMotion" ${settings.reducedMotion?'checked':''}><span><b>Reduce motion</b><small>Limit animation and transitions.</small></span></label><label class="check-row"><input type="checkbox" name="largeText" ${settings.largeText?'checked':''}><span><b>Larger text</b><small>Increase text size across the dashboard.</small></span></label><button class="btn btn-primary btn-full" data-action="save-access">Save preferences</button></section>`;document.body.append(modal);modal.querySelectorAll('.close-access').forEach(b=>b.onclick=()=>modal.remove());modal.querySelector('[data-action="save-access"]').onclick=()=>{const value=Object.fromEntries(new FormData(modal.querySelector('section')).entries());value.highContrast=modal.querySelector('[name="highContrast"]').checked;value.reducedMotion=modal.querySelector('[name="reducedMotion"]').checked;value.largeText=modal.querySelector('[name="largeText"]').checked;localStorage.setItem('qba-accessibility',JSON.stringify(value));document.documentElement.classList.toggle('high-contrast',value.highContrast);document.documentElement.classList.toggle('reduced-motion',value.reducedMotion);document.documentElement.classList.toggle('large-text',value.largeText);modal.remove();toast('Display preferences saved.');};
}

document.addEventListener('click',async e=>{
  const action=e.target.closest('[data-action]')?.dataset.action;
  if(action==='login')renderAuth('login');if(action==='register')renderAuth('register');if(action==='home')renderLanding();if(action==='logout'){try{await api('/api/auth/logout',{method:'POST'});}catch{}host=null;disconnectSocket();renderLanding();}
  if(action==='accessibility')renderAccessibility();
});
app.addEventListener('submit',e=>{if(e.target.id==='quick-join'){e.preventDefault();const code=new FormData(e.target).get('code');location.href=`/join/${encodeURIComponent(code)}`;}});
document.addEventListener('click',e=>{const nav=e.target.closest('[data-nav]');if(nav){e.preventDefault();history.pushState({},'','/');renderRoute();}});

const accessibility=JSON.parse(localStorage.getItem('qba-accessibility')||'{}');document.documentElement.classList.toggle('high-contrast',!!accessibility.highContrast);document.documentElement.classList.toggle('reduced-motion',!!accessibility.reducedMotion);document.documentElement.classList.toggle('large-text',!!accessibility.largeText);
renderRoute();
