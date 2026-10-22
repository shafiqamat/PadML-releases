"use strict";
(() => {
  const $=id=>document.getElementById(id),node=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
  const config=window.PADML_CONFIG||{},base=String(config.trainingBase||config.apiBase||'').replace(/\/+$/,''),tokenKey=`padml-training-token:${base}`;
  let token='',jobs=[],selected=null,timer=null,files=[],preparation=null,epoch=0,loaded=null,aiReady=false;
  const urls=[];const campaign=()=>`campaign${Number($('campaign-number').value)}`;
  let activityKey=null,activityStarted=0,activityTick=null;
  function activity(key,title,detail,{busy=true,done=0,total=0,cloud=false}={}){
    if(activityKey!==key){activityStarted=Date.now();clearInterval(activityTick);activityTick=null;}
    activityKey=key;$('activity-panel').hidden=false;$('activity-title').textContent=title;$('activity-detail').textContent=detail;
    $('activity-spinner').hidden=!busy;$('activity-progress').hidden=!(busy&&total>0);
    if(total>0){$('activity-progress').max=total;$('activity-progress').value=Math.min(done,total);}
    const tick=()=>{const seconds=Math.floor((Date.now()-activityStarted)/1000);$('activity-time').textContent=busy?`${Math.floor(seconds/60)}m ${String(seconds%60).padStart(2,'0')}s in this view`:'';};tick();
    if(busy&&!activityTick)activityTick=setInterval(tick,1000);
    if(!busy){clearInterval(activityTick);activityTick=null;}
    $('activity-hint').textContent=cloud?`Last checked ${new Date().toLocaleTimeString()}. Checks every 5 seconds. Cloud jobs continue if you leave; reconnect and select this version to return.`:busy?'Keep this tab open while this step finishes. Large files and AI analysis can take a few minutes.':'';
  }
  function finishActivity(key,title,detail){if(activityKey===key)activity(key,title,detail,{busy:false});}
  function clearActivity(){clearInterval(activityTick);activityTick=null;activityKey=null;$('activity-panel').hidden=true;}
  const error=(id,text)=>{$(id).textContent=text||'';$(id).hidden=!text;if(text)activity('error','This step needs attention',text,{busy:false});};
  async function timedFetch(url,options={}){const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),180000);try{return await fetch(url,{...options,signal:controller.signal});}catch(e){if(e.name==='AbortError')throw new Error('The connection timed out. A submitted cloud job may still be running. Refresh its status before starting another run.');throw e;}finally{clearTimeout(timeout);}}
  async function request(path,data){const r=await timedFetch(base+'/api/training/'+path,{method:data===undefined?'GET':'POST',headers:{'X-Training-Token':token,...(data===undefined?{}:{'Content-Type':'application/json'})},...(data===undefined?{}:{body:JSON.stringify(data)})});const body=await r.json();if(!r.ok)throw new Error(body.error||`Request failed (${r.status})`);return body;}
  function resetPreparation(){epoch++;preparation=null;if(activityKey==='prepare')clearActivity();$('conversation').hidden=true;$('prep-status').textContent='';}
  function listFiles(){resetPreparation();$('file-list').replaceChildren(...files.map(f=>node('li',`${f.name} · ${(f.size/1024).toFixed(1)} KB`)));}
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
    $('campaign-title').textContent=`Campaign ${Number($('campaign-number').value)}`;
    $('campaign-summary').textContent=active.filter(j=>j.state!=='archived').length?'Select a version to see its dataset, validation and measured-parameter graphs.':'No versions yet. Drop data below to start this campaign.';
    $('version-list').replaceChildren();$('archived-list').replaceChildren();
    active.sort((a,b)=>(b.version||0)-(a.version||0)).forEach(j=>{
      const card=node('div',undefined,'version-card');card.append(node('h3',`v${j.version||'?'} · ${j.name}`),node('p',`${j.state.replaceAll('_',' ')} · ${j.summary?.specimens||0} specimens / ${j.summary?.design_groups||0} designs`));
      const button=node('button',j.state==='archived'?'Restore version group':'View data and graphs');button.type='button';button.addEventListener('click',async()=>{try{if(j.state==='archived'){await request(`jobs/${j.id}/restore`,{});await refresh();}else await openJob(j.id);}catch(e){error('connection-error',e.message);}});card.append(button);
      $(j.state==='archived'?'archived-list':'version-list').append(card);
    });
    const old=$('base-run').value;$('base-run').replaceChildren(new Option('New dataset—uploaded data only',''));
    active.filter(j=>j.state!=='archived'&&(j.evaluation||j.historical)).forEach(j=>$('base-run').append(new Option(`v${j.version||'?'} · ${j.name}`,j.id)));
    $('base-run').value=old;updateBaseNote();
  }
  $('connect-form').addEventListener('submit',async e=>{e.preventDefault();token=$('admin-token').value;error('connection-error','');const b=e.submitter||$('connect-form').querySelector('button');b.disabled=true;activity('connect','Connecting to the workspace','Loading campaign versions and checking AI availability…');try{await refresh();sessionStorage.setItem(tokenKey,token);$('workspace').hidden=false;$('connection-status').textContent='Connected. Cloud jobs continue when you close this tab.';const capability=await request('preparation');aiReady=capability.configured;$('analyze').disabled=!aiReady;$('prep-availability').textContent=aiReady?'GPT-6 Luna · medium reasoning':'OpenAI API key is not configured.';}catch(err){error('connection-error',err.message);}finally{b.disabled=false;finishActivity('connect','Workspace connected','Choose a campaign and drop your experiment files to begin.');}});
  $('disconnect').addEventListener('click',()=>{clearTimeout(timer);clearActivity();resetPreparation();token='';selected=null;sessionStorage.removeItem(tokenKey);$('admin-token').value='';$('workspace').hidden=true;$('connection-status').textContent='Disconnected.';});
  $('refresh').addEventListener('click',async()=>{activity('refresh','Checking the latest status','Contacting the workspace…');try{await refresh();if(selected)await openJob(selected);else finishActivity('refresh','Workspace updated','The latest campaign versions are shown below.');}catch(e){error('connection-error',e.message);}});
  $('campaign-number').addEventListener('change',()=>{if(!$('campaign-number').checkValidity())return;clearTimeout(timer);clearActivity();selected=null;resetPreparation();renderDashboard();$('upload-panel').hidden=false;$('run-panel').hidden=true;});
  $('new-upload').addEventListener('click',()=>{clearTimeout(timer);clearActivity();resetPreparation();selected=null;$('upload-panel').hidden=false;$('run-panel').hidden=true;$('run-name').focus();});
  async function analyze(answer){const generation=epoch;error('prep-error','');$('analyze').disabled=true;$('answer').disabled=true;$('accept').hidden=true;activity('prepare','Preparing your upload','Checking files and connecting to private storage…');
    try{
      if(!preparation){
        if(!$('prep-consent').checked)throw new Error('Confirm sharing samples and notes with OpenAI first.');
        if(!files.length||files.length>50||files.reduce((n,f)=>n+f.size,0)>64*1024*1024)throw new Error('Choose 1–50 files, at most 64 MB total.');
        $('prep-status').textContent='Uploading your files to private storage…';
        const upload=await request('smart/uploads',{campaign_id:campaign(),name:$('run-name').value,base_id:$('base-run').value||null,notes:$('prep-notes').value,share_samples_with_openai:true,files:files.map(f=>({name:f.name,size:f.size}))});
        let uploaded=0;
        for(const post of upload.uploads){if(generation!==epoch)return;activity('prepare',`Uploading file ${uploaded+1} of ${upload.uploads.length}`,post.name);const form=new FormData();Object.entries(post.fields).forEach(([k,v])=>form.append(k,v));form.append('file',files.find(f=>f.name===post.name),post.name);const r=await timedFetch(post.url,{method:'POST',body:form});if(!r.ok)throw new Error('Upload failed. Select the files again to retry.');uploaded++;}
        if(generation!==epoch)return;preparation={id:upload.id};
      }
      $('prep-status').textContent='Luna is identifying your data and checking what is missing…';
      activity('prepare','Luna is reviewing your data','Identifying tables, checking units and mappings, and preparing any clarification questions. No training has started yet.');
      const result=await request(`smart/${preparation.id}/analyze`,{answer:answer||''});if(generation!==epoch)return;
      preparation={...preparation,...result};$('conversation').hidden=false;$('questions').replaceChildren();
      result.plan.questions.forEach(q=>$('questions').append(node('p',q)));
      result.plan.warnings.forEach(w=>$('questions').append(node('p',w,'hint')));
      $('mapping-plan').textContent=JSON.stringify(result.plan,null,2);$('prepared-summary').replaceChildren();$('prep-answer').value='';
      if(result.summary){const p=result.plan;$('prepared-summary').append(node('h3',`${result.summary.specimens} specimens · ${result.summary.designs} designs`),node('p',`${p.family} · ${p.material} · fixture: ${p.fixture} · ${p.speed_in_min} in/min · 0.8 in stroke`),node('p',`Inputs: ${p.variables.map(v=>`${v.name} (${v.unit})`).join(', ')}`));
        if($('base-run').value)$('prepared-summary').append(node('p','Includes the selected earlier dataset. By continuing you confirm its mapping and the same material, fixture and test conditions.'));
        $('accept').hidden=false;$('prep-status').textContent='Dataset prepared. Review the summary, or send corrections below.';
      }else $('prep-status').textContent='Luna needs your answers before it can prepare the dataset.';
      finishActivity('prepare',result.summary?'Your prepared dataset is ready':'Luna needs your answers',result.summary?'Review the summary below, then choose “Use this prepared dataset”.':'Answer the questions in Luna’s data review below to continue.');
    }catch(e){if(generation===epoch){error('prep-error',e.message);$('prep-status').textContent='Preparation needs attention.';}}finally{$('analyze').disabled=!aiReady;$('answer').disabled=false;}
  }
  $('analyze').addEventListener('click',()=>analyze(''));
  $('answer').addEventListener('click',()=>{if(!$('prep-answer').value.trim()){error('prep-error','Enter an answer or correction.');return;}analyze($('prep-answer').value);});
  $('accept').addEventListener('click',async()=>{const b=$('accept');b.disabled=true;activity('accept','Submitting your prepared dataset','Saving the reviewed mapping and starting cloud validation…');try{const job=await request(`smart/${preparation.id}/accept`,{reviewed:true});await refresh();await openJob(job.id);}catch(e){error('prep-error',e.message);}finally{b.disabled=false;}});
  async function artifact(id,name){const info=await request(`jobs/${id}/artifacts/${name}`);const r=await timedFetch(info.download_url);if(!r.ok)throw new Error('Report download failed. Refresh to retry.');return r;}
  async function openJob(id){clearTimeout(timer);if(selected!==id){loaded=null;activity('job:'+id,'Loading this version','Retrieving its current status and available results…');}selected=id;$('upload-panel').hidden=true;$('run-panel').hidden=false;error('run-error','');
    const job=await request(`jobs/${id}`);if(selected!==id)return;if(job.state==='archived'){clearActivity();$('run-panel').hidden=true;await refresh();return;}
    $('run-title').textContent=`v${job.version||'?'} · ${job.name}`;$('run-state').textContent=job.state.replaceAll('_',' ');$('run-counts').textContent=`${job.summary?.specimens||0} specimens / ${job.summary?.design_groups||0} designs`;
    $('run-summary').textContent=job.condition_note||`Inputs: ${(job.summary?.features||[]).join(', ')}`;error('run-error',job.error||'');
    const running=['validating','training','publishing'].includes(job.state),progress=job.progress||{};
    if(running){
      let title='Validating your dataset',detail='The cloud worker is starting or checking measurements, specimen mappings and test conditions.';
      if(job.state==='publishing'){title='Publishing this model';detail='Checking the model package and hosted predictions before making this version available in Predictor.';}
      if(job.state==='training'){
        title='Training and evaluating models';detail='The cloud worker is starting and preparing grouped validation. This can take several minutes.';
        if(progress.total_folds){detail=`Completed ${progress.completed_folds||0} of ${progress.total_folds} held-out-design checks. Each check tests several regression models.`;}
        if(progress.stage==='final_fit'||progress.completed_folds===progress.total_folds&&progress.total_folds){title='Fitting final models and preparing results';detail='Held-out checks are finished. Selecting final estimators and generating the report and graphs.';}
        if(progress.stage==='reports'){title='Generating your report and graphs';detail='Saving validation results and measured-parameter plots.';}
      }
      activity('job:'+id,title,detail,{cloud:true,done:progress.completed_folds||0,total:job.state==='training'&&progress.stage==='nested_validation'?progress.total_folds||0:0});
    }else if(!job.error){activity('job:'+id,job.state==='validated'?'Data checks passed':job.state==='published'?'This version is published':job.state==='complete'?'Training complete':'Version status: '+job.state.replaceAll('_',' '),job.state==='validated'?'Choose “Train this version” to continue.':job.state==='published'?'Reload Predictor to select this model.':'Review this version’s status and results below.',{busy:false});}
    $('run-progress').textContent=running?(job.state==='training'&&progress.total_folds?`Validating design ${progress.completed_folds} of ${progress.total_folds}`:`${job.state} in the cloud…`):'';
    $('start-training').hidden=job.state!=='validated';$('start-training').disabled=!job.summary?.training_minimum_met;
    $('review-panel').hidden=!(job.evaluation||job.historical);$('publish-panel').hidden=!['complete','publish_failed'].includes(job.state)||job.historical;
    $('remove-panel').hidden=running;$('publication-result').textContent=job.state==='published'?'Available in Predictor. Reload Predictor to select this version.':'';
    if((job.evaluation||job.historical)&&loaded!==id){
      activity('job:'+id,'Loading the report and graphs','Retrieving saved results from private storage…');
      $('figures').replaceChildren();$('metrics').replaceChildren();$('report-links').replaceChildren();$('reviewed').checked=false;
      const evaluation=job.evaluation;if(evaluation){$('validation-method').textContent=evaluation.method;const table=node('table',undefined,'metrics'),head=node('tr');['Output','Held-out MAE','R²','Baseline MAE'].forEach(x=>head.append(node('th',x)));table.append(head);Object.entries(evaluation.metrics||{}).forEach(([n,m])=>{const row=node('tr');[n.replaceAll('_',' '),Number(m.mae).toPrecision(4),m.r2==null?'Not estimable':Number(m.r2).toFixed(3),evaluation.mean_baseline?.[n]?.mae==null?'See report':Number(evaluation.mean_baseline[n].mae).toPrecision(4)].forEach(x=>row.append(node('td',x)));table.append(row);});$('metrics').append(table);}else $('validation-method').textContent='Historical validation: see the versioned report for methods and caveats.';
      const report=await (await artifact(id,'REPORT.md')).text();if(selected!==id)return;$('training-report').textContent=report;
      for(const [name,caption] of [['validation.png','Measured versus held-out predicted outcomes'],['measured_force_vs_parameters.png','Measured plateau force by parameter'],['measured_length_vs_parameters.png','Measured plateau length by parameter']]){const blob=await(await artifact(id,name)).blob();if(selected!==id)return;const url=URL.createObjectURL(blob);urls.push(url);const fig=node('figure'),img=node('img');img.src=url;img.alt=caption;fig.append(node('figcaption',caption),img);$('figures').append(fig);}
      loaded=id;
      if(job.error)error('run-error',job.error);else finishActivity('job:'+id,job.state==='published'?'Published version ready':'Results ready for review','The report and all three graphs are loaded below.');
    }
    if(running)timer=setTimeout(()=>openJob(id).catch(e=>error('run-error',e.message+' Refresh to reconnect.')),5000);
  }
  async function runAction(button,action,payload){button.disabled=true;activity('submit',action==='train'?'Starting training':'Starting publication','Submitting your request to the cloud worker…');try{await request(`jobs/${selected}/${action}`,payload);loaded=null;await refresh();await openJob(selected);}catch(e){error('run-error',e.message);}finally{button.disabled=false;}}
  $('start-training').addEventListener('click',()=>runAction($('start-training'),'train',{}));
  $('publish').addEventListener('click',()=>{const j=jobs.find(j=>j.id===selected);runAction($('publish'),'publish',{reviewed:$('reviewed').checked,slug:`${campaign()}-v${j.version}`,name:`${campaign()} v${j.version}`});});
  $('remove-version').addEventListener('click',async()=>{if(!$('remove-confirm').checked){error('run-error','Confirm removal and its effect on dependent versions first.');return;}const b=$('remove-version');b.disabled=true;try{await request(`jobs/${selected}/archive`,{confirmed:true,reason:$('remove-reason').value});selected=null;loaded=null;$('run-panel').hidden=true;$('remove-confirm').checked=false;await refresh();}catch(e){error('run-error',e.message);}finally{b.disabled=false;finishActivity('connect','Workspace connected','Choose a campaign and drop your experiment files to begin.');}});
  if(sessionStorage.getItem(tokenKey)){$('admin-token').value=sessionStorage.getItem(tokenKey);$('connect-form').requestSubmit();}
  window.addEventListener('beforeunload',()=>urls.forEach(u=>URL.revokeObjectURL(u)));
})();
