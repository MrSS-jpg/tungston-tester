const fs = require('fs');

let html = fs.readFileSync('index.html', 'utf8');

// 1. CSS modifications
html = html.replace(
  /<\/style>/,
  `.sbs { display: flex; gap: 16px; width: 100%; margin-bottom: 22px; }
.sbs > * { flex: 1; min-width: 0; margin-bottom: 0 !important; }
.compare-toggle { margin-top: 14px; font-weight: 700; font-size: 13px; display: flex; align-items: center; gap: 8px; cursor: pointer; color: var(--amber); }
@media (max-width: 820px) {
  .sbs { flex-direction: column; }
}
</style>`
);

// 2. HTML Layout Changes
html = html.replace(
  /<select id="model" aria-label="Select Model"><\/select>/,
  `<select id="model" aria-label="Select Model 1"></select>
      <label class="compare-toggle"><input type="checkbox" id="compare-mode"> SIDE-BY-SIDE COMPARE</label>
      <select id="model2" aria-label="Select Model 2" style="display:none; margin-top:14px;"></select>`
);

// 3. JavaScript modifications
html = html.replace(
  /const modelEl=\$\('model'\);/,
  `const modelEl=$('model');
const model2El=$('model2');
const compareToggle=$('compare-mode');

compareToggle.addEventListener('change', () => {
  model2El.style.display = compareToggle.checked ? 'block' : 'none';
});`
);

html = html.replace(
  /function renderModels\(\)\{[^}]+\}/,
  `function renderModels(){
    let h='';
    S.models.forEach(m=>{h+=\`<option value="\${m.id}">\${m.name} (\${m.provider})</option>\`});
    modelEl.innerHTML=h;
    model2El.innerHTML=h;
    if(S.models.length>1) model2El.selectedIndex = 1;
  }`
);

// We need to refactor addBot to accept a container.
html = html.replace(
  /function addBot\(mId,t\)\{/,
  `function addBot(mId,t,container){`
);
html = html.replace(
  /\$\('log'\)\.appendChild\(w\);/,
  `(container || $('log')).appendChild(w);`
);

// We need to refactor run() to extract streamModel.
// The original run() looks like this:
// async function run(txt){
//   // ... UI updates ...
//   var w = addBot(S.config.model, S.config.temp);
//   // ... fetch loop ...
// }

// Let's replace the entire run function
const newRunLogic = `
async function streamModel(modelId, temp, txt, container) {
  var w = addBot(modelId, temp, container);
  var out = w.querySelector('.msg-c');
  var m = S.models.find(x => x.id === modelId);
  if(!m) { out.innerHTML = '<span class="err">Unknown model</span>'; return null; }

  // build messages
  var msgs = [];
  if(S.config.sys) msgs.push({role:'system',content:S.config.sys});
  S.history.forEach(h => msgs.push(h));
  msgs.push({role:'user',content:txt});

  var rText = '';
  try {
    var res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: m.provider, model: m.model, messages: msgs, temp: temp, max: S.config.max })
    });
    if(!res.ok) throw new Error(await res.text());
    
    // streaming
    var reader = res.body.getReader();
    var dec = new TextDecoder();
    while(true){
      var {done, value} = await reader.read();
      if(done) break;
      rText += dec.decode(value, {stream:true});
      out.innerHTML = marked.parse(rText);
    }
  } catch(e) {
    out.innerHTML = \`<span class="err">Error: \${e.message}</span>\`;
  }
  return rText;
}

async function run(txt) {
  if(S.busy) return;
  if(!S.config.model) return showError('Select a model.');
  
  S.busy = true;
  S.history.push({role:'user',content:txt});
  
  addUser(txt);
  inputEl.value='';
  inputEl.style.height='auto';
  btnEl.disabled = true;
  btnEl.textContent = 'RUNNING';

  const isCompare = compareToggle.checked;

  if (isCompare) {
    const sbs = document.createElement('div');
    sbs.className = 'sbs';
    $('log').appendChild(sbs);
    
    // Run both in parallel
    const [res1, res2] = await Promise.all([
      streamModel(S.config.model, S.config.temp, txt, sbs),
      streamModel(model2El.value, S.config.temp, txt, sbs)
    ]);
    
    // In compare mode, we only append the first model's response to history 
    // to prevent confusing the conversation flow, or we append none. Let's append none for now.
  } else {
    const res = await streamModel(S.config.model, S.config.temp, txt, null);
    if (res) S.history.push({role:'assistant',content:res});
  }

  S.busy = false;
  btnEl.disabled = false;
  btnEl.textContent = 'SEND ↗';
  readUsage();
}
`;

html = html.replace(/async function run\(txt\)\{[\s\S]*?readUsage\(\);\s*\}/, newRunLogic);

fs.writeFileSync('index.html', html);
