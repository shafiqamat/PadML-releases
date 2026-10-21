"use strict";
(() => {
  const $=id=>document.getElementById(id),node=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
  const config=window.PADML_CONFIG||{},base=String(config.trainingBase||config.apiBase||'').replace(/\/+$/,''),tokenKey=`padml-training-token:${base}`;
  let token='',jobs=[],selected=null,timer=null,files=[],preparation=null,epoch=0,loaded=null,aiReady=false;
  const urls=[];const campaign=()=>`campaign${Number($('campaign-number').value)}`;
  const error=(id,text)=>{$(id).textContent=text||'';$(id).hidden=!text;};
  async function request(path,data){const r=await fetch(base+'/api/training/'+path,{method:data===undefined?'GET':'POST',headers:{'X-Training-Token':token,...(data===undefined?{}:{'Content-Type':'application/json'})},...(data===undefined?{}:{body:JSON.stringify(data)})});const body=await r.json();if(!r.ok)throw new Error(body.error||`Request failed (${r.status})`);return body;}
  function resetPreparation(){epoch++;preparation=null;$('conversation').hidden=true;$('prep-status').textContent='';}
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
  $('connect-form').addEventListener('submit',async e=>{e.preventDefault();token=$('admin-token').value;error('connection-error','');const b=e.submitter||$('connect-form').querySelector('button');b.disabled=true;try{await refresh();sessionStorage.setItem(tokenKey,token);$('workspace').hidden=false;$('connection-status').textContent='Connected. Cloud jobs continue when you close this tab.';const capability=await request('preparation');aiReady=capability.configured;$('analyze').disabled=!aiReady;$('prep-availability').textContent=aiReady?'GPT-6 Luna · medium reasoning':'OpenAI API key is not configured.';}catch(err){error('connection-error',err.message);}finally{b.disabled=false;}});
  $('disconnect').addEventListener('click',()=>{clearTimeout(timer);resetPreparation();token='';selected=null;sessionStorage.removeItem(tokenKey);$('admin-token').value='';$('workspace').hidden=true;$('connection-status').textContent='Disconnected.';});
  $('refresh').addEventListener('click',async()=>{try{await refresh();if(selected)await openJob(selected);}catch(e){error('connection-error',e.message);}});
  $('campaign-number').addEventListener('change',()=>{if(!$('campaign-number').checkValidity())return;clearTimeout(timer);selected=null;resetPreparation();renderDashboard();$('upload-panel').hidden=false;$('run-panel').hidden=true;});
  $('new-upload').addEventListener('click',()=>{clearTimeout(timer);selected=null;$('upload-panel').hidden=false;$('run-panel').hidden=true;$('run-name').focus();});
  async function analyze(answer){const generation=epoch;error('prep-error','');$('analyze').disabled=true;$('answer').disabled=true;$('accept').hidden=true;
    try{
      if(!preparation){
        if(!$('prep-consent').checked)throw new Error('Confirm sharing samples and notes with OpenAI first.');
        if(!files.length||files.length>50||files.reduce((n,f)=>n+f.size,0)>64*1024*1024)throw new Error('Choose 1–50 files, at most 64 MB total.');
        $('prep-status').textContent='Uploading your files to private storage…';
        const upload=await request('smart/uploads',{campaign_id:campaign(),name:$('run-name').value,base_id:$('base-run').value||null,notes:$('prep-notes').value,share_samples_with_openai:true,files:files.map(f=>({name:f.name,size:f.size}))});
        for(const post of upload.uploads){const form=new FormData();Object.entries(post.fields).forEach(([k,v])=>form.append(k,v));form.append('file',files.find(f=>f.name===post.name),post.name);const r=await fetch(post.url,{method:'POST',body:form});if(!r.ok)throw new Error('Upload failed. Select the files again to retry.');}
        if(generation!==epoch)return;preparation={id:upload.id};
      }
      $('prep-status').textContent='Luna is identifying your data and checking what is missing…';
      const result=await request(`smart/${preparation.id}/analyze`,{answer:answer||''});if(generation!==epoch)return;
      preparation={...preparation,...result};$('conversation').hidden=false;$('questions').replaceChildren();
      result.plan.questions.forEach(q=>$('questions').append(node('p',q)));
      result.plan.warnings.forEach(w=>$('questions').append(node('p',w,'hint')));
      $('mapping-plan').textContent=JSON.stringify(result.plan,null,2);$('prepared-summary').replaceChildren();$('prep-answer').value='';
      if(result.summary){const p=result.plan;$('prepared-summary').append(node('h3',`${result.summary.specimens} specimens · ${result.summary.designs} designs`),node('p',`${p.family} · ${p.material} · fixture: ${p.fixture} · ${p.speed_in_min} in/min · 0.8 in stroke`),node('p',`Inputs: ${p.variables.map(v=>`${v.name} (${v.unit})`).join(', ')}`));
        if($('base-run').value)$('prepared-summary').append(node('p','Includes the selected earlier dataset. By continuing you confirm its mapping and the same material, fixture and test conditions.'));
        $('accept').hidden=false;$('prep-status').textContent='Dataset prepared. Review the summary, or send corrections below.';
      }else $('prep-status').textContent='Luna needs your answers before it can prepare the dataset.';
    }catch(e){error('prep-error',e.message);$('prep-status').textContent='Preparation needs attention.';}finally{$('analyze').disabled=!aiReady;$('answer').disabled=false;}
  }
  $('analyze').addEventListener('click',()=>analyze(''));
  $('answer').addEventListener('click',()=>{if(!$('prep-answer').value.trim()){error('prep-error','Enter an answer or correction.');return;}analyze($('prep-answer').value);});
  $('accept').addEventListener('click',async()=>{const b=$('accept');b.disabled=true;try{const job=await request(`smart/${preparation.id}/accept`,{reviewed:true});await refresh();await openJob(job.id);}catch(e){error('prep-error',e.message);}finally{b.disabled=false;}});
  async function artifact(id,name){const info=await request(`jobs/${id}/artifacts/${name}`);const r=await fetch(info.download_url);if(!r.ok)throw new Error('Report download failed. Refresh to retry.');return r;}
  async function openJob(id){clearTimeout(timer);if(selected!==id)loaded=null;selected=id;$('upload-panel').hidden=true;$('run-panel').hidden=false;error('run-error','');
    const job=await request(`jobs/${id}`);if(selected!==id)return;if(job.state==='archived'){$('run-panel').hidden=true;await refresh();return;}
    $('run-title').textContent=`v${job.version||'?'} · ${job.name}`;$('run-state').textContent=job.state.replaceAll('_',' ');$('run-counts').textContent=`${job.summary?.specimens||0} specimens / ${job.summary?.design_groups||0} designs`;
    $('run-summary').textContent=job.condition_note||`Inputs: ${(job.summary?.features||[]).join(', ')}`;error('run-error',job.error||'');
    const running=['validating','training','publishing'].includes(job.state),progress=job.progress||{};
    $('run-progress').textContent=running?(job.state==='training'&&progress.total_folds?`Validating design ${progress.completed_folds} of ${progress.total_folds}`:`${job.state} in the cloud…`):'';
    $('start-training').hidden=job.state!=='validated';$('start-training').disabled=!job.summary?.training_minimum_met;
    $('review-panel').hidden=!(job.evaluation||job.historical);$('publish-panel').hidden=!['complete','publish_failed'].includes(job.state)||job.historical;
    $('remove-panel').hidden=running;$('publication-result').textContent=job.state==='published'?'Available in Predictor. Reload Predictor to select this version.':'';
    if((job.evaluation||job.historical)&&loaded!==id){
      $('figures').replaceChildren();$('metrics').replaceChildren();$('report-links').replaceChildren();$('reviewed').checked=false;
      const evaluation=job.evaluation;if(evaluation){$('validation-method').textContent=evaluation.method;const table=node('table',undefined,'metrics'),head=node('tr');['Output','Held-out MAE','R²','Baseline MAE'].forEach(x=>head.append(node('th',x)));table.append(head);Object.entries(evaluation.metrics||{}).forEach(([n,m])=>{const row=node('tr');[n.replaceAll('_',' '),Number(m.mae).toPrecision(4),m.r2==null?'Not estimable':Number(m.r2).toFixed(3),evaluation.mean_baseline?.[n]?.mae==null?'See report':Number(evaluation.mean_baseline[n].mae).toPrecision(4)].forEach(x=>row.append(node('td',x)));table.append(row);});$('metrics').append(table);}else $('validation-method').textContent='Historical validation: see the versioned report for methods and caveats.';
      const report=await (await artifact(id,'REPORT.md')).text();if(selected!==id)return;$('training-report').textContent=report;
      for(const [name,caption] of [['validation.png','Measured versus held-out predicted outcomes'],['measured_force_vs_parameters.png','Measured plateau force by parameter'],['measured_length_vs_parameters.png','Measured plateau length by parameter']]){const blob=await(await artifact(id,name)).blob();if(selected!==id)return;const url=URL.createObjectURL(blob);urls.push(url);const fig=node('figure'),img=node('img');img.src=url;img.alt=caption;fig.append(node('figcaption',caption),img);$('figures').append(fig);}
      loaded=id;
    }
    if(running)timer=setTimeout(()=>openJob(id).catch(e=>error('run-error',e.message+' Refresh to reconnect.')),5000);
  }
  async function runAction(button,action,payload){button.disabled=true;try{await request(`jobs/${selected}/${action}`,payload);loaded=null;await refresh();await openJob(selected);}catch(e){error('run-error',e.message);}finally{button.disabled=false;}}
  $('start-training').addEventListener('click',()=>runAction($('start-training'),'train',{}));
  $('publish').addEventListener('click',()=>{const j=jobs.find(j=>j.id===selected);runAction($('publish'),'publish',{reviewed:$('reviewed').checked,slug:`${campaign()}-v${j.version}`,name:`${campaign()} v${j.version}`});});
  $('remove-version').addEventListener('click',async()=>{if(!$('remove-confirm').checked){error('run-error','Confirm removal and its effect on dependent versions first.');return;}const b=$('remove-version');b.disabled=true;try{await request(`jobs/${selected}/archive`,{confirmed:true,reason:$('remove-reason').value});selected=null;loaded=null;$('run-panel').hidden=true;$('remove-confirm').checked=false;await refresh();}catch(e){error('run-error',e.message);}finally{b.disabled=false;}});
  if(sessionStorage.getItem(tokenKey)){$('admin-token').value=sessionStorage.getItem(tokenKey);$('connect-form').requestSubmit();}
  window.addEventListener('beforeunload',()=>urls.forEach(u=>URL.revokeObjectURL(u)));
})();
