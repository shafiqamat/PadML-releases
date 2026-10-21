"use strict";
(() => {
  const $ = id => document.getElementById(id);
  const config = window.PADML_CONFIG || {};
  const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(location.hostname);
  const base = config.trainingBase !== undefined ? String(config.trainingBase).replace(/\/+$/, "") : (local ? "" : null);
  const tokenKey = `padml-training-token:${base}`;
  let token = "", jobs = [], selected = null, deployment = false, timer = null, loadedReview = null, hosted = false;
  const blobs = [];
  let preparation = null, preparationEpoch = 0;
  const node = (tag, text, cls) => { const n = document.createElement(tag); if(text !== undefined) n.textContent = text; if(cls) n.className=cls; return n; };
  const error = (id, message) => { $(id).textContent = message || ""; $(id).hidden = !message; };
  async function request(path, payload, raw=false) {
    if(base === null) throw new Error("No training worker is configured for this hosted page. Open the workspace on your training PC.");
    const response = await fetch(base + "/api/training/" + path, {method:payload === undefined ? "GET":"POST",
      headers:{"X-Training-Token":token,...(payload === undefined?{}:{"Content-Type":"application/json"})},
      ...(payload === undefined ? {} : {body:JSON.stringify(payload)})});
    if(!response.ok) { const data=await response.json().catch(()=>({})); throw new Error(data.error || `Request failed (${response.status})`); }
    if(raw && hosted && response.headers.get('content-type')?.includes('application/json')) {
      const info=await response.json();
      if(info.download_url){const artifact=await fetch(info.download_url);if(!artifact.ok)throw new Error('Report download failed. Refresh to retry.');return artifact;}
      return new Response(JSON.stringify(info),{headers:{'Content-Type':'application/json'}});
    }
    return raw ? response : response.json();
  }
  function download(name, blob, host) {
    const url=URL.createObjectURL(blob); blobs.push(url);
    const a=node("a",name); a.href=url; a.download=name; host.append(a);
  }
  async function refresh() {
    const response=await request("jobs"); jobs=response.jobs; deployment=response.deployment_enabled;hosted=!!response.hosted;
    $("job-list").replaceChildren();
    if(!jobs.length) $("job-list").append(node("p","No runs yet. Upload a batch to begin.","hint"));
    jobs.forEach(job=>{const b=node("button",undefined,"job-item"); b.type="button"; b.append(node("span",job.name),node("small",job.state.replaceAll("_"," ")));
      b.setAttribute("aria-current",String(job.id === selected)); b.addEventListener("click",()=>openJob(job.id).catch(e=>error("run-error",e.message))); $("job-list").append(b);});
    const old=$("base-run").value; $("base-run").replaceChildren(new Option("New dataset — uploaded data only",""));
    jobs.filter(j=>j.evaluation).forEach(j=>$("base-run").append(new Option(j.name,j.id))); $("base-run").value=old;
  }
  async function connect(event) {
    if(event) event.preventDefault(); error("connection-error",""); token=$("admin-token").value;
    const button=$("connect-form").querySelector("button"); button.disabled=true;
    try {await refresh(); sessionStorage.setItem(tokenKey,token); $("workspace").hidden=false; $("connection-status").textContent=hosted?"Connected to cloud training. Jobs continue when you close this tab.":"Connected. Your data and jobs stay on this worker.";
      $("prep-suggest").disabled=true;
      if(hosted){try{const capability=await request('preparation');$("prep-suggest").disabled=!capability.configured;$("prep-availability").textContent=capability.configured?'Ready: GPT-6 Luna · medium reasoning.':'AI preparation needs the server OpenAI API key. Standard uploads are available now.';}catch{$("prep-availability").textContent='AI preparation is unavailable. Standard uploads are available.';}}
      else $("prep-availability").textContent='AI preparation is available on the hosted training workspace.';
    }
    catch(e){error("connection-error",e.message); $("workspace").hidden=true;}
    finally{button.disabled=false;}
  }
  $("connect-form").addEventListener("submit",connect);
  function clearPreparation(){preparation=null;preparationEpoch++;$("prep-review").hidden=true;$("prep-reviewed").checked=false;$("prep-downloads").replaceChildren();}
  ["prep-designs","prep-specimens","prep-curves","prep-manifest","prep-notes"].forEach(id=>$(id).addEventListener('change',clearPreparation));
  $("prep-suggest").addEventListener('click',async()=>{
    error('prep-error','');clearPreparation();const epoch=preparationEpoch;const button=$("prep-suggest");button.disabled=true;
    try{
      if(!$("prep-consent").checked)throw new Error('Confirm sharing the column names and sample rows with OpenAI first.');
      const raw=Object.fromEntries(['designs','specimens','curves'].map(n=>[n+'.csv',$("prep-"+n).files[0]]));
      if(Object.values(raw).some(f=>!f))throw new Error('Choose all three raw CSV tables.');
      if(Object.values(raw).reduce((n,f)=>n+f.size,0)>64*1024*1024)throw new Error('Upload exceeds 64 MB.');
      const settings=$("prep-manifest").files[0];const manifest=settings?JSON.parse(await settings.text()):JSON.parse((await request('template')).files['batch.json']);
      $("prep-status").textContent='Uploading to private storage…';
      const upload=await request('preparation/uploads',{manifest,share_samples_with_openai:true,notes:$("prep-notes").value,sizes:Object.fromEntries(Object.entries(raw).map(([n,f])=>[n,f.size]))});
      for(const [name,post] of Object.entries(upload.uploads)){const form=new FormData();Object.entries(post.fields).forEach(([k,v])=>form.append(k,v));form.append('file',raw[name],name);const r=await fetch(post.url,{method:'POST',body:form});if(!r.ok)throw new Error('Raw upload failed. Retry with a new preparation.');}
      $("prep-status").textContent='Luna is reviewing column meanings and units. This can take up to two minutes…';
      const result=await request(`preparation/${upload.id}/suggest`,{});if(epoch!==preparationEpoch)return;
      preparation={id:upload.id,...result};$("prep-warnings").replaceChildren();
      [...result.proposal.questions,...result.proposal.warnings].forEach(t=>$("prep-warnings").append(node('p',t,'hint')));
      const table=node('table',undefined,'metrics'),header=node('tr');['Table','Training field','Source column','Conversion'].forEach(t=>header.append(node('th',t)));const head=node('thead');head.append(header);table.append(head);const body=node('tbody');
      result.proposal.mappings.forEach(m=>{const row=node('tr');row.append(node('td',m.table),node('td',m.target));
        const source=node('select');source.setAttribute('aria-label',`Source for ${m.table} ${m.target}`);source.append(new Option('Select a source column',''));result.profiles[m.table].columns.forEach(h=>source.append(new Option(h,h)));source.value=m.source||'';
        const conversion=node('select');conversion.setAttribute('aria-label',`Conversion for ${m.target}`);[['identity','Keep original units'],['mm_to_in','mm → in'],['N_to_lbf','N → lbf'],['kN_to_lbf','kN → lbf'],['rad_to_deg','rad → deg']].forEach(([v,t])=>conversion.append(new Option(t,v)));conversion.value=m.conversion;
        source.addEventListener('change',()=>{m.source=source.value||null;preparationEpoch++;$("prep-reviewed").checked=false;});conversion.addEventListener('change',()=>{m.conversion=conversion.value;preparationEpoch++;$("prep-reviewed").checked=false;});
        const cell=node('td');cell.append(source);const unit=node('td');unit.append(conversion);row.append(cell,unit);body.append(row);
      });table.append(body);$("prep-mappings").replaceChildren(table);$("prep-review").hidden=false;
      $("prep-status").textContent='Mapping ready for review. No measurements have been changed.';
    }catch(e){error('prep-error',e.message);$("prep-status").textContent='Preparation did not finish.';}finally{button.disabled=false;}
  });
  $("prep-apply").addEventListener('click',async()=>{
    error('prep-error','');const button=$("prep-apply");button.disabled=true;const epoch=preparationEpoch;
    try{
      if(!preparation||!$("prep-reviewed").checked)throw new Error('Review and confirm the mapping first.');
      $("prep-status").textContent='Python is preparing your files…';
      const result=await request(`preparation/${preparation.id}/apply`,{proposal:preparation.proposal,reviewed:true});
      const loaded=await Promise.all(Object.entries(result.files).map(async([name,url])=>{const r=await fetch(url);if(!r.ok)throw new Error('Prepared-file download expired or failed. Apply the mapping again.');return [name,await r.blob()];}));
      if(epoch!==preparationEpoch)return;$("prep-downloads").replaceChildren();
      for(const [name,blob] of loaded){download(name,blob,$("prep-downloads"));if(name==='preparation_audit.json')continue;
        const id=name==='batch.json'?'manifest-file':name.replace('.csv','-file');const transfer=new DataTransfer();transfer.items.add(new File([blob],name,{type:blob.type}));$(id).files=transfer.files;
      }
      $("manifest-file").dispatchEvent(new Event('change'));$("mapping-verified").checked=false;$("condition-verified").checked=false;
      const excluded=Object.entries(result.ignored_columns).filter(([,cols])=>cols.length).map(([name,cols])=>`${name}: ${cols.join(', ')}`).join('; ');
      $("prep-status").textContent='Prepared files are loaded below. Confirm the experiment, then select Check data.'+(excluded?' Excluded columns: '+excluded:'');
    }catch(e){error('prep-error',e.message);}finally{button.disabled=false;}
  });
  $("disconnect").addEventListener("click",()=>{clearPreparation();clearTimeout(timer);sessionStorage.removeItem(tokenKey);token="";$("admin-token").value="";$("workspace").hidden=true;$("connection-status").textContent="Disconnected. Running jobs continue on the worker.";});
  $("refresh-jobs").addEventListener("click",async()=>{try{await refresh();if(selected)await openJob(selected);}catch(e){error("connection-error",e.message);}});
  $("new-upload").addEventListener("click",()=>{clearTimeout(timer);selected=null;$("upload-panel").hidden=false;$("run-panel").hidden=true;$("run-name").focus();});
  $("manifest-file").addEventListener("change",async()=>{try{const m=JSON.parse(await $("manifest-file").files[0].text());$("material").value=m.condition?.material||"";$("fixture").value=m.condition?.fixture||"";$("speed").value=m.condition?.speed_in_min??"";$("mapping-verified").checked=false;$("condition-verified").checked=false;error("upload-error","");}catch{error("upload-error","Could not read batch.json. Choose a valid JSON settings file.");}});
  $("get-template").addEventListener("click",async()=>{try{const data=await request("template");$("template-links").replaceChildren();Object.entries(data.files).forEach(([name,text])=>download(name,new Blob([text],{type:name.endsWith("json")?"application/json":"text/csv"}),$("template-links")));}catch(e){error("upload-error",e.message);}});
  $("upload-form").addEventListener("submit",async event=>{event.preventDefault();error("upload-error","");const button=$("validate-upload");button.disabled=true;button.textContent="Checking data…";
    try{const picks=["manifest","designs","specimens","curves"].map(n=>$(n+"-file").files[0]);if(picks.reduce((n,f)=>n+f.size,0)>64*1024*1024)throw new Error("Upload exceeds 64 MB.");
      const [settings,designs,specimens,curves]=await Promise.all(picks.map(f=>f.text()));const manifest=JSON.parse(settings);
      manifest.condition={...manifest.condition,material:$("material").value.trim(),fixture:$("fixture").value.trim(),speed_in_min:Number($("speed").value)};
      manifest.mapping_verified=$("mapping-verified").checked;manifest.condition_verified=$("condition-verified").checked;
      const payload={name:$("run-name").value,base_id:$("base-run").value||null,manifest,files:{"designs.csv":designs,"specimens.csv":specimens,"curves.csv":curves}};
      let job;
      if(hosted){
        const sizes=Object.fromEntries(Object.entries(payload.files).map(([n,t])=>[n,new Blob([t]).size]));
        const prepared=await request('uploads/prepare',{name:payload.name,base_id:payload.base_id,manifest,sizes});
        for(const [name,post] of Object.entries(prepared.uploads)){
          const form=new FormData();Object.entries(post.fields).forEach(([k,v])=>form.append(k,v));form.append('file',new Blob([payload.files[name]]),name);
          const uploaded=await fetch(post.url,{method:'POST',body:form});if(!uploaded.ok)throw new Error('File upload failed. Start a new upload to retry.');
        }
        job=await request(`jobs/${prepared.id}/commit`,{});
      }else job=await request('uploads',payload);
      await refresh();await openJob(job.id);
    }catch(e){error("upload-error",e.message);}finally{button.disabled=false;button.textContent="Check data";}});
  async function review(job) {
    if(loadedReview===job.id)return;
    loadedReview=job.id;$("metrics").replaceChildren();$("figures").replaceChildren();$("report-links").replaceChildren();
    const table=node("table",undefined,"metrics"),head=node("tr");["Output","Held-out MAE","R²","Mean-baseline MAE"].forEach(t=>head.append(node("th",t)));const thead=node("thead");thead.append(head);table.append(thead);
    const body=node("tbody");Object.entries(job.evaluation.metrics).forEach(([name,m])=>{const row=node("tr");[name.replaceAll("_"," "),Number(m.mae).toPrecision(4),m.r2 === null ? "Not estimable":Number(m.r2).toFixed(3),Number(job.evaluation.mean_baseline[name].mae).toPrecision(4)].forEach(t=>row.append(node("td",t)));body.append(row);});table.append(body);$("metrics").append(table);
    const prefix=`jobs/${job.id}/artifacts/`;
    try {const response=await request(prefix+"REPORT.md",undefined,true);const text=await response.text();if(selected!==job.id)return;$("training-report").textContent=text;
      for(const [file,caption] of [["validation.png","Held-out prediction accuracy"],["measured_force_vs_parameters.png","Measured plateau force against each parameter"],["measured_length_vs_parameters.png","Measured plateau length against each parameter"]]){
        const r=await request(prefix+file,undefined,true),blob=await r.blob();if(selected!==job.id)return;const url=URL.createObjectURL(blob);blobs.push(url);const fig=node("figure"),img=node("img");img.src=url;img.alt=caption;fig.append(node("figcaption",caption),img);$("figures").append(fig);
      }
      for(const file of ["evaluation.json","validation_predictions.csv"]){const r=await request(prefix+file,undefined,true),blob=await r.blob();if(selected!==job.id)return;download(file,blob,$("report-links"));}
    }catch(e){loadedReview=null;throw e;}
    $("publish-name").value=job.name;$("publish-slug").value=`campaign3-${job.id.slice(0,8)}`;$("reviewed").checked=false;$("deploy-hosted").checked=false;
    $("deploy-hosted").checked=hosted;$("deploy-hosted").disabled=hosted||!deployment;
    $("publish-button").textContent=hosted?'Publish to website':'Publish to local Predictor';
    $("deployment-note").textContent=hosted?'Publishing verifies and activates this version in the hosted Predictor. The current default stays selected.':deployment?"Hosted deployment builds and checks the container before updating the existing API.":"Hosted deployment is not configured on this worker. This publishes to the local Predictor.";
  }
  async function openJob(id) {
    clearTimeout(timer);if(selected!==id)loadedReview=null;selected=id;$("upload-panel").hidden=true;$("run-panel").hidden=false;$("publish-form").hidden=true;
    const job=await request(`jobs/${id}`); if(selected!==id)return;
    $("run-title").textContent=job.name;$("run-state").textContent=job.state.replaceAll("_"," ");$("run-counts").textContent=`${job.summary.specimens} specimens / ${job.summary.design_groups} designs`;
    $("run-summary").replaceChildren(node("p",`Inputs: ${job.summary.features.join(", ")}`,"hint"));error("run-error",job.error||"");
    const running=["validating","training","publishing"].includes(job.state);$("progress-section").hidden=!running;
    const p=job.progress||{};if(p.total_folds){$("run-progress").max=p.total_folds;$("run-progress").value=p.completed_folds;}else{$("run-progress").removeAttribute("value");}
    $("run-progress-text").textContent=job.state==="validating"?"Checking uploaded files, mappings and test conditions…":job.state==="publishing"?"Verifying the model, rebuilding inverse artifacts and publishing…":p.stage==="nested_validation"?`Validating design ${p.completed_folds} of ${p.total_folds}`:(p.stage||"Starting worker").replaceAll("_"," ");
    $("start-training").hidden=job.state!=="validated";$("start-training").disabled=!job.summary.training_minimum_met;
    if(job.state==="validated"&&!job.summary.training_minimum_met)error("run-error","At least 12 independent designs are required. Include an earlier completed dataset or upload more designs.");
    $("review-panel").hidden=!job.evaluation;
    if(job.evaluation)await review(job);
    if(selected!==id)return;
    $("publish-form").hidden=!job.evaluation||!["complete","publish_failed"].includes(job.state);
    $("publication-result").textContent=job.state==="published"?(job.publication?.deployment?.state==="hosted_verified"?"Published and verified on the hosted website.":"Published to the local Predictor. Reload the Predictor to select this version."):"";
    if(running)timer=setTimeout(()=>openJob(id).catch(e=>{error("run-error",`${e.message} Refresh to reconnect; the worker may still be running.`);}),3000);
  }
  $("start-training").addEventListener("click",async()=>{const b=$("start-training");b.disabled=true;try{await request(`jobs/${selected}/train`,{});await openJob(selected);await refresh();}catch(e){error("run-error",e.message);}finally{b.disabled=false;}});
  $("deploy-hosted").addEventListener("change",()=>{$("publish-button").textContent=$("deploy-hosted").checked?"Publish and deploy to website":"Publish to local Predictor";});
  $("publish-form").addEventListener("submit",async event=>{event.preventDefault();error("publish-error","");const b=$("publish-button");b.disabled=true;
    try{await request(`jobs/${selected}/publish`,{slug:$("publish-slug").value,name:$("publish-name").value,reviewed:$("reviewed").checked,deploy:$("deploy-hosted").checked});await openJob(selected);await refresh();}
    catch(e){error("publish-error",e.message);}finally{b.disabled=false;}});
  if(base===null){$("connect-form").hidden=true;$("connection-note").textContent="This hosted page has no training worker connected. Start the worker on your PC and open its training workspace.";const a=node("a","Open this PC’s training workspace");a.href="http://127.0.0.1:8765/training.html";$("connection").append(a);}
  else if(sessionStorage.getItem(tokenKey)){$("admin-token").value=sessionStorage.getItem(tokenKey);connect();}
  window.addEventListener("beforeunload",()=>blobs.forEach(u=>URL.revokeObjectURL(u)));
})();
