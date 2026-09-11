'use strict';
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const token = $('meta[name="review-token"]').content;
const state = {mode:'text', image:null, preview:null, busy:false, result:null, rules:[], canCheck:false, imageVersion:0, loadingImage:false};
const HISTORY_KEY='jiaogao.saved-reports.v1';
let materialVersion=0,historyImageURL=null;
function imageStore(mode,action){
  return new Promise((resolve,reject)=>{
    let db,tx,done=false;
    const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);if(db)db.close();error?reject(error):resolve(value);};
    const timer=setTimeout(()=>{try{tx?.abort();}catch{}finish(new Error('本地图片存储超时'));},4000);
    try{
      const opening=indexedDB.open('jiaogao.materials.v1',1);
      opening.onupgradeneeded=()=>opening.result.createObjectStore('images');
      opening.onerror=()=>finish(new Error('本地图片存储不可用'));
      opening.onblocked=()=>finish(new Error('本地图片存储被占用'));
      opening.onsuccess=()=>{db=opening.result;if(done){db.close();return;}try{tx=db.transaction('images',mode);const request=action(tx.objectStore('images'));tx.oncomplete=()=>finish(null,request.result);tx.onerror=tx.onabort=()=>finish(new Error('图片读写失败'));}catch(e){finish(e);}};
    }catch(e){finish(e);}
  });
}
async function saveReportImage(id,file){
  const keep=new Set(savedReports().map(r=>r.id));
  return imageStore('readwrite',store=>{const cursor=store.openCursor();cursor.onsuccess=()=>{const item=cursor.result;if(item){if(!keep.has(item.key))item.delete();item.continue();}};return file?store.put(file,id):store.get(id);});
}
function showEditor(){
  materialVersion++;if(historyImageURL){URL.revokeObjectURL(historyImageURL);historyImageURL=null;}
  state.viewingHistory=false;$('#historical-material').hidden=true;$('#review-form').hidden=false;
  $('#input-heading').lastChild.textContent='提交材料';$('#submit span:first-child').textContent=state.result?'重新检查':'开始检查';
  $('#action-progress').textContent='编辑内容已保留，可继续检查';markStale();
}
async function showHistoryMaterial(data){
  const version=++materialVersion;if(historyImageURL){URL.revokeObjectURL(historyImageURL);historyImageURL=null;}
  state.viewingHistory=true;$('#review-form').hidden=true;$('#historical-material').hidden=false;
  $('#input-heading').lastChild.textContent='当时提交的材料';$('#submit span:first-child').textContent='返回编辑';
  $('#action-progress').textContent='正在查看历史材料与结果';showError('');
  const source=$('#historical-source');source.replaceChildren();
  sourceBlock(source,data.input.image_file?'附带文案':'广告文案',data.input.text);
  if(data.input.image_file){
    sourceBlock(source,'原图片文件',data.input.image_file);
    const imageBox=element('div','history-image-box'),status=element('p','report-note','正在读取本浏览器保存的原图…');source.append(imageBox,status);
    sourceBlock(source,'当时识别的图片文字（请与原图核对）',data.report.extracted_text);
    imageStore('readonly',store=>store.get(data.id)).then(blob=>{
      if(version!==materialVersion)return;
      if(!(blob instanceof Blob)){status.className='notice';status.textContent='当前浏览器未保存这份原图（可能是旧版或其他设备的记录）。下方识别文字不能代替原图；需要复查时请重新上传。';return;}
      historyImageURL=URL.createObjectURL(blob);const img=element('img','history-original');img.alt='当时提交的海报原图';img.src=historyImageURL;imageBox.append(img);status.textContent='当时提交的原图，仅保存在当前浏览器。';
    }).catch(()=>{if(version===materialVersion){status.className='notice';status.textContent='本地原图暂时无法读取，请保留原文件；文字报告仍可查看。';}});
  }
  sourceBlock(source,'补充判断依据（未经独立核实）',data.input.evidence);
  source.append(element('p','source-note','完整性声明：'+(data.input.declared_incomplete?'当时已声明有截断、遮挡或缺页':'当时未声明材料不完整')));
}
function reportOptimizations(report){return report.optimization_version===2?report.optimization_suggestions||[]:[];}
function savedReports(){
  const records=JSON.parse(localStorage.getItem(HISTORY_KEY)||'[]');
  if(!Array.isArray(records)||records.some(r=>!r||typeof r.id!=='string'||!r.run||!r.input||!Array.isArray(r.report?.checks)))throw new Error('浏览器记录无法读取，请保留已有备份。');
  return records;
}
function rememberReport(data){
  try{
    // 报告文本存 localStorage；新原图另存 IndexedDB，不保存访问码或接口密钥。
    const item={id:data.id,run:data.run,input:data.input,report:data.report};
    const records=[item,...savedReports().filter(r=>r.id!==data.id)].sort((a,b)=>new Date(b.run.executed_at)-new Date(a.run.executed_at)).slice(0,30);
    localStorage.setItem(HISTORY_KEY,JSON.stringify(records));
    $('#history-save-status').className='report-note';
    $('#history-save-status').textContent='已保存到本浏览器的检查记录。';
    return true;
  }catch{
    $('#history-save-status').className='report-note save-failed';
    $('#history-save-status').textContent='本次结果未能保存到浏览器。请立即另存 PDF 或复制报告；可能是存储空间不足或被限制。';
    return false;
  }
}
const element = (tag, className, text) => {const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;};

async function api(path, options={}) {
  const response=await fetch(path,{...options,headers:{'X-Review-Token':token,...options.headers}});
  const body=await response.json();
  if(!response.ok)throw new Error(body.error || '请求未完成，请重试。');
  return body;
}
function showError(message){$('#form-error').textContent=message;$('#form-error').hidden=!message;}
function markStale(){if(state.result)$('#stale-notice').hidden=false;}
function setMode(mode){
  if(state.busy)return;
  state.mode=mode;
  $$('.tab').forEach(btn=>{const active=btn.dataset.mode===mode;btn.classList.toggle('active',active);btn.setAttribute('aria-selected',String(active));btn.tabIndex=active?0:-1;});
  $('#text-zone').hidden=mode!=='text';$('#image-zone').hidden=mode!=='image';markStale();
}
function clearImage(){
  state.imageVersion++;state.loadingImage=false;$('#submit').disabled=state.busy;
  if(state.preview)URL.revokeObjectURL(state.preview);
  state.image=null;state.preview=null;$('#image-file').value='';$('#image-preview').removeAttribute('src');$('#preview-box').hidden=true;$('#dropzone').hidden=false;markStale();
  $('#image-status').textContent='请上传完整、清晰的原图，也支持粘贴图片。';
}
function openImagePicker(){
  if(state.busy)return;
  // 由真实按钮的用户点击同步触发，不依赖透明遮罩或label的间接激活。
  $('#image-file').value='';
  $('#image-file').click();
}
async function selectImage(file){
  if(!file||state.busy)return;
  if(!/\.(png|jpe?g)$/i.test(file.name)){showError('请选择 JPG 或 PNG 图片。');return;}
  if(file.size>10*1024*1024||file.size===0){showError('请选择不超过10 MB的有效图片。');return;}
  const version=++state.imageVersion,url=URL.createObjectURL(file);
  state.loadingImage=true;$('#submit').disabled=true;$('#image-status').textContent='正在读取并验证图片…';
  try{
    const probe=new Image();
    await new Promise((resolve,reject)=>{probe.onload=resolve;probe.onerror=()=>reject(new Error('图片无法打开，可能已经损坏。请重新导出为 JPG 或 PNG 后再上传。'));probe.src=url;});
    if(version!==state.imageVersion){URL.revokeObjectURL(url);return;}
    if(state.preview)URL.revokeObjectURL(state.preview);
    state.image=file;state.preview=url;
    $('#image-preview').src=url;$('#image-name').textContent=file.name;
    $('#preview-box').hidden=false;$('#dropzone').hidden=true;showError('');markStale();
    $('#image-status').textContent=`图片已就绪 · ${probe.naturalWidth} × ${probe.naturalHeight} · ${(file.size/1024/1024).toFixed(2)} MB`;
  }catch(error){
    URL.revokeObjectURL(url);
    if(version===state.imageVersion){showError(error.message);$('#image-status').textContent=state.image?'新图片读取失败，保留之前的图片。':'图片读取失败，请重新选择。';}
  }finally{
    if(version===state.imageVersion){state.loadingImage=false;$('#submit').disabled=state.busy;}
  }
}
function asBase64(file){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(new Error('图片读取失败，请重新选择。'));reader.readAsDataURL(file);});}
function switchView(view){
  if(state.busy)return;
  $$('.view').forEach(node=>node.hidden=node.id!==`view-${view}`);
  $$('.nav-item').forEach(btn=>{const active=btn.dataset.view===view;btn.classList.toggle('active',active);if(active)btn.setAttribute('aria-current','page');else btn.removeAttribute('aria-current');});
  if(view==='history')loadHistory();
  window.scrollTo({top:0,behavior:'instant'});
  $('#main').scrollTo({top:0,behavior:'instant'});
}
function sourceBlock(parent,label,content){parent.append(element('p','source-label',label),element('pre','',content||'无'));}
function renderResult(data,historical=false){
  state.result=data;
  if(historical)showHistoryMaterial(data);else showEditor();
  $('#history-save-status').textContent='';
  $('#report-text').value=managementMarkdown(data);$('#report-backup').open=false;$('#download-status').textContent='';
  if(data.checks_remaining!==undefined)showCloudBudget(data.checks_remaining);
  const r=data.report, order={'高':0,'待确认':1,'中':2,'低':3};
  // 展示层按同一规则合并重复问题；原始逐项判断仍完整保留在展开区与报告数据中。
  const issues=r.checks.filter(c=>c.issues.length).map(c=>{
    const sorted=[...c.issues].sort((a,b)=>(order[a.risk_level]??4)-(order[b.risk_level]??4));
    const join=key=>[...new Set(c.issues.map(i=>i[key]).filter(Boolean))].join('；');
    return {...sorted[0],risk_type:join('risk_type'),original_text:join('original_text'),suggestion:join('suggestion'),human_review_reason:join('human_review_reason'),needs_human_review:c.issues.some(i=>i.needs_human_review),explanation:c.reason};
  }).sort((a,b)=>(order[a.risk_level]??4)-(order[b.risk_level]??4));
  $('#loading-result').hidden=true;$('#empty-result').hidden=true;$('#result-content').hidden=false;
  $('#stale-notice').hidden=true;$('#history-notice').hidden=!historical;
  $('#coverage-notice').hidden=r.checks.some(c=>c.rule_id==='A-11');
  $('#all-checks-heading').textContent=`查看本报告 ${r.checks.length} 条规则的判断`;
  const uncertain=!r.input_complete||r.overall_status==='无法完整判断', clean=!uncertain&&!issues.length;
  $('#summary').className='result-summary'+(clean?' clean':uncertain?' uncertain':'');
  $('#summary-title').textContent=clean?'未发现明确风险':uncertain?'材料不足，暂不能判断':'建议修改后复查';
  $('#summary-note').textContent=clean?'本次材料未发现触发题目规则的问题，发布前请确认事实。':uncertain?'请补充完整、清晰的材料；已识别的问题仍需处理。':'请先处理下方问题，修改后重新检查。';
  $('#summary-symbol').textContent=clean?'✓':uncertain?'?':'!';
  $('#summary-kicker').textContent=historical?'历史检查结果':'检查完成';
  $('#issue-count').textContent=issues.length;$('#rule-count').textContent=r.checks.length;
  $('#run-time').textContent=Number(data.run.elapsed_seconds).toFixed(1);
  $('#result-label').textContent=new Date(data.run.executed_at).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})+' 完成';
  $('#review-required').textContent=r.needs_human_review?'需要人工审核':'无待复核事项';
  $('#limitations').hidden=!r.limitations.length;$('#limitation-list').replaceChildren(...r.limitations.map(t=>element('li','',t)));
  const list=$('#issues');list.replaceChildren();
  const optimizations=reportOptimizations(r);
  $('#optimizations').hidden=!optimizations.length;
  $('#optimization-list').replaceChildren(...optimizations.map(t=>element('p','clean-note',t)));
  if(!issues.length)list.append(element('p','clean-note','这份材料在给定规则范围内没有发现需要整改的问题。'));
  issues.forEach(issue=>{
    const card=element('article','issue-card'),head=element('div','issue-heading'),title=element('div','issue-title');
    title.textContent=issue.risk_type;
    const level=issue.risk_level, color=level==='高'?'high':level==='低'?'low':'medium';
    head.append(title,element('span',`badge ${color}`,level==='待确认'?level:`${level}风险`));
    card.append(head,element('p','quote-label','涉及原文'),element('blockquote','issue-quote',issue.original_text),
      element('p','issue-explanation',issue.explanation),element('p','issue-suggestion','建议：'+issue.suggestion));
    if(issue.needs_human_review)card.append(element('p','issue-human','需要人工复核'+(issue.human_review_reason?'：'+issue.human_review_reason:'')));
    const basis=element('details');basis.append(element('summary','','查看判断依据'),element('p','issue-rule',issue.rule_id+' · '+issue.rule_text));card.append(basis);
    list.append(card);
  });
  const source=$('#source-content');source.replaceChildren();
  sourceBlock(source,'提交文案',data.input.text);
  if(data.input.image_file){sourceBlock(source,'图片识别文字',r.extracted_text);source.append(element('p','source-note','图片文件：'+data.input.image_file),element('p','source-note',r.image_note));}
  if(data.input.evidence)sourceBlock(source,'补充证据（未经独立核实）',data.input.evidence);
  source.append(element('p','source-note','材料完整性声明：'+(data.input.declared_incomplete?'用户明确标记材料不完整':'用户未声明；由系统结合可见材料判断')));
  $('#all-checks').replaceChildren(...r.checks.map(c=>{const row=element('div','check-line');const rule=state.rules.find(rule=>rule.id===c.rule_id);row.append(element('strong','',`${c.rule_id} ${rule?.title||''} · ${c.status}`),element('p','',c.reason));return row;}));
}
async function submitReview(event){
  event.preventDefault();if(state.busy)return;showError('');
  if(state.viewingHistory){showEditor();$('#input-heading').scrollIntoView({block:'start'});return;}
  if(state.loadingImage){showError('图片仍在读取，请稍候再检查。');return;}
  if(!state.canCheck){showError('尚未配置模型密钥。请在启动程序的本地终端配置后重启工作台。');return;}
  const text=(state.mode==='text'?$('#ad-text').value:$('#image-caption').value).trim();
  const evidence=$('#evidence').value.trim();const selected=state.mode==='image'?state.image:null;
  if(state.mode==='image'&&!selected){showError('请先选择一张要检查的图片。');return;}
  if(!text&&!selected){showError('请先填写广告文案或上传一张图片。');$('#ad-text').focus();return;}
  if(text.length+evidence.length>30000){showError('文案和补充依据合计不能超过30000字符。');return;}
  state.busy=true;$('#input-fields').disabled=true;$('#submit').disabled=true;$('.result-panel').setAttribute('aria-busy','true');
  $$('.nav-item').forEach(b=>b.disabled=true);$('#submit span:first-child').textContent='正在检查…';
  $('#result-content').hidden=true;$('#empty-result').hidden=true;$('#loading-result').hidden=false;$('#elapsed').textContent='已等待 0 秒';$('#result-label').textContent='检查中';
  $('#action-progress').textContent='正在检查，请稍候…';
  const started=Date.now(), timer=setInterval(()=>{const seconds=Math.floor((Date.now()-started)/1000);$('#elapsed').textContent=`已等待 ${seconds} 秒`;$('#action-progress').textContent=`检查中 · 已等待 ${seconds} 秒`;},1000);
  const controller=new AbortController(), timeout=setTimeout(()=>controller.abort(),120000);
  try{
    const image=selected?{name:selected.name,data:await asBase64(selected)}:null;
    const result=await api('/api/check',{method:'POST',headers:{'Content-Type':'application/json'},signal:controller.signal,body:JSON.stringify({text,evidence,incomplete:$('#incomplete').checked,image})});
    renderResult(result);
    const saved=rememberReport(result);
    if(saved){try{await saveReportImage(result.id,selected);}catch{if(selected){$('#history-save-status').className='report-note save-failed';$('#history-save-status').textContent='文字报告已保存，但原图未能保存在本浏览器。请保留原文件，历史记录可能无法显示原图。';}}}
    $('#action-progress').textContent='检查完成，可查看结果或修改后复查';
    if(matchMedia('(max-width:850px)').matches)$('#result-heading').scrollIntoView({block:'start'});
  }catch(error){
    $('#loading-result').hidden=true;$('#result-label').textContent='本次未完成';
    if(state.result){$('#result-content').hidden=false;$('#stale-notice').hidden=false;}
    else $('#empty-result').hidden=false;
    showError(error.name==='AbortError'?'等待已超过2分钟。输入已保留；请稍后查看检查记录，确认是否完成后再重试。':error.message==='Failed to fetch'?'无法连接检查服务，请检查网络后重试；输入仍保留在此页。':error.message);
    $('#action-progress').textContent='本次未完成，输入已保留';
  }finally{
    clearInterval(timer);clearTimeout(timeout);state.busy=false;$('#input-fields').disabled=false;$('#submit').disabled=false;$('.result-panel').setAttribute('aria-busy','false');
    $$('.nav-item').forEach(b=>b.disabled=false);$('#submit span:first-child').textContent='重新检查';
  }
}
async function loadHistory(){
  const list=$('#history-list');let local=[],warning='';
  try{local=savedReports();}catch{warning='浏览器记录暂时无法读取，下面尝试显示服务端仍保留的记录。';}
  const localRows=local.map(r=>({id:r.id,time:r.run.executed_at,status:!r.report.input_complete?'材料不足，暂不能判断':r.report.checks.some(c=>c.issues.length)?'建议修改后复查':'未发现明确风险',title:r.input.image_file||r.input.text.slice(0,48),kind:r.input.image_file?'图片':'文字'}));
  function display(remote=[],message=''){
    const displayStatus=status=>String(status||'').includes('未发现风险')?'未发现明确风险':String(status||'').includes('无法完整判断')||String(status||'').includes('材料不足')?'材料不足，暂不能判断':String(status||'').includes('发现风险')?'建议修改后复查':'检查结果';
    remote=remote.map(r=>({...r,status:displayStatus(r.status)}));
    const merged=new Map(remote.map(r=>[r.id,r]));localRows.forEach(r=>merged.set(r.id,r));
    const items=[...merged.values()].sort((a,b)=>new Date(b.time)-new Date(a.time)).slice(0,30);
    list.replaceChildren();
    if(warning||message)list.append(element('p','report-note',warning||message));
    if(!items.length)list.append(element('p','history-empty','还没有检查记录。提交第一份材料后，报告会保存在这里。'));
    items.forEach(item=>{
      const button=element('button','history-card'),body=element('div');button.type='button';
      const saved=local.find(r=>r.id===item.id);
      body.append(element('strong','',item.title),element('small','',`${new Date(item.time).toLocaleString('zh-CN')} · ${item.kind} · ${saved?'本浏览器已保存':'服务端记录，打开后保存到本浏览器'}`));
      button.append(body,element('span','history-status',(item.status==='在本次输入和给定规则范围内未发现风险'?'本次未发现风险':item.status)+'  →'));
      button.addEventListener('click',async()=>{button.disabled=true;try{const report=saved||await api('/api/reports/'+encodeURIComponent(item.id));switchView('review');renderResult(report,true);rememberReport(report);if(matchMedia('(max-width:850px)').matches)$('#input-heading').scrollIntoView({block:'start'});}catch(error){list.prepend(element('p','error-message',error.message));}finally{button.disabled=false;}});
      list.append(button);
    });
  }
  display();
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),6000);
  try{const {items}=await api('/api/history',{signal:controller.signal});display(items);}
  catch{display([],'服务端记录暂时无法读取，已显示本浏览器保存的记录。');}
  finally{clearTimeout(timeout);}
}
function managementSections(data){
  const r=data.report, input=data.input, order={'高':0,'待确认':1,'中':2,'低':3};
  const issues=r.checks.filter(c=>c.issues.length).map(c=>{
    const sorted=[...c.issues].sort((a,b)=>(order[a.risk_level]??4)-(order[b.risk_level]??4));
    const combine=key=>[...new Set(c.issues.map(i=>i[key]).filter(Boolean))].join('；');
    return {...sorted[0],original_text:combine('original_text'),risk_type:combine('risk_type'),suggestion:combine('suggestion'),human_review_reason:combine('human_review_reason'),needs_human_review:c.issues.some(i=>i.needs_human_review),reason:c.reason,
      ...(c.rule_id==='A-06'?{risk_type:'疗效、安全或收益保证需核实',reason:'相关表述涉及敏感承诺，需要审核负责人核实适用条件与证明材料后，再决定是否使用。',suggestion:'暂停使用相关表述，保留原文并提交审核负责人确认；未经确认前不建议发布。'}:{})};
  });
  issues.sort((a,b)=>(order[a.risk_level]??4)-(order[b.risk_level]??4));
  const plain=s=>String(s||'').replace(/A-\d{2}/g,'相关要求');
  const decision=!r.input_complete||r.overall_status==='无法完整判断'?'资料不足，暂缓发布确认':issues.length?'建议完成整改并复核后再发布':'未发现明确问题，可进入发布确认';
  const sections=[{title:'一、决策摘要',paragraphs:[decision,
    !r.input_complete?`本次材料存在阅读或完整性限制，已识别 ${issues.length} 项待处理问题。需补充完整清晰材料后重新检查。`:issues.length?`本次识别 ${issues.length} 项待处理问题。建议由材料负责人逐项整改，由审核负责人确认处理结果。`:'本次提交内容中未发现明确触发检查要求的问题。可选文字优化不影响这一初筛结果；发布负责人仍需确认商业事实真实、材料完整。',
    '本报告用于辅助管理决策，依据为本次提交材料和约定的广告宣传检查要求，不代表完整法律审查或正式发布批准。']}];
  sections.push({title:'二、主要问题与处理建议',paragraphs:issues.length?[]:['本次没有需整改的明确问题。'],items:issues.map((i,n)=>({title:`${n+1}. ${plain(i.risk_type)}（${i.risk_level==='待确认'?'等级待确认':i.risk_level+'风险'}）`,paragraphs:[`涉及表述：${i.original_text}`,`需要关注：${plain(i.reason)}`,`建议行动：${plain(i.suggestion)}`,`确认要求：${i.needs_human_review?'需人工确认'+(i.human_review_reason?'；'+plain(i.human_review_reason):''):'本项未要求额外人工复核，发布前仍应核对事实。'}`]}))});
  sections.push({title:'三、建议推进顺序',paragraphs:!r.input_complete?['请材料负责人先补齐清晰原图或缺失页面，再核查当前已发现的问题；资料齐全后重新检查，交由审核负责人确认。']:issues.length?['请材料负责人先处理高风险和待确认事项，再完成其余整改。涉及活动条件、数据或授权的，补充真实依据；修改后重新检查，由审核负责人确认是否发布。']:['请发布负责人确认商品信息及商业事实真实、当前材料完整，再按现有审批流程决定发布。无需为可选措辞优化重复认定风险。']});
  sections.push({title:'四、待补资料与判断限制',paragraphs:r.limitations.length?r.limitations.map(plain):['本次未识别出影响阅读的明显限制；这不等于已验证所有商业主张真实。'],items:input.evidence?[{title:'已提供的补充说明',paragraphs:[input.evidence,'以上内容由提交者提供，其真实性尚未独立核验。']}]:[]});
  if(reportOptimizations(r).length)sections.push({title:'五、可选文字优化',paragraphs:['以下建议不计入风险；示例只调整表达或排版，请核对后使用。',...reportOptimizations(r)]});
  sections.push({title:'附：本报告对应的送审材料',paragraphs:[...(input.image_file?[`图片文件：${input.image_file}`,'以下图片识别文字可能有遗漏，请与原图核对。',r.extracted_text||'无法可靠识别图片文字。']:[]),...(input.text?[input.image_file?'随图文案：'+input.text:input.text]:[])]});
  const executedAt=new Date(data.run.executed_at);
  if(!r.checks.some(c=>c.rule_id==='A-11'))sections.unshift({title:'检查范围提醒',paragraphs:['这是旧版报告，未包含新增的歧视与群体贬损检查。请重新提交材料后再使用。']});
  const date=Number.isNaN(executedAt.getTime())?'时间未记录':executedAt.toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false})+'（北京时间）';
  return {date,sections};
}
function managementMarkdown(data){
  const doc=managementSections(data),lines=['# 宣传材料发布决策参考','',`检查时间：${doc.date}`,''];
  for(const section of doc.sections){lines.push('## '+section.title,'',...section.paragraphs.flatMap(p=>[p,'']));for(const item of section.items||[])lines.push('### '+item.title,'',...item.paragraphs.flatMap(p=>[p,'']));}
  return lines.join('\n');
}
function prepareManagementPrint(){
  if(!state.result||state.busy)return false;
  const doc=managementSections(state.result),root=$('#management-print');root.replaceChildren();
  root.append(element('p','print-brand','校稿 · 发布前检查'),element('h1','','宣传材料发布决策参考'),element('p','print-date','检查时间：'+doc.date));
  if(!$('#stale-notice').hidden)root.append(element('p','print-warning','当前输入已有修改。本报告对应上一次检查材料，不代表修改后的检查结果。'));
  for(const section of doc.sections){root.append(element('h2','',section.title));for(const p of section.paragraphs)root.append(element('p','',p));for(const item of section.items||[]){root.append(element('h3','',item.title));for(const p of item.paragraphs)root.append(element('p','',p));}}
  return true;
}
function showReportBackup(){
  if(!state.result)return;
  $('#report-backup').open=true;$('#report-text').focus();$('#report-text').select();
}
async function download(format){
  if(!state.result||state.busy)return;
  const result=state.result, type=format==='md'?'text/plain':'application/json';
  const clean={run:result.run,input:result.input,report:result.report};
  const filename=`广告检查_${result.id}.${format}`;
  const buttons=[$('#download-md'),$('#download-json')];buttons.forEach(b=>b.disabled=true);
  try{
    const blob=new Blob(['\ufeff',format==='md'?managementMarkdown(result):JSON.stringify(clean,null,2)],{type:type+';charset=utf-8'});
    if(typeof window.showSaveFilePicker==='function'){
      const handle=await window.showSaveFilePicker({suggestedName:filename,types:[{description:format==='md'?'Markdown 文档':'JSON 数据',accept:{[type]:['.'+format]}}]});
      const writable=await handle.createWritable();
      try{await writable.write(blob);await writable.close();}catch(error){await writable.abort().catch(()=>{});throw error;}
      $('#download-status').textContent='报告已保存。检查结果仍保留在本页。';
    }else{
      showReportBackup();
      $('#download-status').textContent='当前浏览器不支持直接选择文件保存。请使用“保存 PDF 报告”，或复制下方报告文本保存。';
    }
  }catch(error){
    if(error.name==='AbortError')$('#download-status').textContent='已取消保存，报告仍保留在本页。';
    else{showReportBackup();$('#download-status').textContent='未能启动下载。报告仍保留在本页，请复制下方文本保存，或在系统浏览器中打开后重试。';}
  }finally{buttons.forEach(b=>b.disabled=false);}
}
async function init(){
  const actionBar=$('.action-bar');
  new ResizeObserver(()=>{if(actionBar.offsetHeight)document.documentElement.style.setProperty('--action-height',actionBar.offsetHeight+'px');}).observe(actionBar);
  new ResizeObserver(entries=>document.documentElement.style.setProperty('--mobile-header-height',entries[0].target.offsetHeight+'px')).observe($('.sidebar'));
  document.addEventListener('focusin',event=>{if(!actionBar.contains(event.target)&&!$('#view-review').hidden)requestAnimationFrame(()=>{const rect=event.target.getBoundingClientRect();if(rect.bottom>actionBar.getBoundingClientRect().top)event.target.scrollIntoView({block:'center'});});});
  $('#review-form').addEventListener('submit',submitReview);
  $$('.tab').forEach(btn=>{btn.addEventListener('click',()=>setMode(btn.dataset.mode));btn.addEventListener('keydown',e=>{if(['ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();setMode(state.mode==='text'?'image':'text');$(`#tab-${state.mode}`).focus();}});});
  $$('.nav-item').forEach(btn=>btn.addEventListener('click',()=>switchView(btn.dataset.view)));
  $$('[data-go]').forEach(btn=>btn.addEventListener('click',()=>switchView(btn.dataset.go)));
  $('#ad-text').addEventListener('input',()=>{$('#text-count').textContent=$('#ad-text').value.length+' 字';markStale();});
  ['#image-caption','#evidence','#incomplete'].forEach(id=>$(id).addEventListener('input',markStale));
  $('#image-file').addEventListener('change',()=>selectImage($('#image-file').files[0]));
  $('#dropzone').addEventListener('click',openImagePicker);
  $('#change-image').addEventListener('click',openImagePicker);
  $('#image-file').addEventListener('cancel',()=>{if(!state.image)$('#image-status').textContent='已取消选择。可以重新点击“选择图片”，或直接拖入、粘贴图片。';});
  $('#remove-image').addEventListener('click',clearImage);
  $('#image-zone').addEventListener('dragover',event=>{if(event.dataTransfer.types.includes('Files')){event.preventDefault();if(!state.busy)$('#dropzone').classList.add('drag');}});
  $('#image-zone').addEventListener('dragleave',()=>$('#dropzone').classList.remove('drag'));
  $('#image-zone').addEventListener('drop',event=>{event.preventDefault();$('#dropzone').classList.remove('drag');if(state.busy)return;if(event.dataTransfer.files.length!==1){showError('每次请选择一张图片。');return;}selectImage(event.dataTransfer.files[0]);});
  document.addEventListener('paste',event=>{if(state.mode!=='image'||state.busy)return;const files=[...(event.clipboardData?.items||[])].filter(item=>item.kind==='file').map(item=>item.getAsFile()).filter(Boolean);if(!files.length)return;event.preventDefault();if(files.length!==1){showError('每次请粘贴一张图片。');return;}selectImage(files[0]);});
  $$('[data-example]').forEach(button=>button.addEventListener('click',async()=>{
    if(state.busy)return;showError('');$('#evidence').value='';$('#incomplete').checked=false;
    if(button.dataset.example==='image'){
      setMode('image');button.disabled=true;
      try{const response=await fetch('/api/sample-image',{headers:{'X-Review-Token':token}});if(!response.ok)throw new Error('示例图片读取失败。');const blob=await response.blob();await selectImage(new File([blob],'04_清晰测试海报.png',{type:'image/png'}));$('#image-caption').value='';}
      catch(error){showError(error.message);}finally{button.disabled=false;}
    }else{
      setMode('text');$('#ad-text').value=button.dataset.example==='risk'?'全网第一，100%有效！今天下单立减50元！':'这是一款蓝色陶瓷马克杯，容量350毫升，带手柄。';
      $('#ad-text').dispatchEvent(new Event('input'));$('#ad-text').focus();
    }
  }));
  $('#download-md').addEventListener('click',()=>download('md'));$('#download-json').addEventListener('click',()=>download('json'));
  $('#download-pdf').addEventListener('click',()=>{if(!prepareManagementPrint())return;$('#download-status').textContent='请在打印窗口选择“另存为 PDF”。取消保存不会删除报告。';try{window.print();}catch{showReportBackup();$('#download-status').textContent='当前浏览器无法打开打印窗口，请使用系统浏览器保存 PDF，或复制报告文本。';}});
  $('#view-report').addEventListener('click',showReportBackup);
  $('#copy-report').addEventListener('click',async()=>{showReportBackup();try{await navigator.clipboard.writeText($('#report-text').value);$('#download-status').textContent='报告已复制，可粘贴到本地文档。';}catch{$('#download-status').textContent='已选中报告，请按 Ctrl+C 或长按文本复制。';}});
  window.addEventListener('beforeunload',event=>{if(state.busy){event.preventDefault();event.returnValue='';}});
  try{
    const config=await api('/api/config');state.rules=config.rules.rules;state.canCheck=config.key_configured;
    if(config.cloud)showCloudBudget(config.checks_remaining);
    $('#connection').textContent=state.canCheck?'检查服务已就绪':'模型密钥未配置';$('#connection').className='connection '+(state.canCheck?'ok':'error');
    if(!state.canCheck)showError(config.cloud?'检查服务尚未配置完成，请联系演示者。':'模型密钥未配置。请在本地终端运行启动脚本，按提示输入密钥后重新打开页面。');
    $('#rules-list').replaceChildren(...state.rules.map(rule=>{const card=element('article','rule-card');const h=element('h3');h.append(element('span','badge',rule.id),document.createTextNode(rule.title));card.append(h,element('p','',rule.requirement));return card;}));
    $('#rules-version').textContent='A-01 至 A-10：作业题目原文；A-11：用户新增业务规则 · 版本 '+config.rules.version;
  }catch(error){$('#connection').textContent='连接未完成';$('#connection').className='connection error';showError('无法连接检查服务，请刷新页面或重新打开访问入口。');}
}
function showCloudBudget(remaining){$('.action-info p').textContent=Number.isFinite(remaining)?`体验次数剩余 ${remaining} 次`:'检查会使用模型额度';}
init();
$('#return-editor').addEventListener('click',showEditor);
