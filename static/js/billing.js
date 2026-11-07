// ── 請求書 ──
async function loadInv(){
  const d=await api('GET','/invoices');allInv=d.invoices||[];renderInvList();
}
function renderInvList(){
  const sorted=[...allInv].sort((a,b)=>(b.issued_date||'').localeCompare(a.issued_date||''));
  document.getElementById('inv-body').innerHTML=sorted.map(inv=>{
    const sub=inv.items?inv.items.reduce((s,it)=>s+(parseInt(it.qty)||1)*(parseInt(it.unit_price)||0),0):0;
    const tax=Math.floor(sub*(parseInt(inv.tax_rate)||0)/100);
    const grand=sub+tax;
    return`<tr>
      <td style="white-space:nowrap">${(inv.doc_type||'請求書')==='見積書'
        ? '<span style="background:#fffbeb;color:#b45309;border:1px solid #fde68a;border-radius:4px;padding:1px 5px;font-size:10px;font-weight:700">見積</span> '
        : '<span style="background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe;border-radius:4px;padding:1px 5px;font-size:10px;font-weight:700">請求</span> '}
        <span style="font-family:monospace">No.${escHtml(inv.invoice_no||'')}</span></td>
      <td>${escHtml(inv.issued_date||'')}</td><td>${escHtml(inv.due_date||'')}</td>
      <td>${escHtml(inv.client_name||'')}</td><td>${escHtml(inv.subject||'')}</td>
      <td style="text-align:right;font-weight:600">¥${grand.toLocaleString()}</td>
      <td><select style="border:1px solid var(--bd);border-radius:5px;padding:2px 5px;font-size:12px"
          onchange="updInvStatus('${escJsAttr(inv.id)}',this.value)">
        ${['未送付','送付済','入金済','キャンセル'].map(s=>`<option value="${s}"${s===inv.status?' selected':''}>${s}</option>`).join('')}
      </select></td>
      <td style="white-space:nowrap">
        <button class="btn bs bsm" onclick="editInv('${escJsAttr(inv.id)}')">編集</button>
        <button class="btn bg bsm" onclick="downloadInvById('${escJsAttr(inv.id)}')"><span class="ei" data-i="file"></span>PDF</button>
        <button class="btn bd2 bsm" onclick="delInv('${escJsAttr(inv.id)}')">削除</button>
      </td>
    </tr>`;
  }).join('')||'<tr><td colspan="8" style="text-align:center;color:var(--mu)">請求書なし</td></tr>';
}
function _invTotal(inv){
  const items=inv.items||[];
  const sub=items.reduce((s,it)=>s+((parseInt(it.qty)||1)*(parseInt(it.unit_price)||0)),0);
  const tax=Math.floor(sub*(inv.tax_rate||0)/100);
  return sub+tax;
}
function _invLabel(inv){
  if(!inv) return '請求書';
  const kind=inv.doc_type||'請求書';
  const no=inv.invoice_no?`No.${inv.invoice_no}`:'';
  const client=inv.client_name?`${inv.client_name} 宛`:'';
  const total=_invTotal(inv);
  const amt=total?'¥'+total.toLocaleString():'';
  return [kind,no,client,amt].filter(Boolean).join(' ');
}
// 請求書の編集前後を比較して変更点を返す
function _invDiff(before, after){
  const ch=[];
  if(!before) return ch;
  if((before.invoice_no||'')!==(after.invoice_no||'')) ch.push(`請求番号 ${before.invoice_no||'(空)'} → ${after.invoice_no||'(空)'}`);
  if((before.client_name||'')!==(after.client_name||'')) ch.push(`宛先 「${before.client_name||'(空)'}」→「${after.client_name||'(空)'}」`);
  if((before.issued_date||'')!==(after.issued_date||'')) ch.push(`発行日 ${before.issued_date||'(空)'} → ${after.issued_date||'(空)'}`);
  if((before.due_date||'')!==(after.due_date||'')) ch.push(`支払期限 ${before.due_date||'(空)'} → ${after.due_date||'(空)'}`);
  const bT=_invTotal(before), aT=_invTotal(after);
  if(bT!==aT) ch.push(`合計金額 ¥${bT.toLocaleString()} → ¥${aT.toLocaleString()}`);
  else {
    const bn=(before.items||[]).length, an=(after.items||[]).length;
    if(bn!==an) ch.push(`明細 ${bn}件 → ${an}件`);
  }
  if((before.tax_rate||0)!==(after.tax_rate||0)) ch.push(`消費税率 ${before.tax_rate||0}% → ${after.tax_rate||0}%`);
  if((before.notes||'')!==(after.notes||'')) ch.push('備考を変更');
  return ch;
}
async function updInvStatus(id,status){
  const inv=allInv.find(i=>i.id===id);
  await api('PUT','/invoices/'+id,{status,_skipLog:true});
  if(inv)inv.status=status;
  logChange('更新','/invoices',`${_invLabel(inv)} のステータスを「${status}」に変更しました`);
}
// 差出人・振込先の既定値は 設定 → 請求書の差出人 で登録する（団体ごとに違うためコードに書かない）
function invDefault(key){
  const st=sts||{};
  if(key==='from_name') return st.invoice_from_name||st.club_name||'';
  return st['invoice_'+key]||'';
}

// ── 書類の種類（請求書 / 見積書）──
const INV_DOC_TYPES = {
  '請求書': { en: 'INVOICE',   dueLabel: '支払期限', totalLabel: '合計金額' },
  '見積書': { en: 'QUOTATION', dueLabel: '有効期限', totalLabel: '御見積金額' },
};
function getInvDocType(){
  const v = document.getElementById('inv-doctype')?.value;
  return INV_DOC_TYPES[v] ? v : '請求書';
}
// セレクトの変更に合わせて英字見出し・期限ラベル・モーダル見出しを更新
function updInvDocType(){
  const t = getInvDocType(), meta = INV_DOC_TYPES[t];
  const en = document.getElementById('inv-doctype-en');
  if (en) en.textContent = meta.en;
  const dl = document.getElementById('inv-due-label');
  if (dl) dl.textContent = meta.dueLabel;
  const ttl = document.getElementById('inv-title');
  if (ttl) ttl.textContent = `${t}を${editingInvId ? '編集' : '作成'}`;
}
function setInvDocType(t){
  const sel = document.getElementById('inv-doctype');
  if (sel) sel.value = INV_DOC_TYPES[t] ? t : '請求書';
  updInvDocType();
}

function openInv(){
  editingInvId=null;invItems=[{name:'',qty:1,unit_price:0}];
  setInvDocType('請求書');
  ['inv-no','inv-client'].forEach(id=>document.getElementById(id).value='');
  document.getElementById('inv-notes').value=invDefault('notes');
  document.getElementById('inv-from-name').value=invDefault('from_name');
  document.getElementById('inv-from-zip').value=invDefault('from_zip');
  document.getElementById('inv-from-addr').value=invDefault('from_addr');
  document.getElementById('inv-from-tel').value=invDefault('from_tel');
  document.getElementById('inv-issued').value=new Date().toISOString().slice(0,10);
  document.getElementById('inv-due').value='';document.getElementById('inv-tax').value='0';
  document.getElementById('invov').classList.add('open');renderInvItems();
}
function editInv(id){
  const inv=allInv.find(i=>i.id===id);if(!inv)return;
  editingInvId=id;invItems=JSON.parse(JSON.stringify(inv.items||[]));
  setInvDocType(inv.doc_type||'請求書');
  document.getElementById('inv-no').value=inv.invoice_no||'';
  document.getElementById('inv-client').value=inv.client_name||'';
  document.getElementById('inv-issued').value=(inv.issued_date||'').replace(/\//g,'-');
  document.getElementById('inv-due').value=(inv.due_date||'').replace(/\//g,'-');
  document.getElementById('inv-tax').value=String(inv.tax_rate||0);
  document.getElementById('inv-notes').value=inv.notes||invDefault('notes');
  document.getElementById('inv-from-name').value=inv.from_name||invDefault('from_name');
  document.getElementById('inv-from-zip').value=inv.from_zip||invDefault('from_zip');
  document.getElementById('inv-from-addr').value=inv.from_addr||invDefault('from_addr');
  document.getElementById('inv-from-tel').value=inv.from_tel||invDefault('from_tel');
  document.getElementById('invov').classList.add('open');renderInvItems();
}
function closeInv(){document.getElementById('invov').classList.remove('open');}

// 差出人に押す角印（任意）。設定 → 請求書の差出人 で画像を登録すると data URI で保存される。
// html2canvas は生成した HTML を別に描画するため、URL 参照ではなく data URI をそのまま埋め込む。
async function invSealDataUrl(){
  const v=(sts||{}).invoice_seal||'';
  return /^data:image\/(png|jpeg|webp);base64,/.test(v) ? v : '';
}

async function downloadInvPDF(){
  const client=document.getElementById('inv-client').value.trim();
  if(!client){toast('宛先を入力してください','#f59e0b');return;}
  const docType=getInvDocType(), docMeta=INV_DOC_TYPES[docType];
  const docTitle=docType.split('').join(' ');   // 「請 求 書」のように字間を空ける
  const no=document.getElementById('inv-no').value||'----';
  const issued=document.getElementById('inv-issued').value.replace(/-/g,'/');
  const due=document.getElementById('inv-due').value.replace(/-/g,'/');
  const notes=document.getElementById('inv-notes').value||'';
  const rate=parseInt(document.getElementById('inv-tax').value)||0;
  const sub=invItems.reduce((s,it)=>s+(parseInt(it.qty)||1)*(parseInt(it.unit_price)||0),0);
  const tax=Math.floor(sub*rate/100);
  const grand=sub+tax;
  const fromName=document.getElementById('inv-from-name').value.trim()||(sts&&sts.club_name)||'';
  const fromZip=document.getElementById('inv-from-zip').value.trim();
  const fromAddr=document.getElementById('inv-from-addr').value.trim();
  const fromTel=document.getElementById('inv-from-tel').value.trim();
  const seal=await invSealDataUrl();
  // 社印は差出人名の右端に少し重ねて押すのが通例
  const sealImg=seal?`<img src="${seal}" alt="" style="position:absolute;right:0;top:1px;width:62px;height:62px">`:'';

  const tdS='border:1px solid #cbd5e1;padding:7px 10px;font-size:12px;vertical-align:top;';
  const tdRS=tdS+'text-align:right;';
  // 品目名の改行をそのまま出す（備考欄と同じ扱い）
  const tdNameS=tdS+'white-space:pre-wrap;line-height:1.5;';
  const rows=invItems.map((it,i)=>{
    const bg=i%2===0?'#fff':'#f8fafc';
    const amt=(parseInt(it.qty)||1)*(parseInt(it.unit_price)||0);
    return`<tr style="background:${bg}">
      <td style="${tdNameS}">${escHtml(it.name||'')}</td>
      <td style="${tdRS}">${parseInt(it.qty)||1}</td>
      <td style="${tdRS}">¥${(parseInt(it.unit_price)||0).toLocaleString()}</td>
      <td style="${tdRS}font-weight:600">¥${amt.toLocaleString()}</td>
    </tr>`;
  }).join('');

  const notesHtml=notes?`<div style="margin-top:20px;padding:12px 16px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;">
    <div style="font-size:11px;font-weight:700;color:#94a3b8;margin-bottom:6px;letter-spacing:0.05em">備考・振込先</div>
    <pre style="margin:0;font-size:12px;font-family:inherit;color:#374151;line-height:1.7;white-space:pre-wrap">${escHtml(notes)}</pre>
  </div>`:'';

  const html=`<div style="padding:24px 30px;font-family:'Helvetica Neue',Arial,'Hiragino Kaku Gothic ProN',sans-serif;color:#1e293b;max-width:720px;margin:0 auto;box-sizing:border-box">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #1e293b;padding-bottom:10px;margin-bottom:14px">
      <div>
        <div style="font-size:24px;font-weight:800;letter-spacing:0.06em">${docTitle}</div>
        <div style="font-size:10px;color:#94a3b8;margin-top:2px;letter-spacing:0.1em">${docMeta.en}</div>
      </div>
      <div style="text-align:right;font-size:11px;color:#475569;line-height:1.8">
        <div><span style="color:#94a3b8">No. </span><span style="font-family:monospace;font-weight:700">${escHtml(no)}</span></div>
        ${issued?`<div><span style="color:#94a3b8">発行日: </span>${escHtml(issued)}</div>`:''}
        ${due?`<div><span style="color:#94a3b8">${docMeta.dueLabel}: </span>${escHtml(due)}</div>`:''}
      </div>
    </div>
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:36px">
      <div>
        <div style="font-size:15px;font-weight:700;border-bottom:2px solid #1e293b;padding-bottom:3px;margin-bottom:3px;display:inline-block">${escHtml(client)} 御中</div>
      </div>
      ${fromName?`<div style="position:relative;text-align:right;font-size:11px;color:#475569;line-height:1.8;margin-top:52px;padding-right:57px">
        <div style="font-weight:700;font-size:13px;color:#1e293b;margin-bottom:2px">${escHtml(fromName)}</div>
        ${fromZip?`<div>${escHtml(fromZip)} ${escHtml(fromAddr)}</div>`:''}
        ${fromTel?`<div>TEL: ${escHtml(fromTel)}</div>`:''}
        ${sealImg}
      </div>`:''}
    </div>
    <table style="width:100%;border-collapse:collapse;margin-bottom:0;font-size:11px">
      <thead><tr style="background:#1e293b;color:#fff">
        <th style="padding:7px 10px;text-align:left">品目・内容</th>
        <th style="padding:7px 8px;text-align:right;width:50px">数量</th>
        <th style="padding:7px 8px;text-align:right;width:85px">単価</th>
        <th style="padding:7px 8px;text-align:right;width:85px">金額</th>
      </tr></thead>
      <tbody>${rows}</tbody>
      <tfoot>
        ${rate?`<tr style="background:#f8fafc"><td colspan="3" style="${tdRS}color:#64748b;font-size:11px">小計</td><td style="${tdRS}font-size:11px">¥${sub.toLocaleString()}</td></tr>
        <tr style="background:#f8fafc"><td colspan="3" style="${tdRS}color:#64748b;font-size:11px">消費税（${rate}%）</td><td style="${tdRS}font-size:11px">¥${tax.toLocaleString()}</td></tr>`:''}
        <tr style="background:#1e293b;color:#fff">
          <td colspan="3" style="padding:8px 10px;text-align:right;font-size:12px;font-weight:700">${docMeta.totalLabel}</td>
          <td style="padding:8px 10px;text-align:right;font-size:14px;font-weight:800">¥${grand.toLocaleString()}</td>
        </tr>
      </tfoot>
    </table>
    ${notesHtml}
  </div>`;

  const filename=`${docType}_${no}_${client}.pdf`;
  html2pdf().set({margin:[8,8,8,8],filename,image:{type:'jpeg',quality:0.98},html2canvas:{scale:2,useCORS:true,scrollY:0},jsPDF:{unit:'mm',format:'a4',orientation:'portrait'},pagebreak:{mode:'css',before:'.page-break',avoid:'tr'}}).from(html).save();
}


function addInvItem(){invItems.push({name:'',qty:1,unit_price:0});renderInvItems();}
function moveInvItem(i, dir){
  const j=i+dir;
  if(j<0||j>=invItems.length)return;
  [invItems[i],invItems[j]]=[invItems[j],invItems[i]];
  renderInvItems();
}
let _dragSrcIdx=null;
function renderInvItems(){
  document.getElementById('inv-items').innerHTML=invItems.map((it,i)=>`
  <tr draggable="true" data-idx="${i}" style="background:${i%2===0?'#fff':'#f8fafc'};cursor:grab"
    ondragstart="event.dataTransfer.effectAllowed='move';_dragSrcIdx=${i};this.style.opacity='0.4'"
    ondragend="this.style.opacity='1';document.querySelectorAll('#inv-items tr').forEach(r=>r.style.borderTop='')"
    ondragover="event.preventDefault();event.dataTransfer.dropEffect='move';document.querySelectorAll('#inv-items tr').forEach(r=>r.style.borderTop='');this.style.borderTop='2px solid var(--p,#6366f1)'"
    ondrop="event.preventDefault();this.style.borderTop='';const to=${i};if(_dragSrcIdx!==null&&_dragSrcIdx!==to){const arr=invItems.splice(_dragSrcIdx,1);invItems.splice(to,0,arr[0]);_dragSrcIdx=null;renderInvItems()}"
  >
    <td style="border:1px solid #e2e8f0;padding:5px 8px;vertical-align:top"><textarea rows="${Math.min((String(it.name||'').match(/\n/g)||[]).length+1,12)}" oninput="invItems[${i}].name=this.value;autoGrowInvItem(this)" placeholder="品目・内容（改行できます）" style="width:100%;border:none;background:transparent;font-size:12px;line-height:1.5;outline:none;resize:none;overflow:hidden;font-family:inherit;display:block;box-sizing:border-box" ondragstart="event.stopPropagation()">
${escHtml(it.name||'')}</textarea></td>
    <td style="border:1px solid #e2e8f0;padding:5px 4px;vertical-align:top"><input type="number" value="${it.qty||1}" oninput="invItems[${i}].qty=parseInt(this.value)||1;calcInvTotal()" style="width:50px;border:none;background:transparent;font-size:12px;text-align:right;outline:none" min="1" ondragstart="event.stopPropagation()"></td>
    <td style="border:1px solid #e2e8f0;padding:5px 4px"><input type="number" value="${it.unit_price||0}" oninput="invItems[${i}].unit_price=parseInt(this.value)||0;calcInvTotal()" style="width:80px;border:none;background:transparent;font-size:12px;text-align:right;outline:none" min="0" ondragstart="event.stopPropagation()"></td>
    <td style="border:1px solid #e2e8f0;padding:5px 8px;text-align:right;font-size:12px;font-weight:600;white-space:nowrap;vertical-align:top">¥${((it.qty||1)*(it.unit_price||0)).toLocaleString()}</td>
    <td style="border:none;padding:2px;white-space:nowrap;vertical-align:top">
      <button onclick="moveInvItem(${i},-1)" ${i===0?'disabled':''} style="background:none;border:none;cursor:pointer;color:#94a3b8;font-size:13px;padding:0 2px;opacity:${i===0?'0.3':'1'}" title="上へ">▲</button>
      <button onclick="moveInvItem(${i},1)" ${i===invItems.length-1?'disabled':''} style="background:none;border:none;cursor:pointer;color:#94a3b8;font-size:13px;padding:0 2px;opacity:${i===invItems.length-1?'0.3':'1'}" title="下へ">▼</button>
      <button onclick="invItems.splice(${i},1);renderInvItems()" style="background:none;border:none;cursor:pointer;color:#94a3b8;font-size:14px;padding:0 2px" title="削除">×</button>
    </td>
  </tr>`).join('');
  growAllInvItems();
  calcInvTotal();
}
// 入力内容の行数だけ縦に伸ばす（スクロールバーを出さない）
// 高さを 0 にしてから測る。auto だと表のセルに引き伸ばされた高さを拾って
// 測るたびに行が伸び続けるため。
function autoGrowInvItem(el){
  el.style.height='0px';
  // 非表示のときは scrollHeight が 0 になるので行数から見積もる
  const lines=(el.value.match(/\n/g)||[]).length+1;
  el.style.height=(el.scrollHeight || lines*18+10)+'px';
}
// 高さは列幅が確定してからでないと正しく測れない（描画直後や非表示中に測ると
// 折り返し前提の高すぎる値になる）。rows 属性で概ねの高さは出ているので、
// 折り返しぶんの微調整だけ次のフレームで行う。
function growAllInvItems(){
  requestAnimationFrame(() =>
    document.querySelectorAll('#inv-items textarea').forEach(autoGrowInvItem));
}
function calcInvTotal(){
  const sub=invItems.reduce((s,it)=>s+(parseInt(it.qty)||1)*(parseInt(it.unit_price)||0),0);
  const rate=parseInt(document.getElementById('inv-tax').value)||0;
  const tax=Math.floor(sub*rate/100);
  const grand=sub+tax;
  document.getElementById('inv-total-area').innerHTML=
    `<div style="display:flex;flex-direction:column;gap:4px">
      <div style="display:flex;justify-content:space-between;font-size:12px;color:#64748b"><span>小計</span><span>¥${sub.toLocaleString()}</span></div>
      ${rate?`<div style="display:flex;justify-content:space-between;font-size:12px;color:#64748b"><span>消費税（${rate}%）</span><span>¥${tax.toLocaleString()}</span></div>`:''}
      <div style="display:flex;justify-content:space-between;font-size:15px;font-weight:800;color:var(--p);border-top:2px solid var(--bd);padding-top:6px;margin-top:2px"><span>合計金額</span><span>¥${grand.toLocaleString()}</span></div>
    </div>`;
}
async function saveInv(){
  const client=document.getElementById('inv-client').value.trim();
  if(!client){toast('宛先を入力してください','#f59e0b');return;}
  const data={
    doc_type:getInvDocType(),
    invoice_no:document.getElementById('inv-no').value.trim(),
    client_name:client, issued_date:document.getElementById('inv-issued').value.replace(/-/g,'/'),
    due_date:document.getElementById('inv-due').value.replace(/-/g,'/'),
    tax_rate:parseInt(document.getElementById('inv-tax').value)||0,
    notes:document.getElementById('inv-notes').value, items:invItems,
    from_name:document.getElementById('inv-from-name').value.trim(),
    from_zip:document.getElementById('inv-from-zip').value.trim(),
    from_addr:document.getElementById('inv-from-addr').value.trim(),
    from_tel:document.getElementById('inv-from-tel').value.trim(),
    status:editingInvId?(allInv.find(i=>i.id===editingInvId)||{}).status||'未送付':'未送付',
  };
  if(editingInvId){
    const before=allInv.find(i=>i.id===editingInvId);
    const changes=_invDiff(before, {...data,items:invItems});
    data.id=editingInvId;await api('PUT','/invoices/'+editingInvId,{...data,_skipLog:true});
    const idx=allInv.findIndex(i=>i.id===editingInvId);if(idx>=0)allInv[idx]={...allInv[idx],...data};
    const desc = changes.length
      ? `${_invLabel({...data,items:invItems})} を編集：${changes.join('、')}`
      : `${_invLabel({...data,items:invItems})} を編集（変更なし）`;
    logChange('更新','/invoices',desc);
  }else{
    const res=await api('POST','/invoices',{...data,_skipLog:true});if(res.invoice)allInv.push(res.invoice);
    logChange('作成','/invoices',`${_invLabel({...data,items:invItems})} を新規作成しました`);
  }
  closeInv();renderInvList();toast('保存しました','#059669');
}
async function delInv(id){
  if(!confirm('削除しますか？'))return;
  const inv=allInv.find(i=>i.id===id);
  await api('DELETE','/invoices/'+id,{_skipLog:true});
  logChange('削除','/invoices',`${_invLabel(inv)} を削除しました`);
  allInv=allInv.filter(i=>i.id!==id);renderInvList();
}

function downloadInvById(id){
  const inv=allInv.find(i=>i.id===id);if(!inv)return;
  // モーダルに値をセットしてPDFダウンロード
  editingInvId=id;invItems=JSON.parse(JSON.stringify(inv.items||[]));
  setInvDocType(inv.doc_type||'請求書');
  document.getElementById('inv-no').value=inv.invoice_no||'';
  document.getElementById('inv-client').value=inv.client_name||'';
  document.getElementById('inv-issued').value=(inv.issued_date||'').replace(/\//g,'-');
  document.getElementById('inv-due').value=(inv.due_date||'').replace(/\//g,'-');
  document.getElementById('inv-tax').value=String(inv.tax_rate||0);
  document.getElementById('inv-notes').value=inv.notes||invDefault('notes');
  // 差出人も入れる（未設定だと住所も角印も出ないため）
  document.getElementById('inv-from-name').value=inv.from_name||invDefault('from_name');
  document.getElementById('inv-from-zip').value=inv.from_zip||invDefault('from_zip');
  document.getElementById('inv-from-addr').value=inv.from_addr||invDefault('from_addr');
  document.getElementById('inv-from-tel').value=inv.from_tel||invDefault('from_tel');
  return downloadInvPDF();
}

// ── 請求シート ──
function blTab(t){
  ['sheet','history','members'].forEach(x=>{
    const p=document.getElementById('bl-'+x+'-pane');if(p)p.style.display=x===t?'':'none';
    const btn=document.getElementById('bltab-'+x);if(btn)btn.classList.toggle('active',x===t);
  });
  if(t==='history')loadBlHistory();
}

function _updSub(acId, subId){
  const ac=document.getElementById(acId), sub=document.getElementById(subId);
  if(ac&&sub) sub.innerHTML=subOp(ac.value,'');
}
function updBlDebitSub(){ _updSub('bl-debit-ac','bl-debit-sub'); }
function updBlOtherDebitSub(){ _updSub('bl-other-debit-ac','bl-other-debit-sub'); }
function updBlOtherCreditSub(){ _updSub('bl-other-credit-ac','bl-other-credit-sub'); }

function toggleBlType(){
  const type = document.querySelector('input[name="bl_type"]:checked').value;
  if(type === 'buhi'){
    document.getElementById('bl-buhi-inputs').style.display = 'grid';
    document.getElementById('bl-other-inputs').style.display = 'none';
  } else {
    document.getElementById('bl-buhi-inputs').style.display = 'none';
    document.getElementById('bl-other-inputs').style.display = 'grid';
  }
  renderBlPreview();
}

async function loadBilling(){
  const d=await api('GET','/members'); allMembers=d.members||[];
  [['bl-debit-ac','普通預金'],['bl-credit-ac','会費収入'],
   ['bl-other-debit-ac','普通預金'],['bl-other-credit-ac','']].forEach(([id,val])=>{
    const el=document.getElementById(id); if(el) el.innerHTML=allAcOp(val);
  });
  updBlDebitSub(); updBlOtherDebitSub(); updBlOtherCreditSub();
  // 借方補助のデフォルトを三井住友に設定
  const debitSub=document.getElementById('bl-debit-sub');
  if(debitSub){
    const smbc=Array.from(debitSub.options).find(o=>o.value.includes('三井住友'));
    if(smbc) debitSub.value=smbc.value;
  }
  const otherDebitSub=document.getElementById('bl-other-debit-sub');
  if(otherDebitSub){
    const smbc=Array.from(otherDebitSub.options).find(o=>o.value.includes('三井住友'));
    if(smbc) otherDebitSub.value=smbc.value;
  }
  renderMemberTable(); renderBlPreview();
}

function renderBlPreview(){
  const type = document.querySelector('input[name="bl_type"]:checked').value;
  const table = document.getElementById('bl-preview-table');
  if(!table) return;

  if (type === 'buhi') {
    table.innerHTML = `<thead><tr><th>氏名</th><th>種別</th><th style="text-align:right">会費</th><th>摘要</th><th>貸方補助</th></tr></thead>
    <tbody>` + allMembers.map((m,i)=>{
      const fee=parseInt(m.base_fee||0);
      const defTekiyo = m.default_tekiyo || getDefaultTekiyo(fee);
      return`<tr>
        <td>${escHtml(m.name||'')}</td><td>${escHtml(m.type||'')}</td>
        <td style="text-align:right">¥${fee.toLocaleString()}</td>
        <td><select class="bl-tekiyo-sel" data-member="${i}" style="border:1px solid var(--bd);border-radius:4px;padding:2px;font-size:11px;width:160px">${tekiyoOptions(defTekiyo)}</select></td>
        <td><select class="bl-sub-sel" data-member="${i}" style="border:1px solid var(--bd);border-radius:4px;padding:2px;font-size:11px;width:120px">${allSubOp(m.default_sub||'')}</select></td>
      </tr>`;
    }).join('') + `</tbody>`;
  } else {
    // 対象チェックボックスを削除
    table.innerHTML = `<thead><tr><th>氏名</th><th>請求額</th><th>摘要</th></tr></thead>
    <tbody>` + allMembers.map((m,i)=>{
      return`<tr>
        <td>${escHtml(m.name||'')}</td>
        <td><input type="number" class="bl-other-fee fi" data-member="${i}" value="0" min="0" style="width:80px; padding:3px; font-size:12px; text-align:right;"></td>
        <td><input type="text" class="bl-other-memo fi" data-member="${i}" style="width:140px; padding:3px; font-size:12px;"></td>
      </tr>`;
    }).join('') + `</tbody>`;
  }
}

// PDF生成処理（html2pdf.jsを使用）
function downloadBillingPDF(payload) {
  const isBuhi = payload.type === 'buhi';
  const title = isBuhi ? `${payload.period}月分 会費請求シート` : `${payload.title} 請求シート`;
  const hasMemo = !isBuhi && payload.members.some(m => m.memo_template);
  
  const total = payload.members.reduce((s, m) => s + m.fee, 0);
  const count = payload.members.length;

  const thStyle = 'border:1px solid #94a3b8; padding:7px 10px; background:#1e293b; color:#fff; font-size:11px; font-weight:600; text-align:left;';
  const tdStyle = 'border:1px solid #cbd5e1; padding:7px 10px; font-size:12px;';
  const tdRStyle = tdStyle + 'text-align:right;';

  const headerCols = (isBuhi || hasMemo)
    ? ['氏名', '振込名義（カナ）', '摘要', '請求額']
    : ['氏名', '振込名義（カナ）', '請求額'];

  const rows = payload.members.map((m, i) => {
    const bg = i % 2 === 0 ? '#fff' : '#f8fafc';
    const memo = isBuhi
      ? (m.tekiyo || getBuhiMemoDesc(m.fee))
      : (m.memo_template || '');
    const showMemo = isBuhi || hasMemo;
    const memoHtml = showMemo ? `<td style="${tdStyle}color:#475569;font-size:11px;">${escHtml(memo)}</td>` : '';
    return `<tr style="background:${bg}">
      <td style="${tdStyle}">${escHtml(m.name)}</td>
      <td style="${tdStyle}color:#475569;">${escHtml(m.kana || '')}</td>
      ${memoHtml}
      <td style="${tdRStyle}font-weight:600;">¥${m.fee.toLocaleString()}</td>
    </tr>`;
  }).join('');

  const footColspan = headerCols.length - 1;
  const html = `
  <div style="padding:24px 28px; font-family:'Helvetica Neue',Arial,'Hiragino Kaku Gothic ProN',sans-serif; color:#1e293b; max-width:720px; margin:0 auto;">
    <div style="border-bottom:3px solid #1e293b; padding-bottom:10px; margin-bottom:4px; display:flex; justify-content:space-between; align-items:flex-end;">
      <h2 style="margin:0; font-size:20px; font-weight:700; letter-spacing:0.02em;">${escHtml(title)}</h2>
      <span style="font-size:12px; color:#64748b;">対象人数: ${count}名</span>
    </div>
    ${payload.due_date ? `
    <div style="display:flex; justify-content:flex-end; margin:8px 0 16px;">
      <span style="background:#fef2f2; border:1px solid #fca5a5; border-radius:5px; padding:4px 12px; font-size:12px; font-weight:700; color:#dc2626;">
        振込期限：${escHtml(payload.due_date)}
      </span>
    </div>` : '<div style="margin-bottom:16px;"></div>'}
    <table style="width:100%; border-collapse:collapse; font-size:12px;">
      <thead>
        <tr>${headerCols.map(h => `<th style="${thStyle}">${h}</th>`).join('')}</tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr>
          <td colspan="${footColspan}" style="${tdStyle}font-weight:700; text-align:right; background:#f1f5f9; color:#334155;">合計（${count}名）</td>
          <td style="${tdRStyle}font-weight:700; font-size:13px; background:#f1f5f9; color:#1e293b;">¥${total.toLocaleString()}</td>
        </tr>
      </tfoot>
    </table>
    <div style="margin-top:18px; font-size:10px; color:#94a3b8; text-align:right;">
      発行日: ${new Date().toLocaleDateString('ja-JP', {year:'numeric',month:'2-digit',day:'2-digit'}).replace(/\//g,'/')}
    </div>
  </div>`;

  const filename = isBuhi
    ? `請求シート_${payload.period.replace('/','')}.pdf`
    : `請求シート_${payload.title}.pdf`;

  html2pdf().set({
    margin: 10,
    filename,
    image: { type: 'jpeg', quality: 0.98 },
    html2canvas: { scale: 2, scrollY: 0 },
    jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
    pagebreak: { mode: 'css', before: '.page-break', avoid: 'tr' }
  }).from(html).save();
}

function getBuhiMemoDesc(fee, overrideTekiyo) {
  if(overrideTekiyo) return overrideTekiyo;
  return getDefaultTekiyo(fee);
}

async function genBillingSheet(){
  const type = document.querySelector('input[name="bl_type"]:checked').value;
  let payload = {};

  if (type === 'buhi') {
    const period=document.getElementById('bl-period').value;
    const due=document.getElementById('bl-due').value;
    if(!period){toast('対象月を選択してください','#f59e0b');return;}
    
    const debitAc=(document.getElementById('bl-debit-ac')||{}).value||'普通預金';
    const debitSub=(document.getElementById('bl-debit-sub')||{}).value||'';
    const creditAc=(document.getElementById('bl-credit-ac')||{}).value||'';
    const subs=document.querySelectorAll('.bl-sub-sel');
    const tekiyoSels=document.querySelectorAll('.bl-tekiyo-sel');
    
    const membersData=allMembers.map((m,i)=>{
      const fee = parseInt(m.base_fee||0);
      const tekiyo = tekiyoSels[i] ? tekiyoSels[i].value : getBuhiMemoDesc(fee);
      const autoMemo = `{$取引月}月分 ${tekiyo}`;
      
      return{
        name:m.name, kana:m.kana||'', fee:fee,
        debit_account: debitAc, debit_sub: debitSub, 
        credit_account: creditAc, credit_sub: subs[i]?subs[i].value:'',
        memo_template: autoMemo, tekiyo: tekiyo, auto_journal: true,
      };
    });
    
    payload = {
      type: 'buhi', period: period.replace('-','/'), due_date: due.replace(/-/g,'/'),
      debit_account: debitAc, debit_sub: debitSub, credit_account: creditAc, memo_template: '',
      members: membersData
    };
  } else {
    const title=document.getElementById('bl-other-title').value.trim();
    const start=document.getElementById('bl-start').value;
    const due=document.getElementById('bl-other-due').value;
    if(!title){toast('請求タイトルを入力してください','#f59e0b');return;}
    if(!start){toast('判定開始日を入力してください','#f59e0b');return;}
    
    const debitAc=(document.getElementById('bl-other-debit-ac')||{}).value||'普通預金';
    const debitSub=(document.getElementById('bl-other-debit-sub')||{}).value||'';
    const creditAc=(document.getElementById('bl-other-credit-ac')||{}).value||'';
    const creditSub=(document.getElementById('bl-other-credit-sub')||{}).value||'';
    
    const fees=document.querySelectorAll('.bl-other-fee');
    const memos=document.querySelectorAll('.bl-other-memo');
    
    const membersData=[];
    allMembers.forEach((m,i)=>{
      const fee = parseInt(fees[i].value)||0;
      if(fee <= 0) return; // 0円なら自動で対象外
      membersData.push({
        name:m.name, kana:m.kana||'', fee: fee,
        debit_account: debitAc, debit_sub: debitSub, 
        credit_account: creditAc, credit_sub: creditSub,
        memo_template: memos[i]?memos[i].value.trim():'', auto_journal: true,
      });
    });
    if(!membersData.length){toast('請求対象者がいません','#f59e0b');return;}
    
    payload = {
      type: 'other', title: title, start_date: start.replace(/-/g,'/'), due_date: due.replace(/-/g,'/'),
      debit_account: debitAc, debit_sub: debitSub, credit_account: creditAc, credit_sub: creditSub, members: membersData
    };
  }

  const res=await api('POST','/billing/sheets', {...payload,_skipLog:true});
  const _blTitle = payload.type==='other' ? payload.title : `${payload.period}月分 会費`;
  const _blCount = (payload.members||[]).length;
  const _blTotal = (payload.members||[]).reduce((s,m)=>s+parseInt(m.fee||0),0);
  logChange('作成','/billing',`請求シート「${_blTitle}」を生成（対象${_blCount}名・合計¥${_blTotal.toLocaleString()}）`);
  toast('請求シートを生成し、履歴に保存しました','#059669');
  downloadBillingPDF(payload);
  blTab('history');
}

// 生成済みシートの一覧。ボタンを押すたびに全シートを取り直さないよう、ここに持っておく。
let _blSheets=[];
async function _blFetchSheets(){
  const d=await api('GET','/billing/sheets');
  _blSheets=d.sheets||[];
  return _blSheets;
}
async function _blSheet(sheetId){
  let s=_blSheets.find(x=>x.id===sheetId);
  if(!s){ await _blFetchSheets(); s=_blSheets.find(x=>x.id===sheetId); }
  return s||null;
}
function _blSheetTitle(s){ return s.type==='other' ? (s.title||'') : `${s.period}月分 会費`; }
function _blParseDate(str){
  const p=String(str||'').split('/');
  return p.length===3 ? new Date(parseInt(p[0]),parseInt(p[1])-1,parseInt(p[2])) : null;
}
function _blToday(){ const t=new Date(); t.setHours(0,0,0,0); return t; }
function _blOverdueDays(dueDate){
  if(!dueDate) return 0;
  const d=Math.floor((_blToday()-dueDate)/86400000);
  return d>0?d:0;
}

async function loadBlHistory(){
  const sheets=await _blFetchSheets();
  const el=document.getElementById('bl-history-list');
  if(!sheets.length){el.innerHTML='<p style="color:var(--mu)">生成履歴なし</p>';return;}
  const today=_blToday();

  el.innerHTML=sheets.map(s=>{
    const isOther = s.type === 'other';
    const badge = isOther ? '<span class="badge" style="background:#fef3c7;color:#b45309">その他請求</span>' : '<span class="badge" style="background:#dbeafe;color:#1e3a8a">会費請求</span>';
    const members=s.members||[];
    const paid=members.filter(m=>m.paid);
    const unpaid=members.filter(m=>!m.paid&&parseInt(m.fee||0)>0);
    const totalFee=members.reduce((sum,m)=>sum+parseInt(m.fee||0),0);
    const paidFee=paid.reduce((sum,m)=>sum+parseInt(m.fee||0),0);
    const dueDate=_blParseDate(s.due_date);
    const sheetOverdueDays=_blOverdueDays(dueDate);
    const isOverdue = sheetOverdueDays>0 && unpaid.length>0;
    const id=escJsAttr(s.id);

    return`<div style="border:${isOverdue?'2px solid #fca5a5':'1px solid var(--bd)'};border-radius:8px;padding:12px;margin-bottom:10px;background:${isOverdue?'#fff8f8':''}">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
        <div>
          ${badge}
          ${isOverdue ? `<span style="background:#dc2626;color:#fff;font-size:11px;font-weight:700;padding:2px 8px;border-radius:99px;margin-left:4px"><span class="ei" data-i="alert"></span>期限超過 +${sheetOverdueDays}日</span>` : (dueDate&&today<=dueDate ? `<span style="background:#dcfce7;color:#16a34a;font-size:11px;font-weight:600;padding:2px 8px;border-radius:99px;margin-left:4px">期限内</span>` : '')}
          <strong style="margin-left:6px">${escHtml(_blSheetTitle(s))}</strong>
          ${isOther ? `<span style="font-size:12px;color:var(--mu);margin-left:8px">判定開始: ${escHtml(s.start_date||'')}</span>` : ''}
          <span style="font-size:12px;color:${isOverdue?'#dc2626':'var(--mu)'};margin-left:8px;font-weight:${isOverdue?'600':'400'}">期限: ${escHtml(s.due_date||'未設定')}</span>
          <span style="font-size:12px;color:var(--mu);margin-left:8px">作成: ${escHtml(s.created_at||'')}</span>
          ${s.checked_at?`<span style="font-size:12px;color:var(--in);margin-left:8px">最終確認: ${escHtml(s.checked_at)}</span>`:''}
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button class="btn bg bsm" onclick="runBlCheck('${id}')"><span class="ei" data-i="refresh"></span>振込確認チェック</button>
          <button class="btn bp bsm" onclick="showBlDetail('${id}')"><span class="ei" data-i="clipboard"></span>詳細表示</button>
          <button class="btn bs bsm" onclick="redownloadBlPDF('${id}')"><span class="ei" data-i="file"></span>PDF</button>
          <button class="btn bs bsm" onclick="openBlEdit('${id}')"><span class="ei" data-i="edit"></span>編集</button>
          <button class="btn bd2 bsm" onclick="delBlSheet('${id}')">削除</button>
        </div>
      </div>
      <div style="margin-top:8px;font-size:12px">
        <span style="color:var(--in)">振込確認: ${paid.length}/${members.length}名</span>
        <span style="color:var(--p);margin-left:12px">入金額: ¥${paidFee.toLocaleString()} / ¥${totalFee.toLocaleString()}</span>
        ${s.journaled_count?`<span style="color:var(--mu);margin-left:12px">自動仕訳: ${parseInt(s.journaled_count)||0}件</span>`:''}
        ${isOverdue ? `<span style="color:#dc2626;font-weight:600;margin-left:12px"><span class="ei" data-i="alert"></span>期限超過未入金: ${unpaid.length}名</span>` : ''}
      </div>
      ${unpaid.length?`
      <div style="margin-top:6px;font-size:12px;color:${isOverdue?'#dc2626':'var(--ex)'}">
        未入金: ${unpaid.map(m=>escHtml(m.name)).join('、')}
      </div>`:''}
    </div>`;
  }).join('');
}

async function delBlSheet(sheetId){
  if(!confirm('このシートを削除しますか？'))return;
  const s=await _blSheet(sheetId);
  const res=await api('DELETE','/billing/sheets/'+sheetId,{_skipLog:true});
  if(res.ok){
    logChange('削除','/billing',`請求シート「${s?_blSheetTitle(s):'(不明)'}」を削除しました`);
    toast('削除しました','#059669');loadBlHistory();
  }
  else toast(res.error||'削除エラー','#dc2626');
}

// ── PDF再ダウンロード ──
async function redownloadBlPDF(sheetId){
  const sheet=await _blSheet(sheetId);
  if(!sheet){toast('シートが見つかりません','#dc2626');return;}
  downloadBillingPDF(sheet);
}

// ── 履歴シート編集 ──
let _blEditId=null;
let _blEditSnapshot=null;
async function openBlEdit(sheetId){
  const sheet=await _blSheet(sheetId);
  if(!sheet){toast('シートが見つかりません','#dc2626');return;}
  _blEditId=sheetId;
  const dispTitle=_blSheetTitle(sheet);
  _blEditSnapshot={
    title: dispTitle,
    due_date: sheet.due_date||'',
    total: (sheet.members||[]).reduce((s,m)=>s+parseInt(m.fee||0),0),
    count: (sheet.members||[]).length,
  };

  document.getElementById('bl-edit-title').textContent=`編集: ${dispTitle}`;
  document.getElementById('bl-edit-due').value=(sheet.due_date||'').replace(/\//g,'-');

  const tbody=document.getElementById('bl-edit-members');
  tbody.innerHTML=(sheet.members||[]).map((m,i)=>{
    const tekiyo=sheet.type==='buhi'?(m.tekiyo||m.memo_template||''):(m.memo_template||'');
    return`<tr style="background:${i%2===0?'#fff':'#f8fafc'}">
      <td style="padding:6px 8px;font-size:13px">${escHtml(m.name||'')}</td>
      <td style="padding:4px"><input type="number" class="bl-edit-fee fi" data-idx="${i}" value="${parseInt(m.fee||0)||0}" min="0" style="width:85px;text-align:right;padding:4px 6px;font-size:12px"></td>
      <td style="padding:4px"><input type="text" class="bl-edit-tekiyo fi" data-idx="${i}" value="${escHtml(tekiyo)}" style="width:180px;padding:4px 6px;font-size:12px"></td>
    </tr>`;
  }).join('');
  document.getElementById('bl-edit-ov').classList.add('open');
}
function closeBlEdit(){document.getElementById('bl-edit-ov').classList.remove('open');}
async function saveBlEdit(){
  if(!_blEditId)return;
  const due=document.getElementById('bl-edit-due').value.replace(/-/g,'/');
  const fees=document.querySelectorAll('.bl-edit-fee');
  const tekiyos=document.querySelectorAll('.bl-edit-tekiyo');
  const members=Array.from(fees).map((f,i)=>({
    fee:parseInt(f.value)||0,
    tekiyo:tekiyos[i]?tekiyos[i].value.trim():'',
    memo_template:tekiyos[i]?tekiyos[i].value.trim():'',
  }));
  const res=await api('PUT','/billing/sheets/'+_blEditId,{due_date:due,members,_skipLog:true});
  if(res.ok){
    const snap=_blEditSnapshot||{};
    const newTotal=members.reduce((s,m)=>s+parseInt(m.fee||0),0);
    const ch=[];
    if(snap.due_date!==due) ch.push(`期限 ${snap.due_date||'(未設定)'} → ${due}`);
    if(snap.total!==newTotal) ch.push(`請求総額 ¥${(snap.total||0).toLocaleString()} → ¥${newTotal.toLocaleString()}`);
    const sheetName=snap.title||'請求シート';
    const desc = ch.length
      ? `請求シート「${sheetName}」を編集：${ch.join('、')}`
      : `請求シート「${sheetName}」を編集（金額・摘要を調整）`;
    logChange('更新','/billing',desc);
    toast('保存しました','#059669');closeBlEdit();loadBlHistory();
  }
  else toast(res.error||'保存エラー','#dc2626');
}

async function runBlCheck(sheetId){
  toast('振込確認チェック中...');
  const s=await _blSheet(sheetId);
  const res=await api('POST','/billing/check/'+sheetId,{_skipLog:true});
  if(res.ok){
    logChange('更新','/billing',`「${s?_blSheetTitle(s):'請求シート'}」の振込確認チェックを実行（${res.matched}名入金確認、${res.journaled}件自動仕訳）`);
    toast(`${res.matched}名確認、${res.journaled}件自動仕訳`,'#059669');
    const [tx]=await Promise.all([api('GET','/transactions'), loadBlHistory()]);
    allTx=tx.transactions||allTx;
    loadDash();
  }else toast(res.error||'エラー','#dc2626');
}

async function showBlDetail(sheetId){
  const sheet=await _blSheet(sheetId);
  if(!sheet)return;
  const members=sheet.members||[];
  const today=_blToday();
  const dueDate=_blParseDate(sheet.due_date);
  const overdueDays=_blOverdueDays(dueDate);
  const overdueMembers=members.filter(m=>!m.paid&&parseInt(m.fee||0)>0&&overdueDays>0);
  const id=escJsAttr(sheetId);

  document.getElementById('bl-detail-title').textContent=`${_blSheetTitle(sheet)} 振込確認結果`;
  document.getElementById('bl-detail-body').innerHTML=`
    ${overdueMembers.length>0 ? `<div style="margin-bottom:10px;padding:10px 14px;background:#fff1f2;border:1px solid #fca5a5;border-radius:8px;display:flex;align-items:center;gap:8px;">
      <span style="font-size:18px"><span class="ei" data-i="alert"></span></span>
      <span style="font-size:13px;font-weight:600;color:#dc2626">振込期限超過: ${overdueMembers.length}名（期限: ${escHtml(sheet.due_date)}）</span>
    </div>` : (dueDate && today <= dueDate ? `<div style="margin-bottom:10px;padding:8px 14px;background:#f0fdf4;border:1px solid #86efac;border-radius:8px;font-size:12px;color:#16a34a;"><span class="ei" data-i="checkc"></span>振込期限内（期限: ${escHtml(sheet.due_date)}）</div>` : '')}
    <div class="tbl-wrap"><table><thead><tr>
      <th>氏名</th><th>振込名義</th><th style="text-align:right">請求額</th>
      <th>振込確認</th><th style="text-align:right">入金額</th><th>入金日</th><th>期限超過</th><th>貸方補助</th>
    </tr></thead>
    <tbody>${members.map((m, i)=>{
      const fee=parseInt(m.fee||0);
      const paid=!!m.paid;
      const isOverdue = !paid && fee>0 && overdueDays>0;
      const rowBg = paid ? '#f0fdf4' : (isOverdue ? '#fff1f2' : (fee ? '#fff7f7' : ''));
      return`<tr style="background:${rowBg}">
        <td style="font-weight:500; display:flex; align-items:center; gap:6px;">
          ${isOverdue ? '<span style="color:#dc2626;font-size:13px"><span class="ei" data-i="alert"></span></span>' : ''}
          ${escHtml(m.name||'')}
          ${paid && !m.manual_paid ? `<button class="btn bs bsm" style="padding:2px 6px; font-size:10px" onclick="showBlTx('${id}', ${i})">詳細</button>` : ''}
          ${m.manual_paid ? `<span class="badge" style="background:#eef2ff;border:1px solid #c7d2fe;color:#4338ca;font-size:10px">手動</span>
            <button class="btn bs bsm" style="padding:2px 6px; font-size:10px" onclick="setBlManualPaid('${id}', ${i}, false)">取消</button>` : ''}
          ${!paid && fee>0 ? `<button class="btn bs bsm" style="padding:2px 6px; font-size:10px" onclick="setBlManualPaid('${id}', ${i}, true)">手動で振込済み</button>` : ''}
        </td>
        <td style="font-size:12px;color:var(--mu)">${escHtml(m.kana||'')}</td>
        <td style="text-align:right">¥${fee.toLocaleString()}</td>
        <td style="text-align:center;font-size:16px;color:${paid?'var(--in)':'var(--ex)'}">${paid?'✓':'<span class="ei" data-i="x"></span>'}</td>
        <td style="text-align:right;color:var(--in)">${paid?'¥'+fee.toLocaleString():''}</td>
        <td style="font-size:12px;color:var(--mu);white-space:nowrap">${paid?escHtml(m.paid_date||''):''}</td>
        <td style="text-align:center">${paid ? '<span style="color:var(--in);font-size:12px">—</span>' : (isOverdue ? `<span style="background:#dc2626;color:#fff;font-size:11px;font-weight:700;padding:2px 7px;border-radius:99px;white-space:nowrap">+${overdueDays}日</span>` : (dueDate ? `<span style="font-size:11px;color:#64748b">期限内</span>` : '<span style="font-size:11px;color:#94a3b8">—</span>'))}</td>
        <td><span class="badge" style="background:#f8fafc;border:1px solid #cbd5e1;color:#475569">${escHtml(m.credit_sub||'なし')}</span></td>
      </tr>`;
    }).join('')}</tbody></table></div>
    <div style="margin-top:10px;font-size:13px;font-weight:600;text-align:right">
      入金: ${members.filter(m=>m.paid).length}/${members.length}名 /
      入金額: ¥${members.filter(m=>m.paid).reduce((s,m)=>s+parseInt(m.fee||0),0).toLocaleString()} /
      請求総額: ¥${members.reduce((s,m)=>s+parseInt(m.fee||0),0).toLocaleString()}
      ${overdueMembers.length>0 ? ` / <span style="color:#dc2626">期限超過: ${overdueMembers.length}名</span>` : ''}
    </div>`;
  document.getElementById('bl-detail-ov').classList.add('open');
}

// メンバーを手動で振込済みにする／手動の振込済みを取り消す（現金で受け取ったときなど）。
// 手動の振込済みは仕訳しない。振込確認チェックを実行しても上書きされない。
async function setBlManualPaid(sheetId, mIndex, paid){
  const s=await _blSheet(sheetId);
  const m=s && (s.members||[])[mIndex];
  if(!m) return;
  let date='';
  if(paid){
    date=prompt(`${m.name} を手動で振込済みにします。\n入金日（YYYY/MM/DD）を入力してください。\n※仕訳は作成されません。必要なら仕訳帳で登録してください。`, _blToday().toLocaleDateString('ja-JP',{year:'numeric',month:'2-digit',day:'2-digit'}));
    if(date===null) return;
    date=date.trim();
  }else if(!confirm(`${m.name} の手動の振込済みを取り消しますか？`)) return;
  const res=await api('POST','/billing/manual-paid/'+sheetId,{index:mIndex, paid, date, _skipLog:true});
  if(!res.ok){ toast(res.error||'エラー','#dc2626'); return; }
  const title=_blSheetTitle(s);
  logChange('更新','/billing', paid
    ? `「${title}」で ${m.name} を手動で振込済みに（入金日 ${res.member.paid_date}）`
    : `「${title}」で ${m.name} の手動の振込済みを取り消し`);
  toast(paid?'振込済みにしました':'取り消しました','#059669');
  await loadBlHistory();
  showBlDetail(sheetId);
  loadDash();
}

// 振込確認で照合した取引を表示する。
// サーバーが照合した取引（paid_tx_id）をそのまま出す。以前は画面側で別の条件
//   （期間を見ない・カナの部分一致）で探し直していたため、照合結果と違う取引が出ていた。
async function showBlTx(sheetId, mIndex) {
  const sheet=await _blSheet(sheetId);
  const m=sheet && (sheet.members||[])[mIndex];
  if(!m) return;
  const tx=m.paid_tx_id ? (allTx||[]).find(t=>t.id===m.paid_tx_id) : null;
  let html='';
  if(tx){
    const entries=tx.entries||[];
    if(entries.length){
      entries.forEach(e=>{
        html+=`<tr>
          <td style="white-space:nowrap">${escHtml(tx.date||'')}</td>
          <td>${escHtml(e.debit_account||'')}</td><td style="font-size:12px;color:var(--mu)">${escHtml(e.debit_sub||'')}</td>
          <td>${escHtml(e.credit_account||'')}</td><td style="font-size:12px;color:var(--mu)">${escHtml(e.credit_sub||'')}</td>
          <td style="text-align:right;font-weight:600">¥${parseInt(e.amount||0).toLocaleString()}</td>
          <td style="font-size:12px">${escHtml(e.memo||tx.memo||'')}</td>
        </tr>`;
      });
    }else{
      const amt=Math.max(tx.debit||0, tx.credit||0, tx.bank_debit||0, tx.bank_credit||0);
      html+=`<tr>
          <td style="white-space:nowrap">${escHtml(tx.date||'')}</td>
          <td colspan="4"><span style="color:var(--mu);font-size:12px">[未仕訳] 振込名義: ${escHtml(tx.party||'')}</span></td>
          <td style="text-align:right;font-weight:600">¥${amt.toLocaleString()}</td>
          <td style="font-size:12px">${escHtml(tx.memo||'')}</td>
        </tr>`;
    }
  }

  document.getElementById('mtitle').textContent = `${m.name} の振込詳細`;
  document.getElementById('mbody').innerHTML = !html
    ? '<p style="color:var(--mu)">該当する取引データが見つかりません（振込確認チェックをもう一度実行してください）</p>'
    : `<div class="tbl-wrap"><table><thead><tr>
        <th>取引日</th><th>借方科目</th><th>借方補助</th><th>貸方科目</th><th>貸方補助</th><th style="text-align:right">金額</th><th>摘要</th>
       </tr></thead><tbody>${html}</tbody></table></div>`;
  const detov = document.getElementById('detov');
  detov.style.zIndex = '1050';
  detov.classList.add('open');
}

function renderMemberTable(){
  const el=document.getElementById('member-body');if(!el)return;
  el.innerHTML=allMembers.map((m,i)=>`<tr>
    <td><input type="text" value="${escHtml(m.name||'')}" style="border:1px solid var(--bd);border-radius:4px;padding:3px 6px;font-size:12px;width:90px" onblur="allMembers[${i}].name=this.value"></td>
    <td><input type="text" value="${escHtml(m.kana||'')}" style="border:1px solid var(--bd);border-radius:4px;padding:3px 6px;font-size:11px;width:110px" onblur="allMembers[${i}].kana=this.value"></td>
    <td><input value="${escHtml(m.type||'')}" placeholder="一般" list="mb-type-list" style="border:1px solid var(--bd);border-radius:4px;padding:2px 4px;font-size:11px;width:80px" onchange="allMembers[${i}].type=this.value.trim()"></td>
    <td><select style="border:1px solid var(--bd);border-radius:4px;padding:2px;font-size:11px;width:110px" onchange="allMembers[${i}].default_sub=this.value">${allSubOp(m.default_sub||'')}</select></td>
    <td style="text-align:right"><input type="number" value="${parseInt(m.base_fee||0)||0}" style="border:1px solid var(--bd);border-radius:4px;padding:3px 5px;font-size:12px;width:70px;text-align:right" onblur="allMembers[${i}].base_fee=parseInt(this.value)||0;updMemberTekiyo(${i})"></td>
    <td><select style="border:1px solid var(--bd);border-radius:4px;padding:2px;font-size:11px;width:150px" onchange="allMembers[${i}].default_tekiyo=this.value">${tekiyoOptions(m.default_tekiyo||getDefaultTekiyo(m.base_fee||0))}</select></td>
    <td><button onclick="allMembers.splice(${i},1);renderMemberTable()" style="background:none;border:none;cursor:pointer;color:var(--ex)">×</button></td>
  </tr>`).join('');
}

// 会費金額変更時にデフォルト摘要を自動更新
function updMemberTekiyo(i) {
  const m = allMembers[i];
  if(!m) return;
  // 摘要が明示的にカスタム設定されていない場合は金額から自動セット
  const newDef = getDefaultTekiyo(m.base_fee||0);
  if(!m.default_tekiyo || feeMasters().some(fm => fm.tekiyo === m.default_tekiyo)) {
    m.default_tekiyo = newDef;
  }
  renderMemberTable();
}
async function saveMembers(){await api('POST','/members',{members:allMembers});toast('保存しました','#059669');}

function openAddMember(){
  document.getElementById('mb-def-sub').innerHTML = allSubOp('');
  document.getElementById('mb-tekiyo').innerHTML = tekiyoOptions('');
  document.getElementById('memberov').classList.add('open');
}

function submitAddMember(){
  const name=document.getElementById('mb-name').value.trim();
  if(!name){toast('氏名を入力してください','#f59e0b');return;}
  const fee=parseInt(document.getElementById('mb-fee').value)||0;
  const tekiyo=document.getElementById('mb-tekiyo').value||getDefaultTekiyo(fee);
  allMembers.push({
    name, kana:document.getElementById('mb-kana').value,
    type:document.getElementById('mb-type').value,
    default_sub:document.getElementById('mb-def-sub').value,
    base_fee:fee,
    default_tekiyo:tekiyo,
  });
  renderMemberTable();document.getElementById('memberov').classList.remove('open');
}
