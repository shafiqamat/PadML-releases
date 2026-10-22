"use strict";
(() => {
  const $=id=>document.getElementById(id),node=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
  const config=window.PADML_CONFIG||{},base=String(config.trainingBase||config.apiBase||'').replace(/\/+$/,''),tokenKey=`padml-training-token:${base}`;
  let token='',jobs=[],selected=null,timer=null,files=[],preparation=null,epoch=0,loaded=null,aiReady=false;
  const urls=[];const campaignNumber=()=>Number($('campaign-number').value),campaign=()=>`campaign${campaignNumber()}`;
  const campaignLabel=id=>String(id||'').replace(/^campaign/,'Campaign ');
  const number=new Intl.NumberFormat(undefined,{maximumSignificantDigits:4}),kb=new Intl.NumberFormat(undefined,{maximumFractionDigits:1});
  const STATES={uploaded:['Uploaded',''],validating:['Validating','running'],validated:['Data checks passed','ok'],training:['Training','running'],
    complete:['Ready for review','ok'],publishing:['Publishing','running'],published:['Published','ok'],failed:['Failed','bad'],publish_failed:['Publish failed','bad'],archived:['Removed','']};
  // Near-zero errors (e.g. synthetic exact fits) stay compact instead of printing fifteen zeros.
  const metric=v=>v===0?'0':Math.abs(v)<1e-3?v.toExponential(2):number.format(v);
  const stateLabel=s=>(STATES[s]||[String(s).replaceAll('_',' ')])[0];
  const OUTPUTS={plateau_force_lbf:['Plateau force','lbf'],plateau_length_in:['Plateau length','in'],energy_in_lbf:['Absorbed energy','in·lbf']};
  let activityKey=null,activityStarted=0,activityTick=null;
  function activity(key,title,detail,{busy=true,done=0,total=0,cloud=false,failed=false}={}){
    if(activityKey!==key){activityStarted=Date.now();clearInterval(activityTick);activityTick=null;}
    activityKey=key;const panel=$('activity-panel');panel.hidden=false;panel.classList.toggle('busy',busy);panel.classList.toggle('failed',failed);panel.classList.toggle('done',!busy&&!failed);
    $('activity-title').textContent=title;$('activity-detail').textContent=detail;$('activity-dismiss').hidden=busy;
    $('activity-spinner').hidden=!busy;$('activity-progress').hidden=!(busy&&total>0);
    if(total>0){$('activity-progress').max=total;$('activity-progress').value=Math.min(done,total);}
    const tick=()=>{const seconds=Math.floor((Date.now()-activityStarted)/1000);$('activity-time').textContent=busy?`${Math.floor(seconds/60)}m ${String(seconds%60).padStart(2,'0')}s in this view`:'';};tick();
    if(busy&&!activityTick)activityTick=setInterval(tick,1000);
    if(!busy){clearInterval(activityTick);activityTick=null;}
    $('activity-hint').textContent=cloud?`Last checked ${new Date().toLocaleTimeString()}. Checks every 5 seconds. Cloud jobs continue if you leave; reconnect and select this version to return.`:busy?'Keep this tab open while this step finishes. Large files and AI analysis can take a few minutes.':'';
  }
  function finishActivity(key,title,detail){if(activityKey===key)activity(key,title,detail,{busy:false});}
  function clearActivity(){clearInterval(activityTick);activityTick=null;activityKey=null;$('activity-panel').hidden=true;}
  $('activity-dismiss').addEventListener('click',clearActivity);
  // Errors appear beside the control that failed; the status panel repeats them for screen-reader users.
  const error=(id,text)=>{$(id).textContent=text||'';$(id).hidden=!text;if(text)activity('error','This step needs attention',text,{busy:false,failed:true});};
  function setStep(current){const order=['upload','questions','train','publish'];document.querySelectorAll('#workflow li').forEach(li=>{const i=order.indexOf(li.dataset.step);
    li.classList.toggle('done',current==='finished'||i<order.indexOf(current));if(li.dataset.step===current)li.setAttribute('aria-current','step');else li.removeAttribute('aria-current');});}
  function reveal(id){const el=$(id);el.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'start'});el.focus({preventScroll:true});}
  function writeHash(){const params=new URLSearchParams({campaign:String(campaignNumber())});if(selected)params.set('version',selected);history.replaceState(null,'',`#${params}`);}
  async function timedFetch(url,options={}){const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),180000);try{return await fetch(url,{...options,signal:controller.signal});}catch(e){if(e.name==='AbortError')throw new Error('The connection timed out. A submitted cloud job may still be running. Refresh its status before starting another run.');throw new Error('Could not reach the workspace. Check your connection, then choose Refresh.');}finally{clearTimeout(timeout);}}
  async function request(path,data){const r=await timedFetch(base+'/api/training/'+path,{method:data===undefined?'GET':'POST',headers:{'X-Training-Token':token,...(data===undefined?{}:{'Content-Type':'application/json'})},...(data===undefined?{}:{body:JSON.stringify(data)})});const body=await r.json();if(!r.ok)throw new Error(body.error||`Request failed (${r.status}). Refresh and try again.`);return body;}
  function resetPreparation(){epoch++;preparation=null;if(activityKey==='prepare')clearActivity();$('conversation').hidden=true;$('prepare-controls').hidden=false;$('prep-status').textContent='';error('prep-error','');if(!selected)setStep('upload');}
  function listFiles(){resetPreparation();$('file-list').replaceChildren(...files.map(f=>node('li',`${f.name} · ${kb.format(f.size/1024)} KB`)));}
  $('raw-files').addEventListener('change',()=>{files=Array.from($('raw-files').files);listFiles();});
  $('drop-zone').addEventListener('dragover',e=>{e.preventDefault();$('drop-zone').classList.add('dragging');});
  $('drop-zone').addEventListener('dragleave',()=>$('drop-zone').classList.remove('dragging'));
  $('drop-zone').addEventListener('drop',e=>{e.preventDefault();$('drop-zone').classList.remove('dragging');files=Array.from(e.dataTransfer.files);listFiles();});
  ['prep-notes','base-run','run-name'].forEach(id=>$(id).addEventListener('change',resetPreparation));
  function updateBaseNote(){const j=jobs.find(j=>j.id===$('base-run').value);$('base-note').textContent=j?.condition_note||(j?'Only compatible family, variables and test conditions can be combined.':'');}
  $('base-run').addEventListener('change',updateBaseNote);
  async function refresh(){const response=await request('jobs');jobs=response.jobs;renderDashboard();}
  function renderDashboard(){
    const active=jobs.filter(j=>(j.campaign_id||j.summary?.campaign_id||'campaign3')===campaign());
    $('campaign-title').textContent=`Campaign ${campaignNumber()}`;
    $('campaign-summary').textContent=active.filter(j=>j.state!=='archived').length?'Select a version to see its dataset, validation and measured-parameter graphs.':'No versions yet. Drop data below to start this campaign.';
    $('version-list').replaceChildren();$('archived-list').replaceChildren();
    active.sort((a,b)=>(b.version||0)-(a.version||0)).forEach(j=>{
      const card=node('article',undefined,'version-card');if(j.id===selected)card.setAttribute('aria-current','true');
      card.append(node('h3',`v${j.version||'?'} · ${j.name}`),node('p',`${stateLabel(j.state)} · ${j.summary?.specimens||0} specimens / ${j.summary?.design_groups||0} designs`));
      const button=node('button',j.state==='archived'?'Restore version group':'View data and graphs');button.type='button';button.addEventListener('click',async()=>{try{if(j.state==='archived'){await request(`jobs/${j.id}/restore`,{});await refresh();}else{await openJob(j.id);reveal('run-title');}}catch(e){error('connection-error',e.message);}});card.append(button);
      $(j.state==='archived'?'archived-list':'version-list').append(card);
    });
    const old=$('base-run').value;$('base-run').replaceChildren(new Option('New dataset—uploaded data only',''));
    active.filter(j=>j.state!=='archived'&&(j.evaluation||j.historical)).forEach(j=>$('base-run').append(new Option(`v${j.version||'?'} · ${j.name}`,j.id)));
    $('base-run').value=old;updateBaseNote();
  }
  function showConnected(connected){$('connection').hidden=connected;$('workspace').hidden=!connected;}
  $('connect-form').addEventListener('submit',async e=>{e.preventDefault();token=$('admin-token').value;error('connection-error','');const b=e.submitter||$('connect-form').querySelector('button');b.disabled=true;activity('connect','Connecting to the workspace…','Loading campaign versions and checking AI availability.');
    try{const params=new URLSearchParams(location.hash.slice(1));if(Number(params.get('campaign'))>0)$('campaign-number').value=params.get('campaign');
      await refresh();sessionStorage.setItem(tokenKey,token);showConnected(true);$('connection-status').textContent='';
      const capability=await request('preparation');aiReady=capability.configured;$('analyze').disabled=!aiReady;$('prep-availability').textContent=aiReady?'GPT-6 Luna · medium reasoning':'AI preparation is unavailable: the OpenAI API key is not configured.';
      finishActivity('connect','Workspace connected','Choose a campaign and drop your experiment files to begin.');setStep('upload');
      const version=params.get('version');if(version&&jobs.some(j=>j.id===version)){await openJob(version);reveal('run-title');}
    }catch(err){error('connection-error',err.message);}finally{b.disabled=false;}});
  $('disconnect').addEventListener('click',()=>{clearTimeout(timer);clearActivity();resetPreparation();token='';selected=null;sessionStorage.removeItem(tokenKey);$('admin-token').value='';showConnected(false);$('connection-status').textContent='Disconnected.';history.replaceState(null,'',location.pathname);$('admin-token').focus();});
  $('refresh').addEventListener('click',async()=>{activity('refresh','Checking the latest status…','Contacting the workspace.');try{await refresh();if(selected)await openJob(selected);else finishActivity('refresh','Workspace updated','The latest campaign versions are shown below.');}catch(e){error('connection-error',e.message);}});
  function showUpload(){clearTimeout(timer);clearActivity();selected=null;resetPreparation();renderDashboard();$('upload-panel').hidden=false;$('run-panel').hidden=true;setStep('upload');writeHash();}
  $('campaign-number').addEventListener('change',()=>{if($('campaign-number').checkValidity())showUpload();});
  $('new-upload').addEventListener('click',()=>{showUpload();$('run-name').focus();});
  function renderPreparation(result){
    $('conversation').hidden=false;$('prepare-controls').hidden=true;
    $('questions').replaceChildren(...result.plan.questions.map(q=>node('li',q)));
    $('warning-list').replaceChildren(...result.plan.warnings.map(w=>node('li',w)));$('warnings').hidden=!result.plan.warnings.length;
    $('mapping-plan').textContent=JSON.stringify(result.plan,null,2);$('prep-answer').value='';
    const summary=$('prepared-summary');summary.replaceChildren();summary.hidden=!result.summary;
    const ready=Boolean(result.summary);$('accept-row').hidden=!ready;$('historical-confirm').checked=false;
    $('historical-confirm-line').hidden=!(ready&&jobs.find(j=>j.id===$('base-run').value)?.historical);
    $('answer-label').textContent=ready?'Corrections (optional)':'Your answers';$('answer').className=ready?'':'primary';$('answer').textContent=ready?'Send corrections to Luna':'Send answer to Luna';
    if(ready){const p=result.plan;summary.append(node('h4',`${result.summary.specimens} specimens · ${result.summary.designs} designs · ${number.format(result.summary.curve_points||0)} curve points`),
      node('p',`${p.family} · ${p.material} · fixture: ${p.fixture} · ${p.speed_in_min} in/min · 0.8 in stroke`),node('p',`Inputs: ${p.variables.map(v=>`${v.name} (${v.unit})`).join(', ')}`));
      if($('base-run').value)summary.append(node('p','Includes the selected earlier dataset. Only compatible mappings, material, fixture and test conditions can be combined.'));}
    setStep(ready?'train':'questions');
  }
  async function analyze(answer){const generation=epoch;error('prep-error','');$('analyze').disabled=true;$('answer').disabled=true;activity('prepare','Preparing your upload…','Checking files and connecting to private storage.');
    try{
      if(!preparation){
        if(!$('prep-consent').checked)throw new Error('Tick “Share these samples and notes with OpenAI” to continue.');
        if(!files.length||files.length>50||files.reduce((n,f)=>n+f.size,0)>64*1024*1024)throw new Error('Choose 1–50 files, at most 64 MB in total.');
        $('prep-status').textContent='Uploading your files to private storage…';
        const upload=await request('smart/uploads',{campaign_id:campaign(),name:$('run-name').value.trim()||`Campaign ${campaignNumber()}`,base_id:$('base-run').value||null,notes:$('prep-notes').value,share_samples_with_openai:true,files:files.map(f=>({name:f.name,size:f.size}))});
        let uploaded=0;
        for(const post of upload.uploads){if(generation!==epoch)return;activity('prepare',`Uploading file ${uploaded+1} of ${upload.uploads.length}…`,post.name,{done:uploaded,total:upload.uploads.length});const form=new FormData();Object.entries(post.fields).forEach(([k,v])=>form.append(k,v));form.append('file',files.find(f=>f.name===post.name),post.name);const r=await timedFetch(post.url,{method:'POST',body:form});if(!r.ok)throw new Error('Upload failed. Select the files again to retry.');uploaded++;}
        if(generation!==epoch)return;preparation={id:upload.id};
      }
      $('prep-status').textContent='Luna is identifying your data and checking what is missing…';
      activity('prepare','Luna is reviewing your data…','Identifying tables, checking units and mappings, and preparing any clarification questions. No training has started yet.');
      const result=await request(`smart/${preparation.id}/analyze`,{answer:answer||''});if(generation!==epoch)return;
      preparation={...preparation,...result};renderPreparation(result);
      $('prep-status').textContent=result.summary?'Dataset prepared. Review the summary below.':'Luna needs your answers before it can prepare the dataset.';
      finishActivity('prepare',result.summary?'Your prepared dataset is ready':'Luna needs your answers',result.summary?'Review the summary, then choose “Use this prepared dataset”.':'Answer the numbered questions in Luna’s data review.');
      reveal('conversation-title');
    }catch(e){if(generation===epoch){error('prep-error',e.message);$('prep-status').textContent='';}}finally{$('analyze').disabled=!aiReady;$('answer').disabled=false;}
  }
  $('prep-consent').addEventListener('change',()=>{if($('prep-consent').checked)error('prep-error','');});
  $('analyze').addEventListener('click',()=>analyze(''));
  $('answer').addEventListener('click',()=>{if(!$('prep-answer').value.trim()){error('prep-error','Type your answer or correction in the box above, then send it.');$('prep-answer').focus();return;}analyze($('prep-answer').value);});
  $('accept').addEventListener('click',async()=>{const historical=!$('historical-confirm-line').hidden;if(historical&&!$('historical-confirm').checked){error('prep-error','Tick the confirmation that the earlier dataset used the same mapping and test conditions.');$('historical-confirm').focus();return;}
    const b=$('accept');b.disabled=true;b.textContent='Submitting…';activity('accept','Submitting your prepared dataset…','Saving the reviewed mapping and starting cloud validation.');try{const job=await request(`smart/${preparation.id}/accept`,{reviewed:true,historical_conditions_confirmed:historical&&$('historical-confirm').checked});await refresh();await openJob(job.id);reveal('run-title');}catch(e){error('prep-error',e.message);}finally{b.disabled=false;b.textContent='Use this prepared dataset';}});
  async function artifact(id,name){const info=await request(`jobs/${id}/artifacts/${name}`);const r=await timedFetch(info.download_url);if(!r.ok)throw new Error('Report download failed. Choose Refresh to retry.');return r;}
  function metricsTable(evaluation){const table=node('table',undefined,'metrics'),head=node('tr');['Output','Held-out MAE','R²','Mean-baseline MAE'].forEach(x=>{const th=node('th',x);th.scope='col';head.append(th);});table.append(head);
    Object.entries(evaluation.metrics||{}).forEach(([n,m])=>{const [label,unit]=OUTPUTS[n]||[n.replaceAll('_',' '),''],row=node('tr'),b=evaluation.mean_baseline?.[n]?.mae;
      [`${label}${unit?` (${unit})`:''}`,metric(m.mae),m.r2==null?'Not estimable':m.r2.toFixed(3),b==null?'See report':metric(b)].forEach((x,i)=>{const cell=node(i?'td':'th',x);if(!i)cell.scope='row';row.append(cell);});table.append(row);});
    table.append(node('caption','MAE is in each output’s unit. Lower is better; compare it with the mean baseline.'));return table;}
  async function openJob(id){clearTimeout(timer);const switched=selected!==id;if(switched){loaded=null;activity('job:'+id,'Loading this version…','Retrieving its current status and available results.');}selected=id;$('upload-panel').hidden=true;$('run-panel').hidden=false;error('run-error','');error('publish-error','');writeHash();
    const job=await request(`jobs/${id}`);if(selected!==id)return;if(job.state==='archived'){clearActivity();$('run-panel').hidden=true;selected=null;writeHash();await refresh();return;}
    // Keep the version cards in step with the panel while the cloud job advances.
    // Re-render only on change so polling does not move keyboard focus.
    const index=jobs.findIndex(j=>j.id===id),changed=index<0||jobs[index].state!==job.state||jobs[index].summary?.specimens!==job.summary?.specimens;
    if(changed){if(index<0)jobs.push(job);else jobs[index]={...jobs[index],...job};}if(changed||switched)renderDashboard();
    $('run-title').textContent=`v${job.version||'?'} · ${job.name}`;const [label,tone]=STATES[job.state]||[job.state,''];$('run-state').textContent=label;$('run-state').className=`status-badge ${tone}`;
    $('run-counts').textContent=`${job.summary?.specimens||0} specimens / ${job.summary?.design_groups||0} designs`;
    $('run-summary').textContent=job.condition_note||`Inputs: ${(job.summary?.features||[]).join(', ')||'checked during validation'}`;error('run-error',job.error||'');
    const running=['validating','training','publishing'].includes(job.state),progress=job.progress||{};
    setStep(job.state==='published'?'finished':['complete','publishing','publish_failed'].includes(job.state)?'publish':'train');
    if(running){
      let title='Validating your dataset…',detail='The cloud worker is starting or checking measurements, specimen mappings and test conditions.';
      if(job.state==='publishing'){title='Publishing this model…';detail='Checking the model package and hosted predictions before making this version available in Predictor.';}
      if(job.state==='training'){
        title='Training and evaluating models…';detail='The cloud worker is starting and preparing grouped validation. This can take several minutes.';
        if(progress.total_folds){detail=`Completed ${progress.completed_folds||0} of ${progress.total_folds} held-out-design checks. Each check tests several regression models.`;}
        if(progress.stage==='final_fit'||progress.completed_folds===progress.total_folds&&progress.total_folds){title='Fitting final models and preparing results…';detail='Held-out checks are finished. Selecting final estimators and generating the report and graphs.';}
        if(progress.stage==='reports'){title='Generating your report and graphs…';detail='Saving validation results and measured-parameter plots.';}
      }
      activity('job:'+id,title,detail,{cloud:true,done:progress.completed_folds||0,total:job.state==='training'&&progress.stage==='nested_validation'?progress.total_folds||0:0});
    }else if(!job.error){activity('job:'+id,job.state==='validated'?'Data checks passed':job.state==='published'?'This version is published':job.state==='complete'?'Training complete':'Version status: '+stateLabel(job.state),job.state==='validated'?'Choose “Train this version” to continue.':job.state==='published'?'Reload Predictor to select this model.':'Review this version’s status and results below.',{busy:false});}
    $('run-progress').textContent=running?(job.state==='training'&&progress.total_folds?`Validating design ${progress.completed_folds} of ${progress.total_folds}`:`${stateLabel(job.state)} in the cloud…`):'';
    $('start-training').hidden=job.state!=='validated';$('start-training').disabled=!job.summary?.training_minimum_met;
    if(job.state==='validated'&&!job.summary?.training_minimum_met)$('run-progress').textContent='Training needs at least 12 independent designs.';
    $('review-panel').hidden=!(job.evaluation||job.historical);$('publish-panel').hidden=!['complete','publish_failed'].includes(job.state)||job.historical;
    $('remove-panel').hidden=running;$('publication-result').textContent=job.state==='published'?'Available in Predictor. Reload Predictor to select this version.':'';
    if((job.evaluation||job.historical)&&loaded!==id){
      activity('job:'+id,'Loading the report and graphs…','Retrieving saved results from private storage.');
      $('figures').replaceChildren();$('metrics').replaceChildren();$('report-links').replaceChildren();$('reviewed').checked=false;
      const evaluation=job.evaluation;if(evaluation){$('validation-method').textContent=evaluation.method;$('metrics').append(metricsTable(evaluation));}else $('validation-method').textContent='Historical validation: see the versioned report for methods and caveats.';
      const report=await (await artifact(id,'REPORT.md')).text();if(selected!==id)return;$('training-report').textContent=report;
      for(const [name,caption,tall] of [['validation.png','Measured versus held-out predicted outcomes',false],['measured_force_vs_parameters.png','Measured plateau force by parameter',true],['measured_length_vs_parameters.png','Measured plateau length by parameter',true]]){
        const blob=await(await artifact(id,name)).blob();if(selected!==id)return;const url=URL.createObjectURL(blob);urls.push(url);
        const fig=node('figure',undefined,tall?'tall':''),img=node('img'),cap=node('figcaption',caption),open=node('a','Open full size');img.src=url;img.alt=caption;img.loading='lazy';img.decoding='async';open.href=url;open.target='_blank';open.rel='noopener';cap.append(open);fig.append(cap,img);$('figures').append(fig);}
      loaded=id;
      if(job.error)error('run-error',job.error);else finishActivity('job:'+id,job.state==='published'?'Published version ready':'Results ready for review','The report and all three graphs are loaded below.');
    }
    if(running)timer=setTimeout(()=>openJob(id).catch(e=>error('run-error',e.message)),5000);
  }
  async function runAction(button,action,payload){const label=button.textContent;button.disabled=true;button.textContent=action==='train'?'Starting…':'Publishing…';activity('submit',action==='train'?'Starting training…':'Starting publication…','Submitting your request to the cloud worker.');try{await request(`jobs/${selected}/${action}`,payload);loaded=null;await refresh();await openJob(selected);}catch(e){error(action==='publish'?'publish-error':'run-error',e.message);}finally{button.disabled=false;button.textContent=label;}}
  $('start-training').addEventListener('click',()=>runAction($('start-training'),'train',{}));
  $('reviewed').addEventListener('change',()=>{if($('reviewed').checked)error('publish-error','');});
  $('publish').addEventListener('click',()=>{if(!$('reviewed').checked){error('publish-error','Tick “I reviewed the report and all three graphs” before publishing.');$('reviewed').focus();return;}
    const j=jobs.find(j=>j.id===selected);runAction($('publish'),'publish',{reviewed:true,slug:`${campaign()}-v${j.version}`,name:`${campaignLabel(campaign())} · v${j.version}`});});
  $('remove-version').addEventListener('click',async()=>{if(!$('remove-confirm').checked){error('run-error','Tick the removal confirmation first. This also removes dependent versions.');$('remove-confirm').focus();return;}const b=$('remove-version');b.disabled=true;try{await request(`jobs/${selected}/archive`,{confirmed:true,reason:$('remove-reason').value});selected=null;loaded=null;$('run-panel').hidden=true;$('upload-panel').hidden=false;setStep('upload');$('remove-confirm').checked=false;$('remove-panel').open=false;await refresh();writeHash();finishActivity(activityKey,'Version removed','It is listed under “Removed versions” and can be restored.');}catch(e){error('run-error',e.message);}finally{b.disabled=false;}});
  if(sessionStorage.getItem(tokenKey)){$('admin-token').value=sessionStorage.getItem(tokenKey);$('connect-form').requestSubmit();}
  window.addEventListener('beforeunload',()=>urls.forEach(u=>URL.revokeObjectURL(u)));
})();
