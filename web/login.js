'use strict';
const form=document.querySelector('#login-form'),code=document.querySelector('#code'),submit=document.querySelector('#login-submit'),label=document.querySelector('#button-label'),error=document.querySelector('#login-error'),statusText=document.querySelector('#login-status'),toggle=document.querySelector('#toggle-code');
let busy=false;toggle.hidden=false;
toggle.addEventListener('click',()=>{const show=code.type==='password';code.type=show?'text':'password';toggle.textContent=show?'隐藏':'显示';toggle.setAttribute('aria-pressed',String(show));});
function reset(){busy=false;form.setAttribute('aria-busy','false');submit.disabled=false;code.readOnly=false;toggle.disabled=false;label.textContent='进入工作台';statusText.textContent='';}
window.addEventListener('pageshow',reset);
if(error.textContent.trim())code.setAttribute('aria-invalid','true');
form.addEventListener('submit',async event=>{
event.preventDefault();if(busy)return;busy=true;form.setAttribute('aria-busy','true');submit.disabled=true;code.readOnly=true;toggle.disabled=true;error.textContent='';code.removeAttribute('aria-invalid');label.textContent='正在登录…';statusText.textContent='正在验证访问码，请稍候。';
const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),25000);
try{const response=await fetch('/login',{method:'POST',body:new URLSearchParams({code:code.value}),credentials:'same-origin',signal:controller.signal});
if(response.ok&&response.redirected&&new URL(response.url).pathname==='/'){label.textContent='即将进入…';statusText.textContent='验证成功，正在打开工作台。';window.location.assign('/');return;}
if(response.status===401){code.setAttribute('aria-invalid','true');throw new Error('访问码不正确，请检查后重试。');}
if(response.status===429)throw new Error('尝试次数较多，请一分钟后再试。');
if(response.status===403)throw new Error('登录请求未通过验证，请刷新页面后重试。');throw new Error('登录暂未完成，请稍后重试。');
}catch(e){error.textContent=e.name==='AbortError'?'等待时间较长，请稍后刷新页面确认是否已登录。':e instanceof TypeError?'无法连接服务，请检查网络后重试。':e.message;reset();code.focus();}finally{clearTimeout(timer);}
});
