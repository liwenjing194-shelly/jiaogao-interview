'use strict';
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const token = $('meta[name="review-token"]').content;
const state = {mode:'text', image:null, preview:null, busy:false, result:null, rules:[], canCheck:false, imageVersion:0, loadingImage:false};
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
  $('#image-status').textContent='尚未选择图片。选择后会显示预览，再点击底部“开始检查”。';
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
    $('#image-status').textContent=`已选择 ${file.name} · ${probe.naturalWidth} × ${probe.naturalHeight} · ${(file.size/1024/1024).toFixed(2)} MB。点击底部按钮提交检查。`;
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
}
function sourceBlock(parent,label,content){parent.append(element('p','source-label',label),element('pre','',content||'无'));}
function renderResult(data,historical=false){
  state.result=data;
  $('#report-text').value=data.markdown||'';$('#report-backup').open=false;$('#download-status').textContent='';
  if(data.checks_remaining!==undefined)showCloudBudget(data.checks_remaining);
  const r=data.report, issues=r.checks.flatMap(c=>c.issues);
  $('#loading-result').hidden=true;$('#empty-result').hidden=true;$('#result-content').hidden=false;
  $('#stale-notice').hidden=true;$('#history-notice').hidden=!historical;
  const uncertain=r.overall_status==='无法完整判断', clean=!issues.length&&r.input_complete;
  $('#summary').className='result-summary'+(clean?' clean':uncertain?' uncertain':'');
  $('#summary-title').textContent=clean?'初筛通过，未发现明确规则风险':uncertain?'信息待补充，暂不能完成初筛':'发现规则风险，建议修改后复查';
  $('#summary-note').textContent=clean?'本次提交材料通过题目十条规则初筛；可选优化不影响此结论，不代表全面合规认证。':r.input_complete?'请逐项处理规则问题；可选表达优化单独列出。':'已保留可见问题；检查不完整，请补充清晰原文件。';
  $('#summary-symbol').textContent=clean?'✓':uncertain?'?':'!';
  $('#summary-kicker').textContent=historical?'历史检查结果':'检查完成';
  $('#issue-count').textContent=issues.length;$('#rule-count').textContent=r.checks.length;
  $('#run-time').textContent=Number(data.run.elapsed_seconds).toFixed(1);
  $('#result-label').textContent=new Date(data.run.executed_at).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})+' 完成';
  $('#review-required').textContent=r.needs_human_review?'需要人工审核':'无待复核事项';
  $('#limitations').hidden=!r.limitations.length;$('#limitation-list').replaceChildren(...r.limitations.map(t=>element('li','',t)));
  const list=$('#issues');list.replaceChildren();
  const optimizations=r.optimization_suggestions||[];
  $('#optimizations').hidden=!optimizations.length;
  $('#optimization-list').replaceChildren(...optimizations.map(t=>element('p','clean-note',t)));
  if(!issues.length)list.append(element('p','clean-note','这份材料在给定规则范围内没有发现需要整改的问题。'));
  issues.forEach(issue=>{
    const card=element('article','issue-card'),head=element('div','issue-heading'),title=element('div','issue-title');
    title.append(element('span','badge',issue.rule_id),document.createTextNode(issue.risk_type));
    const level=issue.risk_level, color=level==='高'?'high':level==='低'?'low':'medium';
    head.append(title,element('span',`badge ${color}`,level==='待确认'?level:`${level}风险`));
    card.append(head,element('p','quote-label','风险原文'),element('blockquote','issue-quote',issue.original_text),
      element('p','issue-rule','对应规则：'+issue.rule_text),element('p','issue-suggestion','修改建议：'+issue.suggestion),
      element('p','issue-human',`人工审核：${issue.needs_human_review?'需要':'不需要'}${issue.human_review_reason?' · '+issue.human_review_reason:''}`));
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
    $('#action-progress').textContent='检查完成，可查看结果或修改后复查';
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
  const list=$('#history-list');list.replaceChildren(element('p','history-empty','正在读取检查记录…'));
  try{
    const {items}=await api('/api/history');list.replaceChildren();
    if(!items.length)list.append(element('p','history-empty','还没有检查记录。提交第一份材料后，结果会出现在这里。'));
    items.forEach(item=>{
      const button=element('button','history-card'),body=element('div');button.type='button';
      body.append(element('strong','',item.title),element('small','',`${new Date(item.time).toLocaleString('zh-CN')} · ${item.kind}`));
      button.append(body,element('span','history-status',(item.status==='在本次输入和给定规则范围内未发现风险'?'本次未发现风险':item.status)+'  →'));
      button.addEventListener('click',async()=>{button.disabled=true;try{const report=await api('/api/reports/'+encodeURIComponent(item.id));switchView('review');renderResult(report,true);}catch(error){list.prepend(element('p','error-message',error.message));}finally{button.disabled=false;}});
      list.append(button);
    });
  }catch(error){list.replaceChildren(element('p','error-message',error.message));}
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
    const blob=new Blob(['\ufeff',format==='md'?result.markdown:JSON.stringify(clean,null,2)],{type:type+';charset=utf-8'});
    if(typeof window.showSaveFilePicker==='function'){
      const handle=await window.showSaveFilePicker({suggestedName:filename});
      const writable=await handle.createWritable();
      try{await writable.write(blob);await writable.close();}catch(error){await writable.abort().catch(()=>{});throw error;}
      $('#download-status').textContent='报告已保存。检查结果仍保留在本页。';
    }else{
      const url=URL.createObjectURL(blob),a=document.createElement('a');
      a.href=url;a.download=filename;a.target='_blank';a.rel='noopener';a.hidden=true;document.body.append(a);
      // 不让不支持download的浏览器用临时文件替换工作台；给予下载充分读取时间。
      try{a.click();}finally{setTimeout(()=>{a.remove();URL.revokeObjectURL(url);},60000);}
      $('#download-status').textContent='已请求下载，请查看浏览器下载列表。如果没有文件，可用“查看 / 复制报告”保存。';
    }
  }catch(error){
    if(error.name==='AbortError')$('#download-status').textContent='已取消保存，报告仍保留在本页。';
    else{showReportBackup();$('#download-status').textContent='未能启动下载。报告仍保留在本页，请复制下方文本保存，或在系统浏览器中打开后重试。';}
  }finally{buttons.forEach(b=>b.disabled=false);}
}
async function init(){
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
  $('#view-report').addEventListener('click',showReportBackup);
  $('#copy-report').addEventListener('click',async()=>{showReportBackup();try{await navigator.clipboard.writeText($('#report-text').value);$('#download-status').textContent='报告已复制，可粘贴到本地文档。';}catch{$('#download-status').textContent='已选中报告，请按 Ctrl+C 或长按文本复制。';}});
  window.addEventListener('beforeunload',event=>{if(state.busy){event.preventDefault();event.returnValue='';}});
  try{
    const config=await api('/api/config');state.rules=config.rules.rules;state.canCheck=config.key_configured;
    if(config.cloud)showCloudBudget(config.checks_remaining);
    $('#connection').textContent=state.canCheck?'检查服务已就绪':'模型密钥未配置';$('#connection').className='connection '+(state.canCheck?'ok':'error');
    if(!state.canCheck)showError(config.cloud?'检查服务尚未配置完成，请联系演示者。':'模型密钥未配置。请在本地终端运行启动脚本，按提示输入密钥后重新打开页面。');
    $('#rules-list').replaceChildren(...state.rules.map(rule=>{const card=element('article','rule-card');const h=element('h3');h.append(element('span','badge',rule.id),document.createTextNode(rule.title));card.append(h,element('p','',rule.requirement));return card;}));
    $('#rules-version').textContent='规则来源：作业题目及要求.docx · 版本 '+config.rules.version;
  }catch(error){$('#connection').textContent='连接未完成';$('#connection').className='connection error';showError('无法连接检查服务，请刷新页面或重新打开访问入口。');}
}
function showCloudBudget(remaining){$('.action-info p').textContent=`体验版剩余 ${remaining} 次检查 · 非百炼账户余额`;}
init();
